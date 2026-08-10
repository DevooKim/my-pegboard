//! Linear IPC 커맨드.
//!
//! API 키는 이 경계를 넘어가지 않는다. 프론트는 위젯 id와 설정만 넘기고,
//! 자격증명 조립은 전부 여기서 한다 (Jira·GitHub 커맨드와 같은 규칙).

use serde::{Deserialize, Serialize};
use tauri::State;

use crate::providers::linear::{
    LinearClient, LinearCredentials, LinearError, LinearIssue, LinearIssueDetail, LinearPreset,
    LinearQuery, LinearSort, LinearTeam, LinearWorkflowState, PRESETS,
};
use crate::secrets::{Secret, SecretKey};
use crate::state::AppState;

/// 위젯 데이터 봉투. 프론트의 `WidgetEnvelope<T>`와 짝을 이룬다.
#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct LinearWidgetData {
    pub issues: Vec<LinearIssue>,
    /// 다음 페이지가 있는가. **총 건수는 없다** — Linear 커넥션이 `totalCount`를
    /// 주지 않으므로 GitHub처럼 "217건 중 30건"을 만들 수 없다.
    /// 그래서 "N건까지 표시" 쪽으로만 알린다(Jira와 같은 처지).
    #[serde(default)]
    pub has_more: bool,
    pub fetched_at: String,
    /// 디스크 캐시에서 왔는가. true면 갱신이 실패했거나 아직 안 끝났다.
    pub from_cache: bool,
}

#[derive(Debug, Clone, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct LinearWidgetError {
    /// `transient` | `permanent` — 프론트가 재시도 UI를 고르는 축.
    pub kind: String,
    pub message: String,
    /// 401 여부. 전역 배너를 한 번만 띄우기 위한 신호 (DECISIONS 16장).
    pub is_auth_failure: bool,
    pub retry_after_secs: Option<u64>,
    /// 실패했지만 직전 성공 데이터가 있으면 함께 준다. 목록을 비우지 않기 위해.
    pub stale: Option<LinearWidgetData>,
}

/// 모달·팝오버에서 쓰는 단발 호출 실패.
///
/// [`LinearWidgetError`]와 나눠 둔 이유는 Jira의 `JiraCallError`와 같다 —
/// 저쪽은 위젯 봉투라 `stale`을 들고 다니는데, 팝오버는 캐시하지 않으므로
/// 그 필드가 늘 `None`이 되고 프론트가 "있을 수도 있는 값"을 매번 확인하게 된다.
#[derive(Debug, Clone, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct LinearCallError {
    pub kind: String,
    /// Linear 원문 그대로. 우리가 고쳐 쓰지 않는다.
    pub message: String,
    pub is_auth_failure: bool,
    pub retry_after_secs: Option<u64>,
}

impl From<LinearError> for LinearCallError {
    fn from(e: LinearError) -> Self {
        Self {
            kind: match e.kind() {
                crate::providers::linear::ErrorKind::Transient => "transient".into(),
                crate::providers::linear::ErrorKind::Permanent => "permanent".into(),
            },
            message: e.to_string(),
            is_auth_failure: e.is_auth_failure(),
            retry_after_secs: e.retry_after_secs(),
        }
    }
}

impl LinearCallError {
    /// 연결이 아예 설정되지 않은 경우. 401과 같은 배너를 띄우게 한다 —
    /// 사용자가 할 일("설정에서 연결하세요")이 같기 때문.
    fn not_configured() -> Self {
        Self {
            kind: "permanent".into(),
            message: "Linear 연결이 설정되지 않았습니다".into(),
            is_auth_failure: true,
            retry_after_secs: None,
        }
    }
}

