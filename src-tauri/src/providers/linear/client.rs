//! Linear GraphQL 클라이언트 (DECISIONS 25).
//!
//! # ★ 인증에 `Bearer`를 붙이지 않는다
//!
//! ```text
//! GitHub:  Authorization: Bearer ghp_xxx
//! Linear:  Authorization: lin_api_xxx      ← 접두사 없음
//! ```
//!
//! GitHub provider를 복사해 오면 `.bearer_auth()`를 그대로 쓰게 되고, Linear는
//! **401**을 준다. 접두사 하나 때문에 "키를 잘못 넣었나" 하며 시간을 버리는
//! 종류의 실패다. 그래서 [`LinearClient::graphql`]은 `.header("Authorization", ...)`을
//! 직접 쓰고, 테스트가 그 형태를 고정한다.
//!
//! # 왜 GraphQL 하나뿐인가
//!
//! Linear에는 REST가 없다. 선택의 문제가 아니다.
//!
//! # rate limit
//!
//! API 키 기준 요청 1500~2500/시간, 복잡도 3,000,000점/시간, **단일 쿼리 최대
//! 10,000점**이다. 위젯 4개를 5분마다 돌려도 시간당 48요청이라 요청 수는 문제가
//! 아니다. 다만 **복잡도**는 `first`가 크면 올라가므로 [`MAX_FIRST`]로 자른다.
//!
//! **rate limit이 HTTP 400으로 온다** — 이 앱에서 400은 영구 실패다.
//! `error.rs`가 본문을 보고 갈라낸다. 그 모듈 문서가 이 함정의 전말이다.
//!
//! # 쿼리를 문자열로 관리하는 대가
//!
//! GraphQL 쿼리가 Rust 문자열 상수다. 오타가 컴파일에 안 잡힌다는 뜻이라
//! `tests/`에 fixture로 파싱을 검증한다.
//!
//! **⚠️ 이 fixture는 실제 응답이 아니다.** Linear API 키가 없어 한 번도 실물을
//! 받지 못했고, 공개 `schema.graphql`을 보고 손으로 썼다 (DECISIONS 25.7).
//! GitHub provider의 `search.json`은 진짜 응답이었다 — 그 차이를 기억해야 한다.

use std::time::Duration;

use chrono::Utc;

use super::error::{body_says_rate_limited, classify_status, LinearError, LinearResult};
use super::presets::{apply_team_scope, LinearSort, LinearSortDirection, PresetScope};
use super::types::{
    GlobalMetadataData, GqlEnvelope, IssueCreateData, IssueDetailData, IssueNode, IssueUpdateData,
    IssuesData, LinearCreateIssueInput, LinearGlobalMetadata, LinearIssue, LinearIssueDetail,
    LinearIssuePage, LinearLabelOption, LinearMetadataList, LinearProjectOption, LinearTeam,
    LinearTeamMetadata, LinearViewer, LinearWorkflowState, PageInfo, ProjectMetadataNode,
    StateNode, TeamMetadataData, TeamStatesData, TeamsData, UserNode, ViewerData, ViewerIssuesData,
};
use serde_json::{json, Value};

const GRAPHQL_URL: &str = "https://api.linear.app/graphql";
const DEFAULT_TIMEOUT: Duration = Duration::from_secs(20);
const DEFAULT_CONNECT_TIMEOUT: Duration = Duration::from_secs(8);

/// 한 번에 가져올 최대 항목 수.
///
/// Linear 커넥션의 `first` 상한은 250이지만 거기까지 가지 않는다. 복잡도가
/// 항목 수에 비례하고 단일 쿼리 상한이 10,000점이라, 우리 쿼리의 필드 수를
/// 고려해 100에서 자른다. 위젯이 100줄 넘게 보여줄 일도 없다.
const MAX_FIRST: u32 = 100;

fn pagination_args(direction: LinearSortDirection, limit: u32) -> Value {
    let limit = limit.clamp(1, MAX_FIRST);
    match direction {
        LinearSortDirection::Descending => json!({
            "first": limit,
            "after": null,
            "last": null,
            "before": null,
        }),
        LinearSortDirection::Ascending => json!({
            "first": null,
            "after": null,
            "last": limit,
            "before": null,
        }),
    }
}

fn finish_page(
    mut issues: Vec<LinearIssue>,
    page_info: Option<PageInfo>,
    direction: LinearSortDirection,
) -> LinearIssuePage {
    if direction == LinearSortDirection::Ascending {
        issues.reverse();
    }
    let next_cursor = match direction {
        LinearSortDirection::Descending => page_info
            .filter(|page| page.has_next_page)
            .and_then(|page| page.end_cursor),
        LinearSortDirection::Ascending => page_info
            .filter(|page| page.has_previous_page)
            .and_then(|page| page.start_cursor),
    };
    LinearIssuePage {
        issues,
        next_cursor,
    }
}

