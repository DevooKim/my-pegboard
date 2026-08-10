//! Linear 응답 타입.
//!
//! # 필요한 필드만 남긴다
//!
//! GraphQL 응답은 중첩이 깊다(`viewer.assignedIssues.nodes[].state.color`).
//! 그대로 IPC로 보내면 WebView가 쓰지도 않을 구조를 파싱한다. Rust에서 **평평하게
//! 펴서** 화면이 쓰는 모양 그대로 넘긴다 (CLAUDE.md: 페이로드 1/10).
//!
//! # ★ 모든 필드에 `#[serde(default)]`
//!
//! **Linear API 키가 없어 실제 응답을 한 번도 받지 못했다** (DECISIONS 25.7).
//! 공개 `schema.graphql`을 근거로 썼으므로 모양이 다를 가능성이 있다. 필드 하나가
//! 없다고 목록 전체가 죽으면 "왜 안 뜨지"만 남으므로, 없는 필드는 비고 나머지는
//! 살아남게 한다. 저장된 필터(`/filter/search`)에서 같은 판단을 한 적이 있다.
//!
//! # 접두사 `Linear`
//!
//! specta는 모듈 경로를 버리고 **struct 이름만** 가져간다. `Preset`이 Jira와
//! GitHub 양쪽에 있어 생성물에 같은 타입이 두 번 나온 사고가 있었다.
//! IPC 경계로 나가는 타입에는 provider 이름을 접두사로 붙인다.

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use specta::Type;

/// 목록 한 줄. **화면이 그리는 모양 그대로**다.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct LinearIssue {
    /// Linear 내부 UUID. `issueUpdate(id:)`가 이걸 받는다.
    /// **화면에 보여주지 않는다** — 사람이 읽는 식별자는 `identifier`다.
    pub id: String,
    /// `ENG-123`. 목록에서 유일하므로 React key로도 쓸 수 있지만, 이론적으로
    /// 팀 이름이 바뀌면 달라질 수 있어 key는 `id`를 쓴다.
    pub identifier: String,
    pub title: String,
    /// 클릭하면 열 주소. Linear가 완성된 URL을 준다 — 우리가 조립하지 않는다.
    pub url: String,

    /// 상태. **팀마다 다르다** — 이름·색·개수 전부.
    pub state: LinearState,

    /// **`priorityLabel`을 그대로 쓴다.** `priority` 정수(0~4)의 의미를
    /// 실측하지 못했으므로 숫자를 해석하지 않는다 (25.3).
    /// 0을 "없음"으로 가정하면 틀렸을 때 조용히 잘못된 배지를 그린다.
    pub priority_label: String,
    /// 정수 우선순위. **정렬·표시에 쓰지 않는다.** 나중에 실측한 뒤 판단할
    /// 재료로만 남긴다 — 지금 쓰면 모르는 것을 아는 척하는 것이다.
    pub priority: i64,

    /// 담당자 이름. 미할당이면 `None`.
    pub assignee: Option<String>,
    pub assignee_avatar_url: Option<String>,

    /// 팀 이름(`Engineering`). 그룹 헤더에 쓴다.
    pub team_name: String,
    /// 팀 id. **상태 변경 팝오버가 이 팀의 상태 목록을 조회한다.**
    /// 같은 팀 이슈들이 목록을 공유하므로 프론트가 이 값으로 캐시를 나눈다.
    pub team_id: String,

    /// 프로젝트 이름. 프로젝트에 속하지 않은 이슈가 흔하다.
    pub project_name: Option<String>,

    /// `YYYY-MM-DD` 또는 ISO 8601. Linear가 무엇을 주는지 실측하지 못했다 —
    /// 프론트가 두 모양 모두 견디게 만들어 뒀다.
    pub due_date: Option<String>,
    /// 스토리 포인트. 팀이 추정을 안 쓰면 `None`.
    pub estimate: Option<i64>,

    /// ISO 8601. "2일 전" 표시와 정렬에 쓴다.
    pub updated_at: String,
    pub created_at: String,

    /// 라벨 이름. 없으면 빈 배열.
    pub labels: Vec<String>,
}

