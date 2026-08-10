//! Linear provider 테스트.
//!
//! **라이브 API를 치지 않는다.** 전부 fixture JSON에 대해 돈다.
//!
//! # ⚠️ 이 fixture는 실제 응답이 아니다
//!
//! GitHub provider의 `search.json`은 `gh api graphql`로 캡처한 **진짜 응답**이었다.
//! 이쪽은 **Linear API 키가 없어 한 번도 실물을 받지 못했고**, 공개
//! `schema.graphql`을 보고 손으로 썼다 (DECISIONS 25.7).
//!
//! 그래서 이 테스트들이 증명하는 것과 증명하지 못하는 것을 구분해야 한다:
//!
//! - **증명한다:** 우리 파싱이 결측·null·미지의 값·잔여 필드에 견딘다.
//!   에러 분류가 표대로 동작한다. 쿼리에 필수 필드가 들어 있다
//! - **증명하지 못한다:** Linear가 정말 이 모양으로 준다는 것.
//!   프리셋 필터가 의도한 이슈를 준다는 것
//!
//! 그래서 fixture에 **일부러 이상한 노드를 섞어뒀다** — 실물이 우리 기대와
//! 다를 가능성이 이 위젯에서 가장 높은 위험이고, 그때 목록 전체가 죽지 않는
//! 것이 유일한 방어다.

use serde_json::json;

use crate::commands::linear::LinearWidgetConfig;

use super::client::{query_exports, LinearCredentials};
use super::error::{body_says_rate_limited, classify_status, ErrorKind, LinearError};
use super::presets::{
    apply_team_scope, completed_state_types, LinearAssigneeFilter, LinearCustomFilter,
    LinearKnownIds, LinearPreset, LinearQuery, LinearSort, LinearSortDirection, PresetScope,
    DEFAULT_PRESET_ID, PRESETS,
};
use super::types::{
    GqlEnvelope, IssueDetailData, IssueNode, LinearCreateIssueInput, LinearGlobalMetadata,
    LinearIssue, LinearTeamMetadata, PageInfo, StateNode, TeamStatesData, ViewerIssuesData,
};

/// fixture를 파싱해 평평한 항목 목록으로 만든다. 클라이언트가 하는 일과 같다.
fn parse_issues(json_text: &str) -> (Vec<LinearIssue>, Option<String>) {
    let envelope: GqlEnvelope<ViewerIssuesData> =
        serde_json::from_str(json_text).expect("fixture 파싱 실패");
    let connection = envelope
        .data
        .expect("data 없음")
        .viewer
        .expect("viewer 없음")
        .issues
        .expect("issues 없음");

    let issues = connection
        .nodes
        .into_iter()
        .flatten()
        .filter_map(IssueNode::flatten)
        .collect();
    let cursor = connection
        .page_info
        .filter(|p| p.has_next_page)
        .and_then(|p| p.end_cursor);
    (issues, cursor)
}

const ISSUES_FIXTURE: &str = include_str!("fixtures/viewer_issues.json");
const METADATA_FIXTURE: &str = include_str!("fixtures/metadata.json");
const ISSUE_CREATE_FIXTURE: &str = include_str!("fixtures/issue_create.json");

// ─────────────────────────── 파싱 ───────────────────────────

/// 기본 경로. 이게 깨지면 스키마가 우리 기대와 다르다.
#[test]
fn parses_viewer_issues() {
    let (issues, cursor) = parse_issues(ISSUES_FIXTURE);

    // 노드 7개 중 빈 객체·state 없음·id 없음 셋이 빠져 4개.
    assert_eq!(issues.len(), 4, "살릴 수 있는 항목을 잃었다");
    assert_eq!(cursor.as_deref(), Some("cursor-abc"), "커서를 못 읽었다");

    let first = &issues[0];
    assert_eq!(first.identifier, "ENG-142");
    assert_eq!(first.id, "11111111-2222-3333-4444-555555555555");
    assert_eq!(first.title, "로그인 후 리다이렉트가 한 번 더 발생한다");
    assert_eq!(first.url, "https://linear.app/acme/issue/ENG-142/redirect");
    assert_eq!(first.state.name, "In Progress");
    assert_eq!(first.state.id, "state-inprogress");
    assert_eq!(first.state.color, "#f2c94c");
    assert_eq!(first.team_name, "Engineering");
    assert_eq!(first.project_name.as_deref(), Some("인증 개편"));
    assert_eq!(first.due_date.as_deref(), Some("2026-08-20"));
    assert_eq!(first.estimate, Some(3));
    assert_eq!(first.labels, vec!["bug", "auth"]);
}

/// **`team.id`는 상태 변경의 전제다.** 이게 비면 팝오버가 상태 목록을
/// 조회할 수 없고, 배지를 눌러도 아무것도 안 뜬다 — 조용한 기능 상실이다.
#[test]
fn keeps_team_id_for_the_status_popover() {
    let (issues, _) = parse_issues(ISSUES_FIXTURE);
    for issue in &issues {
        assert!(
            !issue.team_id.is_empty(),
            "{}에 team_id가 없다 — 상태 변경 팝오버가 조용히 죽는다",
            issue.identifier
        );
    }
}

/// **`priorityLabel`을 그대로 쓴다.** 정수 0~4의 의미를 실측하지 못했으므로
/// 숫자를 해석하지 않는다 (DECISIONS 25.3).
#[test]
fn uses_priority_label_verbatim_without_interpreting_the_number() {
    let (issues, _) = parse_issues(ISSUES_FIXTURE);

    let high = &issues[0];
    assert_eq!(high.priority_label, "High");
    assert_eq!(high.priority, 2, "정수는 담아두되 해석하지 않는다");

    // priority 0에 "없음" 같은 말을 우리가 발명하지 않는다.
    let zero = issues
        .iter()
        .find(|i| i.identifier == "ENG-143")
        .expect("ENG-143 없음");
    assert_eq!(zero.priority, 0);
    assert_eq!(
        zero.priority_label, "No priority",
        "0을 우리 말로 바꾸면 실측과 어긋날 때 거짓이 된다"
    );
}