/// 이슈 목록의 공통 필드 조각.
///
/// **한 요청에 목록이 필요한 것을 다 담는다** — 상태·담당자·팀·프로젝트·라벨을
/// 개별 조회하면 30건에 요청 150개가 된다(GitHub provider가 REST 검색을 버린
/// 것과 같은 이유).
///
/// `team { id }`가 **필수**다. 상태 변경 팝오버가 그 팀의 상태 목록을 조회하고,
/// 프론트가 팀 단위로 캐시를 나눈다. 빠뜨리면 팝오버가 아무 상태도 못 그린다.
const ISSUE_FIELDS: &str = r#"
  id
  identifier
  title
  url
  priority
  priorityLabel
  estimate
  dueDate
  updatedAt
  createdAt
  state { id name color type }
  assignee { id name displayName avatarUrl }
  team { id key name }
  project { name }
  labels(first: 10) { nodes { name } }
"#;

/// `viewer` 아래 커넥션에서 가져오는 쿼리.
///
/// 커넥션 이름(`assignedIssues` / `createdIssues`)과 정렬을 문자열로 끼워
/// 넣는다. **둘 다 우리 코드의 상수에서만 온다** — 사용자 입력이 여기로 들어오는
/// 경로가 없다(`PresetScope::viewer_connection`, `LinearSort::as_str`).
/// GraphQL에는 필드 이름을 변수로 받는 방법이 없어서 문자열 조립이 유일한 길이다.
fn viewer_issues_query(connection: &str, order_by: &str) -> String {
    format!(
        r#"
query($filter: IssueFilter, $first: Int, $after: String, $last: Int, $before: String) {{
  viewer {{
    issues: {connection}(filter: $filter, first: $first, after: $after, last: $last, before: $before, orderBy: {order_by}) {{
      nodes {{{ISSUE_FIELDS}}}
      pageInfo {{ hasNextPage endCursor hasPreviousPage startCursor }}
    }}
  }}
}}
"#
    )
}

/// 최상위 `issues` 쿼리. 팀 범위와 함께 쓴다.
fn all_issues_query(order_by: &str) -> String {
    format!(
        r#"
query($filter: IssueFilter, $first: Int, $after: String, $last: Int, $before: String) {{
  issues(filter: $filter, first: $first, after: $after, last: $last, before: $before, orderBy: {order_by}) {{
    nodes {{{ISSUE_FIELDS}}}
    pageInfo {{ hasNextPage endCursor hasPreviousPage startCursor }}
  }}
}}
"#
    )
}

/// 팀 목록. 설정창의 범위 선택 UI를 채운다.
const TEAMS_QUERY: &str = r#"
query {
  teams(first: 100) {
    nodes { id key name }
  }
}
"#;

const GLOBAL_METADATA_QUERY: &str = r#"
query {
  viewer { id name displayName avatarUrl }
  teams(first: 100) {
    nodes { id key name }
    pageInfo { hasNextPage }
  }
  issueLabels(first: 100) {
    nodes { id name color }
    pageInfo { hasNextPage }
  }
}
"#;

const TEAM_METADATA_QUERY: &str = r#"
query($teamId: String!) {
  team(id: $teamId) {
    id
    states(first: 50) {
      nodes { id name color type position }
      pageInfo { hasNextPage }
    }
    members(first: 100) {
      nodes { id name displayName avatarUrl }
      pageInfo { hasNextPage }
    }
    projects(first: 100) {
      nodes { id name team { id } }
      pageInfo { hasNextPage }
    }
  }
}
"#;

/// 한 팀의 워크플로우 상태 목록.
///
/// # Jira와 모델이 다르다 (DECISIONS 25.5)
///
/// Jira는 `/issue/{key}/transitions`로 **그 티켓에서 지금 갈 수 있는 곳**을 받는다.
/// Linear는 팀의 상태 목록을 받아 그중 하나를 `stateId`로 지정한다 — 전이 개념이
/// 없고 어디로든 갈 수 있다.
///
/// 따라서 **이슈 단위가 아니라 팀 단위 조회**다. 목록의 이슈 30건이 같은 팀이면
/// 조회는 한 번이고, 프론트가 팀 id로 캐시를 나눈다.
const TEAM_STATES_QUERY: &str = r#"
query($teamId: String!) {
  team(id: $teamId) {
    states(first: 50) {
      nodes { id name color type position }
    }
  }
}
"#;

/// `viewer` 확인. 설정창 [확인] 버튼 한 방.
const VIEWER_QUERY: &str = r#"
query { viewer { id name } }
"#;

