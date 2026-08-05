//! Jira provider — REST v3 (Atlassian Cloud).
//!
//! 위젯 하나 = provider 하나 (CLAUDE.md "철칙"). 이 모듈은 Jira에 대해 아는 전부를 담고,
//! 그 바깥(캐시·스케줄러·키체인·커맨드)에 대해서는 아무것도 모른다.
//!
//! # 경계
//!
//! - **자격증명을 스스로 읽지 않는다.** [`JiraCredentials`]를 인자로 받는다. 키체인은 `secrets/` 소관.
//! - **재시도하지 않는다.** [`JiraError::kind`]로 일시/영구를 알려줄 뿐, 백오프는 `scheduler/` 소관.
//! - **캐시하지 않는다.** `cache/` 소관.
//!
//! # 확인된 환경 (실측, 2026-07-29)
//!
//! - Atlassian Cloud `https://your-team.atlassian.net`, cloudId `00000000-0000-0000-0000-000000000000`
//! - 검색은 `/rest/api/3/search/jql` — 구 `/rest/api/3/search`는 deprecated이고 **total을 주지 않는다**
//! - `description`은 ADF JSON, 사용자 식별자는 `accountId`
//! - 프로젝트마다 생성 필수 필드가 다르다 (ABC 3개 / XYZ 4개) → `createmeta` 필수
//!
//! # 사용
//!
//! ```no_run
//! # async fn demo() -> Result<(), Box<dyn std::error::Error>> {
//! use my_pegboard_lib::providers::jira::{JiraClient, JiraCredentials, JiraQuery, LIST_FIELDS};
//!
//! let client = JiraClient::new(JiraCredentials::new(
//!     "https://your-team.atlassian.net",
//!     "me@example.com",
//!     "api-token",
//! ))?;
//!
//! let jql = JiraQuery::Preset { id: "assigned-to-me".into() }
//!     .to_jql()
//!     .expect("known preset");
//!
//! let page = client.search_issues(&jql, 30, LIST_FIELDS).await?;
//! for issue in &page.issues {
//!     println!("{} {}", issue.key, issue.summary);
//! }
//! // page.next_page_token 이 Some이면 다음 페이지가 있다. total은 존재하지 않는다.
//! # Ok(())
//! # }
//! ```

pub mod client;
pub mod error;
pub mod presets;
pub mod types;

#[cfg(test)]
mod tests;

pub use client::{
    auth_header, build_search_body, fields_param, join_url, JiraClient, JiraCredentials,
    DEFAULT_MAX_RESULTS, DEFAULT_TIMEOUT, MAX_RESULTS_LIMIT,
};
pub use error::{parse_retry_after, ErrorKind, JiraError};
pub use presets::{
    apply_sort, default_query, is_numeric_filter_id, JiraQuery, Preset, SortDirection, SortField,
    PRESETS,
};
pub use types::{
    Adf, AllowedValue, CommentPage, CreateIssueInput, CreateMeta, CreateMetaField, CreatedIssue,
    JiraComment, JiraFilter, JiraIdentity, JiraIssue, JiraIssueDetail, JiraIssueType,
    JiraIssueTypeOption, JiraPriority, JiraStatus, JiraParent, JiraProject, JiraProjectWithTypes,
    JiraSprint, JiraStatusCategory, JiraUser, SearchPage, DETAIL_FIELDS, LIST_FIELDS,
};
