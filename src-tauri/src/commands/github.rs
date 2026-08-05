//! GitHub IPC 커맨드.
//!
//! 토큰은 이 경계를 넘어가지 않는다. 프론트는 위젯 id와 설정만 넘기고,
//! 자격증명 조립은 전부 여기서 한다 (Jira 커맨드와 같은 규칙).

use serde::{Deserialize, Serialize};
use tauri::State;

use crate::providers::github::{
    apply_scope, GithubClient, GithubCredentials, GithubError, GithubItem, GithubQuery,
    GithubPreset, GithubRepo, PRESETS,
};
use crate::secrets::{Secret, SecretKey};
use crate::state::AppState;

/// 위젯 데이터 봉투. 프론트의 `WidgetEnvelope<T>`와 짝을 이룬다.
#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct GithubWidgetData {
    pub items: Vec<GithubItem>,
    /// 전체 건수. GitHub은 Jira와 달리 총계를 준다 — "217건 중 30건"이 가능하다.
    pub total: i64,
    pub fetched_at: String,
    /// 디스크 캐시에서 왔는가. true면 갱신이 실패했거나 아직 안 끝났다.
    pub from_cache: bool,
}

#[derive(Debug, Clone, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct GithubWidgetError {
    /// `transient` | `permanent` — 프론트가 재시도 UI를 고르는 축.
    pub kind: String,
    pub message: String,
    /// 401 여부. 전역 배너를 한 번만 띄우기 위한 신호 (DECISIONS 16장).
    pub is_auth_failure: bool,
    pub retry_after_secs: Option<u64>,
    /// 실패했지만 직전 성공 데이터가 있으면 함께 준다. 목록을 비우지 않기 위해.
    pub stale: Option<GithubWidgetData>,
}

#[derive(Debug, Clone, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct GithubWidgetConfig {
    /// 사용자가 붙인 위젯 이름. 비어 있으면 쿼리 이름을 쓴다.
    #[serde(default)]
    pub title: Option<String>,
    pub query: GithubQuery,
    pub max_results: u32,
    /// 저장소 범위. 빈 목록이면 전체.
    ///
    /// 쿼리와 분리하는 이유는 Jira의 `projects`와 같다 — 프리셋이든 생 쿼리든
    /// 똑같이 적용돼야 하고, 프리셋마다 저장소별 변종을 만드는 것은 조합 폭발이다.
    #[serde(default)]
    pub repos: Vec<String>,
    /// 조직 범위. 빈 목록이면 전체.
    ///
    /// `repos`와 **합집합**이다(실측). GitHub 검색에서 `org:x repo:o/a`는
    /// "x 조직 **또는** o/a"이지 교집합이 아니다. 설정 UI가 둘을 동시에 쓰지
    /// 않도록 안내한다.
    #[serde(default)]
    pub orgs: Vec<String>,
    /// 저장소별로 묶어서 보여줄까. 기본 켬.
    #[serde(default = "default_true")]
    pub group_by_repo: bool,
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
pub fn github_presets() -> Vec<GithubPreset> {
    PRESETS.to_vec()
}

/// 토큰이 저장돼 있는가. 설정 안내를 띄울지 고르는 데 쓴다.
#[tauri::command]
#[specta::specta]
pub fn github_is_configured(state: State<'_, AppState>) -> Result<bool, String> {
    state
        .secrets
        .has(&SecretKey::github_token())
        .map_err(|e| format!("키체인을 읽을 수 없습니다: {e}"))
}

/// 토큰 저장. **평문 파일에 쓰지 않는다** (CLAUDE.md).
#[tauri::command]
#[specta::specta]
pub fn github_save_token(state: State<'_, AppState>, token: String) -> Result<(), String> {
    let token = token.trim();
    if token.is_empty() {
        return Err("토큰이 비어 있습니다".into());
    }
    state
        .secrets
        .set(&SecretKey::github_token(), &Secret::new(token))
        .map_err(|e| format!("키체인에 저장할 수 없습니다: {e}"))
}

#[tauri::command]
#[specta::specta]
pub fn github_delete_token(state: State<'_, AppState>) -> Result<(), String> {
    state
        .secrets
        .delete(&SecretKey::github_token())
        .map_err(|e| format!("키체인에서 지울 수 없습니다: {e}"))
}