/// 상세 조회.
///
/// # 왜 목록 쿼리에 `description`을 넣지 않았나
///
/// 이슈 본문은 길다. 30건을 받으면서 본문까지 실으면 페이로드가 몇 배가 되고,
/// 그중 사용자가 실제로 읽는 것은 열어본 하나다 — "필요한 필드만 남긴다"는
/// 원칙(CLAUDE.md)이 정확히 이 경우를 말한다.
///
/// 그래서 Jira 상세와 같은 구조를 쓴다: 목록이 가진 값으로 **모달 골격을 0ms에**
/// 그리고, 본문만 뒤에 채운다 (DECISIONS 11.4 D2 / 25.6).
const ISSUE_DETAIL_QUERY: &str = r#"
query($id: String!) {
  issue(id: $id) {
    id
    identifier
    description
    branchName
  }
}
"#;

/// 상태 변경.
///
/// **`issueUpdate`는 멱등이 아니다** — 자동 재시도를 하지 않는다(25.5).
/// Jira 전이와 같은 판단이며, 여기서는 성공 응답이 `success: Boolean!`이라
/// 본문을 봐야 한다(Jira는 204 No Content였다).
const ISSUE_UPDATE_STATE_MUTATION: &str = r#"
mutation($id: String!, $stateId: String!) {
  issueUpdate(id: $id, input: { stateId: $stateId }) {
    success
  }
}
"#;

fn issue_create_mutation() -> String {
    format!(
        r#"
mutation($input: IssueCreateInput!) {{
  issueCreate(input: $input) {{
    success
    issue {{ {ISSUE_FIELDS} }}
  }}
}}
"#
    )
}

/// Linear API 키. **Debug에 절대 노출하지 않는다** (CLAUDE.md: 마스킹 필수).
#[derive(Clone)]
pub struct LinearCredentials {
    api_key: String,
}

impl LinearCredentials {
    pub fn new(api_key: impl Into<String>) -> Self {
        Self {
            api_key: api_key.into(),
        }
    }
}

impl std::fmt::Debug for LinearCredentials {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        // 길이만 남긴다. 키가 로그에 찍히면 그걸로 끝이다.
        f.debug_struct("LinearCredentials")
            .field("api_key", &format_args!("<{}자>", self.api_key.len()))
            .finish()
    }
}

pub struct LinearClient {
    http: reqwest::Client,
    credentials: LinearCredentials,
}

impl std::fmt::Debug for LinearClient {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("LinearClient")
            .field("credentials", &self.credentials)
            .finish_non_exhaustive()
    }
}

impl LinearClient {
    pub fn new(credentials: LinearCredentials) -> LinearResult<Self> {
        Self::with_timeout(credentials, DEFAULT_TIMEOUT)
    }

    pub fn with_timeout(credentials: LinearCredentials, timeout: Duration) -> LinearResult<Self> {
        let http = reqwest::Client::builder()
            .timeout(timeout)
            .connect_timeout(DEFAULT_CONNECT_TIMEOUT)
            .gzip(true)
            .user_agent(concat!("my-pegboard/", env!("CARGO_PKG_VERSION")))
            .build()
            .map_err(|e| LinearError::Network {
                message: format!("HTTP 클라이언트 생성 실패: {e}"),
            })?;
        Ok(Self { http, credentials })
    }

    /// 이미 만들어둔 클라이언트를 공유 (커넥션 풀 재사용).
    pub fn with_http_client(http: reqwest::Client, credentials: LinearCredentials) -> Self {
        Self { http, credentials }
    }

