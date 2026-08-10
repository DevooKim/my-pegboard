//! Linear 쿼리 프리셋 (DECISIONS 25.2).
//!
//! Jira의 `presets.rs`와 같은 구조다 — **프리셋 몇 개 + 탈출구.**
//! 다만 탈출구의 모양이 다르다.
//!
//! | 서비스 | 탈출구 |
//! |---|---|
//! | Jira | 생 JQL 문자열 |
//! | GitHub | 생 검색 문자열 |
//! | **Linear** | **없다** |
//!
//! Linear의 필터는 문자열이 아니라 **`IssueFilter` JSON 객체**다. 사용자에게
//! GraphQL 필터 JSON을 손으로 쓰게 하는 것은 탈출구가 아니라 함정이다 — 문법
//! 오류를 우리가 검증할 수 없고, Linear의 에러도 JQL 오류만큼 친절하지 않다.
//! 대신 **팀 범위**를 프리셋과 직교하게 두어 조합으로 커버한다.
//!
//! # 모든 프리셋이 `viewer` 기반이다
//!
//! Jira의 `currentUser()`, GitHub의 `@me`와 같은 역할이다. `viewer`는
//! **API 키가 곧 사용자**이므로 accountId 조회가 필요 없다 — 위젯 4개가 각자
//! 자기를 조회하는 왕복이 없다.
//!
//! # ⚠️ 미검증 (DECISIONS 25.7)
//!
//! **API 키가 없어 프리셋이 실제로 의도한 이슈를 주는지 확인하지 못했다.**
//! 특히 "완료되지 않은"을 표현한 `state.type: { nin: [...] }`가 실제 계정에서도
//! 의도대로 동작하는지는 확인하지 못했다. 공개 스키마의 닫힌 상태 타입은
//! 확인했지만 새 타입이 추가될 수도 있다. 그래서
//! [`Self::completed_filter`]는 **`nin`(제외)** 방식이다 — 모르는 값이 오면
//! **포함되는** 쪽으로 기운다. `in`(포함)으로 썼다가 값이 틀리면 목록이 통째로
//! 비고, 그건 고장과 구별되지 않는다.

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

/// 위젯 config에 저장되는 쿼리.
///
/// **프리셋 id만 저장한다.** 필터 JSON을 굳혀 저장하지 않는 이유는 Jira·GitHub과
/// 같다 — id로 저장하면 나중에 프리셋 정의를 고쳤을 때 이미 배치된 위젯도 같이
/// 고쳐진다.
///
/// `enum`을 유지하는 이유: 나중에 "저장된 뷰(`customView`)" 같은 갈래가 생길
/// 자리다. Jira가 프리셋 → 저장된 필터로 늘어난 것과 같은 모양이 될 것이다.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, specta::Type)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum LinearQuery {
    /// 프리셋 id. 알 수 없는 id면 [`LinearQuery::to_filter`]가 `None`을 준다.
    Preset { id: String },
}

impl LinearQuery {
    /// 실제로 API에 보낼 `IssueFilter`. 프리셋 id가 미지면 `None`.
    ///
    /// `None`은 **빈 필터가 아니다.** 빈 필터를 보내면 조직 전체 이슈를 긁어오는
    /// 조용한 오작동이 된다 — 커맨드가 영구 에러로 바꾼다.
    pub fn to_filter(&self) -> Option<Value> {
        match self {
            LinearQuery::Preset { id } => LinearPreset::by_id(id).map(|p| p.filter()),
        }
    }

    /// 이 프리셋이 `viewer` 아래 커넥션을 쓰는가.
    ///
    /// `viewer.assignedIssues`는 담당자 조건을 **서버가** 적용하므로 필터에
    /// `assignee`를 넣을 필요가 없다. 반대로 "최근 업데이트된 팀 이슈"처럼
    /// 내가 안 걸린 것도 봐야 하는 프리셋은 최상위 `issues`를 쓴다.
    pub fn scope(&self) -> Option<PresetScope> {
        match self {
            LinearQuery::Preset { id } => LinearPreset::by_id(id).map(|p| p.scope),
        }
    }

    /// 위젯 기본 제목.
    pub fn default_title(&self) -> String {
        match self {
            LinearQuery::Preset { id } => LinearPreset::by_id(id)
                .map(|p| p.name.to_owned())
                .unwrap_or_else(|| "Linear".to_owned()),
        }
    }
}

/// 어느 커넥션에서 이슈를 가져오는가.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub enum PresetScope {
    /// `viewer { assignedIssues(...) }`
    ViewerAssigned,
    /// `viewer { createdIssues(...) }`
    ViewerCreated,
    /// 최상위 `issues(filter: ...)`. 팀 범위와 함께 쓴다.
    AllIssues,
}

impl PresetScope {
    /// GraphQL 쿼리에서 쓸 커넥션 이름. `viewer` 아래가 아니면 `None`.
    pub const fn viewer_connection(self) -> Option<&'static str> {
        match self {
            PresetScope::ViewerAssigned => Some("assignedIssues"),
            PresetScope::ViewerCreated => Some("createdIssues"),
            PresetScope::AllIssues => None,
        }
    }
}

/// 정렬. **스키마가 주는 것이 이 둘뿐이다.**
///
/// `PaginationOrderBy`에는 `createdAt`과 `updatedAt`만 있다. Jira처럼
/// 우선순위·마감일 정렬을 만들 수 없고, **설정 UI에 없는 정렬을 만들지 않는다** —
/// 클라이언트에서 다시 정렬하면 "30건 중에서만" 정렬한 것이라 거짓이 된다
/// (DECISIONS 25.3).
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub enum LinearSort {
    /// 기본값. "지금 뭐가 움직였나"가 이 앱의 목적이다.
    #[default]
    UpdatedAt,
    CreatedAt,
}

