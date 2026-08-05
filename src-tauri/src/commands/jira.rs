//! Jira IPC 커맨드.
//!
//! 토큰은 이 경계를 넘어가지 않는다. 프론트는 위젯 id와 설정만 넘기고,
//! 자격증명 조립은 전부 여기서 한다.

use serde::{Deserialize, Serialize};
use tauri::State;

use crate::providers::jira::{
    apply_sort, CreateIssueInput, CreateMeta, CreateMetaField, CreatedIssue, JiraClient, JiraComment,
    JiraError, JiraIdentity, JiraIssue, JiraIssueDetail, JiraProject, JiraProjectWithTypes,
    JiraQuery, JiraTransition, Preset, SortDirection, SortField, LIST_FIELDS,
};
use crate::secrets::{Secret, SecretKey};
use crate::state::{AppState, JiraSessionCache};

/// 위젯 데이터 봉투. 프론트의 `WidgetEnvelope<T>`와 짝을 이룬다.
///
/// 로딩/에러 상태를 명시적으로 담는 이유: TanStack Query를 쓰지 않기로 했으므로
/// (DECISIONS 5장) 그것이 공짜로 주던 `isLoading`/`isError`를 직접 모델링해야 한다.
#[derive(Debug, Clone, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct JiraWidgetData {
    pub issues: Vec<JiraIssue>,
    /// 실제로 네트워크에서 가져온 시각. 캐시 히트면 과거 시각이다 — "N분 전 데이터" 표시용.
    pub fetched_at: String,
    /// 이 응답이 디스크 캐시에서 왔는가. true면 갱신이 실패했거나 아직 안 끝났다는 뜻.
    pub from_cache: bool,
}

#[derive(Debug, Clone, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct JiraWidgetError {
    /// `transient` | `permanent` — 프론트가 재시도 UI를 고르는 축.
    pub kind: String,
    pub message: String,
    /// 401 여부. 전역 배너를 한 번만 띄우기 위한 신호(DECISIONS 16장).
    pub is_auth_failure: bool,
    pub retry_after_secs: Option<u64>,
    /// 실패했지만 직전 성공 데이터가 있으면 함께 준다. 목록을 비우지 않기 위해서.
    pub stale: Option<JiraWidgetData>,
}

#[derive(Debug, Clone, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct JiraWidgetConfig {
    /// 사용자가 붙인 위젯 이름. 비어 있으면 쿼리 이름을 쓴다.
    #[serde(default)]
    pub title: Option<String>,
    pub query: JiraQuery,
    /// DECISIONS 11.2 — 기본 30건.
    pub max_results: u32,
    /// 프로젝트 키로 범위를 좁힌다. 빈 목록이면 전체.
    ///
    /// 쿼리와 분리해서 두는 이유: 프리셋이든 생 JQL이든 똑같이 적용돼야 한다.
    /// 프리셋마다 프로젝트별 변종을 만드는 것은 조합 폭발이다.
    #[serde(default)]
    pub projects: Vec<String>,
    /// 자동 새로고침 주기(초). **0이면 자동 갱신하지 않는다** — 수동 새로고침만.
    ///
    /// 위젯마다 다르다(DECISIONS 11.2). 프론트에서 1분 미만으로 내려오지
    /// 않도록 막지만, 손으로 고친 board.json에 대비해 여기서도 보정한다.
    #[serde(default = "default_refresh_secs")]
    pub refresh_secs: u32,
    /// 목록에 표시할 열. 비어 있으면 기본 세트.
    #[serde(default)]
    pub columns: Option<Vec<String>>,
    /// 정렬 기준. **프리셋에만 적용된다** — 생 JQL의 ORDER BY는 사용자 몫이다.
    #[serde(default)]
    pub sort_field: Option<SortField>,
    #[serde(default)]
    pub sort_direction: Option<SortDirection>,
}

/// 5분 (DECISIONS 11.2 기본값)
fn default_refresh_secs() -> u32 {
    300
}

/// 자동 갱신을 켠 경우의 하한. 이보다 잦으면 rate limit에 가까워진다.
pub const MIN_REFRESH_SECS: u32 = 60;

impl Default for JiraWidgetConfig {
    fn default() -> Self {
        Self {
            title: None,
            query: crate::providers::jira::default_query(),
            max_results: 15,
            projects: Vec::new(),
            refresh_secs: default_refresh_secs(),
            columns: None,
            sort_field: None,
            sort_direction: None,
        }
    }
}

/// 프리셋 목록. 설정 폼의 드롭다운을 채운다.
#[tauri::command]
#[specta::specta]
pub fn jira_presets() -> Vec<Preset> {
    Preset::all().to_vec()
}

/// 프로젝트 목록. 위젯 설정의 범위 선택을 채운다.
#[tauri::command]
#[specta::specta]
pub async fn jira_projects(state: State<'_, AppState>) -> Result<Vec<JiraProject>, String> {
    let Some(creds) = state.jira_credentials()? else {
        return Ok(Vec::new());
    };
    let client = JiraClient::with_http_client(state.http.clone(), creds);
    client.list_projects().await.map_err(|e| e.to_string())
}

/// 연결 상태. 프론트가 알아야 할 것은 두 가지뿐이다 —
/// 설정이 됐는지, 그리고 티켓 링크를 만들 base URL이 무엇인지.
/// **토큰과 이메일은 넘기지 않는다.**
#[derive(Debug, Clone, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct JiraConnectionInfo {
    pub configured: bool,
    pub base_url: Option<String>,
}