/// `gh` CLI에 로그인된 토큰을 가져와 키체인에 복사한다.
///
/// # 왜 복사인가 (런타임 의존이 아니라)
///
/// gh를 매번 부르면 gh 로그아웃·재설치·PATH 변경이 전부 조용한 실패가 된다.
/// 앱 밖에서 일어나는 일이라 원인을 알 수 없다. 한 번 복사해두면 그 뒤로는
/// gh가 사라져도 앱이 돈다.
///
/// 대가: gh가 토큰을 갱신해도 우리 사본은 낡는다. 그때는 401이 나고,
/// 사용자가 버튼을 다시 누르면 된다 — **드러나는 실패**다.
#[tauri::command]
#[specta::specta]
pub async fn github_import_gh_token(state: State<'_, AppState>) -> Result<String, String> {
    let output = tokio::process::Command::new("gh")
        .args(["auth", "token"])
        .output()
        .await
        .map_err(|e| {
            if e.kind() == std::io::ErrorKind::NotFound {
                "gh CLI를 찾을 수 없습니다. `brew install gh`로 설치한 뒤 `gh auth login`을 실행하세요.".to_string()
            } else {
                format!("gh 실행에 실패했습니다: {e}")
            }
        })?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        let hint = stderr.trim();
        return Err(if hint.is_empty() {
            "gh에 로그인돼 있지 않습니다. `gh auth login`을 실행하세요.".to_string()
        } else {
            format!("gh에서 토큰을 가져오지 못했습니다: {hint}")
        });
    }

    let token = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if token.is_empty() {
        return Err("gh가 빈 토큰을 반환했습니다. `gh auth login`을 실행하세요.".into());
    }

    state
        .secrets
        .set(&SecretKey::github_token(), &Secret::new(&token))
        .map_err(|e| format!("키체인에 저장할 수 없습니다: {e}"))?;

    // 토큰 자체는 절대 돌려주지 않는다. 로그인 이름만 확인해서 준다.
    let client = GithubClient::with_http_client(state.http.clone(), GithubCredentials::new(&token));
    match client.search("is:pr author:@me", 1).await {
        Ok(_) => Ok("gh CLI의 토큰을 가져왔습니다".into()),
        Err(e) => Err(format!(
            "토큰은 저장했지만 GitHub 호출에 실패했습니다: {e}"
        )),
    }
}

/// 토큰이 실제로 동작하는지 확인. 설정창의 [확인] 버튼.
#[tauri::command]
#[specta::specta]
pub async fn github_verify(state: State<'_, AppState>) -> Result<String, String> {
    let client = client_from_state(&state)?;
    client
        .search("is:pr author:@me", 1)
        .await
        .map(|page| format!("연결됐습니다 (내 PR {}건)", page.total))
        .map_err(|e| e.to_string())
}