/// 워크플로우 상태.
///
/// # `type`을 색의 근거로 쓰지 않는다
///
/// Jira는 `statusCategory.key`가 `new`/`indeterminate`/`done` 셋으로 고정이라
/// 색을 그것으로 골랐다. Linear의 `WorkflowState.type`은 공개 스키마의 값은
/// 확인했지만 **실제 응답을 실측하지 못했다**(25.3). 그래서 **`color`를 쓴다** — 스키마가 상태마다
/// 색을 주므로 우리가 매핑을 발명할 필요가 없고, Linear에서 보던 색과 같아진다.
///
/// `type`은 그래도 담아 보낸다. 완료 여부 같은 판단이 나중에 필요해질 수 있고,
/// **모르는 값이 와도 문자열이라 아무것도 깨지지 않는다.**
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct LinearState {
    /// 상태 id. `issueUpdate(input: { stateId })`가 받는 값.
    pub id: String,
    pub name: String,
    /// `#rgb`/`#rrggbb`. 배지 색의 유일한 근거다.
    pub color: String,
    /// 스키마상 `String!`. 값의 종류를 모르므로 **분기하지 않는다.**
    pub type_name: String,
}

/// 목록 한 페이지.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct LinearIssuePage {
    pub issues: Vec<LinearIssue>,
    /// 다음 페이지 커서. **총 건수는 없다** — Linear 커넥션은 `totalCount`를
    /// 주지 않으므로 GitHub처럼 "217건 중 30건"을 만들 수 없다. Jira 신규
    /// 검색과 같은 처지다.
    pub next_cursor: Option<String>,
}

/// 상세 모달이 나중에 채우는 부분.
///
/// 목록이 이미 가진 값(제목·상태·담당자·팀·날짜)은 여기 없다 — 모달 골격을
/// **0ms에** 그리는 재료는 목록에서 오고, 이 조회는 본문만 채운다
/// (Jira 상세와 같은 구조, DECISIONS 11.4 D2 / 25.6).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct LinearIssueDetail {
    pub id: String,
    pub identifier: String,
    /// **markdown이다.** Jira의 ADF와 다르므로 ADF 렌더러를 재사용할 수 없다.
    /// 프론트의 `markdown/` 렌더러가 의존성 0으로 그린다 (DECISIONS 25.6).
    pub description: Option<String>,
    /// `sammy/eng-142-redirect`. 브랜치를 만들 때 복사해 쓴다.
    pub branch_name: Option<String>,
}

/// 설정창 팀 목록의 한 줄.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct LinearTeam {
    pub id: String,
    /// `ENG`. 화면이 짧게 보여줄 때 쓴다.
    pub key: String,
    pub name: String,
}

/// 상태 변경 팝오버를 채우는 한 줄.
///
/// Jira의 `JiraTransition`과 **모델이 다르다.** Jira는 "지금 실행 가능한 전이"를
/// 서버가 계산해 주는데, Linear는 "이 팀에 있는 상태 전부"다. 어디로든 갈 수 있고
/// 필수 필드 개념이 없다 — `has_required_fields`에 해당하는 필드가 없는 이유다
/// (DECISIONS 25.5).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct LinearWorkflowState {
    pub id: String,
    pub name: String,
    pub color: String,
    pub type_name: String,
    /// 팀이 정한 표시 순서. Rust가 이 값으로 정렬해서 준다 —
    /// 정렬 책임을 화면에 넘기지 않는다.
    pub position: f64,
}

