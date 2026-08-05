//! 응답 역직렬화 테스트.
//!
//! 두 가지를 지킨다:
//! 1. **null을 만나도 깨지지 않는다.** 담당자·우선순위·아바타 없음은 예외가 아니라 일상이다.
//! 2. **커서 페이지네이션이 정확히 끝난다.** 종료 조건을 틀리면 무한 루프거나 데이터 누락이다.

use super::*;

const SEARCH_PAGE_1: &str = include_str!("fixtures/search_page_1.json");
const SEARCH_PAGE_2_LAST: &str = include_str!("fixtures/search_page_2_last.json");
const SEARCH_EMPTY: &str = include_str!("fixtures/search_empty.json");
const ISSUE_DETAIL: &str = include_str!("fixtures/issue_detail.json");
const ISSUE_MINIMAL: &str = include_str!("fixtures/issue_minimal.json");
const COMMENTS: &str = include_str!("fixtures/comments.json");
const CREATEMETA_ABC: &str = include_str!("fixtures/createmeta_dth.json");
const CREATEMETA_XYZ: &str = include_str!("fixtures/createmeta_edu.json");
const MYSELF: &str = include_str!("fixtures/myself.json");
const CREATED_ISSUE: &str = include_str!("fixtures/created_issue.json");

fn page1() -> SearchPage {
    serde_json::from_str(SEARCH_PAGE_1).expect("fixture should deserialize")
}

// ---------------------------------------------------------------------------
// 목록 이슈
// ---------------------------------------------------------------------------

#[test]
fn deserializes_fully_populated_issue() {
    let page = page1();
    let issue = &page.issues[0];

    assert_eq!(issue.key, "ABC-142");
    assert_eq!(issue.summary, "위젯 드래그 시 레이아웃 저장이 중복 호출됨");
    assert_eq!(
        issue.updated.as_deref(),
        Some("2026-07-29T14:03:11.482+0900")
    );

    let status = issue.status.as_ref().expect("status present");
    assert_eq!(status.name, "진행 중");
    let cat = status.status_category.as_ref().expect("category present");
    // 색은 상태 이름이 아니라 이 키로 정한다 — 이름은 프로젝트마다 다르다.
    assert_eq!(cat.key, "indeterminate");
    assert_eq!(cat.color_name.as_deref(), Some("yellow"));

    let assignee = issue.assignee.as_ref().expect("assignee present");
    // 식별자는 accountId다. 이메일이 아니다.
    assert_eq!(assignee.account_id, "5f8a1b2c3d4e5f6a7b8c9d0e");
    assert_eq!(assignee.display_name, "김현우");
    // avatarUrls 맵이 단일 URL로 접혀야 한다 — 48x48을 고른다.
    assert_eq!(
        assignee.avatar_url.as_deref(),
        Some("https://secure.gravatar.com/avatar/abc123?d=https%3A%2F%2Favatar-management.services.atlassian.com%2Finitials%2FSK-0.png&s=48")
    );

    assert_eq!(issue.priority.as_ref().unwrap().name, "Medium");
    assert_eq!(issue.issue_type.as_ref().unwrap().name, "[Team] 기능");
    assert!(!issue.issue_type.as_ref().unwrap().subtask);
}

#[test]
fn deserializes_issue_with_null_assignee_and_priority() {
    // 백로그 티켓 대부분이 이 모양이다. 여기서 깨지면 위젯이 통째로 빈다.
    let page = page1();
    let issue = &page.issues[1];

    assert_eq!(issue.key, "ABC-139");
    assert!(issue.assignee.is_none(), "담당자 없음이 None이어야 한다");
    assert!(issue.priority.is_none(), "우선순위 없음이 None이어야 한다");
    // 나머지 필드는 정상적으로 읽혀야 한다 — null 하나가 행 전체를 날리면 안 된다.
    assert_eq!(issue.summary, "담당자 미지정 백로그 항목");
    assert_eq!(
        issue
            .status
            .as_ref()
            .unwrap()
            .status_category
            .as_ref()
            .unwrap()
            .key,
        "new"
    );
}

#[test]
fn deserializes_user_without_avatar_urls() {
    // 앱/서비스 계정은 avatarUrls 자체가 없다.
    let page = page1();
    let assignee = page.issues[2].assignee.as_ref().expect("assignee present");
    assert_eq!(assignee.account_id, "712020:aaaa-bbbb-cccc-dddd");
    assert_eq!(assignee.display_name, "서비스 계정");
    assert!(assignee.avatar_url.is_none());
}

#[test]
fn avatar_falls_back_to_smaller_size_when_48_missing() {
    let json = serde_json::json!({
        "key": "X-1",
        "fields": {
            "summary": "s",
            "assignee": {
                "accountId": "acc",
                "displayName": "N",
                "avatarUrls": { "24x24": "https://example.com/a24.png" }
            }
        }
    });
    let issue: JiraIssue = serde_json::from_value(json).unwrap();
    assert_eq!(
        issue.assignee.unwrap().avatar_url.as_deref(),
        Some("https://example.com/a24.png")
    );
}