#[tauri::command]
#[specta::specta]
pub fn jira_connection(state: State<'_, AppState>) -> Result<JiraConnectionInfo, String> {
    let base_url = {
        let c = state.connections.lock().map_err(|_| "상태 잠금 실패")?;
        c.jira_base_url.clone()
    };
    Ok(JiraConnectionInfo {
        configured: state.jira_credentials()?.is_some(),
        base_url,
    })
}

/// Jira 연결이 설정돼 있는가. 설정 안내를 띄울지 결정한다.
#[tauri::command]
#[specta::specta]
pub fn jira_is_configured(state: State<'_, AppState>) -> Result<bool, String> {
    Ok(state.jira_credentials()?.is_some())
}

/// 설정창의 "연결 테스트" 버튼.
#[tauri::command]
#[specta::specta]
pub async fn jira_verify(
    state: State<'_, AppState>,
    base_url: String,
    email: String,
    api_token: String,
) -> Result<String, String> {
    let creds = crate::providers::jira::JiraCredentials::new(base_url, email, api_token);
    let client = JiraClient::with_http_client(state.http.clone(), creds);
    match client.verify_credentials().await {
        Ok(identity) => Ok(identity.display_name),
        Err(e) => Err(e.to_string()),
    }
}

/// 자격증명 저장. 토큰과 이메일은 키체인, base_url만 파일.
#[tauri::command]
#[specta::specta]
pub fn jira_save_credentials(
    state: State<'_, AppState>,
    base_url: String,
    email: String,
    api_token: String,
) -> Result<(), String> {
    state
        .secrets
        .set(&SecretKey::jira_email(), &Secret::new(email))
        .map_err(|e| e.to_string())?;
    state
        .secrets
        .set(&SecretKey::jira_token(), &Secret::new(api_token))
        .map_err(|e| e.to_string())?;

    {
        let mut c = state.connections.lock().map_err(|_| "상태 잠금 실패")?;
        c.version = 1;
        c.jira_base_url = Some(base_url);
    }
    state.save_connections()?;
    tracing::info!("Jira 자격증명 저장됨");
    Ok(())
}

/// 위젯 하나의 데이터를 가져온다.
///
/// 흐름: 캐시 즉시 반환이 아니라 **네트워크 시도 → 실패 시 캐시로 폴백**.
/// 앱 시작 시의 0ms 표시는 별도 커맨드([`jira_cached`])가 담당한다 —
/// 두 경로를 나눠야 프론트가 "캐시부터 그리고 갱신" 순서를 제어할 수 있다.
#[tauri::command]
#[specta::specta]
pub async fn jira_fetch(
    state: State<'_, AppState>,
    widget_id: String,
    config: JiraWidgetConfig,
) -> Result<JiraWidgetData, JiraWidgetError> {
    let creds = state
        .jira_credentials()
        .map_err(|e| permanent_error(&e, None))?
        .ok_or_else(|| JiraWidgetError {
            kind: "permanent".into(),
            message: "Jira 연결이 설정되지 않았습니다".into(),
            is_auth_failure: true,
            retry_after_secs: None,
            stale: None,
        })?;

    let Some(jql) = config.query.to_jql() else {
        return Err(permanent_error(
            "알 수 없는 프리셋입니다. 위젯 설정에서 쿼리를 다시 선택하세요.",
            None,
        ));
    };
    // 정렬과 프로젝트 범위는 **프리셋에만** 적용한다.
    // 사용자가 쓴 JQL은 그 자체로 완결이므로 우리가 손대면 의도를 덮어쓴다.
    let is_preset = matches!(config.query, JiraQuery::Preset { .. });
    let jql = if is_preset {
        let sorted = match (config.sort_field, config.sort_direction) {
            (Some(f), dir) => apply_sort(&jql, f, dir.unwrap_or(SortDirection::Desc)),
            _ => jql,
        };
        scope_to_projects(&sorted, &config.projects)
    } else {
        jql
    };

    let client = JiraClient::with_http_client(state.http.clone(), creds);
    match client
        .search_issues(&jql, config.max_results, LIST_FIELDS)
        .await
    {
        Ok(page) => {
            let fetched_at = chrono::Utc::now();
            if let Ok(cache) = state.cache.lock() {
                if let Ok(value) = serde_json::to_value(&page.issues) {
                    let _ = cache.put(&widget_id, value, fetched_at);
                }
            }
            Ok(JiraWidgetData {
                issues: page.issues,
                fetched_at: fetched_at.to_rfc3339(),
                from_cache: false,
            })
        }
        Err(e) => {
            tracing::warn!(widget_id = %widget_id, error = %e, "Jira 조회 실패");
            Err(to_widget_error(&state, &widget_id, e))
        }
    }
}

/// 디스크 캐시만 읽는다. 네트워크를 건드리지 않으므로 즉시 반환된다.
///
/// **앱 시작 시 이것을 먼저 부른다.** 0ms에 실제 데이터를 그리는 것이
/// Jira 웹과의 결정적 차이(DECISIONS 17장).
#[tauri::command]
#[specta::specta]
pub fn jira_cached(
    state: State<'_, AppState>,
    widget_id: String,
) -> Result<Option<JiraWidgetData>, String> {
    let cache = state.cache.lock().map_err(|_| "상태 잠금 실패")?;
    Ok(cached_data(&cache, &widget_id))
}