/// `viewer` 확인 결과. 설정창 [확인] 버튼이 쓴다.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct LinearViewer {
    pub id: String,
    pub name: String,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct LinearMetadataList<T> {
    pub items: Vec<T>,
    pub fetched_at: Option<DateTime<Utc>>,
    pub truncated: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct LinearUserOption {
    pub id: String,
    pub name: String,
    pub avatar_url: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct LinearProjectOption {
    pub id: String,
    pub name: String,
    pub team_id: String,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct LinearLabelOption {
    pub id: String,
    pub name: String,
    pub color: String,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct LinearGlobalMetadata {
    pub teams: LinearMetadataList<LinearTeam>,
    pub viewer: Option<LinearUserOption>,
    pub labels: LinearMetadataList<LinearLabelOption>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct LinearTeamMetadata {
    pub team_id: String,
    pub states: LinearMetadataList<LinearWorkflowState>,
    pub members: LinearMetadataList<LinearUserOption>,
    pub projects: LinearMetadataList<LinearProjectOption>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct LinearCreateIssueInput {
    pub team_id: String,
    pub title: String,
    pub description: Option<String>,
    pub state_id: Option<String>,
    pub assignee_id: Option<String>,
    pub priority: Option<u8>,
    pub project_id: Option<String>,
}

impl LinearCreateIssueInput {
    pub fn to_graphql_input(&self) -> serde_json::Value {
        serde_json::json!({
            "teamId": self.team_id,
            "title": self.title,
            "description": self.description,
            "stateId": self.state_id,
            "assigneeId": self.assignee_id,
            "priority": self.priority,
            "projectId": self.project_id,
        })
    }
}

// ─────────────────────────── GraphQL 응답 파싱용 ───────────────────────────
//
// 아래 타입들은 **네트워크 경계 전용**이다. IPC로 나가지 않으므로 `pub(crate)`이고
// 이름이 자유롭다. GraphQL의 깊은 중첩을 여기서 받아 위의 평평한 타입으로 편다.

#[derive(Debug, Deserialize)]
pub(crate) struct GqlEnvelope<T> {
    pub data: Option<T>,
    #[serde(default)]
    pub errors: Vec<GqlError>,
}

#[derive(Debug, Deserialize)]
pub(crate) struct GqlError {
    #[serde(default)]
    pub message: String,
    #[serde(default)]
    pub extensions: Option<GqlErrorExtensions>,
}

#[derive(Debug, Deserialize)]
pub(crate) struct GqlErrorExtensions {
    /// `RATELIMITED` 등. 이 문자열 하나로 재시도 정책이 갈린다.
    #[serde(default)]
    pub code: Option<String>,
}

/// `viewer { assignedIssues|createdIssues(...) { ... } }`
#[derive(Debug, Deserialize)]
pub(crate) struct ViewerIssuesData {
    #[serde(default)]
    pub viewer: Option<ViewerIssues>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ViewerIssues {
    /// 프리셋마다 다른 커넥션을 쓰므로 셋 다 optional로 받고, 있는 것을 쓴다.
    /// 쿼리에서 alias(`issues:`)를 붙여 이름을 하나로 모은다.
    #[serde(default)]
    pub issues: Option<IssueConnection>,
}

/// 최상위 `issues(filter: ...)` — 팀 범위·전체 조회용.
#[derive(Debug, Deserialize)]
pub(crate) struct IssuesData {
    #[serde(default)]
    pub issues: Option<IssueConnection>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct IssueConnection {
    #[serde(default)]
    pub nodes: Vec<Option<IssueNode>>,
    #[serde(default)]
    pub page_info: Option<PageInfo>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PageInfo {
    #[serde(default)]
    pub has_next_page: bool,
    #[serde(default)]
    pub end_cursor: Option<String>,
    #[serde(default)]
    pub has_previous_page: bool,
    #[serde(default)]
    pub start_cursor: Option<String>,
}

/// GraphQL의 이슈 노드. **모든 필드가 `Option` + `serde(default)`다** —
/// 모듈 문서의 미검증 사정 참조.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct IssueNode {
    #[serde(default)]
    pub id: Option<String>,
    #[serde(default)]
    pub identifier: Option<String>,
    #[serde(default)]
    pub title: Option<String>,
    #[serde(default)]
    pub url: Option<String>,
    #[serde(default)]
    pub priority: Option<f64>,
    #[serde(default)]
    pub priority_label: Option<String>,
    #[serde(default)]
    pub estimate: Option<f64>,
    #[serde(default)]
    pub due_date: Option<String>,
    #[serde(default)]
    pub updated_at: Option<String>,
    #[serde(default)]
    pub created_at: Option<String>,
    #[serde(default)]
    pub state: Option<StateNode>,
    #[serde(default)]
    pub assignee: Option<UserNode>,
    #[serde(default)]
    pub team: Option<TeamNode>,
    #[serde(default)]
    pub project: Option<ProjectNode>,
    #[serde(default)]
    pub labels: Option<LabelConnection>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct StateNode {
    #[serde(default)]
    pub id: Option<String>,
    #[serde(default)]
    pub name: Option<String>,
    #[serde(default)]
    pub color: Option<String>,
    /// 스키마 필드 이름은 `type`. Rust 예약어라 rename한다.
    #[serde(default, rename = "type")]
    pub state_type: Option<String>,
    #[serde(default)]
    pub position: Option<f64>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct UserNode {
    #[serde(default)]
    pub id: Option<String>,
    #[serde(default)]
    pub name: Option<String>,
    #[serde(default)]
    pub display_name: Option<String>,
    #[serde(default)]
    pub avatar_url: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct TeamNode {
    #[serde(default)]
    pub id: Option<String>,
    #[serde(default)]
    pub key: Option<String>,
    #[serde(default)]
    pub name: Option<String>,
}

#[derive(Debug, Deserialize)]
pub(crate) struct ProjectNode {
    #[serde(default)]
    pub name: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct LabelConnection {
    #[serde(default)]
    pub nodes: Vec<Option<LabelNode>>,
    #[serde(default)]
    pub page_info: Option<PageInfo>,
}

#[derive(Debug, Deserialize)]
pub(crate) struct LabelNode {
    #[serde(default)]
    pub id: Option<String>,
    #[serde(default)]
    pub name: Option<String>,
    #[serde(default)]
    pub color: Option<String>,
}

/// `issue(id:) { description branchName }`
#[derive(Debug, Deserialize)]
pub(crate) struct IssueDetailData {
    #[serde(default)]
    pub issue: Option<IssueDetailNode>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct IssueDetailNode {
    #[serde(default)]
    pub id: Option<String>,
    #[serde(default)]
    pub identifier: Option<String>,
    #[serde(default)]
    pub description: Option<String>,
    #[serde(default)]
    pub branch_name: Option<String>,
}

/// `teams { nodes { ... } }`
#[derive(Debug, Deserialize)]
pub(crate) struct TeamsData {
    #[serde(default)]
    pub teams: Option<TeamConnection>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct TeamConnection {
    #[serde(default)]
    pub nodes: Vec<Option<TeamNode>>,
    #[serde(default)]
    pub page_info: Option<PageInfo>,
}

/// `team(id:) { states { nodes { ... } } }`
#[derive(Debug, Deserialize)]
pub(crate) struct TeamStatesData {
    #[serde(default)]
    pub team: Option<TeamWithStates>,
}

#[derive(Debug, Deserialize)]
pub(crate) struct TeamWithStates {
    #[serde(default)]
    pub states: Option<StateConnection>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct StateConnection {
    #[serde(default)]
    pub nodes: Vec<Option<StateNode>>,
    #[serde(default)]
    pub page_info: Option<PageInfo>,
}

/// `viewer { id name }`
#[derive(Debug, Deserialize)]
pub(crate) struct ViewerData {
    #[serde(default)]
    pub viewer: Option<UserNode>,
}

#[derive(Debug, Deserialize)]
pub(crate) struct GlobalMetadataData {
    #[serde(default)]
    pub viewer: Option<UserNode>,
    #[serde(default)]
    pub teams: Option<TeamConnection>,
    #[serde(default, rename = "issueLabels")]
    pub issue_labels: Option<LabelConnection>,
}

#[derive(Debug, Deserialize)]
pub(crate) struct TeamMetadataData {
    #[serde(default)]
    pub team: Option<TeamMetadataNode>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct TeamMetadataNode {
    #[serde(default)]
    pub id: Option<String>,
    #[serde(default)]
    pub states: Option<StateConnection>,
    #[serde(default)]
    pub members: Option<UserConnection>,
    #[serde(default)]
    pub projects: Option<ProjectConnection>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct UserConnection {
    #[serde(default)]
    pub nodes: Vec<Option<UserNode>>,
    #[serde(default)]
    pub page_info: Option<PageInfo>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ProjectConnection {
    #[serde(default)]
    pub nodes: Vec<Option<ProjectMetadataNode>>,
    #[serde(default)]
    pub page_info: Option<PageInfo>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ProjectMetadataNode {
    #[serde(default)]
    pub id: Option<String>,
    #[serde(default)]
    pub name: Option<String>,
    #[serde(default)]
    pub team: Option<TeamNode>,
}

/// `issueUpdate(...) { success }`
#[derive(Debug, Deserialize)]
pub(crate) struct IssueUpdateData {
    #[serde(default, rename = "issueUpdate")]
    pub issue_update: Option<IssuePayload>,
}

#[derive(Debug, Deserialize)]
pub(crate) struct IssuePayload {
    #[serde(default)]
    pub success: Option<bool>,
}

#[derive(Debug, Deserialize)]
pub(crate) struct IssueCreateData {
    #[serde(default, rename = "issueCreate")]
    pub issue_create: Option<IssueCreatePayload>,
}

#[derive(Debug, Deserialize)]
pub(crate) struct IssueCreatePayload {
    #[serde(default)]
    pub success: Option<bool>,
    #[serde(default)]
    pub issue: Option<IssueNode>,
}

impl IssueNode {
    /// GraphQL 노드를 화면이 쓰는 평평한 항목으로 편다.
    ///
    /// **필수 최소값이 없으면 `None`을 돌려 그 항목만 버린다.** 하나가 이상하다고
    /// 목록 전체를 실패시키지 않는다 — 목록이 사라지면 안 된다(CLAUDE.md).
    ///
    /// 최소값은 `id`·`identifier`·`state`·`team`이다. 앞의 둘이 없으면 클릭도
    /// 상태 변경도 못 하고, 뒤의 둘이 없으면 배지와 그룹을 그릴 수 없다.
    pub(crate) fn flatten(self) -> Option<LinearIssue> {
        let id = self.id?;
        let identifier = self.identifier?;

        let state_node = self.state?;
        let state = LinearState {
            id: state_node.id.unwrap_or_default(),
            // 이름이 없으면 빈 문자열이 아니라 물음표를 넣는다 — 빈 배지는
            // "상태가 없다"로 보이지만 실제로는 우리가 못 읽은 것이다.
            name: state_node.name.unwrap_or_else(|| "?".to_owned()),
            color: normalize_color(state_node.color.as_deref()),
            type_name: state_node.state_type.unwrap_or_default(),
        };

        let team = self.team?;

        let assignee = self.assignee;
        let (assignee_name, assignee_avatar_url) = match assignee {
            // `displayName`이 짧아서 목록에 낫다. 없으면 `name`으로 내려간다.
            Some(u) => (u.display_name.or(u.name), u.avatar_url),
            None => (None, None),
        };

        let labels = self
            .labels
            .map(|c| {
                c.nodes
                    .into_iter()
                    .flatten()
                    .filter_map(|l| l.name)
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default();

        Some(LinearIssue {
            id,
            identifier,
            title: self.title.unwrap_or_default(),
            url: self.url.unwrap_or_default(),
            state,
            // 라벨이 없으면 빈 문자열이다. 프론트가 빈 문자열을 "표시하지 않음"으로
            // 다룬다 — 우리가 "없음" 같은 말을 발명하면 그게 Linear의 표현과
            // 다를 때 거짓이 된다.
            priority_label: self.priority_label.unwrap_or_default(),
            priority: self.priority.unwrap_or(0.0) as i64,
            assignee: assignee_name,
            assignee_avatar_url,
            team_name: team.name.or(team.key).unwrap_or_default(),
            team_id: team.id.unwrap_or_default(),
            project_name: self.project.and_then(|p| p.name),
            due_date: self.due_date,
            estimate: self.estimate.map(|e| e as i64),
            updated_at: self.updated_at.unwrap_or_default(),
            created_at: self.created_at.unwrap_or_default(),
            labels,
        })
    }
}

impl StateNode {
    /// 팝오버가 쓰는 상태 한 줄. `id`가 없으면 고를 수 없으므로 버린다.
    pub(crate) fn into_workflow_state(self) -> Option<LinearWorkflowState> {
        let id = self.id?;
        Some(LinearWorkflowState {
            id,
            name: self.name.unwrap_or_else(|| "?".to_owned()),
            color: normalize_color(self.color.as_deref()),
            type_name: self.state_type.unwrap_or_default(),
            position: self.position.unwrap_or(0.0),
        })
    }
}

impl TeamNode {
    pub(crate) fn into_team(self) -> Option<LinearTeam> {
        let id = self.id?;
        Some(LinearTeam {
            key: self.key.clone().unwrap_or_default(),
            name: self.name.or(self.key).unwrap_or_default(),
            id,
        })
    }
}

impl UserNode {
    pub(crate) fn into_user_option(self) -> Option<LinearUserOption> {
        let id = self.id?;
        Some(LinearUserOption {
            id,
            name: self
                .display_name
                .or(self.name)
                .unwrap_or_else(|| "이름 없음".to_owned()),
            avatar_url: self.avatar_url,
        })
    }
}

/// 색을 CSS에 그대로 넣을 수 있는 모양으로 만든다.
///
/// **이 값은 `style={{ backgroundColor }}`로 들어간다.** 그래서 여기가
/// 인젝션 지점이다 — 이스케이프가 아니라 **화이트리스트**로 막는다
/// (`is_numeric_filter_id`가 필터 id를 다루는 것과 같은 판단).
/// `#` + 16진수 3·4·6·8자리만 통과시키고, 아니면 회색으로 떨어진다.
///
/// 회색으로 떨어지는 것은 조용한 실패가 아니다 — 상태 **이름**이 배지에 그대로
/// 적혀 있어서 정보가 사라지지 않는다. 색만 기본값이 된다.
fn normalize_color(color: Option<&str>) -> String {
    const FALLBACK: &str = "#8a8f98";
    let Some(raw) = color else {
        return FALLBACK.to_owned();
    };
    let trimmed = raw.trim();
    let Some(hex) = trimmed.strip_prefix('#') else {
        return FALLBACK.to_owned();
    };
    let valid_len = matches!(hex.len(), 3 | 4 | 6 | 8);
    if valid_len && hex.chars().all(|c| c.is_ascii_hexdigit()) {
        trimmed.to_owned()
    } else {
        FALLBACK.to_owned()
    }
}