#[test]
fn tolerates_missing_display_name() {
    // 삭제된 계정은 displayName이 없을 수 있다. 빈 문자열이 파싱 실패보다 낫다.
    let json = serde_json::json!({
        "key": "X-1",
        "fields": { "summary": "s", "assignee": { "accountId": "acc" } }
    });
    let issue: JiraIssue = serde_json::from_value(json).unwrap();
    let assignee = issue.assignee.unwrap();
    assert_eq!(assignee.account_id, "acc");
    assert_eq!(assignee.display_name, "");
}

#[test]
fn tolerates_issue_with_no_fields_object() {
    // fields를 전부 제외하고 요청하면 Jira가 fields를 생략하기도 한다.
    let json = serde_json::json!({ "key": "X-1" });
    let issue: JiraIssue = serde_json::from_value(json).unwrap();
    assert_eq!(issue.key, "X-1");
    assert_eq!(issue.summary, "");
    assert!(issue.status.is_none());
}

#[test]
fn tolerates_status_without_category() {
    let json = serde_json::json!({
        "key": "X-1",
        "fields": { "summary": "s", "status": { "name": "이상한 상태" } }
    });
    let issue: JiraIssue = serde_json::from_value(json).unwrap();
    let status = issue.status.unwrap();
    assert_eq!(status.name, "이상한 상태");
    assert!(status.status_category.is_none());
}

#[test]
fn ignores_unknown_fields_in_response() {
    // Jira가 필드를 추가해도 우리가 깨지면 안 된다. fixture에 self/id/active 등이
    // 들어 있는 것 자체가 이 검증이지만, 명시적으로 한 번 더 못박는다.
    let json = serde_json::json!({
        "key": "X-1",
        "expand": "operations,versionedRepresentations",
        "fields": {
            "summary": "s",
            "customfield_99999": { "weird": true },
            "watches": { "watchCount": 3 }
        }
    });
    let issue: JiraIssue = serde_json::from_value(json).unwrap();
    assert_eq!(issue.summary, "s");
}

#[test]
fn list_issue_serializes_to_camel_case_for_frontend() {
    let page = page1();
    let json = serde_json::to_value(&page.issues[0]).unwrap();
    assert!(json.get("issueType").is_some(), "issueType (camelCase)");
    assert!(json.get("issue_type").is_none());
    assert_eq!(json["assignee"]["accountId"], "5f8a1b2c3d4e5f6a7b8c9d0e");
    assert_eq!(json["status"]["statusCategory"]["key"], "indeterminate");
}

#[test]
fn list_issue_omits_detail_only_fields() {
    // 목록 페이로드에 description/labels/reporter가 섞이면 IPC가 10배로 뚱뚱해진다.
    // `created`는 사용자가 열로 켤 수 있어 목록에도 들어간다(작은 문자열이라 부담이 없다).
    let page = page1();
    let json = serde_json::to_value(&page.issues[0]).unwrap();
    for forbidden in ["description", "labels", "reporter"] {
        assert!(
            json.get(forbidden).is_none(),
            "목록 타입에 {forbidden}가 있으면 안 된다"
        );
    }
}

// ---------------------------------------------------------------------------
// 커서 페이지네이션 — total은 존재하지 않는다
// ---------------------------------------------------------------------------

#[test]
fn search_page_exposes_cursor_not_total() {
    let page = page1();
    assert_eq!(page.issues.len(), 3);
    assert_eq!(page.next_page_token.as_deref(), Some("CAEaAggD"));
    assert!(page.has_more());

    // 신규 엔드포인트는 total을 주지 않는다. 직렬화 결과에도 있으면 안 된다 —
    // 있으면 프론트가 "N건 중 M건" UI를 만들려 든다 (DECISIONS 8장).
    let json = serde_json::to_value(&page).unwrap();
    assert!(
        json.get("total").is_none(),
        "SearchPage에 total이 있으면 안 된다"
    );
    assert!(json.get("startAt").is_none());
    assert_eq!(json["nextPageToken"], "CAEaAggD");
}

#[test]
fn last_page_has_no_cursor() {
    let page: SearchPage = serde_json::from_str(SEARCH_PAGE_2_LAST).unwrap();
    assert_eq!(page.issues.len(), 1);
    assert_eq!(page.issues[0].key, "OPS-12");
    // 종료 조건. 여기서 Some이 나오면 페이지네이션 루프가 안 끝난다.
    assert!(page.next_page_token.is_none());
    assert!(!page.has_more());
}

#[test]
fn is_last_true_overrides_a_stale_cursor() {
    // Jira가 isLast:true와 nextPageToken을 함께 주는 모순 응답을 보내면
    // 커서를 버려야 한다. 안 그러면 같은 페이지를 영원히 돈다.
    let json = r#"{"issues":[],"nextPageToken":"ZZZ","isLast":true}"#;
    let page: SearchPage = serde_json::from_str(json).unwrap();
    assert!(page.next_page_token.is_none());
}