// ---------------------------------------------------------------------------
// 상세 모달 · 생성 폼 (2차)
// ---------------------------------------------------------------------------

/// 모달·폼에서 쓰는 단발 호출 실패.
///
/// [`JiraWidgetError`]와 나눠 둔 이유: 저쪽은 위젯 봉투라 `stale`(직전 성공 데이터)을
/// 들고 다닌다. 모달은 캐시하지 않으므로(D2) 그 필드가 늘 `None`이 되고,
/// 프론트가 "있을 수도 있는 값"을 매번 확인하게 만든다.
#[derive(Debug, Clone, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct JiraCallError {
    /// `transient` | `permanent` — 프론트가 [다시 시도]를 보일지 고르는 축.
    pub kind: String,
    /// Jira 원문 그대로. 우리가 고쳐 쓰지 않는다.
    pub message: String,
    /// 401. 전역 배너 1회 규칙의 트리거 (DECISIONS 16장).
    pub is_auth_failure: bool,
    pub retry_after_secs: Option<u64>,
}

impl JiraCallError {
    fn permanent(message: impl Into<String>) -> Self {
        Self {
            kind: "permanent".into(),
            message: message.into(),
            is_auth_failure: false,
            retry_after_secs: None,
        }
    }

    /// 연결이 아예 설정되지 않은 경우. 401과 같은 배너를 띄우게 한다 —
    /// 사용자가 할 일("설정에서 연결하세요")이 같기 때문.
    fn not_configured() -> Self {
        Self {
            kind: "permanent".into(),
            message: "Jira 연결이 설정되지 않았습니다".into(),
            is_auth_failure: true,
            retry_after_secs: None,
        }
    }
}

impl From<JiraError> for JiraCallError {
    fn from(e: JiraError) -> Self {
        Self {
            kind: match e.kind() {
                crate::providers::jira::ErrorKind::Transient => "transient".into(),
                crate::providers::jira::ErrorKind::Permanent => "permanent".into(),
            },
            message: e.to_string(),
            is_auth_failure: e.is_auth_failure(),
            retry_after_secs: e.retry_after_secs(),
        }
    }
}

/// 상세 모달의 코멘트 영역.
#[derive(Debug, Clone, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct JiraCommentsView {
    /// **시간 오름차순(대화 순서)으로 정렬된 최신 20건.**
    ///
    /// Jira에 `orderBy=-created`로 요청해 최신 20건을 받고 여기서 뒤집는다.
    /// 정렬 책임을 프론트에 넘기지 않는다 — 화면이 데이터를 재가공하기 시작하면
    /// "Rust가 데이터의 주인"이라는 경계가 흐려진다.
    pub comments: Vec<JiraComment>,
    pub total: u32,
    /// `total`이 받아온 개수보다 많은가. "이전 N개는 Jira에서" 링크를 띄울지.
    pub has_older: bool,
}

/// 상세 모달이 한 번에 받는 코멘트 수 (D3).
const COMMENT_PAGE_SIZE: u32 = 20;

/// 생성 폼·설정창이 공유하는 프로젝트 목록.
#[derive(Debug, Clone, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct JiraCreateOptions {
    pub projects: Vec<JiraProjectWithTypes>,
    /// ISO 8601. ↻ 버튼 옆의 "3일 전" 표시용.
    pub fetched_at: Option<String>,
    /// 디스크 캐시에서 온 것인가.
    pub from_cache: bool,
}

/// 생성 실패. [`JiraCallError`]에 "티켓이 생겼을 수도 있다"는 축이 더 붙는다.
#[derive(Debug, Clone, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct JiraCreateFailure {
    pub kind: String,
    pub message: String,
    pub is_auth_failure: bool,
    /// 요청이 Jira에 닿았는지 알 수 없다 → 티켓이 만들어졌을 수 있다.
    ///
    /// 프론트는 이때 [생성] 버튼을 잠그고 "Jira에서 확인하세요"를 띄운다.
    /// 생성은 멱등이 아니고 우리에겐 삭제 기능이 없다.
    pub possibly_created: bool,
    /// 400 재조회 결과, 우리가 채울 수 없는 필수 필드.
    pub missing_fields: Vec<CreateMetaField>,
    /// 자동 재시도를 실제로 했는가 (로그·표시용).
    pub retried: bool,
}

impl JiraCreateFailure {
    fn from_error(e: &JiraError, possibly_created: bool, retried: bool) -> Self {
        Self {
            kind: match e.kind() {
                crate::providers::jira::ErrorKind::Transient => "transient".into(),
                crate::providers::jira::ErrorKind::Permanent => "permanent".into(),
            },
            message: e.to_string(),
            is_auth_failure: e.is_auth_failure(),
            possibly_created,
            missing_fields: Vec::new(),
            retried,
        }
    }

    fn precondition(message: impl Into<String>) -> Self {
        Self {
            kind: "permanent".into(),
            message: message.into(),
            is_auth_failure: true,
            possibly_created: false,
            missing_fields: Vec::new(),
            retried: false,
        }
    }
}

/// 자격증명 + 클라이언트를 한 번에. 커맨드 6개가 같은 앞부분을 갖는다.
fn client_for(state: &AppState) -> Result<JiraClient, JiraCallError> {
    let creds = state
        .jira_credentials()
        .map_err(JiraCallError::permanent)?
        .ok_or_else(JiraCallError::not_configured)?;
    Ok(JiraClient::with_http_client(state.http.clone(), creds))
}

