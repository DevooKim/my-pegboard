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
    // `openSprints()`는 "지금 활성화된 스프린트 전부"다. Jira에 '현재 스프린트'라는
    // 단일 개념은 없다 — 보드마다 스프린트가 따로 돌기 때문. 여러 보드에 걸쳐
    // 진행 중인 스프린트를 모두 포함하는 것이 실무에서 원하는 동작이다.
    // (실측: 내 것 22건 / 전체 285건)
    Preset {
        id: "current-sprint-mine",
        name: "현재 스프린트 — 내 티켓",
        description: "진행 중인 스프린트에서 내가 담당인 미해결 티켓",
        jql: "sprint IN openSprints() AND assignee = currentUser() AND resolution = Unresolved \
              ORDER BY updated DESC",
    },
    Preset {
        id: "current-sprint-team",
        name: "현재 스프린트 — 전체",
        description: "진행 중인 스프린트의 미해결 티켓 (담당자 무관)",
        // 전체 285건은 위젯 하나에 담기엔 너무 넓다. 그래도 스코프를 임의로
        // 좁히지 않는 이유: '우리 팀'의 정의가 조직마다 달라 프리셋으로 표현할 수
        // 없다(DECISIONS 11.1). 좁히려면 JQL 직접 입력으로 가는 것이 정직하다.
        jql: "sprint IN openSprints() AND resolution = Unresolved ORDER BY updated DESC",
    },
    Preset {
        id: "reported-by-me",
        name: "내가 보고한 티켓",
        description: "내가 만들었고 아직 해결되지 않은 티켓",
        jql: "reporter = currentUser() AND resolution = Unresolved ORDER BY updated DESC",
    },
    Preset {
        id: "my-projects-recent",
        name: "최근 내가 관련된 티켓",
        description: "담당·보고·관찰 중인 티켓 가운데 최근 2주 안에 움직인 것",
        // 이전 JQL은 두 가지가 틀렸다(실측으로 확인):
        //
        //   1. `projectsLeadByUser()`가 0건이었다. 프로젝트 리드가 아니면 아무것도
        //      반환하지 않는다. "내 프로젝트"라는 이름과 동작이 전혀 달랐다.
        //   2. 괄호가 없어 `A OR (B AND C)`로 해석됐다. `updated >= -14d`가
        //      OR 왼쪽 항에는 적용되지 않아, 리드 프로젝트가 있었다면 그쪽은
        //      기간 제한 없이 전부 들어왔을 것이다.
        //
        // 지금은 "내가 관련된 티켓"을 명시적으로 나열하고 기간을 전체에 건다.
        // (실측: 27건)
        jql: "(assignee = currentUser() OR reporter = currentUser() OR watcher = currentUser()) \
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

// ---------------------------------------------------------------------------
// 정렬 (프리셋 전용)
// ---------------------------------------------------------------------------

/// 프리셋에 적용할 정렬 기준.
///
/// **생 JQL에는 적용하지 않는다.** 사용자가 쓴 JQL에 이미 `ORDER BY`가 있으면
/// 우리가 덧붙일 수 없고, 없더라도 정렬은 그 JQL의 일부로 사용자가 정할 몫이다.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub enum SortField {
    Updated,
    Created,
    Due,
    Priority,
    Key,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub enum SortDirection {
    Asc,
    Desc,
}

impl SortField {
    /// JQL 필드명.
    pub fn as_jql(self) -> &'static str {
        match self {
            SortField::Updated => "updated",
            SortField::Created => "created",
            SortField::Due => "duedate",
            SortField::Priority => "priority",
            SortField::Key => "key",
        }
    }
}

/// 프리셋 JQL의 `ORDER BY`를 사용자가 고른 것으로 교체한다.
///
/// 프리셋은 완성된 JQL(`... ORDER BY updated DESC`)을 들고 있으므로,
/// 덧붙이는 게 아니라 **잘라내고 다시 붙여야** 한다. 두 개가 남으면 400이다.
pub fn apply_sort(jql: &str, field: SortField, dir: SortDirection) -> String {
    let base = match jql.to_uppercase().find(" ORDER BY ") {
        Some(i) => &jql[..i],
        None => jql,
    }
    .trim();

    let d = match dir {
        SortDirection::Asc => "ASC",
        SortDirection::Desc => "DESC",
    };
    format!("{base} ORDER BY {} {d}", field.as_jql())
}

#[cfg(test)]
mod sort_tests {
    use super::{apply_sort, SortDirection, SortField, Preset};

    #[test]
    fn replaces_existing_order_by_rather_than_appending() {
        // 프리셋은 이미 ORDER BY를 들고 있다. 두 개가 되면 Jira가 400을 낸다.
        let out = apply_sort(
            "assignee = currentUser() ORDER BY updated DESC",
            SortField::Created,
            SortDirection::Asc,
        );
        assert_eq!(out, "assignee = currentUser() ORDER BY created ASC");
        assert_eq!(out.to_uppercase().matches("ORDER BY").count(), 1);
    }

    #[test]
    fn adds_order_by_when_absent() {
        let out = apply_sort("x = 1", SortField::Due, SortDirection::Desc);
        assert_eq!(out, "x = 1 ORDER BY duedate DESC");
    }

    #[test]
    fn every_preset_survives_every_sort_combination() {
        for preset in Preset::all() {
            for field in [
                SortField::Updated,
                SortField::Created,
                SortField::Due,
                SortField::Priority,
                SortField::Key,
            ] {
                for dir in [SortDirection::Asc, SortDirection::Desc] {
                    let out = apply_sort(preset.jql, field, dir);
                    assert_eq!(
                        out.to_uppercase().matches("ORDER BY").count(),
                        1,
                        "프리셋 {}에 ORDER BY가 중복됐다: {out}",
                        preset.id
                    );
                    assert!(!out.contains("  "), "연속 공백: {out}");
                }
            }
        }
    }

    #[test]
    fn lowercase_order_by_is_also_replaced() {
        let out = apply_sort("x = 1 order by created", SortField::Key, SortDirection::Asc);
        assert_eq!(out, "x = 1 ORDER BY key ASC");
    }
}
