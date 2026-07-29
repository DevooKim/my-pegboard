//! Jira IPC 커맨드.
//!
//! 토큰은 이 경계를 넘어가지 않는다. 프론트는 위젯 id와 설정만 넘기고,
//! 자격증명 조립은 전부 여기서 한다.

use serde::{Deserialize, Serialize};
use tauri::State;

use crate::providers::jira::{
    apply_sort, JiraClient, JiraError, JiraIssue, JiraProject, JiraQuery, Preset, SortDirection,
    SortField, LIST_FIELDS,
};
use crate::secrets::{Secret, SecretKey};
use crate::state::AppState;

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