    /// GraphQL 요청 한 번. **모든 호출이 여기를 지난다.**
    ///
    /// 에러 분류의 유일한 관문이다. 개별 메서드가 상태 코드를 보지 않는다.
    async fn graphql<T: serde::de::DeserializeOwned>(
        &self,
        query: &str,
        variables: Value,
        context: &str,
    ) -> LinearResult<T> {
        let response = self
            .http
            .post(GRAPHQL_URL)
            // ★ `bearer_auth`가 아니다. Linear는 키를 그대로 받는다 —
            //   "Bearer "를 붙이면 401이다 (모듈 문서 참조).
            .header("Authorization", auth_header_value(&self.credentials))
            .header("Content-Type", "application/json")
            .json(&json!({ "query": query, "variables": variables }))
            .send()
            .await
            .map_err(|e| LinearError::Network {
                message: format!("{context}: {e}"),
            })?;

        let status = response.status().as_u16();

        // 헤더는 본문을 읽기 전에 챙긴다 (본문 읽기가 소유권을 가져간다).
        let reset_at_ms = rate_limit_reset_ms(&response);

        let body = response
            .text()
            .await
            .map_err(|error| body_read_error(context, error))?;

        if !(200..300).contains(&status) {
            return Err(classify_status(
                status,
                extract_message(&body).unwrap_or_else(|| preview(&body)),
                &body,
                reset_at_ms,
                now_ms(),
            ));
        }

        // GraphQL은 실패해도 200을 준다. 본문의 errors를 봐야 한다.
        let envelope: GqlEnvelope<T> =
            serde_json::from_str(&body).map_err(|e| LinearError::Decode {
                message: format!("{context}: {e} (본문 앞부분: {})", preview(&body)),
            })?;

        if !envelope.errors.is_empty() {
            let message = envelope
                .errors
                .iter()
                .map(|e| e.message.as_str())
                .collect::<Vec<_>>()
                .join("; ");

            // rate limit만은 일시적이다. 200 본문으로도 올 수 있다.
            let coded_rate_limit = envelope.errors.iter().any(|e| {
                e.extensions
                    .as_ref()
                    .and_then(|x| x.code.as_deref())
                    .is_some_and(|c| c.eq_ignore_ascii_case(super::error::RATELIMITED_CODE))
            });
            if coded_rate_limit || body_says_rate_limited(&body) {
                return Err(LinearError::RateLimited {
                    message,
                    retry_after_secs: reset_at_ms
                        .map(|reset| reset.saturating_sub(now_ms()) / 1000),
                });
            }
            return Err(LinearError::GraphqlErrors { message });
        }

        envelope.data.ok_or_else(|| LinearError::Decode {
            message: format!("{context}: data가 비어 있습니다"),
        })
    }

    /// 이슈 목록. **목록 위젯의 유일한 진입점.**
    ///
    /// GitHub의 `search`와 달리 **총 건수가 없다.** Linear 커넥션은 `totalCount`를
    /// 주지 않으므로 "217건 중 30건"을 만들 수 없다 — Jira 신규 검색과 같다.
    pub async fn issues(
        &self,
        scope: PresetScope,
        filter: &Value,
        team_ids: &[String],
        sort: LinearSort,
        direction: LinearSortDirection,
        limit: u32,
    ) -> LinearResult<LinearIssuePage> {
        let filter = apply_team_scope(filter, team_ids);
        let order_by = sort.as_str();
        let mut variables = pagination_args(direction, limit);
        variables["filter"] = filter;

        let connection = match scope.viewer_connection() {
            Some(name) => {
                let query = viewer_issues_query(name, order_by);
                let data: ViewerIssuesData = self.graphql(&query, variables, "이슈 목록").await?;
                data.viewer.and_then(|v| v.issues)
            }
            None => {
                let query = all_issues_query(order_by);
                let data: IssuesData = self.graphql(&query, variables, "이슈 목록").await?;
                data.issues
            }
        };

        // 커넥션 자체가 없으면 스키마가 우리 기대와 다르다. **조용히 빈 목록을
        // 돌려주지 않는다** — 빈 목록은 "조건에 맞는 게 없다"로 읽히고, 그건
        // 우리가 응답을 못 읽었다는 사실을 숨긴다.
        let Some(connection) = connection else {
            return Err(LinearError::Decode {
                message: "이슈 목록: 응답에 이슈 커넥션이 없습니다".to_owned(),
            });
        };

        // 파싱 못 한 항목은 버리고 나머지를 살린다. 하나가 이상하다고
        // 목록 전체를 실패시키지 않는다 (CLAUDE.md: 목록이 사라지면 안 된다).
        let issues: Vec<LinearIssue> = connection
            .nodes
            .into_iter()
            .flatten()
            .filter_map(IssueNode::flatten)
            .collect();

        Ok(finish_page(issues, connection.page_info, direction))
    }

    /// 팀 목록. 설정창의 범위 UI를 채운다.
    ///
    /// 100개에서 끊는다. 팀이 그보다 많은 조직에서 드롭다운은 이미 고를 수 없는
    /// UI이고, 그때는 목록이 아니라 검색이 필요하다.
    pub async fn teams(&self) -> LinearResult<Vec<LinearTeam>> {
        let data: TeamsData = self.graphql(TEAMS_QUERY, json!({}), "팀 목록").await?;
        let Some(connection) = data.teams else {
            return Err(LinearError::Decode {
                message: "팀 목록: 응답에 teams가 없습니다".to_owned(),
            });
        };
        Ok(connection
            .nodes
            .into_iter()
            .flatten()
            .filter_map(|t| t.into_team())
            .collect())
    }