/// 티켓 하나의 상세. **캐시하지 않는다** (D2) — 목록이 준 골격 위에 덧그리는 값이라
/// 낡은 것을 보여줄 바에는 잠깐 비어 있는 편이 정직하다.
#[tauri::command]
#[specta::specta]
pub async fn jira_issue(
    state: State<'_, AppState>,
    key: String,
) -> Result<JiraIssueDetail, JiraCallError> {
    let client = client_for(&state)?;
    client.get_issue(&key).await.map_err(|e| {
        tracing::warn!(issue = %key, error = %e, "티켓 상세 조회 실패");
        e.into()
    })
}

/// 코멘트 최신 20건을 대화 순서로 (D3).
#[tauri::command]
#[specta::specta]
pub async fn jira_comments(
    state: State<'_, AppState>,
    key: String,
) -> Result<JiraCommentsView, JiraCallError> {
    let client = client_for(&state)?;
    let page = client
        .get_comments_newest(&key, COMMENT_PAGE_SIZE)
        .await
        .map_err(|e| {
            tracing::warn!(issue = %key, error = %e, "코멘트 조회 실패");
            JiraCallError::from(e)
        })?;

    // `-created`로 받았으므로 최신이 앞에 있다. 대화 순서로 뒤집는다.
    let mut comments = page.comments;
    comments.reverse();

    let has_older = page.total as usize > comments.len();
    Ok(JiraCommentsView {
        comments,
        total: page.total,
        has_older,
    })
}

/// 프로젝트 + 이슈타입. 디스크 캐시가 있으면 네트워크를 건드리지 않는다 (D9).
#[tauri::command]
#[specta::specta]
pub async fn jira_create_options(
    state: State<'_, AppState>,
    force_refresh: bool,
) -> Result<JiraCreateOptions, JiraCallError> {
    // 캐시 우선. 잠금은 짧게 잡고 값만 복사해서 나온다.
    let cached = {
        let meta = state.jira_meta.lock().map_err(|_| {
            JiraCallError::permanent("상태 잠금 실패")
        })?;
        if meta.has_projects() {
            Some((meta.projects().to_vec(), meta.fetched_at()))
        } else {
            None
        }
    };

    if !force_refresh {
        if let Some((projects, fetched_at)) = cached.clone() {
            return Ok(JiraCreateOptions {
                projects,
                fetched_at: fetched_at.map(|t| t.to_rfc3339()),
                from_cache: true,
            });
        }
    }

    let client = client_for(&state)?;
    match client.list_projects_with_issue_types().await {
        Ok(projects) => {
            let fetched_at = chrono::Utc::now();
            if let Ok(mut meta) = state.jira_meta.lock() {
                meta.set_projects(projects.clone(), fetched_at);
                if let Err(e) = meta.save() {
                    // 캐시 저장 실패가 조회 성공을 되돌리지는 않는다.
                    tracing::warn!(error = %e, "Jira 메타 캐시 저장 실패");
                }
            }
            Ok(JiraCreateOptions {
                projects,
                fetched_at: Some(fetched_at.to_rfc3339()),
                from_cache: false,
            })
        }
        Err(e) => {
            // 갱신에 실패해도 캐시가 있으면 그것을 준다. 드롭다운이 비는 것보다 낫다.
            // 사용자에게는 옆의 "N일 전"이 낡았다는 신호가 된다.
            if let Some((projects, fetched_at)) = cached {
                tracing::warn!(error = %e, "프로젝트 목록 갱신 실패 — 캐시를 유지한다");
                return Ok(JiraCreateOptions {
                    projects,
                    fetched_at: fetched_at.map(|t| t.to_rfc3339()),
                    from_cache: true,
                });
            }
            tracing::warn!(error = %e, "프로젝트 목록 조회 실패 (캐시 없음)");
            Err(e.into())
        }
    }
}

/// 생성 폼 스키마. 세션 캐시 히트면 네트워크를 건드리지 않는다 (D10).
#[tauri::command]
#[specta::specta]
pub async fn jira_createmeta(
    state: State<'_, AppState>,
    project_key: String,
    issue_type_id: String,
    force_refresh: bool,
) -> Result<CreateMeta, JiraCallError> {
    let cache_key = JiraSessionCache::meta_key(&project_key, &issue_type_id);

    if !force_refresh {
        if let Ok(session) = state.jira_session.lock() {
            if let Some(meta) = session.createmeta.get(&cache_key) {
                return Ok(meta.clone());
            }
        }
    }

    let client = client_for(&state)?;
    let meta = client
        .get_createmeta(&project_key, &issue_type_id)
        .await
        .map_err(|e| {
            tracing::warn!(project = %project_key, issue_type = %issue_type_id, error = %e, "createmeta 조회 실패");
            JiraCallError::from(e)
        })?;

    if let Ok(mut session) = state.jira_session.lock() {
        session.createmeta.insert(cache_key, meta.clone());
    }
    Ok(meta)
}

/// 내 계정. "나에게 할당" 체크박스가 쓴다. 세션 캐시.
#[tauri::command]
#[specta::specta]
pub async fn jira_myself(state: State<'_, AppState>) -> Result<JiraIdentity, JiraCallError> {
    if let Ok(session) = state.jira_session.lock() {
        if let Some(identity) = &session.identity {
            return Ok(identity.clone());
        }
    }

    let client = client_for(&state)?;
    let identity = client.verify_credentials().await.map_err(|e| {
        tracing::warn!(error = %e, "/myself 조회 실패");
        JiraCallError::from(e)
    })?;

    if let Ok(mut session) = state.jira_session.lock() {
        session.identity = Some(identity.clone());
    }
    Ok(identity)
}

