//! GitHub 응답 타입.
//!
//! # 필요한 필드만 남긴다
//!
//! GraphQL 응답은 중첩이 깊다(`commits.nodes[0].commit.statusCheckRollup.state`).
//! 그대로 IPC로 보내면 WebView가 쓰지도 않을 구조를 파싱한다. Rust에서 **평평하게
//! 펴서** 화면이 쓰는 모양 그대로 넘긴다 (CLAUDE.md: 페이로드 1/10).
//!
//! # 왜 PR과 Issue를 한 타입에 담나
//!
//! DECISIONS 12장: 위젯 타입은 하나고 PR/Issue는 쿼리로 구분한다. GitHub에서
//! PR은 이슈의 특수 형태이고, 검색도 한 번에 섞여 나온다. 타입을 나누면 목록을
//! 두 갈래로 그려야 하는데 화면에서 둘의 차이는 **뱃지 몇 개**뿐이다.
//!
//! PR 고유 필드(`review`, `ci`, `additions`)는 `Option`이다. Issue면 전부 `None`.

use serde::{Deserialize, Serialize};
use specta::Type;

/// 목록 한 줄. **화면이 그리는 모양 그대로**다.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct GithubItem {
    /// `owner/name#123` — 목록에서 유일하다. React key로 쓴다.
    pub id: String,
    pub number: i64,
    pub title: String,
    /// `owner/name`. 화면이 좁으면 `owner/`를 버리므로 나누지 않고 통째로 준다.
    pub repository: String,
    /// 클릭하면 열 주소.
    pub url: String,
    pub author: Option<String>,
    /// PR인가. false면 Issue다.
    pub is_pull_request: bool,
    pub state: ItemState,
    /// PR만. 리뷰가 요청되지 않았으면 `None`(실측: `reviewDecision`이 null).
    pub review: Option<ReviewState>,
    /// PR만. CI를 안 돌리는 저장소면 `None`.
    pub ci: Option<CheckState>,
    /// PR만. 변경 규모.
    pub additions: Option<i64>,
    pub deletions: Option<i64>,
    /// ISO 8601. "2일 전" 표시와 정렬에 쓴다.
    pub updated_at: String,
    /// 코멘트 수. 0이면 화면에 그리지 않는다.
    pub comments: i64,
}

/// 항목의 상태. PR과 Issue를 한 축에 모았다.
///
/// `Draft`를 따로 두는 이유: GraphQL은 `isDraft`를 `state`와 **별도 필드**로
/// 준다(실측). 화면에서는 초안이 열림과 다른 아이콘이라 여기서 합쳐둔다.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum ItemState {
    Open,
    /// PR만.
    Draft,
    /// PR만.
    Merged,
    Closed,
}

/// PR 리뷰 결정. GraphQL `reviewDecision`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum ReviewState {
    Approved,
    ChangesRequested,
    ReviewRequired,
}

/// CI 종합 상태. GraphQL `statusCheckRollup.state`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum CheckState {
    Success,
    Failure,
    Pending,
    /// `ERROR` / `EXPECTED` — 성공도 실패도 아닌 것들.
    Other,
}

/// 검색 결과 한 페이지.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct GithubSearchPage {
    pub items: Vec<GithubItem>,
    /// 전체 건수. GitHub 검색은 Jira와 달리 **총계를 준다**(실측: `issueCount`).
    /// 그래서 "42건 중 30건" 표시가 가능하다 — Jira 위젯과 다른 점이다.
    pub total: i64,
    /// 이 응답이 쓴 rate limit 포인트. 설정창 "정보"에 노출한다.
    pub cost: Option<i64>,
    pub rate_limit_remaining: Option<i64>,
}

/// 설정창 저장소 목록의 한 줄.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct GithubRepo {
    /// `owner/name`. 설정에 저장되는 식별자다.
    pub name_with_owner: String,
    /// 최근 푸시 시각(ISO 8601). 목록 정렬 기준 — 68개를 알파벳순으로 늘어놓으면
    /// 지금 일하는 저장소를 찾아야 한다.
    pub pushed_at: Option<String>,
    pub is_private: bool,
    pub is_archived: bool,
}

// ─────────────────────────── GraphQL 응답 파싱용 ───────────────────────────
//
// 아래 타입들은 **네트워크 경계 전용**이다. IPC로 나가지 않는다.
// GraphQL의 깊은 중첩을 여기서 받아 위의 평평한 타입으로 편다.

#[derive(Debug, Deserialize)]
pub(crate) struct GqlEnvelope<T> {
    pub data: Option<T>,
    #[serde(default)]
    pub errors: Vec<GqlError>,
}