/// 위젯 데이터를 네트워크에서 가져온다.
#[tauri::command]
#[specta::specta]
pub async fn github_fetch(
    state: State<'_, AppState>,
    widget_id: String,
    config: GithubWidgetConfig,
) -> Result<GithubWidgetData, GithubWidgetError> {
    let client = client_from_state(&state).map_err(|e| GithubWidgetError {
        kind: "permanent".into(),
        message: e,
        is_auth_failure: true,
        retry_after_secs: None,
        stale: None,
    })?;

    let Some(search) = config.query.to_search() else {
        return Err(permanent_error(
            "알 수 없는 프리셋입니다. 위젯 설정에서 쿼리를 다시 선택하세요.",
            None,
        ));
    };

    // 범위는 프리셋·생 쿼리 모두에 적용한다.
    //
    // Jira에서 정렬·범위를 프리셋에만 적용한 것과 다르다. JQL은 `ORDER BY`가
    // 있어서 우리가 손대면 사용자 의도를 덮어쓸 수 있지만, GitHub 검색에
    // 한정자를 더하는 것은 원 쿼리의 조건을 지운다거나 하지 않는다.
    let search = apply_scope(&search, &config.repos, &config.orgs);

    match client.search(&search, config.max_results).await {
        Ok(page) => {
            let fetched_at = chrono::Utc::now();
            let data = GithubWidgetData {
                items: page.items,
                total: page.total,
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
            tracing::warn!(widget_id = %widget_id, error = %e, "GitHub 조회 실패");
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
pub fn github_cached(
    state: State<'_, AppState>,
    widget_id: String,
) -> Result<Option<GithubWidgetData>, String> {
    let cache = state.cache.lock().map_err(|_| "상태 잠금 실패")?;
    Ok(cached_data(&cache, &widget_id))
}

/// 저장소 목록. 설정창의 필터·순서 UI를 채운다.
///
/// 캐시가 있으면 캐시를 준다. `refresh: true`면 네트워크에서 다시 받는다.
#[tauri::command]
#[specta::specta]
pub async fn github_repos(
    state: State<'_, AppState>,
    refresh: bool,
) -> Result<GithubRepoList, String> {
    if !refresh {
        let meta = state.github_meta.lock().map_err(|_| "상태 잠금 실패")?;
        if meta.has_repos() {
            return Ok(GithubRepoList {
                repos: meta.repos().to_vec(),
                fetched_at: meta.fetched_at().map(|t| t.to_rfc3339()),
            });
        }
    }

    let client = client_from_state(&state)?;
    let repos = client.list_repos().await.map_err(|e| e.to_string())?;
    let fetched_at = chrono::Utc::now();

    let mut meta = state.github_meta.lock().map_err(|_| "상태 잠금 실패")?;
    meta.set_repos(repos, fetched_at);
    meta.save()
        .map_err(|e| format!("저장소 목록을 저장할 수 없습니다: {e}"))?;

    Ok(GithubRepoList {
        repos: meta.repos().to_vec(),
        fetched_at: Some(fetched_at.to_rfc3339()),
    })
}

#[derive(Debug, Clone, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct GithubRepoList {
    pub repos: Vec<GithubRepo>,
    pub fetched_at: Option<String>,
}

// ---------------------------------------------------------------------------
// 내부 헬퍼
// ---------------------------------------------------------------------------

fn client_from_state(state: &AppState) -> Result<GithubClient, String> {
    let token = state
        .secrets
        .get(&SecretKey::github_token())
        .map_err(|e| format!("키체인을 읽을 수 없습니다: {e}"))?
        .ok_or("GitHub 토큰이 설정되지 않았습니다")?;

    Ok(GithubClient::with_http_client(
        state.http.clone(),
        GithubCredentials::new(token.expose()),
    ))
}

fn cached_data(
    cache: &crate::storage::cache::CacheStore,
    widget_id: &str,
) -> Option<GithubWidgetData> {
    let entry = cache.get(widget_id).ok().flatten()?;
    let mut data: GithubWidgetData = serde_json::from_value(entry.payload).ok()?;
    data.fetched_at = entry.fetched_at.to_rfc3339();
    data.from_cache = true;
    Some(data)
}

fn permanent_error(message: &str, stale: Option<GithubWidgetData>) -> GithubWidgetError {
    GithubWidgetError {
        kind: "permanent".into(),
        message: message.to_owned(),
        is_auth_failure: false,
        retry_after_secs: None,
        stale,
    }
}

fn to_widget_error(state: &AppState, widget_id: &str, e: GithubError) -> GithubWidgetError {
    let stale = state
        .cache
        .lock()
        .ok()
        .and_then(|c| cached_data(&c, widget_id));

    GithubWidgetError {
        kind: match e.kind() {
            crate::providers::github::ErrorKind::Transient => "transient".into(),
            crate::providers::github::ErrorKind::Permanent => "permanent".into(),
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

    /// 캐시에서 읽은 데이터는 **반드시** `from_cache: true`여야 한다.
    /// 아니면 "N분 전 데이터" 표시가 안 뜨고 사용자가 낡은 걸 최신으로 믿는다.
    #[test]
    fn cached_data_is_marked_as_cached() {
        let dir = tempfile::TempDir::new().unwrap();
        let cache = crate::storage::cache::CacheStore::new(dir.path());
        let at = chrono::Utc::now();

        let fresh = GithubWidgetData {
            items: vec![],
            total: 7,
            fetched_at: at.to_rfc3339(),
            from_cache: false,
        };
        cache
            .put("w1", serde_json::to_value(&fresh).unwrap(), at)
            .unwrap();

        let got = cached_data(&cache, "w1").expect("캐시를 못 읽었다");
        assert!(got.from_cache, "캐시에서 왔는데 from_cache가 false다");
        assert_eq!(got.total, 7, "총 건수가 캐시를 왕복하며 사라졌다");
    }

    /// 저장소 범위는 프리셋과 생 쿼리 **양쪽 모두**에 적용된다.
    #[test]
    fn repo_filter_applies_to_raw_queries_too() {
        let raw = GithubQuery::Raw {
            query: "is:pr author:someone".into(),
        };
        let search = raw.to_search().unwrap();
        let scoped = apply_scope(&search, &["o/a".to_string()], &[]);
        assert_eq!(scoped, "is:pr author:someone repo:o/a");
    }
}