    pub async fn global_metadata(&self) -> LinearResult<LinearGlobalMetadata> {
        let data: GlobalMetadataData = self
            .graphql(GLOBAL_METADATA_QUERY, json!({}), "Linear 메타데이터")
            .await?;
        let fetched_at = Utc::now();
        let mut metadata = flatten_global_metadata(data)?;
        metadata.teams.fetched_at = Some(fetched_at);
        metadata.labels.fetched_at = Some(fetched_at);
        Ok(metadata)
    }

    pub async fn team_metadata(&self, team_id: &str) -> LinearResult<LinearTeamMetadata> {
        let data: TeamMetadataData = self
            .graphql(
                TEAM_METADATA_QUERY,
                json!({ "teamId": team_id }),
                "Linear 팀 메타데이터",
            )
            .await?;
        let fetched_at = Utc::now();
        let mut metadata = flatten_team_metadata(data, team_id)?;
        metadata.states.fetched_at = Some(fetched_at);
        metadata.members.fetched_at = Some(fetched_at);
        metadata.projects.fetched_at = Some(fetched_at);
        Ok(metadata)
    }

    /// 한 팀의 워크플로우 상태 목록. 상태 변경 팝오버를 채운다.
    ///
    /// **`position` 순으로 정렬해서 준다.** 정렬 책임을 화면에 넘기지 않는다 —
    /// 팀이 정한 순서(백로그 → 할 일 → 진행 중 → 완료)가 곧 사용자가 기대하는
    /// 순서다.
    pub async fn team_states(&self, team_id: &str) -> LinearResult<Vec<LinearWorkflowState>> {
        let data: TeamStatesData = self
            .graphql(TEAM_STATES_QUERY, json!({ "teamId": team_id }), "상태 목록")
            .await?;

        let Some(states) = data.team.and_then(|t| t.states) else {
            // 팀이 없거나 볼 권한이 없다. 빈 배열로 뭉개면 팝오버가
            // "가능한 상태가 없습니다"를 그리는데, 그건 다른 사실이다.
            return Err(LinearError::NotFound {
                message: format!("팀을 찾을 수 없습니다: {team_id}"),
            });
        };

        let mut list: Vec<LinearWorkflowState> = states
            .nodes
            .into_iter()
            .flatten()
            .filter_map(|s| s.into_workflow_state())
            .collect();
        list.sort_by(|a, b| a.position.total_cmp(&b.position));
        Ok(list)
    }

    /// 이슈 상태 변경. **우리가 Linear에 하는 유일한 쓰기다.**
    ///
    /// 자동 재시도가 없다 — `issueUpdate`는 멱등이 아니다. 호출자(커맨드)도
    /// 재시도하지 않고, 재시도 판단은 사람이 팝오버에서 한다.
    ///
    /// `success: false`를 성공으로 뭉개지 않는다. HTTP 200 + `errors` 없음 +
    /// `success: false`가 가능한 조합이고, 그걸 넘기면 **바뀌지 않은 상태를
    /// 바뀌었다고 보고**한다.
    pub async fn update_issue_state(&self, issue_id: &str, state_id: &str) -> LinearResult<()> {
        let data: IssueUpdateData = self
            .graphql(
                ISSUE_UPDATE_STATE_MUTATION,
                json!({ "id": issue_id, "stateId": state_id }),
                "상태 변경",
            )
            .await?;

        match data.issue_update.and_then(|p| p.success) {
            Some(true) => Ok(()),
            Some(false) => Err(LinearError::BadRequest {
                message: "Linear가 상태 변경을 거절했습니다 (success: false)".to_owned(),
            }),
            None => Err(LinearError::Decode {
                message: "상태 변경: 응답에 success가 없습니다".to_owned(),
            }),
        }
    }

    pub async fn create_issue(&self, input: &LinearCreateIssueInput) -> LinearResult<LinearIssue> {
        let team_id = input.team_id.trim();
        if team_id.is_empty() {
            return Err(LinearError::BadRequest {
                message: "Linear 이슈 생성: 팀을 선택하세요".to_owned(),
            });
        }
        let title = input.title.trim();
        if title.is_empty() {
            return Err(LinearError::BadRequest {
                message: "Linear 이슈 생성: 제목을 입력하세요".to_owned(),
            });
        }
        if input.priority.is_some_and(|priority| priority > 4) {
            return Err(LinearError::BadRequest {
                message: "Linear 이슈 생성: 우선순위는 0부터 4까지만 가능합니다".to_owned(),
            });
        }

        let mut normalized = input.clone();
        normalized.team_id = team_id.to_owned();
        normalized.title = title.to_owned();
        let query = issue_create_mutation();
        let data: IssueCreateData = self
            .graphql(
                &query,
                json!({ "input": normalized.to_graphql_input() }),
                "이슈 생성",
            )
            .await?;
        flatten_issue_create(data)
    }

