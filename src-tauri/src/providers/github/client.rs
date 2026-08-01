//! GitHub GraphQL 클라이언트 (DECISIONS 12.1).
//!
//! # 왜 GraphQL 하나뿐인가
//!
//! REST 검색은 **분당 30회**다. PR 30건의 리뷰 상태를 개별 조회하면 즉시 넘긴다.
//! GraphQL은 포인트 기반(시간당 5000점)이고, **한 요청에 목록 + 리뷰 상태 +
//! CI + 변경 규모가 전부 들어온다.**
//!
//! 실측(2026-08-02): 검색 1회 = **1점**. 위젯 4개를 5분마다 돌려도 시간당 48점,
//! 한도의 1%다. rate limit은 사실상 제약이 아니다.
//!
//! # 쿼리를 문자열로 관리하는 대가
//!
//! GraphQL 쿼리가 Rust 문자열 상수다. 오타가 컴파일에 안 잡힌다는 뜻이라,
//! `tests/`에 **실제 응답 fixture로 파싱을 검증**한다.

use std::time::Duration;

use super::error::{classify_status, GithubError, GithubResult};
use super::types::{
    GithubItem, GithubRepo, GithubSearchPage, GqlEnvelope, ReposData, SearchData,
};

const GRAPHQL_URL: &str = "https://api.github.com/graphql";
const DEFAULT_TIMEOUT: Duration = Duration::from_secs(20);
const DEFAULT_CONNECT_TIMEOUT: Duration = Duration::from_secs(8);

/// 한 번에 가져올 최대 항목 수.
///
/// GitHub GraphQL의 `first`는 100이 상한이다. 위젯이 그만큼 보여줄 일은 없지만
/// 상한을 넘기면 쿼리 자체가 거절되므로 여기서 자른다.
const MAX_FIRST: u32 = 100;

/// 검색 쿼리.
///
/// `__typename`이 필요한 이유: fragment만으로는 PR인지 Issue인지 구분이 안 온다.
/// CI(`statusCheckRollup`)는 **`commits(last: 1)` 아래**에 있다 — 최상위 필드가
/// 아니다(실측으로 확인).
const SEARCH_QUERY: &str = r#"
query($q: String!, $first: Int!) {
  search(query: $q, type: ISSUE, first: $first) {
    issueCount
    nodes {
      __typename
      ... on PullRequest {
        number title url state isDraft merged reviewDecision
        additions deletions updatedAt
        author { login }
        repository { nameWithOwner }
        comments { totalCount }
        commits(last: 1) { nodes { commit {
          statusCheckRollup { state }
        }}}
      }
      ... on Issue {
        number title url state updatedAt
        author { login }
        repository { nameWithOwner }
        comments { totalCount }
      }
    }
  }
  rateLimit { cost remaining }
}
"#;

/// 저장소 목록 쿼리.
///
/// `ownerAffiliations`에 세 가지를 다 넣는 이유: 내 저장소만이 아니라 협업자로
/// 참여한 것, 조직 소속인 것까지 봐야 한다. 실측 68개가 이 조합의 결과다.
const REPOS_QUERY: &str = r#"
query($first: Int!, $after: String) {
  viewer {
    repositories(
      first: $first
      after: $after
      ownerAffiliations: [OWNER, COLLABORATOR, ORGANIZATION_MEMBER]
      orderBy: { field: PUSHED_AT, direction: DESC }
    ) {
      nodes { nameWithOwner pushedAt isPrivate isArchived }
      pageInfo { hasNextPage endCursor }
    }
  }
}
"#;

/// GitHub API 토큰. **Debug에 절대 노출하지 않는다** (CLAUDE.md: 마스킹 필수).
#[derive(Clone)]
pub struct GithubCredentials {
    token: String,
}

impl GithubCredentials {
    pub fn new(token: impl Into<String>) -> Self {
        Self {
            token: token.into(),
        }
    }
}