#[derive(Debug, Clone, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct LinearWidgetConfig {
    /// 사용자가 붙인 위젯 이름. 비어 있으면 프리셋 이름을 쓴다.
    #[serde(default)]
    pub title: Option<String>,
    pub query: LinearQuery,
    pub max_results: u32,
    /// 팀 범위. 빈 목록이면 전체.
    ///
    /// 쿼리와 분리하는 이유는 Jira의 `projects`·GitHub의 `repos`와 같다 —
    /// 프리셋마다 팀별 변종을 만드는 것은 조합 폭발이다.
    #[serde(default)]
    pub teams: Vec<String>,
    /// **정렬은 두 종뿐이다.** `PaginationOrderBy`가 그것만 준다 (DECISIONS 25.3).
    #[serde(default)]
    pub sort: LinearSort,
    /// 팀별로 묶어서 보여줄까. 기본 켬.
    #[serde(default = "default_true")]
    pub group_by_team: bool,
    #[serde(default = "default_refresh_secs")]
    pub refresh_secs: u32,
}

const fn default_true() -> bool {
    true
}

const fn default_refresh_secs() -> u32 {
    300
}

/// 프리셋 목록. 설정 폼이 드롭다운을 채운다.
#[tauri::command]
#[specta::specta]
pub fn linear_presets() -> Vec<LinearPreset> {
    PRESETS.to_vec()
}

/// API 키가 저장돼 있는가. 설정 안내를 띄울지 고르는 데 쓴다.
#[tauri::command]
#[specta::specta]
pub fn linear_is_configured(state: State<'_, AppState>) -> Result<bool, String> {
    state
        .secrets
        .has(&SecretKey::linear_token())
        .map_err(|e| format!("키체인을 읽을 수 없습니다: {e}"))
}

/// API 키 저장. **평문 파일에 쓰지 않는다** (CLAUDE.md).
#[tauri::command]
#[specta::specta]
pub fn linear_save_token(state: State<'_, AppState>, token: String) -> Result<(), String> {
    let token = token.trim();
    if token.is_empty() {
        return Err("API 키가 비어 있습니다".into());
    }
    state
        .secrets
        .set(&SecretKey::linear_token(), &Secret::new(token))
        .map_err(|e| format!("키체인에 저장할 수 없습니다: {e}"))
}

#[tauri::command]
#[specta::specta]
pub fn linear_delete_token(state: State<'_, AppState>) -> Result<(), String> {
    state
        .secrets
        .delete(&SecretKey::linear_token())
        .map_err(|e| format!("키체인에서 지울 수 없습니다: {e}"))
}

/// 키가 실제로 동작하는지 확인. 설정창의 [확인] 버튼.
///
/// `viewer { id name }` 한 방이다 — 이슈를 조회하지 않는다. 확인의 목적은
/// "키가 유효한가"이고, 이슈가 0건인 것은 실패가 아니다.
#[tauri::command]
#[specta::specta]
pub async fn linear_verify(state: State<'_, AppState>) -> Result<String, String> {
    let client = client_from_state(&state)?;
    client
        .viewer()
        .await
        .map(|v| format!("연결됐습니다 — {}", v.name))
        .map_err(|e| e.to_string())
}

/// 위젯 데이터를 네트워크에서 가져온다.
#[tauri::command]
#[specta::specta]
pub async fn linear_fetch(
    state: State<'_, AppState>,
    widget_id: String,
    config: LinearWidgetConfig,
) -> Result<LinearWidgetData, LinearWidgetError> {
    let client = client_from_state(&state).map_err(|e| LinearWidgetError {
        kind: "permanent".into(),
        message: e,
        is_auth_failure: true,
        retry_after_secs: None,
        stale: None,
    })?;

    // 프리셋 id를 못 풀면 **빈 필터를 보내지 않는다.** 빈 필터는 조직 전체
    // 이슈를 긁어오는 조용한 오작동이 된다.
    let (Some(filter), Some(scope)) = (config.query.to_filter(), config.query.scope()) else {
        return Err(permanent_error(
            "알 수 없는 프리셋입니다. 위젯 설정에서 쿼리를 다시 선택하세요.",
            None,
        ));
    };

    match client
        .issues(
            scope,
            &filter,
            &config.teams,
            config.sort,
            config.max_results,
        )
        .await
    {
        Ok(page) => {
            let fetched_at = chrono::Utc::now();
            let data = LinearWidgetData {
                issues: page.issues,
                has_more: page.next_cursor.is_some(),
                fetched_at: fetched_at.to_rfc3339(),
                from_cache: false,
            };
            if let Ok(cache) = state.cache.lock() {
                if let Ok(value) = serde_json::to_value(&data) {
                    let _ = cache.put(&widget_id, value, fetched_at);
                }
            }
            Ok(data)
        }
        Err(e) => {
            tracing::warn!(widget_id = %widget_id, error = %e, "Linear 조회 실패");
            Err(to_widget_error(&state, &widget_id, e))
        }
    }
}