impl LinearSort {
    /// GraphQL `orderBy` 인자에 들어갈 값.
    pub const fn as_str(self) -> &'static str {
        match self {
            LinearSort::UpdatedAt => "updatedAt",
            LinearSort::CreatedAt => "createdAt",
        }
    }
}

/// 프리셋 정의. 정적 테이블이므로 `&'static str`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct LinearPreset {
    /// 저장되는 안정적 식별자. **한번 정하면 바꾸지 않는다** (기존 위젯이 깨진다).
    pub id: &'static str,
    pub name: &'static str,
    pub description: &'static str,
    pub scope: PresetScope,
    /// 완료된 이슈를 제외하는가.
    pub open_only: bool,
}

/// 프리셋 4종.
///
/// GitHub의 `is:open`을 전부 박아둔 것과 같은 판단으로 대부분 미완료만 본다 —
/// 완료된 것까지 섞이면 "지금 볼 것"이라는 목적이 흐려진다. 예외는
/// `recently-updated`뿐이고, 그건 "무슨 일이 있었나"를 보는 자리라서 완료로
/// 옮겨진 것도 정보다.
pub static PRESETS: &[LinearPreset] = &[
    LinearPreset {
        id: "assigned-to-me",
        name: "내게 할당된 이슈",
        description: "나에게 할당된 미완료 이슈",
        scope: PresetScope::ViewerAssigned,
        open_only: true,
    },
    LinearPreset {
        id: "created-by-me",
        name: "내가 만든 이슈",
        description: "내가 만든 미완료 이슈",
        scope: PresetScope::ViewerCreated,
        open_only: true,
    },
    LinearPreset {
        id: "assigned-to-me-all",
        name: "내게 할당된 이슈 (완료 포함)",
        description: "완료·취소된 것까지 — 최근에 뭘 했는지 볼 때",
        scope: PresetScope::ViewerAssigned,
        open_only: false,
    },
    LinearPreset {
        id: "recently-updated",
        name: "최근 업데이트된 이슈",
        description: "팀 전체에서 최근 움직인 이슈. 범위에서 팀을 고르세요",
        scope: PresetScope::AllIssues,
        open_only: false,
    },
];

/// 새 위젯의 기본 프리셋.
///
/// `assigned-to-me`인 이유: 위젯을 처음 놓았을 때 **내 것이 보이는 것**이
/// 가장 예상에 맞다. `recently-updated`를 기본으로 두면 팀 범위를 안 고른
/// 상태에서 조직 전체가 쏟아진다.
pub const DEFAULT_PRESET_ID: &str = "assigned-to-me";

impl LinearPreset {
    pub fn by_id(id: &str) -> Option<&'static LinearPreset> {
        PRESETS.iter().find(|p| p.id == id)
    }

    /// 이 프리셋의 `IssueFilter`.
    ///
    /// `viewer` 커넥션을 쓰는 프리셋은 담당자/작성자 조건을 서버가 이미 적용하므로
    /// 여기에 넣지 않는다. 남는 것은 "완료 제외"뿐이고, 그것도 아니면 빈 객체다.
    pub fn filter(&self) -> Value {
        if self.open_only {
            json!({ "state": { "type": { "nin": completed_state_types() } } })
        } else {
            json!({})
        }
    }
}

/// "완료됐다"로 볼 상태 타입들.
///
/// # `nin`(제외)인 이유가 여기 있다
///
/// 공개 `schema.graphql`이 `completed`·`canceled`·`duplicate`를 닫힌 상태로
/// 정의한다. 실제 계정 응답은 아직 실측하지 못했으므로, 필터 방향은 여전히
/// 값이 추가돼도 목록 전체가 사라지지 않는 `nin`을 쓴다.
///
/// **틀렸을 때의 결과가 방향에 따라 다르다:**
/// - `nin`(지금): 값이 안 맞으면 아무것도 제외되지 않는다 → **완료된 것이 섞여 보인다.**
///   눈에 보이는 실패다. 사용자가 "완료된 게 왜 있지"라고 말할 수 있다
/// - `in`(반대): 값이 안 맞으면 아무것도 남지 않는다 → **목록이 통째로 빈다.**
///   고장과 구별되지 않는다
///
/// 모르면 보이는 쪽으로 기운다.
pub fn completed_state_types() -> Vec<&'static str> {
    vec!["completed", "canceled", "duplicate"]
}

/// 팀 범위를 필터에 합친다.
///
/// GitHub의 `apply_scope`가 검색 문자열에 `repo:`를 이어붙인 것과 같은 자리인데,
/// **문자열이 아니라 JSON 객체**라 방식이 다르다. `IssueFilter`의 필드를 하나
/// 더하는 것이므로 기존 조건을 지우거나 덮지 않는다.
///
/// 빈 목록이면 원본을 그대로 돌려준다 — 범위를 안 건 것이 곧 전체다.
///
/// ```text
/// { state: {...} } + ["t1","t2"]
///   → { state: {...}, team: { id: { in: ["t1","t2"] } } }
/// ```
pub fn apply_team_scope(filter: &Value, team_ids: &[String]) -> Value {
    if team_ids.is_empty() {
        return filter.clone();
    }

    let mut out = filter.clone();
    // 필터가 객체가 아니면(있을 수 없지만) 새 객체로 시작한다. 조건을
    // 조용히 버리는 것보다 팀 범위만이라도 적용되는 편이 낫다.
    if !out.is_object() {
        out = json!({});
    }
    if let Some(map) = out.as_object_mut() {
        map.insert("team".to_owned(), json!({ "id": { "in": team_ids } }));
    }
    out
}