/// nullable 필드가 전부 빠져도 항목이 살아야 한다.
#[test]
fn survives_missing_nullable_fields() {
    let (issues, _) = parse_issues(ISSUES_FIXTURE);
    let bare = issues
        .iter()
        .find(|i| i.identifier == "ENG-143")
        .expect("ENG-143 없음");

    assert_eq!(bare.assignee, None);
    assert_eq!(bare.assignee_avatar_url, None);
    assert_eq!(bare.project_name, None);
    assert_eq!(bare.due_date, None);
    assert_eq!(bare.estimate, None);
    assert!(bare.labels.is_empty());
    // 그래도 목록에 그릴 수 있는 최소값은 있다.
    assert_eq!(bare.state.name, "Backlog");
    assert!(!bare.id.is_empty());
}

/// **`WorkflowState.type`의 실제 응답은 못 봤다.** 모르는 문자열이 와도 깨지지 않고,
/// 그 값으로 분기하지 않는다 — 색은 `color`가 정한다 (DECISIONS 25.3).
#[test]
fn unknown_state_type_does_not_break_anything() {
    let (issues, _) = parse_issues(ISSUES_FIXTURE);
    let weird = issues
        .iter()
        .find(|i| i.identifier == "DES-7")
        .expect("DES-7 없음");

    assert_eq!(weird.state.type_name, "someBrandNewType");
    // 이름과 색은 그대로 살아 있어야 한다. 배지를 그릴 수 있다는 뜻이다.
    assert_eq!(weird.state.name, "Waiting on legal");
    assert_eq!(weird.state.color, "#5e6ad2");
}

/// `displayName`이 없으면 `name`으로 내려간다. 담당자 칸이 비지 않게.
#[test]
fn falls_back_from_display_name_to_name() {
    let (issues, _) = parse_issues(ISSUES_FIXTURE);
    let des = issues
        .iter()
        .find(|i| i.identifier == "DES-7")
        .expect("DES-7 없음");
    assert_eq!(des.assignee.as_deref(), Some("designer"));
}

/// 이름이 null인 라벨은 버리고 나머지를 살린다.
#[test]
fn drops_nameless_labels_but_keeps_the_rest() {
    let (issues, _) = parse_issues(ISSUES_FIXTURE);
    let des = issues
        .iter()
        .find(|i| i.identifier == "DES-7")
        .expect("DES-7 없음");
    assert_eq!(des.labels, vec!["blocked"]);
}

/// **목록이 사라지면 안 된다** (CLAUDE.md). 이상한 노드는 그것만 버린다.
#[test]
fn drops_broken_nodes_without_failing_the_list() {
    let (issues, _) = parse_issues(ISSUES_FIXTURE);

    assert!(
        !issues.iter().any(|i| i.identifier == "ENG-145"),
        "state가 없는 항목은 배지를 그릴 수 없어 버려야 한다"
    );
    assert!(
        !issues.iter().any(|i| i.identifier == "ENG-146"),
        "id가 없는 항목은 상태 변경을 할 수 없어 버려야 한다"
    );
    // 그런데도 멀쩡한 것들은 남아 있다.
    assert!(issues.iter().any(|i| i.identifier == "ENG-142"));
    assert!(issues.iter().any(|i| i.identifier == "ENG-144"));
}

/// 우리가 안 읽는 필드가 잔뜩 있어도 파싱된다.
///
/// 실측을 못 했으므로 응답에 무엇이 더 있을지 모른다. `deny_unknown_fields`를
/// 쓰지 않는 것이 의도적이라는 사실을 여기서 고정한다.
#[test]
fn ignores_fields_we_do_not_read() {
    let (issues, _) = parse_issues(ISSUES_FIXTURE);
    // ENG-142에는 description·branchName·someFutureField가 들어 있다.
    assert_eq!(issues[0].identifier, "ENG-142");
}

/// **색은 CSS에 그대로 들어간다.** 화이트리스트를 통과하지 못하면 회색이다 —
/// 상태 이름은 배지에 남아 있으므로 정보가 사라지지 않는다.
///
/// fixture의 값이 `#`로 **시작하는** 것이 중요하다. 접두사만 보고 통과시키는
/// 구현(`if trimmed.starts_with('#')`)에서는 이 테스트가 실패해야 한다 —
/// `#`가 없는 값으로만 시험하면 길이·자릿수 검사를 지워도 테스트가 통과한다.
#[test]
fn rejects_colors_that_are_not_plain_hex() {
    let (issues, _) = parse_issues(ISSUES_FIXTURE);
    let broken = issues
        .iter()
        .find(|i| i.identifier == "ENG-144")
        .expect("ENG-144 없음");

    assert_eq!(broken.state.color, "#8a8f98", "이상한 색이 그대로 통과했다");
    assert!(
        !broken.state.color.contains("javascript"),
        "style에 들어갈 값이다 — 화이트리스트가 뚫렸다"
    );
    // 이름은 그대로다. 색만 기본값으로 떨어진다.
    assert_eq!(broken.state.name, "Todo");
}