/// 디스크 캐시만 읽는다. 네트워크를 건드리지 않으므로 즉시 반환된다.
///
/// **앱 시작 시 이것을 먼저 부른다.** 0ms에 실제 데이터를 그리는 것이
/// 이 앱의 존재 이유다 (DECISIONS 17장).
#[tauri::command]
#[specta::specta]
pub fn linear_cached(
    state: State<'_, AppState>,
    widget_id: String,
) -> Result<Option<LinearWidgetData>, String> {
    let cache = state.cache.lock().map_err(|_| "상태 잠금 실패")?;
    Ok(cached_data(&cache, &widget_id))
}

/// 팀 목록. 설정 폼의 범위 UI를 채운다.
///
/// 캐시가 있으면 캐시를 준다. `refresh: true`면 네트워크에서 다시 받는다.
#[tauri::command]
#[specta::specta]
pub async fn linear_teams(
    state: State<'_, AppState>,
    refresh: bool,
) -> Result<LinearTeamList, String> {
    if !refresh {
        let meta = state.linear_meta.lock().map_err(|_| "상태 잠금 실패")?;
        if meta.has_teams() {
            return Ok(LinearTeamList {
                teams: meta.teams().to_vec(),
                fetched_at: meta.fetched_at().map(|t| t.to_rfc3339()),
            });
        }
    }

    let client = client_from_state(&state)?;
    let teams = client.teams().await.map_err(|e| e.to_string())?;
    let fetched_at = chrono::Utc::now();

    let mut meta = state.linear_meta.lock().map_err(|_| "상태 잠금 실패")?;
    meta.set_teams(teams, fetched_at);
    meta.save()
        .map_err(|e| format!("팀 목록을 저장할 수 없습니다: {e}"))?;

    Ok(LinearTeamList {
        teams: meta.teams().to_vec(),
        fetched_at: Some(fetched_at.to_rfc3339()),
    })
}

#[derive(Debug, Clone, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct LinearTeamList {
    pub teams: Vec<LinearTeam>,
    pub fetched_at: Option<String>,
}

/// 이슈 본문(markdown). 상세 모달이 골격을 그린 뒤에 채운다.
///
/// **목록 쿼리에 본문을 넣지 않은 이유:** 30건의 본문을 다 받으면 페이로드가
/// 몇 배가 되고 그중 읽는 것은 열어본 하나다 (CLAUDE.md: 필요한 필드만 남긴다).
///
/// **디스크에 캐시하지 않는다** — 낡은 본문보다 잠깐 비는 편이 정직하다
/// (Jira 상세와 같은 판단, DECISIONS 11.4 D2).
#[tauri::command]
#[specta::specta]
pub async fn linear_issue(
    state: State<'_, AppState>,
    issue_id: String,
) -> Result<LinearIssueDetail, LinearCallError> {
    let client = client_for_call(&state)?;
    client.issue_detail(&issue_id).await.map_err(|e| {
        tracing::warn!(issue = %issue_id, error = %e, "이슈 상세 조회 실패");
        LinearCallError::from(e)
    })
}