    /// 이슈 본문(markdown). 상세 모달이 골격을 그린 뒤에 채운다.
    ///
    /// **디스크에 캐시하지 않는다** — 낡은 본문을 보여줄 바에는 잠깐 비는 편이
    /// 정직하다 (Jira 상세와 같은 판단, DECISIONS 11.4 D2).
    pub async fn issue_detail(&self, issue_id: &str) -> LinearResult<LinearIssueDetail> {
        let data: IssueDetailData = self
            .graphql(ISSUE_DETAIL_QUERY, json!({ "id": issue_id }), "이슈 상세")
            .await?;

        let issue = data.issue.ok_or_else(|| LinearError::NotFound {
            message: format!("이슈를 찾을 수 없습니다: {issue_id}"),
        })?;

        Ok(LinearIssueDetail {
            id: issue.id.unwrap_or_else(|| issue_id.to_owned()),
            identifier: issue.identifier.unwrap_or_default(),
            // `description`이 없는 것과 빈 것을 구분하지 않는다 — 화면에서
            // 둘 다 "설명이 없습니다"이고, 그것이 사실이다.
            description: issue.description,
            branch_name: issue.branch_name,
        })
    }

    /// API 키가 실제로 동작하는지. 설정창 [확인] 버튼.
    pub async fn viewer(&self) -> LinearResult<LinearViewer> {
        let data: ViewerData = self.graphql(VIEWER_QUERY, json!({}), "연결 확인").await?;
        let user = data.viewer.ok_or_else(|| LinearError::Decode {
            message: "연결 확인: 응답에 viewer가 없습니다".to_owned(),
        })?;
        Ok(LinearViewer {
            id: user.id.unwrap_or_default(),
            name: user
                .display_name
                .or(user.name)
                .unwrap_or_else(|| "이름 없음".to_owned()),
        })
    }
}

fn body_read_error(context: &str, error: impl std::fmt::Display) -> LinearError {
    LinearError::Network {
        message: format!("{context}: 응답 본문을 읽지 못했습니다: {error}"),
    }
}

/// `Authorization` 헤더 값.
///
/// **키를 그대로 쓴다.** 별도 함수로 뽑은 이유는 테스트가 이 형태를 고정할 수
/// 있게 하려는 것이다 — `Bearer `가 붙으면 401이 되고, 그건 실제 요청을 보내야만
/// 드러나는 종류의 실패다.
pub fn auth_header_value(credentials: &LinearCredentials) -> String {
    credentials.api_key.clone()
}

#[cfg(test)]
fn decode_global_metadata(body: &str) -> LinearResult<LinearGlobalMetadata> {
    let envelope: GqlEnvelope<GlobalMetadataData> =
        serde_json::from_str(body).map_err(|error| LinearError::Decode {
            message: format!("Linear 메타데이터: {error}"),
        })?;
    if !envelope.errors.is_empty() {
        return Err(LinearError::GraphqlErrors {
            message: envelope
                .errors
                .iter()
                .map(|error| error.message.as_str())
                .collect::<Vec<_>>()
                .join("; "),
        });
    }
    let data = envelope.data.ok_or_else(|| LinearError::Decode {
        message: "Linear 메타데이터: data가 비어 있습니다".to_owned(),
    })?;
    flatten_global_metadata(data)
}

#[cfg(test)]
fn decode_team_metadata(body: &str, team_id: &str) -> LinearResult<LinearTeamMetadata> {
    let envelope: GqlEnvelope<TeamMetadataData> =
        serde_json::from_str(body).map_err(|error| LinearError::Decode {
            message: format!("Linear 팀 메타데이터: {error}"),
        })?;
    if !envelope.errors.is_empty() {
        return Err(LinearError::GraphqlErrors {
            message: envelope
                .errors
                .iter()
                .map(|error| error.message.as_str())
                .collect::<Vec<_>>()
                .join("; "),
        });
    }
    let data = envelope.data.ok_or_else(|| LinearError::Decode {
        message: "Linear 팀 메타데이터: data가 비어 있습니다".to_owned(),
    })?;
    flatten_team_metadata(data, team_id)
}