/// 티켓 생성. 우리가 하는 유일한 쓰기 (DECISIONS 11.5).
///
/// 실패 처리는 5.6의 결정 트리를 그대로 따른다. 핵심은 **400 계열만 자동 재시도**한다는 것.
/// 네트워크·타임아웃·5xx는 요청이 닿았는지 알 수 없으므로 재시도하면 티켓이 두 개가 되고,
/// 우리에겐 지우는 기능이 없다.
#[tauri::command]
#[specta::specta]
pub async fn jira_create_issue(
    state: State<'_, AppState>,
    input: CreateIssueInput,
) -> Result<CreatedIssue, JiraCreateFailure> {
    let creds = state
        .jira_credentials()
        .map_err(JiraCreateFailure::precondition)?
        .ok_or_else(|| JiraCreateFailure::precondition("Jira 연결이 설정되지 않았습니다"))?;
    let client = JiraClient::with_http_client(state.http.clone(), creds);

    let first = match client.create_issue(&input).await {
        Ok(created) => {
            tracing::info!(key = %created.key, "티켓 생성됨");
            return Ok(created);
        }
        Err(e) => e,
    };

    match &first {
        // 400 — 스키마가 우리 생각과 다르다. 재조회해서 한 번만 다시 시도한다.
        JiraError::BadRequest { .. } => {
            tracing::warn!(error = %first, "티켓 생성 400 — createmeta 재조회");

            let meta = match client
                .get_createmeta(&input.project_key, &input.issue_type_id)
                .await
            {
                Ok(meta) => {
                    if let Ok(mut session) = state.jira_session.lock() {
                        session.createmeta.insert(
                            JiraSessionCache::meta_key(&input.project_key, &input.issue_type_id),
                            meta.clone(),
                        );
                    }
                    meta
                }
                // 재조회조차 실패하면 원래 400을 그대로 돌려준다.
                Err(meta_err) => {
                    tracing::warn!(error = %meta_err, "createmeta 재조회 실패");
                    return Err(JiraCreateFailure::from_error(&first, false, false));
                }
            };

            let (reconciled, missing) = reconcile_with_meta(&input, &meta);

            // 재조립해도 똑같으면 다시 보내봐야 같은 400이다. 재시도하지 않는다.
            if reconciled == input {
                let mut failure = JiraCreateFailure::from_error(&first, false, false);
                failure.missing_fields = missing;
                return Err(failure);
            }

            match client.create_issue(&reconciled).await {
                Ok(created) => {
                    tracing::info!(key = %created.key, "티켓 생성됨 (재조립 후)");
                    Ok(created)
                }
                Err(second) => {
                    let mut failure = JiraCreateFailure::from_error(
                        &second,
                        // 두 번째 시도가 네트워크로 죽었다면 그건 닿았을 수 있다.
                        is_possibly_created(&second),
                        true,
                    );
                    failure.missing_fields = missing;
                    Err(failure)
                }
            }
        }

        // 요청이 닿았는지 알 수 없다 — 절대 자동 재시도하지 않는다.
        JiraError::RateLimited { .. }
        | JiraError::ServerError { .. }
        | JiraError::Network { .. } => {
            tracing::error!(error = %first, "티켓 생성 실패 — 생성됐을 수 있음");
            Err(JiraCreateFailure::from_error(&first, true, false))
        }

        // 401/403/404/Decode/기타 — 그대로 돌려준다.
        _ => {
            tracing::warn!(error = %first, "티켓 생성 실패");
            Err(JiraCreateFailure::from_error(&first, false, false))
        }
    }
}

/// 응답을 못 받은 부류인가 = 서버에서 만들어졌을 수 있는가.
fn is_possibly_created(e: &JiraError) -> bool {
    matches!(
        e,
        JiraError::RateLimited { .. } | JiraError::ServerError { .. } | JiraError::Network { .. }
    )
}

/// `extra_fields`를 새 createmeta 스키마로 다시 조립한다.
///
/// 반환: `(재조립된 input, 우리가 채울 수 없는 필수 필드)`
///
/// 400을 받았을 때 프로젝트 설정이 바뀐 경우를 흡수하는 것이 목적이다.
/// 순수 함수로 뽑아 둔 이유는 네트워크 없이 테스트하기 위해서다 — 이 로직이
/// 틀리면 중복 티켓이 생기거나 영영 생성이 안 된다.
pub fn reconcile_with_meta(
    input: &CreateIssueInput,
    meta: &CreateMeta,
) -> (CreateIssueInput, Vec<CreateMetaField>) {
    let mut out = input.clone();

    // 새 스키마에 없는 필드는 Jira가 거부한다. 빼고 다시 보낸다.
    out.extra_fields
        .retain(|field_id, _| meta.field(field_id).is_some());

    // 우리가 채울 수 없는 필수 필드. `hasDefaultValue: true`는 서버가 채우므로 제외한다
    // (실측: EDU의 reporter가 여기 해당한다 — 4.2).
    let missing = meta
        .required_user_input()
        .into_iter()
        .filter(|f| !is_covered_by_form(&f.field_id, &out))
        .cloned()
        .collect();

    (out, missing)
}

