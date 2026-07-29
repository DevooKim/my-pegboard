//! JQL 프리셋 (DECISIONS 11.1).
//!
//! 결정의 요지: **프리셋 몇 개 + JQL 직접 입력 탈출구.** 폼 빌더는 만들지 않는다.
//! "내 티켓"은 프리셋으로 완벽히 커버되지만 "우리 팀 티켓"은 조직마다 정의가 달라
//! 프리셋으로 표현할 수 없다. 그 경계에서 JQL로 넘긴다.
//!
//! 모든 프리셋은 `currentUser()`를 쓴다 — **accountId를 미리 조회할 필요가 없다.**
//! 이건 단순한 편의가 아니라 시작 성능 문제다. 위젯 4개가 각자 `/myself`를 부르지 않는다.

use serde::{Deserialize, Serialize};

/// 위젯 config에 저장되는 쿼리. 프리셋이거나 생 JQL이거나 둘 중 하나.
///
/// 프리셋을 JQL 문자열로 굳혀 저장하지 않는 이유: 나중에 프리셋 정의를 고치면
/// 이미 배치된 위젯들도 같이 고쳐져야 한다. id로 저장하면 그게 공짜다.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, specta::Type)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum JiraQuery {
    /// 프리셋 id. 알 수 없는 id면 [`JiraQuery::to_jql`]가 `None`을 준다.
    Preset { id: String },
    /// 탈출구. 사용자가 직접 쓴 JQL을 **그대로** 보낸다.
    ///
    /// 검증하지 않는다 — 우리가 JQL 파서를 쓸 이유가 없고, 틀리면 Jira가
    /// 훨씬 나은 에러 메시지를 준다 (DECISIONS 16장, 400은 원문 보존).
    Raw { jql: String },
}

impl JiraQuery {
    /// 실제로 API에 보낼 JQL. 프리셋 id가 미지면 `None`.
    pub fn to_jql(&self) -> Option<String> {
        match self {
            JiraQuery::Preset { id } => Preset::by_id(id).map(|p| p.jql.to_owned()),
            JiraQuery::Raw { jql } => Some(jql.clone()),
        }
    }

    /// 위젯 기본 제목 (DECISIONS 11.2 — "제목: 프리셋 이름, 덮어쓰기 가능").
    pub fn default_title(&self) -> String {
        match self {
            JiraQuery::Preset { id } => Preset::by_id(id)
                .map(|p| p.name.to_owned())
                .unwrap_or_else(|| "Jira".to_owned()),
            JiraQuery::Raw { .. } => "Jira".to_owned(),
        }
    }
}

/// 프리셋 정의. 정적 테이블이므로 `&'static str`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct Preset {
    /// 저장되는 안정적 식별자. **한번 정하면 바꾸지 않는다** (기존 위젯이 깨진다).
    pub id: &'static str,
    /// 설정 UI에 보이는 이름.
    pub name: &'static str,
    /// 이 프리셋이 무엇을 보여주는지 한 줄 설명.
    pub description: &'static str,
    pub jql: &'static str,
}

/// 정렬 기준은 전부 `updated DESC`로 통일한다 (DECISIONS 11.2 기본 정렬).
///
/// 각 프리셋에 `ORDER BY`를 박아둔 이유: 위젯이 정렬을 따로 조합하면
/// 사용자 JQL에 이미 `ORDER BY`가 있을 때 문자열을 이어붙이다 깨진다.
/// 프리셋은 완성된 JQL을 들고 있고, 생 JQL은 사용자가 알아서 한다.
pub const PRESETS: &[Preset] = &[
    Preset {
        id: "assigned-to-me",
        name: "내게 할당된 티켓",
        description: "내가 담당자이고 아직 해결되지 않은 티켓",
        jql: "assignee = currentUser() AND resolution = Unresolved ORDER BY updated DESC",
    },
    Preset {
        id: "reported-by-me",
        name: "내가 보고한 티켓",
        description: "내가 만들었고 아직 해결되지 않은 티켓",
        jql: "reporter = currentUser() AND resolution = Unresolved ORDER BY updated DESC",
    },
    Preset {
        id: "my-projects-recent",
        name: "최근 업데이트된 내 프로젝트",
        description: "내가 참여 중인 프로젝트에서 최근 2주 안에 움직인 티켓",
        // `project IN projectsWhereUserHasPermission(...)`가 아니라 `issueFunction`도 아닌
        // 표준 JQL만 쓴다. Jira Cloud 기본 설치에서 동작하는 함수만 사용한다.
        jql: "project IN projectsLeadByUser() OR (assignee = currentUser() OR reporter = currentUser()) \
              AND updated >= -14d ORDER BY updated DESC",
    },
    Preset {
        id: "watched-by-me",
        name: "내가 지켜보는 티켓",
        description: "watch 중이고 아직 해결되지 않은 티켓",
        jql: "watcher = currentUser() AND resolution = Unresolved ORDER BY updated DESC",
    },
    Preset {
        id: "mentioned-recently",
        name: "최근 나를 언급한 티켓",
        description: "코멘트나 설명에서 나를 언급한, 최근 2주 내 움직인 티켓",
        jql: "text ~ currentUser() AND updated >= -14d ORDER BY updated DESC",
    },
];

impl Preset {
    /// id로 조회. 저장된 위젯 config를 읽을 때 쓴다.
    pub fn by_id(id: &str) -> Option<&'static Preset> {
        PRESETS.iter().find(|p| p.id == id)
    }

    /// 설정 UI 드롭다운을 채우는 목록.
    pub fn all() -> &'static [Preset] {
        PRESETS
    }
}

/// 위젯을 새로 만들 때의 기본 쿼리.
pub fn default_query() -> JiraQuery {
    JiraQuery::Preset {
        id: "assigned-to-me".to_owned(),
    }
}

#[cfg(test)]
#[path = "tests/presets_tests.rs"]
mod presets_tests;