#[derive(Debug, Deserialize)]
pub(crate) struct GqlError {
    pub message: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SearchData {
    pub search: SearchResult,
    pub rate_limit: Option<GqlRateLimit>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SearchResult {
    pub issue_count: i64,
    /// `null`이 섞여 온다 — PR도 Issue도 아닌 타입(Discussion 등)이 검색에
    /// 걸리면 fragment가 매칭되지 않아 빈 객체가 된다. 걸러낸다.
    #[serde(default)]
    pub nodes: Vec<Option<SearchNode>>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct GqlRateLimit {
    pub cost: i64,
    pub remaining: i64,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SearchNode {
    /// `__typename`으로 PR/Issue를 가른다. fragment만으로는 구분이 안 온다.
    #[serde(rename = "__typename")]
    pub typename: Option<String>,
    pub number: Option<i64>,
    pub title: Option<String>,
    pub url: Option<String>,
    pub state: Option<String>,
    pub is_draft: Option<bool>,
    pub merged: Option<bool>,
    pub review_decision: Option<String>,
    pub additions: Option<i64>,
    pub deletions: Option<i64>,
    pub updated_at: Option<String>,
    pub author: Option<GqlActor>,
    pub repository: Option<GqlRepository>,
    pub comments: Option<GqlCount>,
    /// CI는 `commits(last: 1)` 아래에 있다 — 최상위 필드가 아니다(실측).
    pub commits: Option<GqlCommits>,
}

#[derive(Debug, Deserialize)]
pub(crate) struct GqlActor {
    pub login: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct GqlRepository {
    pub name_with_owner: String,
}

#[derive(Debug, Deserialize)]
pub(crate) struct GqlCount {
    #[serde(rename = "totalCount")]
    pub total_count: i64,
}

#[derive(Debug, Deserialize)]
pub(crate) struct GqlCommits {
    #[serde(default)]
    pub nodes: Vec<GqlCommitNode>,
}

#[derive(Debug, Deserialize)]
pub(crate) struct GqlCommitNode {
    pub commit: Option<GqlCommit>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct GqlCommit {
    pub status_check_rollup: Option<GqlRollup>,
}

#[derive(Debug, Deserialize)]
pub(crate) struct GqlRollup {
    pub state: String,
}

// ── 저장소 목록 ──

#[derive(Debug, Deserialize)]
pub(crate) struct ReposData {
    pub viewer: ReposViewer,
}

#[derive(Debug, Deserialize)]
pub(crate) struct ReposViewer {
    pub repositories: RepoConnection,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RepoConnection {
    #[serde(default)]
    pub nodes: Vec<Option<RepoNode>>,
    pub page_info: PageInfo,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PageInfo {
    pub has_next_page: bool,
    pub end_cursor: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RepoNode {
    pub name_with_owner: String,
    pub pushed_at: Option<String>,
    pub is_private: bool,
    pub is_archived: bool,
}

impl SearchNode {
    /// GraphQL 노드를 화면이 쓰는 평평한 항목으로 편다.
    ///
    /// 필수 필드가 없으면 `None`을 돌려 **그 항목만** 버린다. 하나가 이상하다고
    /// 목록 전체를 실패시키지 않는다 — 목록이 사라지면 안 된다(CLAUDE.md).
    pub(crate) fn flatten(self) -> Option<GithubItem> {
        let repository = self.repository?.name_with_owner;
        let number = self.number?;
        let is_pull_request = self.typename.as_deref() == Some("PullRequest");

        let state = match (self.state.as_deref(), self.is_draft, self.merged) {
            (_, _, Some(true)) => ItemState::Merged,
            (Some("MERGED"), _, _) => ItemState::Merged,
            (Some("CLOSED"), _, _) => ItemState::Closed,
            (Some("OPEN"), Some(true), _) => ItemState::Draft,
            (Some("OPEN"), _, _) => ItemState::Open,
            // 모르는 상태를 열림으로 뭉개지 않는다. 닫힘으로 두면 눈에 덜 띄어
            // 놓칠 수 있으므로 열림 쪽이 안전하다.
            _ => ItemState::Open,
        };

        let review = match self.review_decision.as_deref() {
            Some("APPROVED") => Some(ReviewState::Approved),
            Some("CHANGES_REQUESTED") => Some(ReviewState::ChangesRequested),
            Some("REVIEW_REQUIRED") => Some(ReviewState::ReviewRequired),
            _ => None,
        };

        let ci = self
            .commits
            .and_then(|c| c.nodes.into_iter().next())
            .and_then(|n| n.commit)
            .and_then(|c| c.status_check_rollup)
            .map(|r| match r.state.as_str() {
                "SUCCESS" => CheckState::Success,
                "FAILURE" => CheckState::Failure,
                "PENDING" => CheckState::Pending,
                _ => CheckState::Other,
            });

        Some(GithubItem {
            id: format!("{repository}#{number}"),
            number,
            title: self.title.unwrap_or_default(),
            url: self.url.unwrap_or_default(),
            author: self.author.map(|a| a.login),
            is_pull_request,
            state,
            review,
            ci,
            additions: self.additions,
            deletions: self.deletions,
            updated_at: self.updated_at.unwrap_or_default(),
            comments: self.comments.map_or(0, |c| c.total_count),
            repository,
        })
    }
}
