//! Jira REST v3 HTTP 클라이언트.
//!
//! **자격증명은 파라미터로만 받는다.** 이 모듈은 키체인을 모른다 — `secrets/`가 읽어서
//! [`JiraCredentials`]로 넘겨준다. 그래야 이 모듈을 실제 토큰 없이 테스트할 수 있다.
//!
//! 설계상 두 개의 층으로 나뉜다:
//!
//! - **순수 함수** ([`build_search_body`], [`join_url`], `auth_header` …) — 네트워크 없이 테스트된다.
//! - **`JiraClient` 메서드** — 위를 조립해서 실제로 쏜다.
//!
//! 요청 조립 로직을 순수 함수로 뽑은 이유는 취향이 아니라, 필드 축소 같은
//! **성능 요구사항을 테스트로 고정**하기 위해서다. "fields를 보냈나?"를 실제 HTTP 없이 검증한다.

use base64::Engine as _;
use std::time::Duration;

use super::error::{parse_retry_after, JiraError};
use super::types::{
    CommentPage, CreateIssueInput, CreateMeta, CreatedIssue, JiraIdentity, JiraIssueDetail,
    SearchPage, DETAIL_FIELDS, LIST_FIELDS,
};

/// 요청 타임아웃. 위젯 체감 목표가 1초(CLAUDE.md 성능표)이므로
/// 15초면 "느린 응답"이 아니라 "죽은 요청"이다. 여기서 끊고 백오프에 맡긴다.
pub const DEFAULT_TIMEOUT: Duration = Duration::from_secs(15);

/// 연결 수립 타임아웃. 전체 타임아웃보다 짧게 — 네트워크가 끊겼으면 빨리 알아야 한다.
pub const DEFAULT_CONNECT_TIMEOUT: Duration = Duration::from_secs(5);

/// 위젯 기본 표시 개수 (DECISIONS 11.2).
pub const DEFAULT_MAX_RESULTS: u32 = 30;

/// 한 페이지 상한. Jira 자체 상한은 5000이지만 우리가 그만큼 받을 이유가 없다.
/// 위젯당 최대 30건이고, 페이지네이션이 있으니 큰 페이지는 메모리만 먹는다.
pub const MAX_RESULTS_LIMIT: u32 = 100;

/// Jira 접속에 필요한 것 전부. 키체인에서 읽어와 넘긴다.
#[derive(Clone)]
pub struct JiraCredentials {
    /// `https://your-team.atlassian.net` (후행 슬래시는 있든 없든 됨)
    pub base_url: String,
    /// Atlassian 계정 이메일. Basic Auth의 username 자리.
    pub email: String,
    /// API 토큰. **절대 로그에 찍지 않는다.**
    pub api_token: String,
}

impl JiraCredentials {
    pub fn new(
        base_url: impl Into<String>,
        email: impl Into<String>,
        api_token: impl Into<String>,
    ) -> Self {
        Self {
            base_url: base_url.into(),
            email: email.into(),
            api_token: api_token.into(),
        }
    }
}

/// `Debug`를 손으로 구현한다. derive를 쓰면 토큰이 로그에 그대로 나간다.
/// (CLAUDE.md "로그에 토큰을 찍지 않는다. 마스킹 필수.")
impl std::fmt::Debug for JiraCredentials {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("JiraCredentials")
            .field("base_url", &self.base_url)
            .field("email", &self.email)
            .field("api_token", &"***")
            .finish()
    }
}

/// `Authorization: Basic base64(email:token)` 의 값 부분.
///
/// v3 Cloud는 Bearer(OAuth)도 받지만 우리는 API 토큰 + Basic이다 (DECISIONS 8장).
pub fn auth_header(email: &str, api_token: &str) -> String {
    let raw = format!("{email}:{api_token}");
    format!(
        "Basic {}",
        base64::engine::general_purpose::STANDARD.encode(raw)
    )
}

