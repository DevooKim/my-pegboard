//! Linear provider — GraphQL API (`api.linear.app`).
//!
//! 위젯 하나 = provider 하나 (CLAUDE.md "철칙"). 이 모듈은 Linear에 대해 아는
//! 전부를 담고, 그 바깥(캐시·스케줄러·키체인·커맨드)에 대해서는 아무것도 모른다.
//!
//! # 경계 (Jira·GitHub provider와 동일)
//!
//! - **자격증명을 스스로 읽지 않는다.** [`LinearCredentials`]를 인자로 받는다.
//! - **재시도하지 않는다.** [`LinearError::kind`]로 일시/영구를 알려줄 뿐이다.
//! - **캐시하지 않는다.**
//!
//! # 공개 스키마로 확인한 것 (`linear/linear`의 `schema.graphql` + 공식 문서)
//!
//! - 엔드포인트 `https://api.linear.app/graphql`
//! - **인증 `Authorization: <API_KEY>` — `Bearer` 접두사가 없다.** 붙이면 401
//! - **rate limit이 HTTP 400이다.** 본문 `errors[].extensions.code == "RATELIMITED"`
//! - 헤더 `X-RateLimit-Requests-Remaining` / `X-RateLimit-Complexity-Remaining`
//!   (+ `-Reset`, UTC epoch **밀리초**)
//! - 한도: 요청 1500~2500/시간, 복잡도 3,000,000점/시간, **단일 쿼리 최대 10,000점**
//! - GraphQL은 실패해도 200을 줄 수 있다 (GitHub과 같은 함정)
//! - `viewer.assignedIssues`가 있다 → accountId 조회 없이 내 이슈를 받는다
//! - **`PaginationOrderBy`는 `createdAt`과 `updatedAt` 둘뿐이다** —
//!   Jira처럼 우선순위·마감일 정렬을 만들 수 없다
//! - 상태 변경은 `issueUpdate(id, input: { stateId })`. **전이 개념이 없다**
//!
//! # ⚠️⚠️ 실측하지 못한 것 (DECISIONS 25.7)
//!
//! **Linear API 키가 없어 실제 응답을 한 번도 받지 못했다.** 저장된 필터
//! (`/filter/search`, DECISIONS 11.1)에서 같은 상황이 있었고 같은 방식으로
//! 처리했다 — 모든 필드에 `#[serde(default)]`를 붙여 모양이 달라도 일부만 비고
//! 전체가 죽지 않게 했다.
//!
//! 틀렸을 가능성이 높은 순서대로:
//!
//! 1. **`priority` 정수 0~4의 의미.** 그래서 숫자를 해석하지 않고
//!    `priorityLabel: String!`을 그대로 표시한다. 0을 "없음"으로 가정하지 않았다
//! 2. **`WorkflowState.type`의 실제 응답.** 공개 스키마는 `triage`·`backlog`·
//!    `unstarted`·`started`·`completed`·`canceled`·`duplicate`를 정의하지만
//!    실제 계정 응답은 못 받았다 → 색은 계속 **`state.color`를 쓴다.** `type`은
//!    완료 제외 필터에만 쓴다
//! 3. **프리셋 필터가 실제로 의도한 이슈를 주는지.** "완료 제외"를
//!    `state.type: { nin: [...] }`로 표현했는데, 값이 틀리면 완료된 것이 섞인다.
//!    `in`이 아니라 `nin`인 이유가 그것이다 — 틀렸을 때 목록이 비는 대신
//!    **눈에 보이게** 틀린다 (`presets.rs`)
//! 4. **`dueDate`의 모양** (`YYYY-MM-DD`인지 ISO 8601인지). 프론트가 둘 다 견딘다
//! 5. **`tests/fixtures/`의 응답이 진짜 모양인지.** GitHub provider의 fixture는
//!    실제 캡처였지만 이쪽은 스키마를 보고 손으로 썼다

pub mod client;
pub mod error;
pub mod presets;
pub mod types;

#[cfg(test)]
mod tests;

pub use client::{LinearClient, LinearCredentials};
pub use error::{ErrorKind, LinearError, LinearResult};
pub use presets::{
    apply_team_scope, LinearAssigneeFilter, LinearCustomFilter, LinearFilterError, LinearKnownIds,
    LinearPreset, LinearQuery, LinearSort, LinearSortDirection, PresetScope, DEFAULT_PRESET_ID,
    PRESETS,
};
pub use types::{
    LinearCreateIssueInput, LinearGlobalMetadata, LinearIssue, LinearIssueDetail, LinearIssuePage,
    LinearLabelOption, LinearMetadataList, LinearProjectOption, LinearState, LinearTeam,
    LinearTeamMetadata, LinearUserOption, LinearViewer, LinearWorkflowState,
};