#[test]
fn empty_cursor_string_is_treated_as_no_cursor() {
    let json = r#"{"issues":[],"nextPageToken":""}"#;
    let page: SearchPage = serde_json::from_str(json).unwrap();
    assert!(page.next_page_token.is_none());
}

#[test]
fn empty_result_set_is_not_an_error() {
    // "결과 없음"은 정상 상태다. 에러로 다루면 위젯이 빨개진다.
    let page: SearchPage = serde_json::from_str(SEARCH_EMPTY).unwrap();
    assert!(page.issues.is_empty());
    assert!(!page.has_more());
}

#[test]
fn missing_issues_key_yields_empty_list() {
    let page: SearchPage = serde_json::from_str("{}").unwrap();
    assert!(page.issues.is_empty());
    assert!(!page.has_more());
}

#[test]
fn walking_pages_terminates() {
    // 실제 페이지네이션 루프를 fixture 두 개로 흉내낸다.
    let pages = [SEARCH_PAGE_1, SEARCH_PAGE_2_LAST];
    let mut collected = Vec::new();
    let mut index = 0usize;
    let mut cursor: Option<String> = None;
    let mut guard = 0;

    loop {
        guard += 1;
        assert!(guard < 10, "페이지네이션이 끝나지 않았다");

        let page: SearchPage = serde_json::from_str(pages[index]).unwrap();
        collected.extend(page.issues.iter().map(|i| i.key.clone()));
        match page.next_page_token {
            Some(token) => {
                cursor = Some(token);
                index += 1;
            }
            None => break,
        }
    }

    assert!(cursor.is_some(), "중간에 커서를 한 번은 받았어야 한다");
    assert_eq!(collected, vec!["ABC-142", "ABC-139", "XYZ-77", "OPS-12"]);
}

// ---------------------------------------------------------------------------
// 상세 + ADF
// ---------------------------------------------------------------------------

#[test]
fn deserializes_issue_detail_with_adf_description() {
    let detail: JiraIssueDetail = serde_json::from_str(ISSUE_DETAIL).unwrap();

    assert_eq!(detail.key, "ABC-142");
    assert_eq!(detail.reporter.as_ref().unwrap().display_name, "박서준");
    assert_eq!(detail.labels, vec!["frontend", "performance"]);
    assert_eq!(
        detail.created.as_deref(),
        Some("2026-07-25T11:20:04.000+0900")
    );

    let adf = detail.description.as_ref().expect("description present");
    // ADF는 불투명하게 통과시킨다. 여기서 텍스트나 HTML로 변환하지 않는다.
    assert_eq!(adf["type"], "doc");
    assert_eq!(adf["version"], 1);
    assert_eq!(adf["content"][0]["type"], "paragraph");
    assert_eq!(adf["content"][1]["type"], "codeBlock");
    // 중첩된 marks가 온전히 남아 있어야 프론트가 렌더할 수 있다.
    assert_eq!(adf["content"][0]["content"][1]["marks"][0]["type"], "code");
}

#[test]
fn adf_preserves_unsupported_nodes_for_frontend_placeholder() {
    // DECISIONS 11.4: mediaSingle은 미지원이지만 **조용히 건너뛰지 않는다**.
    // 프론트가 회색 플레이스홀더를 그리려면 노드가 그대로 도착해야 한다.
    // 여기서 우리가 걸러버리면 사용자는 뭔가 빠진 줄도 모른다.
    let detail: JiraIssueDetail = serde_json::from_str(ISSUE_DETAIL).unwrap();
    let adf = detail.description.unwrap();
    let types: Vec<&str> = adf["content"]
        .as_array()
        .unwrap()
        .iter()
        .filter_map(|n| n["type"].as_str())
        .collect();
    assert!(
        types.contains(&"mediaSingle"),
        "미지원 노드도 그대로 전달되어야 한다: {types:?}"
    );
}

#[test]
fn null_description_becomes_none_not_json_null() {
    // 프론트가 `description !== null`로 분기할 수 있게 정규화한다.
    // serde_json::Value::Null이 그대로 오면 "설명 있음"으로 잘못 읽힌다.
    let detail: JiraIssueDetail = serde_json::from_str(ISSUE_MINIMAL).unwrap();
    assert!(detail.description.is_none());
}

#[test]
fn detail_normalizes_missing_labels_to_empty_vec() {
    let json = serde_json::json!({ "key": "X-1", "fields": { "summary": "s" } });
    let detail: JiraIssueDetail = serde_json::from_value(json).unwrap();
    assert!(detail.labels.is_empty());
    // null이 아니라 []여야 한다 — 프론트 분기 하나가 사라진다.
    let out = serde_json::to_value(&detail).unwrap();
    assert_eq!(out["labels"], serde_json::json!([]));
}

#[test]
fn detail_handles_all_nulls() {
    let detail: JiraIssueDetail = serde_json::from_str(ISSUE_MINIMAL).unwrap();
    assert_eq!(detail.key, "PRD-3");
    assert!(detail.assignee.is_none());
    assert!(detail.reporter.is_none());
    assert!(detail.priority.is_none());
    assert!(detail.description.is_none());
    assert!(detail.labels.is_empty());
}

