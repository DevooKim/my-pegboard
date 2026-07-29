//! Jira IPC 커맨드.
//!
//! 토큰은 이 경계를 넘어가지 않는다. 프론트는 위젯 id와 설정만 넘기고,
//! 자격증명 조립은 전부 여기서 한다.

use serde::{Deserialize, Serialize};
use tauri::State;

use crate::providers::jira::{JiraClient, JiraError, JiraIssue, JiraQuery, Preset, LIST_FIELDS};
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
    pub query: JiraQuery,
    /// DECISIONS 11.2 — 기본 30건.
    pub max_results: u32,
}

impl Default for JiraWidgetConfig {
    fn default() -> Self {
        Self {
            query: crate::providers::jira::default_query(),
            max_results: 30,
        }
    }
}

/// 프리셋 목록. 설정 폼의 드롭다운을 채운다.
#[tauri::command]
#[specta::specta]
pub fn jira_presets() -> Vec<Preset> {
    Preset::all().to_vec()
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