/// 한 팀의 워크플로우 상태 목록. 상태 변경 팝오버를 채운다.
///
/// # Jira와 모델이 다르다 (DECISIONS 25.5)
///
/// Jira는 `/issue/{key}/transitions`로 **그 티켓에서 지금 갈 수 있는 곳**을
/// 받는다. Linear는 팀의 상태 목록을 받아 그중 하나를 지정한다 — 전이 개념이
/// 없고, 그래서 **필수 필드 문제도 없다**(`stateId`만 보내면 된다).
///
/// **이슈 단위가 아니라 팀 단위 조회**라서 목록 30건이 같은 팀이면 요청 한 번이다.
/// 프론트가 팀 id로 30초 메모리 캐시를 나눈다.
#[tauri::command]
#[specta::specta]
pub async fn linear_team_states(
    state: State<'_, AppState>,
    team_id: String,
) -> Result<Vec<LinearWorkflowState>, LinearCallError> {
    let client = client_for_call(&state)?;
    client.team_states(&team_id).await.map_err(|e| {
        tracing::warn!(team = %team_id, error = %e, "상태 목록 조회 실패");
        LinearCallError::from(e)
    })
}

/// 이슈 상태 변경. **우리가 Linear에 하는 유일한 쓰기다.**
///
/// **자동 재시도가 없다.** `issueUpdate`는 멱등이 아니다 — 같은 요청이 두 번
/// 나가는 것 자체는 상태를 한 번만 바꾸지만(목표 상태를 지정하므로), 응답을
/// 못 받은 상황에서 다시 보내면 그 사이 사람이 바꾼 값을 덮을 수 있다.
/// Jira 전이와 같은 판단이고, 재시도는 사람이 팝오버에서 한다.
///
/// 성공 후 목록 갱신은 프론트가 한다. **낙관적 업데이트를 하지 않는다** —
/// Linear의 자동화(상태가 바뀌면 담당자를 붙이는 등)를 예측할 수 없다.
#[tauri::command]
#[specta::specta]
pub async fn linear_set_state(
    state: State<'_, AppState>,
    issue_id: String,
    state_id: String,
) -> Result<(), LinearCallError> {
    let client = client_for_call(&state)?;
    client
        .update_issue_state(&issue_id, &state_id)
        .await
        .map_err(|e| {
            tracing::warn!(
                issue = %issue_id,
                state = %state_id,
                error = %e,
                "상태 변경 실패"
            );
            LinearCallError::from(e)
        })?;

    tracing::info!(issue = %issue_id, state = %state_id, "상태 변경됨");
    Ok(())
}

// ---------------------------------------------------------------------------
// 내부 헬퍼
// ---------------------------------------------------------------------------

fn client_from_state(state: &AppState) -> Result<LinearClient, String> {
    let token = state
        .secrets
        .get(&SecretKey::linear_token())
        .map_err(|e| format!("키체인을 읽을 수 없습니다: {e}"))?
        .ok_or("Linear API 키가 설정되지 않았습니다")?;

    Ok(LinearClient::with_http_client(
        state.http.clone(),
        LinearCredentials::new(token.expose()),
    ))
}

fn client_for_call(state: &AppState) -> Result<LinearClient, LinearCallError> {
    client_from_state(state).map_err(|_| LinearCallError::not_configured())
}

fn cached_data(
    cache: &crate::storage::cache::CacheStore,
    widget_id: &str,
) -> Option<LinearWidgetData> {
    let entry = cache.get(widget_id).ok().flatten()?;
    let mut data: LinearWidgetData = serde_json::from_value(entry.payload).ok()?;
    data.fetched_at = entry.fetched_at.to_rfc3339();
    data.from_cache = true;
    Some(data)
}

fn permanent_error(message: &str, stale: Option<LinearWidgetData>) -> LinearWidgetError {
    LinearWidgetError {
        kind: "permanent".into(),
        message: message.to_owned(),
        is_auth_failure: false,
        retry_after_secs: None,
        stale,
    }
}