/// 화이트리스트의 경계를 직접 고정한다.
///
/// 정상 색을 회색으로 뭉개면 Linear 웹과 색이 달라지고, 이상한 값을 통과시키면
/// `style` 속성에 남의 문자열이 들어간다. 양쪽 다 확인해야 한다.
#[test]
fn accepts_valid_hex_and_rejects_everything_else() {
    for good in ["#fff", "#FFFF", "#5e6ad2", "#5e6ad2ff"] {
        let (issues, _) = parse_issues(&fixture_with_color(good));
        assert_eq!(
            issues[0].state.color, good,
            "정상 색 {good}이 회색으로 뭉개졌다"
        );
    }

    for bad in [
        "#5e6ad",      // 5자리 — 유효한 길이가 아니다
        "#gggggg",     // 16진수가 아니다
        "#5e6ad2;x:1", // 뒤에 CSS가 붙었다
        "red",         // 이름 색 — `#`가 없다
        "url(javascript:alert(1))",
        "",
    ] {
        let (issues, _) = parse_issues(&fixture_with_color(bad));
        assert_eq!(
            issues[0].state.color, "#8a8f98",
            "이상한 색 {bad:?}이 통과했다"
        );
    }
}

/// 상태 색만 바꾼 최소 fixture. 화이트리스트 경계를 값별로 시험한다.
fn fixture_with_color(color: &str) -> String {
    serde_json::json!({
        "data": { "viewer": { "issues": { "nodes": [{
            "id": "uuid-c",
            "identifier": "ENG-1",
            "title": "색 시험",
            "url": "https://linear.app/acme/issue/ENG-1/x",
            "updatedAt": "2026-08-06T00:00:00Z",
            "state": { "id": "s", "name": "Todo", "color": color, "type": "unstarted" },
            "team": { "id": "t", "key": "ENG", "name": "Engineering" }
        }] }}}
    })
    .to_string()
}

// ─────────────────────────── 상태 목록 ───────────────────────────

/// 팀 상태 목록은 **`position` 순으로 정렬해서** 나간다.
/// 정렬 책임을 화면에 넘기지 않는다.
#[test]
fn team_states_are_sorted_by_position() {
    let envelope: GqlEnvelope<TeamStatesData> =
        serde_json::from_str(include_str!("fixtures/team_states.json")).expect("파싱 실패");
    let states = envelope
        .data
        .expect("data 없음")
        .team
        .expect("team 없음")
        .states
        .expect("states 없음");

    let mut list: Vec<_> = states
        .nodes
        .into_iter()
        .flatten()
        .filter_map(StateNode::into_workflow_state)
        .collect();
    list.sort_by(|a, b| a.position.total_cmp(&b.position));

    let names: Vec<&str> = list.iter().map(|s| s.name.as_str()).collect();
    assert_eq!(
        names,
        vec![
            // position이 없으면 0으로 떨어져 맨 앞에 온다. Backlog와 순서가
            // 갈리지만 안정 정렬이라 fixture 순서(Backlog가 먼저 나옴)를 따른다.
            "Backlog",
            "position이 없는 상태",
            "Todo",
            "In Progress",
            "Done",
        ],
        "팀이 정한 순서대로 나오지 않았다"
    );

    assert!(
        !list.iter().any(|s| s.id.is_empty()),
        "id 없는 상태는 고를 수 없으므로 버려야 한다"
    );
}

// ─────────────────────────── 상세 ───────────────────────────

/// 상세 조회는 **본문만** 채운다. 목록이 가진 값을 다시 받지 않는다 —
/// 모달 골격은 목록에서 오고(0ms), 이 응답은 그 위에 얹힌다.
#[test]
fn detail_carries_the_markdown_description() {
    // `serde_json::json!`으로 만든다. 원시 문자열 안에 markdown을 그대로 두면
    // `"##`가 raw string 종료로 읽혀서 컴파일이 깨진다.
    let json_text = serde_json::json!({
        "data": { "issue": {
            "id": "uuid-1",
            "identifier": "ENG-142",
            "description": "## 재현\n\n1. 로그인\n2. `/home`으로 이동\n",
            "branchName": "sammy/eng-142-redirect"
        }}
    })
    .to_string();

    let envelope: GqlEnvelope<IssueDetailData> =
        serde_json::from_str(&json_text).expect("파싱 실패");
    let issue = envelope.data.expect("data 없음").issue.expect("issue 없음");

    assert_eq!(issue.identifier.as_deref(), Some("ENG-142"));
    assert!(issue
        .description
        .as_deref()
        .expect("description 없음")
        .contains("## 재현"));
    assert_eq!(issue.branch_name.as_deref(), Some("sammy/eng-142-redirect"));
}

/// 본문이 없는 이슈가 흔하다. 그것 때문에 상세가 실패하면 안 된다.
#[test]
fn detail_survives_a_null_description() {
    let json_text =
        r#"{"data":{"issue":{"id":"uuid-1","identifier":"ENG-143","description":null}}}"#;
    let envelope: GqlEnvelope<IssueDetailData> =
        serde_json::from_str(json_text).expect("파싱 실패");
    let issue = envelope.data.expect("data 없음").issue.expect("issue 없음");

    assert_eq!(issue.description, None);
    assert_eq!(issue.branch_name, None);
}

// ─────────────────────────── 에러 분류 ───────────────────────────

/// **이 위젯의 핵심 함정.** Linear는 rate limit을 HTTP 400으로 보낸다.
/// 이 앱은 400을 영구로 분류하므로, 본문을 안 보면 rate limit이
/// "재시도 없는 영구 실패"가 된다.
#[test]
fn rate_limit_arrives_as_http_400_and_must_be_transient() {
    let body =
        r#"{"errors":[{"message":"Rate limit exceeded","extensions":{"code":"RATELIMITED"}}]}"#;
    let e = classify_status(400, "Rate limit exceeded".into(), body, None, 0);

    assert!(
        matches!(e, LinearError::RateLimited { .. }),
        "400 + RATELIMITED가 rate limit으로 분류되지 않았다: {e:?}"
    );
    assert!(
        e.is_transient(),
        "rate limit을 영구로 분류하면 목록이 새로고침 없이는 안 살아난다"
    );
    assert!(!e.is_auth_failure(), "rate limit은 인증 실패가 아니다");
}