// ---------------------------------------------------------------------------
// 상태 전이 (DECISIONS 11.5 개정)
// ---------------------------------------------------------------------------

/// 이 티켓에서 지금 실행할 수 있는 전이 목록.
///
/// **캐시하지 않는다.** 전이 가능성은 상태가 바뀌면 즉시 낡는다 —
/// 방금 '완료'로 옮긴 티켓에 '완료로 이동'을 다시 보여주는 것보다
/// 조회 한 번이 싸다. 프론트가 30초 TTL 메모리 캐시를 갖는 것은
/// 팝오버를 연달아 여닫을 때의 중복 호출만 막기 위해서고, 그 이상은 아니다.
///
/// **빈 Vec은 에러가 아니다.** 권한이 없거나 워크플로우 끝단이면 Jira가
/// 200 + 빈 배열을 준다. 화면이 "가능한 전이가 없습니다"를 말한다.
#[tauri::command]
#[specta::specta]
pub async fn jira_transitions(
    state: State<'_, AppState>,
    issue_key: String,
) -> Result<Vec<JiraTransition>, JiraCallError> {
    let client = client_for(&state)?;
    let transitions = client.get_transitions(&issue_key).await.map_err(|e| {
        tracing::warn!(issue = %issue_key, error = %e, "전이 목록 조회 실패");
        JiraCallError::from(e)
    })?;

    tracing::debug!(
        issue = %issue_key,
        count = transitions.len(),
        // 필수 필드가 걸린 전이가 몇 개인지 남긴다. 나중에 "왜 브라우저로
        // 나가지?"를 물었을 때 이 숫자가 답이다.
        with_required = transitions.iter().filter(|t| t.has_required_fields).count(),
        "전이 목록 조회됨"
    );
    Ok(transitions)
}

/// 상태 전이 실행. 티켓 생성과 함께 우리가 하는 두 번째 쓰기다.
///
/// **자동 재시도가 없다.** 전이는 멱등이 아니어서 같은 요청이 두 번 나가면
/// 워크플로우를 두 칸 움직일 수 있고, 우리에겐 되돌리는 기능이 없다.
/// 생성(`jira_create_issue`)이 400만 재시도하는 것과 같은 이유이며,
/// 여기서는 그 400조차 재시도하지 않는다 — 400이면 필수 필드가 걸렸다는 뜻이고
/// 그건 폼 없이는 못 채운다. 재시도 판단은 사람이 팝오버에서 한다.
///
/// 성공 후 목록 갱신은 프론트가 한다. **낙관적 업데이트를 하지 않는다** —
/// `to_status_name`은 알지만 워크플로우 후처리(자동 담당자 변경 등)는
/// 예측할 수 없어서, 우리가 그린 값이 서버와 다를 수 있다.
#[tauri::command]
#[specta::specta]
pub async fn jira_transition(
    state: State<'_, AppState>,
    issue_key: String,
    transition_id: String,
) -> Result<(), JiraCallError> {
    let client = client_for(&state)?;
    client
        .transition_issue(&issue_key, &transition_id)
        .await
        .map_err(|e| {
            tracing::warn!(
                issue = %issue_key,
                transition = %transition_id,
                error = %e,
                "상태 전이 실패"
            );
            JiraCallError::from(e)
        })?;

    tracing::info!(issue = %issue_key, transition = %transition_id, "상태 전이됨");
    Ok(())
}

/// 폼이 이미 보내는 필드인가.
fn is_covered_by_form(field_id: &str, input: &CreateIssueInput) -> bool {
    match field_id {
        "project" | "issuetype" | "summary" => true,
        "description" => input.description.is_some(),
        other => input.extra_fields.contains_key(other),
    }
}

// ---------------------------------------------------------------------------

fn cached_data(cache: &crate::storage::cache::CacheStore, widget_id: &str) -> Option<JiraWidgetData> {
    let entry = cache.get(widget_id).ok().flatten()?;
    let issues: Vec<JiraIssue> = serde_json::from_value(entry.payload).ok()?;
    Some(JiraWidgetData {
        issues,
        fetched_at: entry.fetched_at.to_rfc3339(),
        from_cache: true,
    })
}

fn permanent_error(message: &str, stale: Option<JiraWidgetData>) -> JiraWidgetError {
    JiraWidgetError {
        kind: "permanent".into(),
        message: message.to_owned(),
        is_auth_failure: false,
        retry_after_secs: None,
        stale,
    }
}

fn to_widget_error(state: &AppState, widget_id: &str, e: JiraError) -> JiraWidgetError {
    let stale = state
        .cache
        .lock()
        .ok()
        .and_then(|c| cached_data(&c, widget_id));

    JiraWidgetError {
        kind: match e.kind() {
            crate::providers::jira::ErrorKind::Transient => "transient".into(),
            crate::providers::jira::ErrorKind::Permanent => "permanent".into(),
        },
        message: e.to_string(),
        is_auth_failure: e.is_auth_failure(),
        retry_after_secs: e.retry_after_secs(),
        stale,
    }
}