#[test]
fn detail_serializes_camel_case() {
    let detail: JiraIssueDetail = serde_json::from_str(ISSUE_DETAIL).unwrap();
    let json = serde_json::to_value(&detail).unwrap();
    assert!(json.get("issueType").is_some());
    assert!(json.get("reporter").is_some());
    assert_eq!(json["reporter"]["accountId"], "6a1b2c3d4e5f6a7b8c9d0e1f");
    // 2차에 추가된 세 필드. 이 fixture에는 값이 없지만 **키는 나가야** 한다 —
    // 프론트가 `detail.dueDate`를 읽을 때 undefined와 "필드 자체가 없음"을
    // 구분하지 않아도 되게.
    assert!(json.get("dueDate").is_some(), "dueDate 키가 없다");
    assert!(json.get("parent").is_some(), "parent 키가 없다");
    assert!(json.get("sprint").is_some(), "sprint 키가 없다");
}

/// `DETAIL_FIELDS`는 `duedate`/`parent`/`customfield_10020`을 요청하는데
/// 2차 전까지 타입이 그것을 버리고 있었다. 상세 모달은 상위 티켓으로
/// 전환(D4)해야 하므로 parent가 반드시 살아야 한다.
#[test]
fn detail_keeps_due_date_parent_and_sprint() {
    let raw = serde_json::json!({
        "key": "ABC-142",
        "fields": {
            "summary": "요약",
            "duedate": "2026-08-04",
            "parent": { "key": "ABC-400", "fields": { "summary": "로그인 개선" } },
            "customfield_10020": [
                { "name": "Sprint 11", "state": "closed" },
                { "name": "Sprint 12", "state": "active" }
            ]
        }
    });

    let detail: JiraIssueDetail = serde_json::from_value(raw).unwrap();
    assert_eq!(detail.due_date.as_deref(), Some("2026-08-04"));

    let parent = detail.parent.expect("parent가 보존돼야 한다");
    assert_eq!(parent.key, "ABC-400");
    assert_eq!(parent.summary.as_deref(), Some("로그인 개선"));

    // 활성 스프린트를 고른다 — 목록용 JiraIssue와 같은 규칙.
    let sprint = detail.sprint.expect("sprint가 보존돼야 한다");
    assert_eq!(sprint.name, "Sprint 12");
}

// ---------------------------------------------------------------------------
// 코멘트
// ---------------------------------------------------------------------------

#[test]
fn deserializes_comments_with_adf_body() {
    let page: CommentPage = serde_json::from_str(COMMENTS).unwrap();
    // 코멘트는 구식 offset 페이지네이션이라 total이 있다. 검색과 다르다.
    assert_eq!(page.total, 2);
    assert_eq!(page.start_at, 0);
    assert_eq!(page.comments.len(), 2);

    let first = &page.comments[0];
    assert_eq!(first.id, "10200");
    assert_eq!(first.author.as_ref().unwrap().display_name, "박서준");
    let body = first.body.as_ref().unwrap();
    assert_eq!(body["type"], "doc");
    // mention 노드가 attrs와 함께 보존되어야 자체 스타일 칩을 그릴 수 있다.
    assert_eq!(body["content"][0]["content"][1]["type"], "mention");
    assert_eq!(
        body["content"][0]["content"][1]["attrs"]["id"],
        "5f8a1b2c3d4e5f6a7b8c9d0e"
    );
}

#[test]
fn deserializes_comment_with_null_author() {
    // 자동화 규칙이 남긴 코멘트는 author가 없다.
    let page: CommentPage = serde_json::from_str(COMMENTS).unwrap();
    assert!(page.comments[1].author.is_none());
    assert!(page.comments[1].body.is_some());
}

#[test]
fn empty_comment_page_deserializes() {
    let json = r#"{"startAt":0,"maxResults":50,"total":0,"comments":[]}"#;
    let page: CommentPage = serde_json::from_str(json).unwrap();
    assert!(page.comments.is_empty());
    assert_eq!(page.total, 0);
}

// ---------------------------------------------------------------------------
// createmeta — 프로젝트마다 필수 필드가 다르다 (DECISIONS 11.3)
// ---------------------------------------------------------------------------

#[test]
fn dth_requires_only_project_issuetype_summary() {
    let meta: CreateMeta = serde_json::from_str(CREATEMETA_ABC).unwrap();
    let mut required: Vec<&str> = meta
        .required_user_input()
        .iter()
        .map(|f| f.field_id.as_str())
        .collect();
    required.sort_unstable();
    assert_eq!(required, vec!["issuetype", "project", "summary"]);
}