/// rate limit이 아닌 400은 여전히 영구다. 쿼리 오류를 재시도하면 시간만 버린다.
#[test]
fn other_400s_stay_permanent_with_the_original_message() {
    let body = r#"{"errors":[{"message":"Argument Validation Error","extensions":{"code":"BAD_USER_INPUT"}}]}"#;
    let e = classify_status(400, "Argument Validation Error".into(), body, None, 0);

    assert!(matches!(e, LinearError::BadRequest { .. }), "{e:?}");
    assert!(e.is_permanent());
    assert_eq!(
        e.message(),
        "Argument Validation Error",
        "Linear 원문을 우리가 고쳐 쓰지 않는다"
    );
}

/// 리셋 시각은 **밀리초**다. `Retry-After`(초)가 아니다 —
/// 그대로 초로 쓰면 5분 대기가 5일이 된다.
#[test]
fn converts_reset_header_from_millis_to_seconds() {
    let body = r#"{"errors":[{"extensions":{"code":"RATELIMITED"}}]}"#;
    let now_ms = 1_800_000_000_000;
    let reset_ms = now_ms + 90_000; // 90초 뒤

    let e = classify_status(400, "limited".into(), body, Some(reset_ms), now_ms);
    assert_eq!(e.retry_after_secs(), Some(90));
}

/// 리셋 시각이 이미 지났으면 0이다. 음수로 뒤집히지 않는다.
#[test]
fn past_reset_time_does_not_underflow() {
    let body = r#"{"errors":[{"extensions":{"code":"RATELIMITED"}}]}"#;
    let e = classify_status(400, "limited".into(), body, Some(1_000), 9_999_999);
    assert_eq!(e.retry_after_secs(), Some(0));
}

#[test]
fn classifies_by_status() {
    let empty = "";
    assert!(classify_status(401, "bad key".into(), empty, None, 0).is_auth_failure());
    assert!(classify_status(403, "no".into(), empty, None, 0).is_permanent());
    assert!(classify_status(404, "nope".into(), empty, None, 0).is_permanent());
    assert!(classify_status(429, "slow down".into(), empty, None, 0).is_transient());
    assert!(classify_status(503, "down".into(), empty, None, 0).is_transient());
}

/// 알 수 없는 상태 코드: 5xx면 서버 문제로 보고 재시도를 허용한다.
#[test]
fn unknown_status_splits_on_5xx() {
    assert_eq!(
        classify_status(599, "?".into(), "", None, 0).kind(),
        ErrorKind::Transient
    );
    assert_eq!(
        classify_status(418, "?".into(), "", None, 0).kind(),
        ErrorKind::Permanent
    );
}

/// GraphQL 에러는 영구다 — 같은 쿼리를 다시 보내도 같은 자리에서 깨진다.
#[test]
fn graphql_errors_are_permanent() {
    let e = LinearError::GraphqlErrors {
        message: "Cannot query field 'foo' on type 'Issue'".into(),
    };
    assert!(e.is_permanent());
    assert!(!e.is_auth_failure());
}

/// **200 + errors 본문을 실패로 잡아야 한다.** GitHub과 같은 함정이다 —
/// 상태 코드만 보면 성공으로 보인다.
#[test]
fn parses_200_with_errors_body() {
    let json_text =
        r#"{"data":null,"errors":[{"message":"Cannot query field"},{"message":"또 하나"}]}"#;
    let envelope: GqlEnvelope<ViewerIssuesData> =
        serde_json::from_str(json_text).expect("파싱 실패");

    assert!(envelope.data.is_none());
    assert_eq!(envelope.errors.len(), 2);
    assert_eq!(envelope.errors[0].message, "Cannot query field");
}

/// 200 본문에도 RATELIMITED가 올 수 있다. `extensions.code`를 읽어야 한다.
#[test]
fn detects_rate_limit_code_in_a_200_body() {
    let json_text =
        r#"{"data":null,"errors":[{"message":"limited","extensions":{"code":"RATELIMITED"}}]}"#;
    let envelope: GqlEnvelope<ViewerIssuesData> =
        serde_json::from_str(json_text).expect("파싱 실패");

    let coded = envelope.errors.iter().any(|e| {
        e.extensions
            .as_ref()
            .and_then(|x| x.code.as_deref())
            .is_some_and(|c| c == "RATELIMITED")
    });
    assert!(coded, "extensions.code를 못 읽었다");
    assert!(body_says_rate_limited(json_text));
}

/// 본문이 JSON이 아니어도(게이트웨이 HTML 등) rate limit을 놓치지 않는다.
///
/// 놓치면 영구 실패, 과하게 잡으면 재시도 한 번 — 비용이 대칭이 아니다.
#[test]
fn falls_back_to_substring_when_the_body_is_not_json() {
    assert!(body_says_rate_limited("<html>RATELIMITED</html>"));
    assert!(!body_says_rate_limited("<html>Bad Gateway</html>"));
    assert!(!body_says_rate_limited(""));
}

// ─────────────────────────── 프리셋 ───────────────────────────

#[test]
fn default_preset_exists() {
    assert!(
        LinearPreset::by_id(DEFAULT_PRESET_ID).is_some(),
        "기본 프리셋 id가 목록에 없다 — 새 위젯이 빈 화면으로 시작한다"
    );
}

/// id는 config에 저장된다. 바꾸면 이미 배치된 위젯이 깨진다.
#[test]
fn preset_ids_are_stable_and_unique() {
    let expected = [
        "assigned-to-me",
        "created-by-me",
        "assigned-to-me-all",
        "recently-updated",
    ];
    let actual: Vec<&str> = PRESETS.iter().map(|p| p.id).collect();
    assert_eq!(actual, expected, "프리셋 id가 바뀌면 기존 위젯이 깨진다");
}

