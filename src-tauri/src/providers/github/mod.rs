//! GitHub provider — GraphQL API v4 (github.com 전용).
//!
//! 위젯 하나 = provider 하나 (CLAUDE.md "철칙"). 이 모듈은 GitHub에 대해 아는
//! 전부를 담고, 그 바깥(캐시·스케줄러·키체인·커맨드)에 대해서는 아무것도 모른다.
//!
//! # 경계 (Jira provider와 동일)
//!
//! - **자격증명을 스스로 읽지 않는다.** [`GithubCredentials`]를 인자로 받는다.
//! - **재시도하지 않는다.** [`GithubError::kind`]로 일시/영구를 알려줄 뿐이다.
//! - **캐시하지 않는다.**
//!
//! # 확인된 환경 (실측, 2026-08-02)
//!
//! - GraphQL 검색 1회 = **1점** / 시간당 5000점. rate limit은 제약이 아니다
//! - `statusCheckRollup`은 `commits(last: 1).nodes[0].commit` 아래에 있다
//! - `reviewDecision`은 리뷰어가 지정되지 않으면 `null`
//! - PR 상태는 `state` + `isDraft` + `merged` 조합으로 판정한다
//! - 검색은 **총 건수를 준다**(`issueCount`) — Jira 신규 검색과 다른 점
//!
//! # Enterprise 미지원
//!
//! `api.github.com` 고정이다. GHE는 엔드포인트가 다르고 스키마 버전도 다르다.
//! 필요해지면 base URL을 설정으로 빼야 하는데, 지금 쓰는 곳이 없다
//! (DECISIONS 12.1).

pub mod client;
pub mod error;
pub mod presets;
pub mod types;

#[cfg(test)]
mod tests;

pub use client::{GithubClient, GithubCredentials};
pub use error::{ErrorKind, GithubError, GithubResult};
pub use presets::{apply_repo_filter, GithubPreset, GithubQuery, DEFAULT_PRESET_ID, PRESETS};
pub use types::{
    CheckState, GithubItem, GithubRepo, GithubSearchPage, ItemState, ReviewState,
};