/// ⚠️ **이 fixture는 합성 케이스다. 실물과 다르다.**
///
/// 2026-07-31 라이브 확인 결과, 실제 EDU의 `reporter`는 `hasDefaultValue: true`라
/// 폼에 그릴 필요가 없다(서버가 채운다). 실측 4개 조합(DTH/EDU/GRM/PX) 모두
/// 사용자 입력이 필요한 필수 필드는 project·issuetype·summary 3개뿐이다.
///
/// 그래도 이 테스트를 고치지 않는 이유: 검증 대상이 "EDU의 현재 설정"이 아니라
/// **"required이고 기본값이 없는 필드가 있으면 폼이 그것을 집어낸다"는 규칙**이기
/// 때문이다. 프로젝트 설정은 언제든 바뀔 수 있고, 그때 이 규칙이 살아 있어야 한다.
/// (DECISIONS 11.3 / 스펙 4.2, C1)
#[test]
fn edu_additionally_requires_reporter() {
    // 이게 DECISIONS 21장 "MCP 실측이 추측을 이김"의 그 케이스다.
    // ABC만 보고 폼을 고정했으면 XYZ 생성이 전부 실패했을 것.
    let meta: CreateMeta = serde_json::from_str(CREATEMETA_XYZ).unwrap();
    let mut required: Vec<&str> = meta
        .required_user_input()
        .iter()
        .map(|f| f.field_id.as_str())
        .collect();
    required.sort_unstable();
    assert_eq!(
        required,
        vec!["issuetype", "project", "reporter", "summary"]
    );
}

#[test]
fn fields_with_default_values_are_left_to_the_server() {
    // DECISIONS 11.3 규칙 3: hasDefaultValue: true면 폼에 그리지 않는다.
    let meta: CreateMeta = serde_json::from_str(CREATEMETA_ABC).unwrap();

    let reporter = meta.field("reporter").expect("reporter in schema");
    assert!(reporter.has_default_value);
    assert!(!reporter.required);

    // required_user_input에서 빠져야 한다.
    let ids: Vec<&str> = meta
        .required_user_input()
        .iter()
        .map(|f| f.field_id.as_str())
        .collect();
    assert!(!ids.contains(&"reporter"));
    assert!(!ids.contains(&"priority"));
}

#[test]
fn required_with_default_value_is_excluded_from_user_input() {
    // 경계 케이스: required: true인데 hasDefaultValue: true.
    // 서버가 채우므로 사용자에게 물으면 안 된다.
    let json = serde_json::json!({
        "fields": [
            { "fieldId": "reporter", "name": "Reporter", "required": true, "hasDefaultValue": true },
            { "fieldId": "summary", "name": "Summary", "required": true, "hasDefaultValue": false }
        ]
    });
    let meta: CreateMeta = serde_json::from_value(json).unwrap();
    let ids: Vec<&str> = meta
        .required_user_input()
        .iter()
        .map(|f| f.field_id.as_str())
        .collect();
    assert_eq!(ids, vec!["summary"]);
    // 다만 "스키마상 required"로는 여전히 잡혀야 한다.
    let mut all = meta.required_field_ids();
    all.sort_unstable();
    assert_eq!(all, vec!["reporter", "summary"]);
}

#[test]
fn extracts_allowed_values_for_dropdowns() {
    // DECISIONS 11.3 "부수 발견": allowedValues로 드롭다운을 추가 호출 없이 채운다.
    let meta: CreateMeta = serde_json::from_str(CREATEMETA_ABC).unwrap();
    let priority = meta.field("priority").expect("priority field");
    let labels: Vec<&str> = priority
        .allowed_values
        .iter()
        .filter_map(|v| v.label.as_deref())
        .collect();
    assert_eq!(labels, vec!["Highest", "Medium", "Lowest"]);
    assert_eq!(priority.allowed_values[0].id.as_deref(), Some("1"));
}

#[test]
fn allowed_value_label_falls_back_from_name_to_value_to_id() {
    // 커스텀 필드 옵션은 name 대신 value를 쓴다.
    let json = serde_json::json!({
        "fields": [{
            "fieldId": "customfield_10050",
            "name": "환경",
            "required": false,
            "hasDefaultValue": false,
            "allowedValues": [
                { "id": "1", "value": "운영" },
                { "id": "2", "name": "스테이징" },
                { "id": "3" }
            ]
        }]
    });
    let meta: CreateMeta = serde_json::from_value(json).unwrap();
    let field = meta.field("customfield_10050").unwrap();
    let labels: Vec<&str> = field
        .allowed_values
        .iter()
        .filter_map(|v| v.label.as_deref())
        .collect();
    assert_eq!(labels, vec!["운영", "스테이징", "3"]);
}

#[test]
fn createmeta_captures_schema_type() {
    let meta: CreateMeta = serde_json::from_str(CREATEMETA_XYZ).unwrap();
    assert_eq!(
        meta.field("reporter").unwrap().schema_type.as_deref(),
        Some("user")
    );
    assert_eq!(
        meta.field("summary").unwrap().schema_type.as_deref(),
        Some("string")
    );
    assert_eq!(
        meta.field("description").unwrap().schema_type.as_deref(),
        Some("doc")
    );
}