#[test]
fn unknown_preset_is_rejected() {
    let q = LinearQuery::Preset {
        id: "없는-프리셋".into(),
    };
    let error = q
        .to_filter(
            None,
            &LinearKnownIds::new(
                std::iter::empty::<String>(),
                std::iter::empty::<String>(),
                std::iter::empty::<String>(),
                std::iter::empty::<String>(),
            ),
        )
        .unwrap_err();
    assert!(matches!(
        error,
        super::presets::LinearFilterError::UnknownPreset(id) if id == "없는-프리셋"
    ));
    assert_eq!(q.scope(), None);
    assert_eq!(q.default_title(), "Linear");
}

/// **미완료 필터는 `nin`(제외)이어야 한다** (DECISIONS 25.7).
///
/// 공개 스키마에 없는 새 `WorkflowState.type`이 생겨도, 값이 달라졌을 때
/// - `nin`: 아무것도 제외되지 않는다 → 완료된 것이 섞여 **보인다**
/// - `in`: 아무것도 남지 않는다 → 목록이 통째로 빈다 = **고장과 구별되지 않는다**
///
/// 모르면 보이는 쪽으로 기운다. 이 테스트가 그 방향을 고정한다.
#[test]
fn open_only_filter_excludes_rather_than_includes() {
    let preset = LinearPreset::by_id("assigned-to-me").expect("프리셋 없음");
    let filter = preset.filter();

    let type_filter = filter
        .get("state")
        .and_then(|s| s.get("type"))
        .expect("state.type 필터가 없다");

    assert!(
        type_filter.get("nin").is_some(),
        "미완료 필터가 nin이 아니다 — type 값이 틀리면 목록이 통째로 빈다"
    );
    assert!(
        type_filter.get("in").is_none(),
        "in을 쓰면 모르는 type 값에서 목록이 사라진다"
    );
    assert_eq!(
        type_filter.get("nin").unwrap(),
        &json!(completed_state_types())
    );
}

#[test]
fn open_only_filter_excludes_every_terminal_state_type() {
    assert_eq!(
        completed_state_types(),
        vec!["completed", "canceled", "duplicate"]
    );
}

/// 완료 포함 프리셋은 상태 조건을 걸지 않는다.
#[test]
fn all_inclusive_preset_has_no_state_condition() {
    let preset = LinearPreset::by_id("assigned-to-me-all").expect("프리셋 없음");
    assert_eq!(preset.filter(), json!({}));
    assert!(!preset.open_only);
}

/// `viewer` 커넥션을 쓰는 프리셋은 담당자 조건을 필터에 넣지 않는다 —
/// 서버가 이미 적용한다. 넣으면 조건이 두 번 걸린다.
#[test]
fn viewer_presets_do_not_duplicate_the_assignee_condition() {
    for preset in PRESETS {
        if preset.scope.viewer_connection().is_some() {
            let filter = preset.filter();
            assert!(
                filter.get("assignee").is_none(),
                "{}: viewer 커넥션인데 필터에 assignee가 있다",
                preset.id
            );
        }
    }
}

#[test]
fn viewer_connection_names_match_the_schema() {
    assert_eq!(
        PresetScope::ViewerAssigned.viewer_connection(),
        Some("assignedIssues")
    );
    assert_eq!(
        PresetScope::ViewerCreated.viewer_connection(),
        Some("createdIssues")
    );
    assert_eq!(PresetScope::AllIssues.viewer_connection(), None);
}

/// **정렬은 두 종뿐이다.** `PaginationOrderBy`가 그것만 준다 —
/// 없는 정렬을 만들면 설정 UI가 거짓말을 한다 (DECISIONS 25.3).
#[test]
fn sort_options_are_exactly_what_the_schema_offers() {
    assert_eq!(LinearSort::UpdatedAt.as_str(), "updatedAt");
    assert_eq!(LinearSort::CreatedAt.as_str(), "createdAt");
    assert_eq!(LinearSort::default(), LinearSort::UpdatedAt);
}

// ─────────────────────────── 팀 범위 ───────────────────────────

#[test]
fn empty_team_scope_leaves_the_filter_alone() {
    let filter = json!({ "state": { "type": { "nin": ["completed"] } } });
    assert_eq!(apply_team_scope(&filter, &[]), filter);
}

/// 팀 범위는 **필드를 더한다.** 기존 조건을 지우거나 덮지 않는다.
#[test]
fn team_scope_adds_a_field_without_touching_the_rest() {
    let filter = json!({ "state": { "type": { "nin": ["completed"] } } });
    let scoped = apply_team_scope(&filter, &["t1".to_string(), "t2".to_string()]);

    assert_eq!(
        scoped,
        json!({
            "state": { "type": { "nin": ["completed"] } },
            "team": { "id": { "in": ["t1", "t2"] } }
        })
    );
}

#[test]
fn team_scope_works_on_an_empty_filter() {
    let scoped = apply_team_scope(&json!({}), &["t1".to_string()]);
    assert_eq!(scoped, json!({ "team": { "id": { "in": ["t1"] } } }));
}

// ─────────────────────────── 사용자 필터 ───────────────────────────

fn known_filter_ids() -> LinearKnownIds {
    LinearKnownIds::new(
        ["team-eng", "team-design"],
        ["project-auth"],
        ["label-bug"],
        ["started", "unstarted"],
    )
}