fn flatten_global_metadata(data: GlobalMetadataData) -> LinearResult<LinearGlobalMetadata> {
    let teams = data.teams.ok_or_else(|| LinearError::Decode {
        message: "Linear 메타데이터: 응답에 teams가 없습니다".to_owned(),
    })?;
    let labels = data.issue_labels.ok_or_else(|| LinearError::Decode {
        message: "Linear 메타데이터: 응답에 issueLabels가 없습니다".to_owned(),
    })?;

    Ok(LinearGlobalMetadata {
        teams: LinearMetadataList {
            items: teams
                .nodes
                .into_iter()
                .flatten()
                .filter_map(|team| team.into_team())
                .collect(),
            fetched_at: None,
            truncated: teams
                .page_info
                .is_some_and(|page_info| page_info.has_next_page),
        },
        viewer: data.viewer.and_then(UserNode::into_user_option),
        labels: LinearMetadataList {
            items: labels
                .nodes
                .into_iter()
                .flatten()
                .filter_map(|label| {
                    Some(LinearLabelOption {
                        id: label.id?,
                        name: label.name?,
                        color: label.color.unwrap_or_default(),
                    })
                })
                .collect(),
            fetched_at: None,
            truncated: labels
                .page_info
                .is_some_and(|page_info| page_info.has_next_page),
        },
    })
}

fn flatten_team_metadata(
    data: TeamMetadataData,
    requested_team_id: &str,
) -> LinearResult<LinearTeamMetadata> {
    let team = data.team.ok_or_else(|| LinearError::Decode {
        message: format!("Linear 팀 메타데이터: 팀 응답이 없습니다: {requested_team_id}"),
    })?;
    let states = team.states.ok_or_else(|| LinearError::Decode {
        message: format!("Linear 팀 메타데이터: states가 없습니다: {requested_team_id}"),
    })?;
    let members = team.members.ok_or_else(|| LinearError::Decode {
        message: format!("Linear 팀 메타데이터: members가 없습니다: {requested_team_id}"),
    })?;
    let projects = team.projects.ok_or_else(|| LinearError::Decode {
        message: format!("Linear 팀 메타데이터: projects가 없습니다: {requested_team_id}"),
    })?;

    let mut state_items: Vec<_> = states
        .nodes
        .into_iter()
        .flatten()
        .filter_map(StateNode::into_workflow_state)
        .collect();
    state_items.sort_by(|left, right| left.position.total_cmp(&right.position));

    let mut member_items: Vec<_> = members
        .nodes
        .into_iter()
        .flatten()
        .filter_map(UserNode::into_user_option)
        .collect();
    member_items.sort_by_key(|member| member.name.to_lowercase());

    let mut project_items: Vec<_> = projects
        .nodes
        .into_iter()
        .flatten()
        .filter_map(|project: ProjectMetadataNode| {
            Some(LinearProjectOption {
                id: project.id?,
                name: project.name?,
                team_id: project
                    .team
                    .and_then(|team| team.id)
                    .unwrap_or_else(|| requested_team_id.to_owned()),
            })
        })
        .collect();
    project_items.sort_by_key(|project| project.name.to_lowercase());

    Ok(LinearTeamMetadata {
        team_id: team.id.unwrap_or_else(|| requested_team_id.to_owned()),
        states: LinearMetadataList {
            items: state_items,
            fetched_at: None,
            truncated: states
                .page_info
                .is_some_and(|page_info| page_info.has_next_page),
        },
        members: LinearMetadataList {
            items: member_items,
            fetched_at: None,
            truncated: members
                .page_info
                .is_some_and(|page_info| page_info.has_next_page),
        },
        projects: LinearMetadataList {
            items: project_items,
            fetched_at: None,
            truncated: projects
                .page_info
                .is_some_and(|page_info| page_info.has_next_page),
        },
    })
}

fn flatten_issue_create(data: IssueCreateData) -> LinearResult<LinearIssue> {
    let payload = data.issue_create.ok_or_else(|| LinearError::Decode {
        message: "이슈 생성: 응답에 issueCreate가 없습니다".to_owned(),
    })?;
    match payload.success {
        Some(false) => Err(LinearError::BadRequest {
            message: "Linear가 이슈 생성을 거절했습니다 (success: false)".to_owned(),
        }),
        Some(true) => {
            payload
                .issue
                .and_then(IssueNode::flatten)
                .ok_or_else(|| LinearError::Decode {
                    message: "이슈 생성: 성공 응답에 issue가 없거나 읽을 수 없습니다".to_owned(),
                })
        }
        None => Err(LinearError::Decode {
            message: "이슈 생성: 응답에 success가 없습니다".to_owned(),
        }),
    }
}

#[cfg(test)]
fn decode_issue_create(body: &str) -> LinearResult<LinearIssue> {
    let envelope: GqlEnvelope<IssueCreateData> =
        serde_json::from_str(body).map_err(|error| LinearError::Decode {
            message: format!("이슈 생성: {error}"),
        })?;
    if !envelope.errors.is_empty() {
        let message = envelope
            .errors
            .iter()
            .map(|error| error.message.as_str())
            .collect::<Vec<_>>()
            .join("; ");
        if body_says_rate_limited(body) {
            return Err(LinearError::RateLimited {
                message,
                retry_after_secs: None,
            });
        }
        return Err(LinearError::GraphqlErrors { message });
    }
    let data = envelope.data.ok_or_else(|| LinearError::Decode {
        message: "이슈 생성: data가 비어 있습니다".to_owned(),
    })?;
    flatten_issue_create(data)
}

