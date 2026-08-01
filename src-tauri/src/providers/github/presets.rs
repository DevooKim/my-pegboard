//! GitHub 검색 프리셋 (DECISIONS 12장).
//!
//! Jira의 `presets.rs`와 같은 구조다 — **프리셋 몇 개 + 직접 입력 탈출구.**
//! GitHub 검색 문법이 JQL 역할을 그대로 하므로 구조를 맞췄다.
//!
//! 모든 프리셋은 `@me`를 쓴다. Jira의 `currentUser()`와 같은 역할이고,
//! 마찬가지로 **로그인 사용자를 미리 조회할 필요가 없다** — 위젯 4개가 각자
//! `viewer`를 부르지 않는다.
//!
//! # 건수 실측 (2026-08-02, DevooKim 계정)
//!
//! | 프리셋 | 건수 |
//! |---|---|
//! | involves-me | 13 |
//! | my-issues | 9 |
//! | my-prs | 3 |
//! | assigned-issues | 2 |
//! | review-requested | **0** |
//!
//! `review-requested`가 0건이지만 남긴다. 회사 저장소가 붙으면 채워질 자리이고,
//! **놓치면 안 되는 것**이라 목록에 없으면 존재를 잊는다. 다만 기본값으로는
//! 쓰지 않는다 — 위젯을 처음 놓았을 때 빈 화면이면 고장으로 보인다.

use serde::{Deserialize, Serialize};

/// 위젯 config에 저장되는 쿼리. 프리셋이거나 생 검색 문자열이거나.
///
/// 프리셋을 문자열로 굳혀 저장하지 않는 이유는 Jira와 같다 — id로 저장하면
/// 나중에 프리셋 정의를 고쳤을 때 이미 배치된 위젯도 같이 고쳐진다.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, specta::Type)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum GithubQuery {
    /// 프리셋 id. 알 수 없는 id면 [`GithubQuery::to_search`]가 `None`을 준다.
    Preset { id: String },
    /// 탈출구. 사용자가 직접 쓴 검색 문자열을 **그대로** 보낸다.
    ///
    /// 검증하지 않는다. 틀리면 GitHub이 우리보다 나은 메시지를 준다.
    Raw { query: String },
}

impl GithubQuery {
    /// 실제로 API에 보낼 검색 문자열. 프리셋 id가 미지면 `None`.
    pub fn to_search(&self) -> Option<String> {
        match self {
            GithubQuery::Preset { id } => GithubPreset::by_id(id).map(|p| p.query.to_owned()),
            GithubQuery::Raw { query } => Some(query.clone()),
        }
    }

    /// 위젯 기본 제목.
    pub fn default_title(&self) -> String {
        match self {
            GithubQuery::Preset { id } => GithubPreset::by_id(id)
                .map(|p| p.name.to_owned())
                .unwrap_or_else(|| "GitHub".to_owned()),
            GithubQuery::Raw { .. } => "GitHub".to_owned(),
        }
    }
}

/// 프리셋 정의. 정적 테이블이므로 `&'static str`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct GithubPreset {
    /// 저장되는 안정적 식별자. **한번 정하면 바꾸지 않는다** (기존 위젯이 깨진다).
    pub id: &'static str,
    pub name: &'static str,
    pub description: &'static str,
    pub query: &'static str,
}

/// 프리셋 5종.
///
/// `is:open`을 전부 박아둔 이유: 닫힌 것까지 섞이면 "지금 볼 것"이라는 목적이
/// 흐려진다. 닫힌 것을 봐야 하면 직접 입력으로 간다.
pub static PRESETS: &[GithubPreset] = &[
    GithubPreset {
        id: "involves-me",
        name: "내가 관련된 것",
        description: "작성·할당·멘션·리뷰 — 내가 얽힌 열린 PR과 이슈 전부",
        query: "involves:@me is:open",
    },
    GithubPreset {
        id: "review-requested",
        name: "리뷰 요청받은 PR",
        description: "나에게 리뷰가 요청된 열린 PR",
        query: "is:pr is:open review-requested:@me",
    },
    GithubPreset {
        id: "my-prs",
        name: "내 PR",
        description: "내가 올린 열린 PR",
        query: "is:pr is:open author:@me",
    },
    GithubPreset {
        id: "assigned-issues",
        name: "내게 할당된 이슈",
        description: "나에게 할당된 열린 이슈",
        query: "is:issue is:open assignee:@me",
    },
    GithubPreset {
        id: "my-issues",
        name: "내가 만든 이슈",
        description: "내가 만든 열린 이슈",
        query: "is:issue is:open author:@me",
    },
];

/// 새 위젯의 기본 프리셋.
///
/// `involves-me`인 이유: 실측에서 가장 건수가 많고(13), 위젯을 처음 놓았을 때
/// **뭐라도 보이는 것**이 중요하다. 빈 목록은 고장처럼 보인다.
pub const DEFAULT_PRESET_ID: &str = "involves-me";

impl GithubPreset {
    pub fn by_id(id: &str) -> Option<&'static GithubPreset> {
        PRESETS.iter().find(|p| p.id == id)
    }
}

/// 저장소 필터를 검색 문자열에 붙인다.
///
/// GitHub 검색에서 `repo:` 여러 개는 **OR**로 동작한다. 그래서 그냥 이어붙이면
/// "이 저장소들 중에서"가 된다 — 우리가 원하는 의미 그대로다.
///
/// 빈 목록이면 원본을 그대로 돌려준다. 필터를 안 건 것이 곧 전체 검색이다.
pub fn apply_repo_filter(search: &str, repos: &[String]) -> String {
    if repos.is_empty() {
        return search.to_owned();
    }
    let filter = repos
        .iter()
        .map(|r| format!("repo:{r}"))
        .collect::<Vec<_>>()
        .join(" ");
    format!("{search} {filter}")
}