/// 프로젝트 범위를 JQL 앞에 붙인다.
///
/// `ORDER BY` 앞에 끼워 넣어야 한다 — 뒤에 붙이면 문법 오류다.
/// 원본 조건은 괄호로 감싼다. `A OR B`에 `project = X AND`를 그냥 이으면
/// 연산자 우선순위 때문에 전혀 다른 쿼리가 된다.
fn scope_to_projects(jql: &str, projects: &[String]) -> String {
    if projects.is_empty() {
        return jql.to_owned();
    }

    // 프로젝트 키는 Jira 규칙상 영숫자와 밑줄뿐이다. 그 외 문자가 섞인 값은
    // 우리 UI가 만든 것이 아니므로(손으로 고친 board.json 등) 버린다.
    // 따옴표 이스케이프로 막는 것보다 화이트리스트가 확실하다.
    let keys = projects
        .iter()
        .filter(|k| !k.is_empty() && k.chars().all(|c| c.is_ascii_alphanumeric() || c == '_'))
        .map(|k| format!("\"{k}\""))
        .collect::<Vec<_>>();

    if keys.is_empty() {
        return jql.to_owned();
    }
    let scope = format!("project IN ({})", keys.join(", "));

    // ORDER BY는 대소문자를 가리지 않는다.
    let split = jql
        .to_uppercase()
        .find(" ORDER BY ")
        .map(|i| jql.split_at(i));

    match split {
        Some((conditions, order)) => {
            let c = conditions.trim();
            if c.is_empty() {
                format!("{scope}{order}")
            } else {
                format!("{scope} AND ({c}){order}")
            }
        }
        None => {
            let c = jql.trim();
            if c.is_empty() {
                scope
            } else {
                format!("{scope} AND ({c})")
            }
        }
    }
}

#[cfg(test)]
mod reconcile_tests {
    use super::reconcile_with_meta;
    use crate::providers::jira::{CreateIssueInput, CreateMeta, CreateMetaField};

    fn field(id: &str, required: bool, has_default: bool) -> CreateMetaField {
        CreateMetaField {
            field_id: id.into(),
            name: id.into(),
            required,
            has_default_value: has_default,
            schema_type: None,
            allowed_values: Vec::new(),
        }
    }

    /// 항상 있는 세 필드. 폼이 직접 보내므로 missing에 들어가면 안 된다.
    fn base_fields() -> Vec<CreateMetaField> {
        vec![
            field("project", true, false),
            field("issuetype", true, false),
            field("summary", true, false),
        ]
    }

    fn input() -> CreateIssueInput {
        CreateIssueInput {
            project_key: "ABC".into(),
            issue_type_id: "10082".into(),
            summary: "요약".into(),
            description: None,
            extra_fields: Default::default(),
        }
    }

    #[test]
    fn drops_extra_fields_the_new_schema_no_longer_has() {
        let mut i = input();
        i.extra_fields
            .insert("customfield_9999".into(), serde_json::json!("사라진 필드"));
        let meta = CreateMeta {
            fields: base_fields(),
        };

        let (out, _) = reconcile_with_meta(&i, &meta);
        assert!(
            out.extra_fields.is_empty(),
            "스키마에 없는 필드는 제거돼야 한다: {:?}",
            out.extra_fields
        );
    }

    #[test]
    fn keeps_extra_fields_the_schema_still_has() {
        let mut i = input();
        i.extra_fields
            .insert("assignee".into(), serde_json::json!({"id": "acc-1"}));
        let mut fields = base_fields();
        fields.push(field("assignee", false, false));
        let meta = CreateMeta { fields };

        let (out, _) = reconcile_with_meta(&i, &meta);
        assert!(out.extra_fields.contains_key("assignee"));
    }

    #[test]
    fn required_without_default_and_without_value_is_missing() {
        let mut fields = base_fields();
        fields.push(field("customfield_impact", true, false));
        let meta = CreateMeta { fields };

        let (_, missing) = reconcile_with_meta(&input(), &meta);
        assert_eq!(missing.len(), 1);
        assert_eq!(missing[0].field_id, "customfield_impact");
    }

    /// 4.2의 reporter 케이스. required지만 서버가 채우므로 폼이 몰라도 된다.
    #[test]
    fn required_with_default_is_not_missing() {
        let mut fields = base_fields();
        fields.push(field("reporter", true, true));
        let meta = CreateMeta { fields };

        let (_, missing) = reconcile_with_meta(&input(), &meta);
        assert!(
            missing.is_empty(),
            "hasDefaultValue: true는 서버가 채운다: {missing:?}"
        );
    }

    #[test]
    fn required_field_we_do_send_is_not_missing() {
        let mut i = input();
        i.extra_fields
            .insert("reporter".into(), serde_json::json!({"id": "acc-1"}));
        let mut fields = base_fields();
        fields.push(field("reporter", true, false));
        let meta = CreateMeta { fields };

        let (_, missing) = reconcile_with_meta(&i, &meta);
        assert!(missing.is_empty(), "이미 보내는 필드다: {missing:?}");
    }

    /// **재시도 조건.** 바뀐 게 없으면 다시 보내봐야 같은 400이므로
    /// 커맨드가 재시도하지 않는다. 이 동등성이 그 판단의 근거다.
    #[test]
    fn unchanged_input_comes_back_equal() {
        let meta = CreateMeta {
            fields: base_fields(),
        };
        let i = input();
        let (out, _) = reconcile_with_meta(&i, &meta);
        assert_eq!(out, i, "바뀐 게 없으면 원본과 같아야 한다");
    }

    /// 폼이 보내는 세 필드는 스키마가 required로 표시해도 missing이 아니다.
    #[test]
    fn form_owned_fields_are_never_missing() {
        let meta = CreateMeta {
            fields: base_fields(),
        };
        let (_, missing) = reconcile_with_meta(&input(), &meta);
        assert!(missing.is_empty(), "{missing:?}");
    }
}