/// rate limit 리셋 시각(UTC epoch **밀리초**).
///
/// Linear는 `Retry-After`가 아니라 `X-RateLimit-*-Reset`을 준다. 요청 수와
/// 복잡도가 각각 있고, **둘 중 더 늦은 쪽**을 쓴다 — 이른 쪽에 맞춰 다시 쏘면
/// 남은 한도에 또 걸린다.
fn rate_limit_reset_ms(response: &reqwest::Response) -> Option<u64> {
    let requests = header_u64(response, "x-ratelimit-requests-reset");
    let complexity = header_u64(response, "x-ratelimit-complexity-reset");
    match (requests, complexity) {
        (Some(a), Some(b)) => Some(a.max(b)),
        (a, b) => a.or(b),
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

fn now_ms() -> u64 {
    chrono::Utc::now().timestamp_millis().max(0) as u64
}

/// 에러 본문에서 사람이 읽을 메시지를 꺼낸다.
///
/// GraphQL 에러는 `{"errors":[{"message":"..."}]}` 모양이고, 게이트웨이 에러는
/// `{"message":"..."}`일 수 있다. 둘 다 본다. 원문을 그대로 쓰는 게 우리가
/// 다시 쓰는 것보다 낫다 (DECISIONS 16장).
fn extract_message(body: &str) -> Option<String> {
    let value = serde_json::from_str::<Value>(body).ok()?;

    if let Some(errors) = value.get("errors").and_then(|e| e.as_array()) {
        let joined = errors
            .iter()
            .filter_map(|e| e.get("message").and_then(|m| m.as_str()))
            .collect::<Vec<_>>()
            .join("; ");
        if !joined.is_empty() {
            return Some(joined);
        }
    }

    value
        .get("message")
        .and_then(|m| m.as_str())
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

#[cfg(test)]
pub(crate) mod query_exports {
    //! 테스트가 쿼리 문자열을 들여다볼 수 있게 하는 창구.
    //!
    //! 쿼리는 문자열 상수라 오타가 컴파일에 안 잡힌다. 최소한 **필수 필드가
    //! 쿼리에 들어 있는지**는 고정해둔다 — `team { id }`가 빠지면 상태 변경
    //! 팝오버가 조용히 아무것도 못 그린다.
    use super::{LinearIssue, LinearIssuePage, LinearSortDirection};
    use serde_json::Value;

    pub(crate) fn viewer_issues(connection: &str, order_by: &str) -> String {
        super::viewer_issues_query(connection, order_by)
    }
    pub(crate) fn all_issues(order_by: &str) -> String {
        super::all_issues_query(order_by)
    }
    pub(crate) const TEAM_STATES: &str = super::TEAM_STATES_QUERY;
    pub(crate) const ISSUE_UPDATE: &str = super::ISSUE_UPDATE_STATE_MUTATION;
    pub(crate) const GLOBAL_METADATA: &str = super::GLOBAL_METADATA_QUERY;
    pub(crate) const TEAM_METADATA: &str = super::TEAM_METADATA_QUERY;
    pub(crate) fn issue_create() -> String {
        super::issue_create_mutation()
    }

    pub(crate) fn parse_global_metadata(
        body: &str,
    ) -> super::super::error::LinearResult<super::super::types::LinearGlobalMetadata> {
        super::decode_global_metadata(body)
    }

    pub(crate) fn parse_team_metadata(
        body: &str,
    ) -> super::super::error::LinearResult<super::super::types::LinearTeamMetadata> {
        super::decode_team_metadata(body, "team-eng")
    }

    pub(crate) fn parse_issue_create(
        body: &str,
    ) -> super::super::error::LinearResult<super::super::types::LinearIssue> {
        super::decode_issue_create(body)
    }

    pub(crate) fn body_read_error(
        context: &str,
        message: &str,
    ) -> super::super::error::LinearError {
        super::body_read_error(context, message)
    }

    pub(crate) fn pagination_args(direction: LinearSortDirection, limit: u32) -> Value {
        super::pagination_args(direction, limit)
    }

    pub(crate) fn finish_page(
        issues: Vec<LinearIssue>,
        page_info: Option<super::super::types::PageInfo>,
        direction: LinearSortDirection,
    ) -> LinearIssuePage {
        super::finish_page(issues, page_info, direction)
    }
}