#[test]
fn createmeta_accepts_legacy_map_shape() {
    // 구 `/issue/createmeta?expand=projects.issuetypes.fields`는 fields가 맵이었다.
    // 둘 다 받아주면 엔드포인트를 바꿔도 타입이 안 깨진다.
    let json = serde_json::json!({
        "fields": {
            "summary": { "name": "Summary", "required": true, "hasDefaultValue": false,
                         "schema": { "type": "string" } },
            "priority": { "name": "Priority", "required": false, "hasDefaultValue": true }
        }
    });
    let meta: CreateMeta = serde_json::from_value(json).unwrap();
    // fieldId가 없으면 맵 키가 fieldId가 되어야 한다.
    assert!(meta.field("summary").is_some());
    assert!(meta.field("priority").is_some());
    let ids: Vec<&str> = meta
        .required_user_input()
        .iter()
        .map(|f| f.field_id.as_str())
        .collect();
    assert_eq!(ids, vec!["summary"]);
}

#[test]
fn empty_createmeta_yields_no_required_fields() {
    let meta: CreateMeta = serde_json::from_str("{}").unwrap();
    assert!(meta.fields.is_empty());
    assert!(meta.required_user_input().is_empty());
}

// ---------------------------------------------------------------------------
// 생성 페이로드
// ---------------------------------------------------------------------------

#[test]
fn builds_minimal_create_payload() {
    let input = CreateIssueInput {
        project_key: "ABC".into(),
        issue_type_id: "10082".into(),
        summary: "새 티켓".into(),
        description: None,
        extra_fields: Default::default(),
    };
    let payload = input.to_payload();
    assert_eq!(payload["fields"]["project"]["key"], "ABC");
    // 이슈타입은 이름이 아니라 id로 보낸다 — 같은 이름의 타입이 여럿일 수 있다.
    assert_eq!(payload["fields"]["issuetype"]["id"], "10082");
    assert_eq!(payload["fields"]["summary"], "새 티켓");
    // 설명이 없으면 키 자체를 넣지 않는다. null을 보내면 Jira가 400을 줄 수 있다.
    assert!(payload["fields"].get("description").is_none());
}

#[test]
fn create_payload_includes_adf_description() {
    let adf = serde_json::json!({
        "type": "doc",
        "version": 1,
        "content": [{ "type": "paragraph", "content": [{ "type": "text", "text": "본문" }] }]
    });
    let input = CreateIssueInput {
        project_key: "ABC".into(),
        issue_type_id: "10082".into(),
        summary: "s".into(),
        description: Some(adf.clone()),
        extra_fields: Default::default(),
    };
    assert_eq!(input.to_payload()["fields"]["description"], adf);
}

#[test]
fn create_payload_drops_json_null_description() {
    let input = CreateIssueInput {
        project_key: "ABC".into(),
        issue_type_id: "10082".into(),
        summary: "s".into(),
        description: Some(serde_json::Value::Null),
        extra_fields: Default::default(),
    };
    assert!(input.to_payload()["fields"].get("description").is_none());
}

#[test]
fn create_payload_merges_extra_fields_from_createmeta() {
    // XYZ처럼 reporter가 필수인 프로젝트. createmeta가 알려준 필드를 그대로 얹는다.
    let mut extra = std::collections::BTreeMap::new();
    extra.insert(
        "reporter".to_string(),
        serde_json::json!({ "id": "5f8a1b2c3d4e5f6a7b8c9d0e" }),
    );
    let input = CreateIssueInput {
        project_key: "XYZ".into(),
        issue_type_id: "10007".into(),
        summary: "교육 자료 갱신".into(),
        description: None,
        extra_fields: extra,
    };
    let payload = input.to_payload();
    assert_eq!(
        payload["fields"]["reporter"]["id"],
        "5f8a1b2c3d4e5f6a7b8c9d0e"
    );
    assert_eq!(payload["fields"]["project"]["key"], "XYZ");
}

#[test]
fn extra_fields_can_override_base_fields() {
    // 예외적으로 project를 id로 지정해야 하는 경우를 막지 않는다.
    let mut extra = std::collections::BTreeMap::new();
    extra.insert("project".to_string(), serde_json::json!({ "id": "10015" }));
    let input = CreateIssueInput {
        project_key: "ABC".into(),
        issue_type_id: "10082".into(),
        summary: "s".into(),
        description: None,
        extra_fields: extra,
    };
    let payload = input.to_payload();
    assert_eq!(payload["fields"]["project"]["id"], "10015");
    assert!(payload["fields"]["project"].get("key").is_none());
}

#[test]
fn deserializes_created_issue_response() {
    let created: CreatedIssue = serde_json::from_str(CREATED_ISSUE).unwrap();
    assert_eq!(created.key, "ABC-151");
    assert_eq!(created.id, "10602");
    assert!(created
        .self_url
        .as_deref()
        .unwrap()
        .contains("/issue/10602"));
}

// ---------------------------------------------------------------------------
// 연결 테스트
// ---------------------------------------------------------------------------

#[test]
fn deserializes_identity_for_connection_test() {
    let me: JiraIdentity = serde_json::from_str(MYSELF).unwrap();
    assert_eq!(me.account_id, "5f8a1b2c3d4e5f6a7b8c9d0e");
    assert_eq!(me.display_name, "김현우");
    assert_eq!(me.email_address.as_deref(), Some("you@example.com"));
    assert_eq!(
        me.avatar_url.as_deref(),
        Some("https://secure.gravatar.com/avatar/abc123?s=48")
    );
}