/// 전이 실패가 팝오버에 도달하는 모양을 고정한다 (DECISIONS 11.5 개정 · 16장).
///
/// 팝오버는 `kind`만 보고 [다시 시도]를 그릴지 고른다. 그래서 분류가 틀리면
/// 404(전이 id가 사라짐)에 대고 재시도 버튼을 주거나, 429에 대고 안 주게 된다.
#[cfg(test)]
mod transition_error_tests {
    use super::JiraCallError;
    use crate::providers::jira::JiraError;

    #[test]
    fn not_found_is_permanent_and_not_auth_failure() {
        // 티켓이 없거나, 조회 후 워크플로우가 바뀌어 전이 id가 사라진 경우.
        let e: JiraCallError =
            JiraError::from_response(404, r#"{"errorMessages":["Issue does not exist"]}"#, None)
                .into();
        assert_eq!(e.kind, "permanent");
        assert!(!e.is_auth_failure, "404에 로그인 배너를 띄우면 틀린 안내다");
    }

    #[test]
    fn forbidden_is_permanent_and_not_auth_failure() {
        // 전이 권한이 없는 경우. 전역 "로그인하세요" 배너를 띄우면 안 된다 —
        // 토큰은 멀쩡하고 이 티켓만 못 옮긴다.
        let e: JiraCallError =
            JiraError::from_response(403, r#"{"errorMessages":["권한이 없습니다."]}"#, None).into();
        assert_eq!(e.kind, "permanent");
        assert!(!e.is_auth_failure);
    }

    #[test]
    fn unauthorized_still_raises_the_global_banner() {
        let e: JiraCallError = JiraError::from_response(401, "", None).into();
        assert_eq!(e.kind, "permanent");
        assert!(e.is_auth_failure, "401은 전역 배너 1회 규칙의 트리거다");
    }

    /// 400은 대개 "필수 필드가 걸렸다"다. 영구로 분류돼 재시도 버튼이 안 나온다 —
    /// 같은 요청을 다시 보내도 같은 400이고, 채울 폼이 없다.
    #[test]
    fn bad_request_is_permanent_and_keeps_jira_wording() {
        let e: JiraCallError = JiraError::from_response(
            400,
            r#"{"errors":{"resolution":"해결책을 지정해야 합니다."}}"#,
            None,
        )
        .into();
        assert_eq!(e.kind, "permanent");
        assert!(
            e.message.contains("해결책을 지정해야 합니다."),
            "Jira 원문을 그대로 보여준다: {}",
            e.message
        );
    }

    /// 429/5xx는 일시적이다 — 팝오버가 [다시 시도]를 그린다.
    /// 자동 재시도는 하지 않는다(전이는 멱등이 아니다). 사람이 누른다.
    #[test]
    fn rate_limit_and_server_error_are_transient() {
        let e: JiraCallError = JiraError::from_response(429, "", Some(30)).into();
        assert_eq!(e.kind, "transient");
        assert_eq!(e.retry_after_secs, Some(30));

        let e: JiraCallError = JiraError::from_response(503, "", None).into();
        assert_eq!(e.kind, "transient");
    }
}

#[cfg(test)]
mod scope_tests {
    use super::scope_to_projects;

    #[test]
    fn empty_projects_leaves_jql_untouched() {
        let jql = "assignee = currentUser() ORDER BY updated DESC";
        assert_eq!(scope_to_projects(jql, &[]), jql);
    }

    #[test]
    fn scope_goes_before_order_by_not_after() {
        // ORDER BY 뒤에 조건을 붙이면 Jira가 400을 낸다.
        let out = scope_to_projects(
            "assignee = currentUser() ORDER BY updated DESC",
            &["ABC".into()],
        );
        assert_eq!(
            out,
            "project IN (\"ABC\") AND (assignee = currentUser()) ORDER BY updated DESC"
        );
    }

    #[test]
    fn original_conditions_are_parenthesised() {
        // 괄호가 없으면 `X AND A OR B`가 되어 B가 프로젝트 밖으로 새어나간다.
        let out = scope_to_projects("a = 1 OR b = 2", &["XYZ".into()]);
        assert_eq!(out, "project IN (\"XYZ\") AND (a = 1 OR b = 2)");
    }

    #[test]
    fn multiple_projects_are_comma_separated() {
        let out = scope_to_projects("x = 1", &["ABC".into(), "XYZ".into()]);
        assert_eq!(out, "project IN (\"ABC\", \"XYZ\") AND (x = 1)");
    }

    #[test]
    fn handles_lowercase_order_by() {
        let out = scope_to_projects("x = 1 order by created", &["ABC".into()]);
        assert!(out.starts_with("project IN (\"ABC\") AND (x = 1)"));
        assert!(out.ends_with(" order by created"));
    }

    #[test]
    fn malformed_project_keys_are_dropped_entirely() {
        // 손으로 고친 board.json에서 올 수 있는 값. 이스케이프가 아니라 거부한다.
        let out = scope_to_projects("x = 1", &["A\" OR y = 2 OR \"".into()]);
        assert_eq!(out, "x = 1", "잘못된 키는 무시돼야 한다: {out}");
    }

    #[test]
    fn valid_keys_survive_alongside_invalid_ones() {
        let out = scope_to_projects("x = 1", &["ABC".into(), "bad key!".into()]);
        assert_eq!(out, "project IN (\"ABC\") AND (x = 1)");
    }
}