/// `base_url`과 경로를 슬래시 중복 없이 잇는다.
///
/// 사용자가 설정창에 `https://your-team.atlassian.net/`를 붙여넣는 일은 반드시 생긴다.
/// 그때 `//rest/api/3/...`가 되면 Jira가 404를 준다.
pub fn join_url(base_url: &str, path: &str) -> String {
    let base = base_url.trim_end_matches('/');
    let path = path.trim_start_matches('/');
    format!("{base}/{path}")
}

/// `/rest/api/3/search/jql` 요청 본문.
///
/// **구 `/rest/api/3/search`가 아니다** (deprecated, DECISIONS 8장).
/// 신규 엔드포인트는 `startAt`을 받지 않고 `nextPageToken` 커서만 쓴다.
///
/// `fields`를 항상 명시하는 것이 핵심이다. 생략하면 Jira가 `*navigable`(~200 필드)을 준다.
pub fn build_search_body(
    jql: &str,
    max_results: u32,
    fields: &[&str],
    next_page_token: Option<&str>,
) -> serde_json::Value {
    let mut body = serde_json::json!({
        "jql": jql,
        "maxResults": clamp_max_results(max_results),
        "fields": fields,
    });

    if let Some(token) = next_page_token {
        body["nextPageToken"] = serde_json::json!(token);
    }

    body
}

/// 0이나 터무니없이 큰 값이 API로 나가지 않게 막는다.
/// 0을 그대로 보내면 Jira가 빈 배열을 주고, 위젯은 "결과 없음"을 잘못 표시한다.
fn clamp_max_results(requested: u32) -> u32 {
    requested.clamp(1, MAX_RESULTS_LIMIT)
}

/// `fields` 쿼리 파라미터 값 (GET 엔드포인트용). 쉼표로 잇는다.
pub fn fields_param(fields: &[&str]) -> String {
    fields.join(",")
}

/// Jira REST v3 클라이언트.
///
/// `reqwest::Client`는 커넥션 풀을 들고 있으므로 **재사용해야** 한다.
/// 요청마다 새로 만들면 매번 TLS 핸드셰이크가 붙어서, 하필 이 앱이 자랑해야 할
/// "새로고침 1초"를 그대로 까먹는다.
pub struct JiraClient {
    http: reqwest::Client,
    credentials: JiraCredentials,
    auth: String,
}

impl std::fmt::Debug for JiraClient {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("JiraClient")
            .field("credentials", &self.credentials)
            .finish_non_exhaustive()
    }
}

impl JiraClient {
    /// 기본 타임아웃으로 생성.
    pub fn new(credentials: JiraCredentials) -> Result<Self, JiraError> {
        Self::with_timeout(credentials, DEFAULT_TIMEOUT)
    }

    pub fn with_timeout(
        credentials: JiraCredentials,
        timeout: Duration,
    ) -> Result<Self, JiraError> {
        let http = reqwest::Client::builder()
            .timeout(timeout)
            .connect_timeout(DEFAULT_CONNECT_TIMEOUT)
            // gzip: Jira 응답은 JSON이라 압축률이 높다. 필드 축소와 곱해져서 효과가 난다.
            .gzip(true)
            .user_agent(concat!("my-pegboard/", env!("CARGO_PKG_VERSION")))
            .build()
            .map_err(|e| JiraError::Network {
                message: format!("HTTP 클라이언트 생성 실패: {e}"),
            })?;

        let auth = auth_header(&credentials.email, &credentials.api_token);
        Ok(Self {
            http,
            credentials,
            auth,
        })
    }

    /// 이미 만들어둔 `reqwest::Client`를 공유해서 생성 (커넥션 풀 재사용).
    pub fn with_http_client(http: reqwest::Client, credentials: JiraCredentials) -> Self {
        let auth = auth_header(&credentials.email, &credentials.api_token);
        Self {
            http,
            credentials,
            auth,
        }
    }

    pub fn base_url(&self) -> &str {
        &self.credentials.base_url
    }

    fn url(&self, path: &str) -> String {
        join_url(&self.credentials.base_url, path)
    }

    fn get(&self, path: &str) -> reqwest::RequestBuilder {
        self.http
            .get(self.url(path))
            .header(reqwest::header::AUTHORIZATION, &self.auth)
            .header(reqwest::header::ACCEPT, "application/json")
    }