#[test]
fn custom_filter_combines_conditions_with_and_semantics() {
    let filter = LinearCustomFilter {
        team_ids: vec!["team-eng".into(), "team-design".into()],
        assignee: LinearAssigneeFilter::Viewer,
        state_types: vec!["started".into(), "unstarted".into()],
        project_ids: vec!["project-auth".into()],
        label_ids: vec!["label-bug".into()],
        priorities: vec![1, 2],
        created_from: Some("2026-08-01T00:00:00.000Z".into()),
        created_to: Some("2026-08-10T14:59:59.999Z".into()),
        updated_from: None,
        updated_to: None,
    };

    assert_eq!(
        filter
            .to_issue_filter(Some("viewer-1"), &known_filter_ids())
            .unwrap(),
        json!({
            "team": { "id": { "in": ["team-eng", "team-design"] } },
            "assignee": { "id": { "eq": "viewer-1" } },
            "state": { "type": { "in": ["started", "unstarted"] } },
            "project": { "id": { "in": ["project-auth"] } },
            "labels": { "id": { "in": ["label-bug"] } },
            "priority": { "in": [1, 2] },
            "createdAt": { "gte": "2026-08-01T00:00:00.000Z", "lte": "2026-08-10T14:59:59.999Z" }
        })
    );
}

#[test]
fn custom_filter_uses_viewer_id_for_assigned_to_me() {
    let filter = LinearCustomFilter {
        assignee: LinearAssigneeFilter::Viewer,
        ..LinearCustomFilter::default()
    };

    assert_eq!(
        filter
            .to_issue_filter(Some("viewer-1"), &known_filter_ids())
            .unwrap(),
        json!({ "assignee": { "id": { "eq": "viewer-1" } } })
    );
}

#[test]
fn custom_filter_rejects_empty_filter() {
    let error = LinearCustomFilter::default()
        .to_issue_filter(None, &known_filter_ids())
        .unwrap_err();

    assert!(matches!(error, super::presets::LinearFilterError::Empty));
}

#[test]
fn custom_filter_rejects_unknown_ids() {
    let filter = LinearCustomFilter {
        team_ids: vec!["team-missing".into()],
        ..LinearCustomFilter::default()
    };

    let error = filter
        .to_issue_filter(None, &known_filter_ids())
        .unwrap_err();

    assert!(matches!(
        error,
        super::presets::LinearFilterError::UnknownTeam(id) if id == "team-missing"
    ));
}

#[test]
fn custom_filter_rejects_reversed_dates() {
    let filter = LinearCustomFilter {
        created_from: Some("2026-08-11T00:00:00Z".into()),
        created_to: Some("2026-08-10T00:00:00Z".into()),
        ..LinearCustomFilter::default()
    };

    let error = filter
        .to_issue_filter(None, &known_filter_ids())
        .unwrap_err();

    assert!(matches!(
        error,
        super::presets::LinearFilterError::ReversedRange { field: "createdAt" }
    ));
}

#[test]
fn custom_filter_rejects_priority_outside_zero_to_four() {
    let filter = LinearCustomFilter {
        priorities: vec![5],
        ..LinearCustomFilter::default()
    };

    let error = filter
        .to_issue_filter(None, &known_filter_ids())
        .unwrap_err();

    assert!(matches!(
        error,
        super::presets::LinearFilterError::InvalidPriority(5)
    ));
}

#[test]
fn custom_filter_rejects_missing_viewer_and_invalid_dates() {
    let viewer_filter = LinearCustomFilter {
        assignee: LinearAssigneeFilter::Viewer,
        ..LinearCustomFilter::default()
    };
    assert!(matches!(
        viewer_filter
            .to_issue_filter(None, &known_filter_ids())
            .unwrap_err(),
        super::presets::LinearFilterError::ViewerUnavailable
    ));

    let invalid_date = LinearCustomFilter {
        created_from: Some("not-an-iso-date".into()),
        ..LinearCustomFilter::default()
    };
    assert!(matches!(
        invalid_date
            .to_issue_filter(None, &known_filter_ids())
            .unwrap_err(),
        super::presets::LinearFilterError::InvalidDate {
            field: "createdAt",
            ..
        }
    ));
}

#[test]
fn custom_filter_handles_unassigned_and_any_assignee() {
    let unassigned = LinearCustomFilter {
        assignee: LinearAssigneeFilter::Unassigned,
        ..LinearCustomFilter::default()
    };
    assert_eq!(
        unassigned
            .to_issue_filter(None, &known_filter_ids())
            .unwrap(),
        json!({ "assignee": { "null": true } })
    );

    let any = LinearCustomFilter {
        team_ids: vec!["team-eng".into()],
        assignee: LinearAssigneeFilter::Any,
        ..LinearCustomFilter::default()
    };
    assert!(any
        .to_issue_filter(None, &known_filter_ids())
        .unwrap()
        .get("assignee")
        .is_none());
}

// ─────────────────────────── 양방향 페이지 조회 ───────────────────────────

#[test]
fn descending_uses_first_after_and_next_page() {
    assert_eq!(
        query_exports::pagination_args(LinearSortDirection::Descending, 30),
        json!({ "first": 30, "after": null, "last": null, "before": null })
    );

    let page = query_exports::finish_page(
        Vec::new(),
        Some(PageInfo {
            has_next_page: true,
            end_cursor: Some("next".into()),
            has_previous_page: false,
            start_cursor: None,
        }),
        LinearSortDirection::Descending,
    );

    assert_eq!(page.next_cursor.as_deref(), Some("next"));
}