#[test]
fn identity_without_email_is_still_valid() {
    // 사이트 개인정보 설정이 이메일을 가릴 수 있다. 그건 연결 실패가 아니다.
    let json = serde_json::json!({
        "accountId": "acc-1",
        "displayName": "익명",
        "active": true
    });
    let me: JiraIdentity = serde_json::from_value(json).unwrap();
    assert_eq!(me.account_id, "acc-1");
    assert!(me.email_address.is_none());
    assert!(me.avatar_url.is_none());
}

// ---------------------------------------------------------------------------
// 필드 세트 — 성능 계약
// ---------------------------------------------------------------------------

#[test]
fn list_fields_stay_minimal() {
    // 이 상수가 커지면 위젯 페이로드가 그만큼 커진다. 늘리려면 의식적으로 이 테스트를 고쳐야 한다.
    assert_eq!(
        LIST_FIELDS.len(),
        10,
        "목록 필드가 늘었다 — 페이로드 영향 확인 (types.rs의 측정 주석도 갱신할 것)"
    );
    for expected in [
        "summary",
        "status",
        "assignee",
        "priority",
        "issuetype",
        "updated",
    ] {
        assert!(LIST_FIELDS.contains(&expected), "{expected} 누락");
    }
}

#[test]
fn list_fields_exclude_heavy_fields() {
    // description(ADF)이 목록에 섞이면 30건 응답이 수백 KB가 된다.
    for heavy in [
        "description",
        "comment",
        "attachment",
        "worklog",
        "*all",
        "*navigable",
    ] {
        assert!(
            !LIST_FIELDS.contains(&heavy),
            "목록에 무거운 필드 {heavy}가 있으면 안 된다"
        );
    }
}

#[test]
fn detail_fields_superset_of_list_fields() {
    // 상세를 열었는데 목록에 있던 정보가 사라지면 이상하다.
    for f in LIST_FIELDS {
        assert!(DETAIL_FIELDS.contains(f), "상세 필드에 {f} 누락");
    }
    assert!(DETAIL_FIELDS.contains(&"description"));
    assert!(DETAIL_FIELDS.contains(&"reporter"));
    assert!(DETAIL_FIELDS.contains(&"labels"));
    assert!(DETAIL_FIELDS.contains(&"created"));
}

// ---------------------------------------------------------------------------
// 프로젝트 + 이슈타입 (생성 폼)
// ---------------------------------------------------------------------------

/// 실측 응답 형태 (2026-07-31):
/// `{ startAt, maxResults, total, isLast, values: [{ key, name, issueTypes: [...] }] }`
#[test]
fn parses_projects_with_issue_types() {
    let raw = serde_json::json!({
        "startAt": 0,
        "maxResults": 50,
        "total": 2,
        "isLast": true,
        "values": [
            {
                "key": "ABC",
                "name": "Team",
                "issueTypes": [
                    { "id": "10082", "name": "기능", "subtask": false, "hierarchyLevel": 0 },
                    { "id": "10083", "name": "하위 작업", "subtask": true, "hierarchyLevel": -1 }
                ]
            },
            { "key": "XYZ", "name": "제품", "issueTypes": [] }
        ]
    });

    let page: super::super::types::ProjectWithTypesSearchPage =
        serde_json::from_value(raw).unwrap();

    assert!(page.is_last);
    assert_eq!(page.values.len(), 2);
    assert_eq!(page.values[0].key, "ABC");
    assert_eq!(page.values[0].issue_types.len(), 2);
    assert_eq!(page.values[0].issue_types[0].id, "10082");
    assert!(!page.values[0].issue_types[0].subtask);
    // 하위작업은 parent가 필요해 생성 폼에서 제외된다. 그 판단의 근거가 이 플래그다.
    assert!(page.values[0].issue_types[1].subtask);
    assert_eq!(page.values[0].issue_types[1].hierarchy_level, -1);
}

/// Jira가 `issueTypes`를 생략해도 파싱이 실패하면 안 된다 —
/// 프로젝트 목록 전체가 날아가고 설정창이 빈다.
#[test]
fn project_without_issue_types_still_parses() {
    let raw = serde_json::json!({
        "isLast": true,
        "values": [{ "key": "ABC", "name": "Team" }]
    });
    let page: super::super::types::ProjectWithTypesSearchPage =
        serde_json::from_value(raw).unwrap();
    assert_eq!(page.values[0].key, "ABC");
    assert!(page.values[0].issue_types.is_empty());
}

/// `hierarchyLevel`이 없는 응답(구 사이트)도 0으로 받아준다.
#[test]
fn missing_hierarchy_level_defaults_to_standard() {
    let raw = serde_json::json!({
        "isLast": true,
        "values": [{
            "key": "ABC", "name": "Team",
            "issueTypes": [{ "id": "1", "name": "작업" }]
        }]
    });
    let page: super::super::types::ProjectWithTypesSearchPage =
        serde_json::from_value(raw).unwrap();
    let t = &page.values[0].issue_types[0];
    assert_eq!(t.hierarchy_level, 0);
    assert!(!t.subtask);
}