fn to_widget_error(state: &AppState, widget_id: &str, e: LinearError) -> LinearWidgetError {
    let stale = state
        .cache
        .lock()
        .ok()
        .and_then(|c| cached_data(&c, widget_id));

    LinearWidgetError {
        kind: match e.kind() {
            crate::providers::linear::ErrorKind::Transient => "transient".into(),
            crate::providers::linear::ErrorKind::Permanent => "permanent".into(),
        },
        message: e.to_string(),
        is_auth_failure: e.is_auth_failure(),
        retry_after_secs: e.retry_after_secs(),
        stale,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn data(count: usize) -> LinearWidgetData {
        LinearWidgetData {
            issues: Vec::with_capacity(count),
            has_more: true,
            fetched_at: chrono::Utc::now().to_rfc3339(),
            from_cache: false,
        }
    }

    /// 캐시에서 읽은 데이터는 **반드시** `from_cache: true`여야 한다.
    /// 아니면 "N분 전 데이터" 표시가 안 뜨고 사용자가 낡은 걸 최신으로 믿는다.
    #[test]
    fn cached_data_is_marked_as_cached() {
        let dir = tempfile::TempDir::new().unwrap();
        let cache = crate::storage::cache::CacheStore::new(dir.path());
        let at = chrono::Utc::now();

        let fresh = data(0);
        cache
            .put("w1", serde_json::to_value(&fresh).unwrap(), at)
            .unwrap();

        let got = cached_data(&cache, "w1").expect("캐시를 못 읽었다");
        assert!(got.from_cache, "캐시에서 왔는데 from_cache가 false다");
        assert!(got.has_more, "has_more가 캐시를 왕복하며 사라졌다");
    }

    /// **rate limit이 프론트에 `transient`로 나가야 한다.**
    ///
    /// Linear는 rate limit을 HTTP 400으로 보내고, 이 앱은 400을 영구로 분류한다.
    /// provider가 갈라낸 것이 커맨드 경계에서 다시 뭉개지면 아무 소용이 없다 —
    /// 프론트는 `kind` 문자열만 보고 재시도 UI를 고른다.
    #[test]
    fn rate_limited_reaches_the_frontend_as_transient() {
        let e = LinearError::RateLimited {
            message: "Rate limit exceeded".into(),
            retry_after_secs: Some(42),
        };
        let call: LinearCallError = e.into();

        assert_eq!(call.kind, "transient");
        assert_eq!(call.retry_after_secs, Some(42));
        assert!(!call.is_auth_failure);
    }

    /// 401은 전역 배너 신호를 켠다 (DECISIONS 16장).
    #[test]
    fn unauthorized_flags_auth_failure() {
        let call: LinearCallError = LinearError::Unauthorized {
            message: "Authentication required".into(),
        }
        .into();

        assert_eq!(call.kind, "permanent");
        assert!(call.is_auth_failure, "401인데 배너 신호가 안 켜졌다");
    }

    /// 연결이 없을 때도 401과 같은 안내로 모은다 — 사용자가 할 일이 같다.
    #[test]
    fn missing_connection_looks_like_an_auth_failure() {
        let e = LinearCallError::not_configured();
        assert!(e.is_auth_failure);
        assert_eq!(e.kind, "permanent");
    }

    /// 정렬 기본값은 `updatedAt`이다. config에 없을 때(구 위젯) 조용히
    /// `createdAt`으로 떨어지면 목록 순서가 바뀐 이유를 알 수 없다.
    #[test]
    fn config_defaults_sort_to_updated_at() {
        let config: LinearWidgetConfig = serde_json::from_value(serde_json::json!({
            "query": { "kind": "preset", "id": "assigned-to-me" },
            "maxResults": 30
        }))
        .expect("기본값만으로 config가 파싱돼야 한다");

        assert_eq!(config.sort, LinearSort::UpdatedAt);
        assert!(config.group_by_team, "그룹핑 기본값은 켬이다");
        assert_eq!(config.refresh_secs, 300);
        assert!(config.teams.is_empty());
    }
}