#[test]
fn ascending_uses_last_before_previous_page_and_reverses_nodes() {
    assert_eq!(
        query_exports::pagination_args(LinearSortDirection::Ascending, 30),
        json!({ "first": null, "after": null, "last": 30, "before": null })
    );

    let (mut issues, _) = parse_issues(ISSUES_FIXTURE);
    issues.truncate(3);
    let server_order = issues
        .iter()
        .map(|issue| issue.identifier.clone())
        .collect::<Vec<_>>();
    let page = query_exports::finish_page(
        issues,
        Some(PageInfo {
            has_next_page: false,
            end_cursor: None,
            has_previous_page: true,
            start_cursor: Some("previous".into()),
        }),
        LinearSortDirection::Ascending,
    );

    assert_eq!(
        page.issues
            .iter()
            .map(|issue| issue.identifier.as_str())
            .collect::<Vec<_>>(),
        server_order
            .iter()
            .rev()
            .map(String::as_str)
            .collect::<Vec<_>>()
    );
    assert_eq!(page.next_cursor.as_deref(), Some("previous"));
}

#[test]
fn config_without_direction_defaults_to_descending() {
    let config: LinearWidgetConfig = serde_json::from_value(json!({
        "query": { "kind": "preset", "id": "assigned-to-me" },
        "maxResults": 30
    }))
    .unwrap();

    assert_eq!(config.sort_direction, LinearSortDirection::Descending);
}

// ─────────────────────────── 메타데이터 ───────────────────────────

#[test]
fn metadata_fixture_flattens_global_and_team_choices() {
    let global: LinearGlobalMetadata =
        query_exports::parse_global_metadata(METADATA_FIXTURE).expect("전역 메타데이터 파싱 실패");
    let team: LinearTeamMetadata =
        query_exports::parse_team_metadata(METADATA_FIXTURE).expect("팀 메타데이터 파싱 실패");

    assert_eq!(global.viewer.as_ref().unwrap().id, "viewer-1");
    assert_eq!(global.teams.items[0].key, "ENG");
    assert!(global.labels.truncated);
    assert_eq!(team.members.items[0].name, "Sammy");
    assert_eq!(team.projects.items[0].id, "project-auth");
    assert_eq!(team.states.items[0].type_name, "unstarted");
}

#[test]
fn metadata_queries_request_bounded_connections_and_flattened_fields() {
    for needle in [
        "viewer {",
        "teams(first: 100)",
        "issueLabels(first: 100)",
        "pageInfo { hasNextPage }",
        "displayName",
        "avatarUrl",
    ] {
        assert!(
            query_exports::GLOBAL_METADATA.contains(needle),
            "전역 메타데이터 쿼리에 {needle}이 없습니다"
        );
    }
    for needle in [
        "team(id: $teamId)",
        "states(first: 50)",
        "members(first: 100)",
        "projects(first: 100)",
        "pageInfo { hasNextPage }",
    ] {
        assert!(
            query_exports::TEAM_METADATA.contains(needle),
            "팀 메타데이터 쿼리에 {needle}이 없습니다"
        );
    }
}

#[test]
fn metadata_missing_connection_is_decode_error() {
    let json = r#"{"data":{"viewer":null,"teams":null,"issueLabels":null}}"#;
    let error = query_exports::parse_global_metadata(json).unwrap_err();

    assert!(matches!(error, LinearError::Decode { .. }));
}

// ─────────────────────────── 이슈 생성 ───────────────────────────

#[test]
fn issue_create_input_uses_linear_graphql_field_names() {
    let input = LinearCreateIssueInput {
        team_id: "team-eng".into(),
        title: "로그인 수정".into(),
        description: Some("재현 절차".into()),
        state_id: Some("state-todo".into()),
        assignee_id: Some("viewer-1".into()),
        priority: Some(2),
        project_id: Some("project-auth".into()),
    };

    assert_eq!(
        input.to_graphql_input(),
        json!({
            "teamId":"team-eng", "title":"로그인 수정", "description":"재현 절차",
            "stateId":"state-todo", "assigneeId":"viewer-1", "priority":2,
            "projectId":"project-auth"
        })
    );
}

#[tokio::test]
async fn issue_create_rejects_invalid_input_before_transport() {
    let client = super::client::LinearClient::new(LinearCredentials::new("test-key")).unwrap();
    let input = LinearCreateIssueInput {
        team_id: "  ".into(),
        title: "제목".into(),
        description: None,
        state_id: None,
        assignee_id: None,
        priority: None,
        project_id: None,
    };

    let error = client.create_issue(&input).await.unwrap_err();

    assert!(matches!(error, LinearError::BadRequest { .. }));
}

#[test]
fn issue_create_success_fixture_flattens_created_issue() {
    let issue = query_exports::parse_issue_create(ISSUE_CREATE_FIXTURE)
        .expect("생성 성공 fixture 파싱 실패");

    assert_eq!(issue.identifier, "ENG-143");
    assert_eq!(issue.title, "로그인 수정");
    assert_eq!(issue.team_id, "team-eng");
    assert_eq!(issue.state.id, "state-todo");
    assert_eq!(issue.project_name.as_deref(), Some("Authentication"));
}

#[test]
fn issue_create_success_false_is_a_rejected_request() {
    let body = r#"{"data":{"issueCreate":{"success":false,"issue":null}}}"#;
    let error = query_exports::parse_issue_create(body).unwrap_err();

    assert!(matches!(error, LinearError::BadRequest { .. }));
    assert!(!error.possibly_created());
}

#[test]
fn issue_create_missing_issue_is_decode_error() {
    let body = r#"{"data":{"issueCreate":{"success":true,"issue":null}}}"#;
    let error = query_exports::parse_issue_create(body).unwrap_err();

    assert!(matches!(error, LinearError::Decode { .. }));
    assert!(!error.possibly_created());
}

#[test]
fn issue_create_graphql_errors_are_not_treated_as_success() {
    let body = r#"{"data":null,"errors":[{"message":"validation failed"}]}"#;
    let error = query_exports::parse_issue_create(body).unwrap_err();

    assert!(matches!(error, LinearError::GraphqlErrors { .. }));
    assert!(!error.possibly_created());
}