/// 회귀 방지: `isLast`(camelCase)를 못 읽으면 페이지 순회가 끝을 알아채지 못한다.
/// 기존 `ProjectSearchPage`에도 같은 버그가 있었다 (2026-07-31 발견).
#[test]
fn plain_project_page_reads_is_last() {
    let raw = serde_json::json!({
        "isLast": true,
        "values": [{ "key": "ABC", "name": "Team" }]
    });
    let page: super::super::types::ProjectSearchPage = serde_json::from_value(raw).unwrap();
    assert!(page.is_last, "isLast를 읽지 못하면 빈 페이지를 한 번 더 받는다");
}

// ---------------------------------------------------------------------------
// 저장된 필터 (DECISIONS 11.1)
// ---------------------------------------------------------------------------

/// `/filter/search?expand=jql` 응답 파싱.
///
/// **이 응답 모양은 실측으로 확인하지 못했다** (구현 시점에 자격증명 접근이
/// 막혀 있었다). 문서 기준으로 썼고, 필드마다 `default`를 붙여 모양이 달라도
/// 파싱이 통째로 실패하지 않게 했다. 이 테스트는 그 방어가 실제로 되는지 본다.
#[test]
fn filter_search_page_reads_documented_shape() {
    let raw = serde_json::json!({
        "values": [{
            "id": "10001",
            "name": "우리 팀 스프린트",
            "jql": "project = ABC AND sprint IN openSprints()",
            "owner": {
                "accountId": "acc-me",
                "displayName": "김현우",
                "avatarUrls": { "48x48": "https://example.com/a.png" }
            }
        }]
    });
    let page: super::super::types::FilterSearchPage = serde_json::from_value(raw).unwrap();
    let f = page.values[0].clone().into_filter(Some("acc-me"));

    assert_eq!(f.id, "10001");
    assert_eq!(f.name, "우리 팀 스프린트");
    assert_eq!(
        f.jql.as_deref(),
        Some("project = ABC AND sprint IN openSprints()")
    );
    assert!(f.owner_is_me, "소유자 accountId가 내 것과 같으면 내 필터다");
}

/// 남이 공유해준 필터. 소유자가 다르면 `owner_is_me`가 false다.
#[test]
fn shared_filter_is_not_owned_by_me() {
    let raw = serde_json::json!({
        "values": [{
            "id": "10002",
            "name": "남의 필터",
            "owner": { "accountId": "acc-other", "displayName": "다른 사람" }
        }]
    });
    let page: super::super::types::FilterSearchPage = serde_json::from_value(raw).unwrap();
    let f = page.values[0].clone().into_filter(Some("acc-me"));
    assert!(!f.owner_is_me);
    // expand=jql이 없거나 권한이 없으면 jql이 안 온다. 그래도 파싱은 성공해야 한다.
    assert!(f.jql.is_none());
}

/// 내 accountId를 모르면(=/myself 실패) 판정을 포기하고 목록은 살린다.
/// "내가 만든 필터" 그룹이 안 갈리는 것보다 목록 자체가 안 뜨는 게 나쁘다.
#[test]
fn unknown_identity_does_not_lose_the_filter_list() {
    let raw = serde_json::json!({
        "values": [{ "id": "10003", "name": "필터", "owner": { "accountId": "acc-x" } }]
    });
    let page: super::super::types::FilterSearchPage = serde_json::from_value(raw).unwrap();
    let f = page.values[0].clone().into_filter(None);
    assert_eq!(f.id, "10003");
    assert!(!f.owner_is_me);
}

/// 소유자가 아예 없는 항목(삭제된 계정 등)도 목록에서 떨어지지 않아야 한다.
#[test]
fn filter_without_owner_still_parses() {
    let raw = serde_json::json!({ "values": [{ "id": "10004", "name": "주인 없는 필터" }] });
    let page: super::super::types::FilterSearchPage = serde_json::from_value(raw).unwrap();
    let f = page.values[0].clone().into_filter(Some("acc-me"));
    assert_eq!(f.name, "주인 없는 필터");
    assert!(!f.owner_is_me);
}

/// 응답에 우리가 모르는 필드가 잔뜩 있어도 무시하고 지나간다.
#[test]
fn unknown_filter_response_fields_are_ignored() {
    let raw = serde_json::json!({
        "self": "https://x/rest/api/3/filter/search?startAt=0",
        "maxResults": 50,
        "startAt": 0,
        "total": 1,
        "isLast": true,
        "values": [{
            "id": "10005",
            "name": "필터",
            "description": "설명",
            "favourite": true,
            "favouritedCount": 3,
            "sharePermissions": [],
            "viewUrl": "https://x/issues/?filter=10005"
        }]
    });
    let page: super::super::types::FilterSearchPage = serde_json::from_value(raw).unwrap();
    assert_eq!(page.values.len(), 1);
}