impl std::fmt::Debug for GithubCredentials {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        // 길이만 남긴다. 토큰이 로그에 찍히면 그걸로 끝이다.
        f.debug_struct("GithubCredentials")
            .field("token", &format_args!("<{}자>", self.token.len()))
            .finish()
    }
}

pub struct GithubClient {
    http: reqwest::Client,
    credentials: GithubCredentials,
}

impl std::fmt::Debug for GithubClient {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("GithubClient")
            .field("credentials", &self.credentials)
            .finish_non_exhaustive()
    }
}

impl GithubClient {
    pub fn new(credentials: GithubCredentials) -> GithubResult<Self> {
        Self::with_timeout(credentials, DEFAULT_TIMEOUT)
    }

    pub fn with_timeout(
        credentials: GithubCredentials,
        timeout: Duration,
    ) -> GithubResult<Self> {
        let http = reqwest::Client::builder()
            .timeout(timeout)
            .connect_timeout(DEFAULT_CONNECT_TIMEOUT)
            .gzip(true)
            .user_agent(concat!("my-pegboard/", env!("CARGO_PKG_VERSION")))
            .build()
            .map_err(|e| GithubError::Network {
                message: format!("HTTP 클라이언트 생성 실패: {e}"),
            })?;
        Ok(Self { http, credentials })
    }

    /// 이미 만들어둔 클라이언트를 공유 (커넥션 풀 재사용).
    pub fn with_http_client(http: reqwest::Client, credentials: GithubCredentials) -> Self {
        Self { http, credentials }
    }

    /// GraphQL 요청 한 번. **모든 호출이 여기를 지난다.**
    ///
    /// 에러 분류의 유일한 관문이다. 개별 메서드가 상태 코드를 보지 않는다.
    async fn graphql<T: serde::de::DeserializeOwned>(
        &self,
        query: &str,
        variables: serde_json::Value,
        context: &str,
    ) -> GithubResult<T> {
        let response = self
            .http
            .post(GRAPHQL_URL)
            .bearer_auth(&self.credentials.token)
            .json(&serde_json::json!({ "query": query, "variables": variables }))
            .send()
            .await
            .map_err(|e| GithubError::Network {
                message: format!("{context}: {e}"),
            })?;

        let status = response.status().as_u16();

        // 헤더는 본문을 읽기 전에 챙긴다 (본문 읽기가 소유권을 가져간다).
        let retry_after = header_u64(&response, "retry-after");
        let remaining = header_u64(&response, "x-ratelimit-remaining");

        let body = response.text().await.unwrap_or_default();

        if !(200..300).contains(&status) {
            return Err(classify_status(
                status,
                extract_message(&body).unwrap_or_else(|| preview(&body)),
                retry_after,
                remaining,
            ));
        }

        // GraphQL은 실패해도 200을 준다. 본문의 errors를 봐야 한다.
        let envelope: GqlEnvelope<T> = serde_json::from_str(&body).map_err(|e| {
            GithubError::Decode {
                message: format!("{context}: {e} (본문 앞부분: {})", preview(&body)),
            }
        })?;

        if !envelope.errors.is_empty() {
            let message = envelope
                .errors
                .iter()
                .map(|e| e.message.as_str())
                .collect::<Vec<_>>()
                .join("; ");

            // rate limit만은 일시적이다. GraphQL은 이것도 errors로 준다.
            if message.contains("rate limit") || message.contains("RATE_LIMITED") {
                return Err(GithubError::RateLimited {
                    message,
                    retry_after_secs: retry_after,
                });
            }
            return Err(GithubError::GraphqlErrors { message });
        }

        envelope.data.ok_or_else(|| GithubError::Decode {
            message: format!("{context}: data가 비어 있습니다"),
        })
    }