    fn post(&self, path: &str) -> reqwest::RequestBuilder {
        self.http
            .post(self.url(path))
            .header(reqwest::header::AUTHORIZATION, &self.auth)
            .header(reqwest::header::ACCEPT, "application/json")
            .header(reqwest::header::CONTENT_TYPE, "application/json")
    }

    /// 응답을 상태코드로 갈라서 성공이면 파싱, 실패면 [`JiraError`]로 분류한다.
    ///
    /// **여기가 에러 분류의 유일한 관문이다.** 개별 메서드가 상태코드를 보지 않는다.
    async fn handle<T: serde::de::DeserializeOwned>(
        response: reqwest::Response,
        context: &str,
    ) -> Result<T, JiraError> {
        let status = response.status();

        // Retry-After는 본문을 읽기 전에 챙긴다 (본문 읽기가 소유권을 가져간다).
        let retry_after = response
            .headers()
            .get(reqwest::header::RETRY_AFTER)
            .and_then(|v| v.to_str().ok())
            .and_then(parse_retry_after);

        if !status.is_success() {
            // 본문 읽기가 실패해도 상태코드 기반 분류는 살려야 한다.
            let body = response.text().await.unwrap_or_default();
            return Err(JiraError::from_response(
                status.as_u16(),
                &body,
                retry_after,
            ));
        }

        // `.json()`을 바로 쓰지 않는 이유: 파싱이 실패했을 때 원문을 에러에 남기려고.
        // 스키마가 바뀌었을 때 로그에 "무엇이 왔는지"가 없으면 추적이 불가능하다.
        let body = response.text().await.map_err(JiraError::from)?;
        serde_json::from_str::<T>(&body).map_err(|e| {
            JiraError::decode(context, format!("{e} (본문 앞부분: {})", preview(&body)))
        })
    }

    /// 이슈 검색. **목록 위젯의 유일한 진입점.**
    ///
    /// - `fields`를 반드시 지정한다. 목록이면 [`LIST_FIELDS`].
    /// - 반환 [`SearchPage`]에 **total은 없다.** 커서 `next_page_token`만 있다.
    pub async fn search_issues(
        &self,
        jql: &str,
        max_results: u32,
        fields: &[&str],
    ) -> Result<SearchPage, JiraError> {
        self.search_issues_page(jql, max_results, fields, None)
            .await
    }

    /// 기본 필드 세트로 검색하는 편의 함수.
    pub async fn search_issues_default(
        &self,
        jql: &str,
        max_results: u32,
    ) -> Result<SearchPage, JiraError> {
        self.search_issues(jql, max_results, LIST_FIELDS).await
    }

    /// 커서를 이어받아 다음 페이지를 가져온다.
    ///
    /// `next_page_token`이 `None`이면 첫 페이지. 마지막 페이지에서는 응답의
    /// `next_page_token`이 `None`이 되므로 그것이 종료 조건이다.
    pub async fn search_issues_page(
        &self,
        jql: &str,
        max_results: u32,
        fields: &[&str],
        next_page_token: Option<&str>,
    ) -> Result<SearchPage, JiraError> {
        let body = build_search_body(jql, max_results, fields, next_page_token);
        let response = self
            .post("/rest/api/3/search/jql")
            .json(&body)
            .send()
            .await
            .map_err(JiraError::from)?;
        Self::handle(response, "search/jql").await
    }

    /// 이슈 하나를 상세 모달용 필드까지 가져온다 (ADF description 포함).
    pub async fn get_issue(&self, key: &str) -> Result<JiraIssueDetail, JiraError> {
        self.get_issue_with_fields(key, DETAIL_FIELDS).await
    }

    pub async fn get_issue_with_fields(
        &self,
        key: &str,
        fields: &[&str],
    ) -> Result<JiraIssueDetail, JiraError> {
        let response = self
            .get(&format!("/rest/api/3/issue/{}", encode_path(key)))
            .query(&[("fields", fields_param(fields))])
            .send()
            .await
            .map_err(JiraError::from)?;
        Self::handle(response, "issue").await
    }