#[test]
fn issue_create_only_network_and_server_failures_are_possibly_created() {
    assert!(LinearError::Network {
        message: "timeout".into()
    }
    .possibly_created());
    assert!(LinearError::ServerError {
        status: 503,
        message: "down".into()
    }
    .possibly_created());
    assert!(!LinearError::RateLimited {
        message: "limited".into(),
        retry_after_secs: Some(10)
    }
    .possibly_created());
    assert!(!LinearError::Unauthorized {
        message: "bad key".into()
    }
    .possibly_created());
}

#[test]
fn response_body_read_failure_is_transport_uncertainty_for_mutations_and_transient_for_queries() {
    let create_error = query_exports::body_read_error("이슈 생성", "connection reset");
    assert!(matches!(create_error, LinearError::Network { .. }));
    assert!(create_error.is_transient());
    assert!(create_error.possibly_created());

    let query_error = query_exports::body_read_error("이슈 목록", "connection reset");
    assert!(matches!(query_error, LinearError::Network { .. }));
    assert!(query_error.is_transient());
    assert!(query_error.message().contains("이슈 목록"));
}

// ─────────────────────────── 쿼리 문자열 ───────────────────────────
//
// GraphQL 쿼리가 Rust 문자열이라 오타가 컴파일에 안 잡힌다. 최소한 **없으면
// 기능이 조용히 죽는 필드**가 들어 있는지는 고정한다.

/// `team { id }`가 빠지면 상태 변경 팝오버가 아무것도 못 그린다.
/// `state { id }`가 빠지면 현재 상태를 지정할 수 없다.
#[test]
fn issue_query_asks_for_the_fields_the_ui_depends_on() {
    let query = query_exports::viewer_issues("assignedIssues", "updatedAt");

    for needle in [
        "id",
        "identifier",
        "url",
        "priorityLabel",
        "state {",
        "team {",
        "pageInfo",
    ] {
        assert!(query.contains(needle), "쿼리에 {needle}이 없다");
    }
    // 커넥션 이름과 정렬이 실제로 끼워졌는가.
    assert!(query.contains("issues: assignedIssues("));
    assert!(query.contains("orderBy: updatedAt"));
}

#[test]
fn all_issues_query_uses_the_top_level_connection() {
    let query = query_exports::all_issues("createdAt");
    assert!(query.contains("issues(filter: $filter"));
    assert!(query.contains("orderBy: createdAt"));
    assert!(!query.contains("viewer"), "팀 범위 쿼리에 viewer가 있다");
}

/// 상태 목록은 **팀 단위** 조회다 — Jira처럼 이슈 단위가 아니다 (25.5).
#[test]
fn state_query_is_scoped_to_a_team_not_an_issue() {
    assert!(query_exports::TEAM_STATES.contains("team(id: $teamId)"));
    assert!(query_exports::TEAM_STATES.contains("position"));
}

/// 상태 변경은 `stateId` 하나만 보낸다. 필수 필드 폼 문제가 없는 근거다.
#[test]
fn update_mutation_sends_only_the_state_id() {
    let m = query_exports::ISSUE_UPDATE;
    assert!(m.contains("issueUpdate(id: $id, input: { stateId: $stateId })"));
    // `success`를 읽지 않으면 실패를 성공으로 보고한다.
    assert!(m.contains("success"));
}

#[test]
fn create_mutation_contains_success_and_detail_fields() {
    let mutation = query_exports::issue_create();
    for needle in [
        "issueCreate(input: $input)",
        "success",
        "identifier",
        "url",
        "state {",
        "team {",
        "labels(first: 10)",
    ] {
        assert!(
            mutation.contains(needle),
            "생성 mutation에 {needle}이 없습니다"
        );
    }
}

// ─────────────────────────── 인증 헤더 ───────────────────────────

/// **★ `Bearer`를 붙이면 401이다.** GitHub provider를 복사해 오면
/// `.bearer_auth()`를 쓰게 되고, 그 실패는 실제 요청을 보내야만 드러난다.
#[test]
fn auth_header_has_no_bearer_prefix() {
    let creds = LinearCredentials::new("lin_api_examplekey");
    let value = super::client::auth_header_value(&creds);

    assert_eq!(value, "lin_api_examplekey");
    assert!(
        !value.starts_with("Bearer"),
        "Linear는 Bearer 접두사를 받지 않는다 — 붙이면 401이다"
    );
}

// ─────────────────────────── 키 마스킹 ───────────────────────────

/// API 키가 로그에 찍히면 그걸로 끝이다 (CLAUDE.md: 마스킹 필수).
#[test]
fn credentials_debug_never_leaks_the_key() {
    let creds = LinearCredentials::new("lin_api_supersecretkeyvalue");
    let rendered = format!("{creds:?}");

    assert!(
        !rendered.contains("supersecret"),
        "Debug에 키가 노출됐다: {rendered}"
    );
    assert!(
        !rendered.contains("lin_api_"),
        "접두사만으로도 어떤 종류의 키인지 새어나간다: {rendered}"
    );
    // 길이는 남긴다 — "키를 넣었는데 401"을 진단할 때 필요하다.
    assert!(rendered.contains("자>"), "길이 표시가 없다: {rendered}");
}

/// 클라이언트를 Debug로 찍어도 키가 안 나온다.
/// 실수는 대개 `tracing::debug!("{:?}", client)` 한 줄에서 난다.
#[test]
fn client_debug_never_leaks_the_key() {
    let client = super::client::LinearClient::new(LinearCredentials::new("lin_api_secretvalue"))
        .expect("클라이언트 생성 실패");
    let rendered = format!("{client:?}");
    assert!(!rendered.contains("secretvalue"), "leaked: {rendered}");
}