    /// 검색. **목록 위젯의 유일한 진입점.**
    ///
    /// Jira와 달리 **총 건수를 준다**(`issueCount`). 신규 Jira 검색은 total이
    /// 없어서 "42건 중 30건"을 만들 수 없었는데, GitHub은 가능하다.
    pub async fn search(&self, query: &str, first: u32) -> GithubResult<GithubSearchPage> {
        let first = first.clamp(1, MAX_FIRST);
        let data: SearchData = self
            .graphql(
                SEARCH_QUERY,
                serde_json::json!({ "q": query, "first": first }),
                "검색",
            )
            .await?;

        // 파싱 못 한 항목은 버리고 나머지를 살린다. 하나가 이상하다고
        // 목록 전체를 실패시키지 않는다 (CLAUDE.md: 목록이 사라지면 안 된다).
        let items: Vec<GithubItem> = data
            .search
            .nodes
            .into_iter()
            .flatten()
            .filter_map(|n| n.flatten())
            .collect();

        Ok(GithubSearchPage {
            items,
            total: data.search.issue_count,
            cost: data.rate_limit.as_ref().map(|r| r.cost),
            rate_limit_remaining: data.rate_limit.as_ref().map(|r| r.remaining),
        })
    }

    /// 저장소 목록 전체. 설정창의 필터·순서 UI를 채운다.
    ///
    /// 페이지네이션을 **끝까지 돈다.** 실측 68개면 100개 페이지 하나로 끝나지만,
    /// 저장소가 많은 계정에서 잘리면 "왜 내 저장소가 목록에 없지"가 된다.
    /// 안전장치로 페이지 수를 제한한다 — 무한 루프보다는 잘리는 편이 낫다.
    pub async fn list_repos(&self) -> GithubResult<Vec<GithubRepo>> {
        const PAGE_SIZE: u32 = 100;
        const MAX_PAGES: usize = 20; // 2000개. 이보다 많으면 목록 UI가 이미 무의미하다.

        let mut all = Vec::new();
        let mut after: Option<String> = None;

        for _ in 0..MAX_PAGES {
            let data: ReposData = self
                .graphql(
                    REPOS_QUERY,
                    serde_json::json!({ "first": PAGE_SIZE, "after": after }),
                    "저장소 목록",
                )
                .await?;

            let conn = data.viewer.repositories;
            all.extend(conn.nodes.into_iter().flatten().map(|n| GithubRepo {
                name_with_owner: n.name_with_owner,
                pushed_at: n.pushed_at,
                is_private: n.is_private,
                is_archived: n.is_archived,
            }));

            if !conn.page_info.has_next_page {
                break;
            }
            after = conn.page_info.end_cursor;
            if after.is_none() {
                break; // 커서가 없는데 다음이 있다고 하면 더 갈 방법이 없다.
            }
        }

        Ok(all)
    }
}

/// 헤더에서 u64를 꺼낸다. 없거나 파싱 실패면 `None`.
fn header_u64(response: &reqwest::Response, name: &str) -> Option<u64> {
    response
        .headers()
        .get(name)
        .and_then(|v| v.to_str().ok())
        .and_then(|s| s.trim().parse().ok())
}

/// GitHub 에러 본문에서 `message`를 꺼낸다.
///
/// GitHub은 `{"message": "Bad credentials", ...}` 모양으로 준다. 원문을 그대로
/// 쓰는 게 우리가 다시 쓰는 것보다 낫다 (DECISIONS 16장).
fn extract_message(body: &str) -> Option<String> {
    serde_json::from_str::<serde_json::Value>(body)
        .ok()?
        .get("message")?
        .as_str()
        .map(str::to_owned)
}

/// 로그·에러에 남길 본문 앞부분.
fn preview(body: &str) -> String {
    const LIMIT: usize = 200;
    if body.len() <= LIMIT {
        return body.to_owned();
    }
    // 문자 경계에서 자른다. 바이트로 자르면 한글이 깨진다.
    let end = body
        .char_indices()
        .take_while(|(i, _)| *i < LIMIT)
        .last()
        .map_or(0, |(i, c)| i + c.len_utf8());
    format!("{}…", &body[..end])
}