    /// 코멘트 목록. 상세 모달을 여는 이유의 절반 (DECISIONS 11.4).
    ///
    /// 검색과 달리 이 엔드포인트는 offset 페이지네이션이고 `total`을 준다.
    pub async fn get_comments(
        &self,
        key: &str,
        start_at: u32,
        max_results: u32,
    ) -> Result<CommentPage, JiraError> {
        let response = self
            .get(&format!("/rest/api/3/issue/{}/comment", encode_path(key)))
            .query(&[
                ("startAt", start_at.to_string()),
                ("maxResults", max_results.to_string()),
                // 오래된 것부터 — 대화 순서로 읽는 게 자연스럽다.
                ("orderBy", "created".to_string()),
            ])
            .send()
            .await
            .map_err(JiraError::from)?;
        Self::handle(response, "comment").await
    }

    /// 생성 폼 스키마 조회 (DECISIONS 11.3).
    ///
    /// 프로젝트마다 필수 필드가 다르다는 것이 실측으로 확인됐다(ABC 3개 / XYZ 4개).
    /// 그래서 폼을 고정할 수 없고 매번 이걸 물어봐야 한다.
    ///
    /// 응답은 캐시 대상이다 — 다만 캐시는 이 모듈 책임이 아니다.
    pub async fn get_createmeta(
        &self,
        project_key: &str,
        issue_type_id: &str,
    ) -> Result<CreateMeta, JiraError> {
        let path = format!(
            "/rest/api/3/issue/createmeta/{}/issuetypes/{}",
            encode_path(project_key),
            encode_path(issue_type_id)
        );
        let response = self
            .get(&path)
            // 필드가 많은 프로젝트에서 기본 50건에 잘리지 않도록.
            .query(&[("maxResults", "200")])
            .send()
            .await
            .map_err(JiraError::from)?;
        Self::handle(response, "createmeta").await
    }

    /// 티켓 생성. 우리가 하는 유일한 쓰기 작업 (DECISIONS 11.5).
    pub async fn create_issue(&self, input: &CreateIssueInput) -> Result<CreatedIssue, JiraError> {
        let response = self
            .post("/rest/api/3/issue")
            .json(&input.to_payload())
            .send()
            .await
            .map_err(JiraError::from)?;
        Self::handle(response, "create issue").await
    }

    /// 설정창 "연결 테스트" 버튼.
    ///
    /// `/myself`를 쓰는 이유: 인증만 확인하는 가장 가벼운 엔드포인트이고,
    /// 성공하면 화면에 보여줄 이름까지 딸려 온다("○○님으로 연결됨").
    /// 토큰이 틀리면 401이 오고, 그건 [`JiraError::Unauthorized`]로 분류돼
    /// 재시도 없이 곧장 사용자에게 간다.
    pub async fn verify_credentials(&self) -> Result<JiraIdentity, JiraError> {
        let response = self
            .get("/rest/api/3/myself")
            .send()
            .await
            .map_err(JiraError::from)?;
        Self::handle(response, "myself").await
    }
}

/// 경로 세그먼트 최소 인코딩.
///
/// 이슈 키(`PROJ-123`)와 프로젝트 키는 영숫자+하이픈이라 사실상 인코딩이 필요 없지만,
/// 사용자가 상세보기 링크에 이상한 문자를 넣었을 때 경로가 깨지지 않게 막는다.
fn encode_path(segment: &str) -> String {
    let mut out = String::with_capacity(segment.len());
    for byte in segment.bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(byte as char);
            }
            _ => out.push_str(&format!("%{byte:02X}")),
        }
    }
    out
}

/// 파싱 실패 시 에러에 남길 응답 앞부분. 전체를 남기면 로그가 터진다.
fn preview(body: &str) -> String {
    const LIMIT: usize = 200;
    let s: String = body.chars().take(LIMIT).collect();
    if body.chars().count() > LIMIT {
        format!("{s}…")
    } else {
        s
    }
}

#[cfg(test)]
#[path = "tests/client_tests.rs"]
mod client_tests;
