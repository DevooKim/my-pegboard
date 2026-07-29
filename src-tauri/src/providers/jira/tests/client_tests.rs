//! 클라이언트 요청 조립 테스트.
//!
//! 네트워크를 치지 않는다. 검증 대상은 **우리가 무엇을 보내는가**다 —
//! 특히 `fields`를 항상 보내는지(성능 요구사항)와 자격증명이 로그로 새지 않는지.

use super::*;

// ---------------------------------------------------------------------------
// 인증 헤더
// ---------------------------------------------------------------------------

#[test]
fn builds_basic_auth_header() {
    // base64("me@example.com:tok123")
    let header = auth_header("me@example.com", "tok123");
    assert_eq!(header, "Basic bWVAZ29vcm0uaW86dG9rMTIz");
}

#[test]
fn auth_header_roundtrips_to_email_colon_token() {
    use base64::Engine as _;
    let header = auth_header("you@example.com", "ATATT3xFfGF0-secret");
    let encoded = header.strip_prefix("Basic ").expect("Basic prefix");
    let decoded = base64::engine::general_purpose::STANDARD
        .decode(encoded)
        .unwrap();
    assert_eq!(
        String::from_utf8(decoded).unwrap(),
        "you@example.com:ATATT3xFfGF0-secret"
    );
}

#[test]
fn auth_header_handles_non_ascii_and_padding() {
    // 토큰에 +/= 같은 문자가 들어가도 base64가 깨지지 않는지.
    let header = auth_header("한글@example.com", "a+b/c=d");
    assert!(header.starts_with("Basic "));
    assert!(header.len() > 10);
}

#[test]
fn credentials_debug_masks_the_token() {
    // CLAUDE.md: "로그에 토큰을 찍지 않는다. 마스킹 필수."
    // derive(Debug)를 쓰면 이 테스트가 즉시 깨진다.
    let creds = JiraCredentials::new(
        "https://your-team.atlassian.net",
        "me@example.com",
        "super-secret-token",
    );
    let shown = format!("{creds:?}");
    assert!(
        !shown.contains("super-secret-token"),
        "토큰이 노출됐다: {shown}"
    );
    assert!(shown.contains("***"));
    // 진단에 필요한 나머지는 보여야 한다.
    assert!(shown.contains("your-team.atlassian.net"));
    assert!(shown.contains("me@example.com"));
}

#[test]
fn client_debug_masks_the_token() {
    let client = JiraClient::new(JiraCredentials::new(
        "https://your-team.atlassian.net",
        "me@example.com",
        "super-secret-token",
    ))
    .unwrap();
    let shown = format!("{client:?}");
    assert!(
        !shown.contains("super-secret-token"),
        "토큰이 노출됐다: {shown}"
    );
}

// ---------------------------------------------------------------------------
// URL 조립
// ---------------------------------------------------------------------------

#[test]
fn joins_url_without_duplicate_slashes() {
    // 사용자가 설정창에 후행 슬래시를 붙여넣는 일은 반드시 생긴다.
    let expected = "https://your-team.atlassian.net/rest/api/3/search/jql";
    for base in [
        "https://your-team.atlassian.net",
        "https://your-team.atlassian.net/",
        "https://your-team.atlassian.net///",
    ] {
        assert_eq!(join_url(base, "/rest/api/3/search/jql"), expected);
        assert_eq!(join_url(base, "rest/api/3/search/jql"), expected);
    }
}

#[test]
fn client_exposes_base_url_as_configured() {
    let client = JiraClient::new(JiraCredentials::new(
        "https://your-team.atlassian.net",
        "e",
        "t",
    ))
    .unwrap();
    assert_eq!(client.base_url(), "https://your-team.atlassian.net");
}

#[test]
fn encodes_path_segments_safely() {
    // 정상 키는 그대로 통과해야 한다 — 인코딩이 과하면 URL이 깨진다.
    assert_eq!(encode_path("ABC-142"), "ABC-142");
    assert_eq!(encode_path("XYZ"), "XYZ");
    assert_eq!(encode_path("10082"), "10082");

    // 이상한 입력이 경로를 탈출하지 못하게.
    assert_eq!(encode_path("a/b"), "a%2Fb");
    assert_eq!(encode_path("a b"), "a%20b");
    assert_eq!(encode_path("../secret"), "..%2Fsecret");
    assert_eq!(encode_path("?x=1"), "%3Fx%3D1");
}

// ---------------------------------------------------------------------------
// 검색 본문 — 필드 축소가 핵심
// ---------------------------------------------------------------------------

#[test]
fn search_body_always_sends_explicit_fields() {
    // **성능 요구사항.** fields를 생략하면 Jira가 *navigable(~200 필드)을 준다.
    // DECISIONS 6장: "Jira가 이슈당 200개 필드를 주지만 위젯엔 5개면 충분."
    let body = build_search_body("assignee = currentUser()", 30, LIST_FIELDS, None);
    let fields = body["fields"].as_array().expect("fields must be sent");
    assert_eq!(fields.len(), 6);
    assert_eq!(body["fields"][0], "summary");
    assert_eq!(body["jql"], "assignee = currentUser()");
    assert_eq!(body["maxResults"], 30);
}

#[test]
fn search_body_never_requests_wildcard_fields() {
    let body = build_search_body("x", 30, LIST_FIELDS, None);
    let fields: Vec<&str> = body["fields"]
        .as_array()
        .unwrap()
        .iter()
        .filter_map(|v| v.as_str())
        .collect();
    for wildcard in ["*all", "*navigable"] {
        assert!(!fields.contains(&wildcard), "와일드카드 필드 요청 금지");
    }
}

#[test]
fn search_body_omits_cursor_on_first_page() {
    let body = build_search_body("x", 30, LIST_FIELDS, None);
    assert!(body.get("nextPageToken").is_none());
    // 구 엔드포인트의 startAt은 신규 엔드포인트가 받지 않는다. 보내면 안 된다.
    assert!(body.get("startAt").is_none());
}

#[test]
fn search_body_includes_cursor_on_subsequent_pages() {
    let body = build_search_body("x", 30, LIST_FIELDS, Some("CAEaAggD"));
    assert_eq!(body["nextPageToken"], "CAEaAggD");
}

#[test]
fn search_body_clamps_max_results_to_sane_range() {
    // 0을 그대로 보내면 Jira가 빈 배열을 주고 위젯이 "결과 없음"을 잘못 표시한다.
    assert_eq!(
        build_search_body("x", 0, LIST_FIELDS, None)["maxResults"],
        1
    );
    // 상한을 넘기면 메모리만 먹는다.
    assert_eq!(
        build_search_body("x", 100_000, LIST_FIELDS, None)["maxResults"],
        MAX_RESULTS_LIMIT
    );
    // 정상 범위는 그대로.
    assert_eq!(
        build_search_body("x", 30, LIST_FIELDS, None)["maxResults"],
        30
    );
    assert_eq!(
        build_search_body("x", MAX_RESULTS_LIMIT, LIST_FIELDS, None)["maxResults"],
        MAX_RESULTS_LIMIT
    );
}

#[test]
fn search_body_passes_jql_verbatim() {
    // JQL을 재작성하거나 이스케이프하지 않는다. 사용자가 쓴 그대로 간다.
    let jql = r#"project = ABC AND summary ~ "따옴표 \"안\" 문자열" ORDER BY created DESC"#;
    let body = build_search_body(jql, 30, LIST_FIELDS, None);
    assert_eq!(body["jql"], jql);
}

#[test]
fn search_body_accepts_custom_field_set() {
    // 상세 조회나 특수 위젯이 다른 필드 세트를 쓸 수 있어야 한다.
    let body = build_search_body("x", 5, &["summary", "duedate"], None);
    assert_eq!(body["fields"], serde_json::json!(["summary", "duedate"]));
}

#[test]
fn search_body_is_valid_json_object() {
    let body = build_search_body("x", 30, LIST_FIELDS, Some("tok"));
    assert!(body.is_object());
    let keys: Vec<&str> = body
        .as_object()
        .unwrap()
        .keys()
        .map(|s| s.as_str())
        .collect();
    // 우리가 보내는 키는 딱 이 넷이다. 실수로 뭔가 더 붙으면 잡힌다.
    let mut sorted = keys.clone();
    sorted.sort_unstable();
    assert_eq!(sorted, vec!["fields", "jql", "maxResults", "nextPageToken"]);
}

// ---------------------------------------------------------------------------
// GET 쿼리 파라미터
// ---------------------------------------------------------------------------

#[test]
fn fields_param_is_comma_separated() {
    assert_eq!(fields_param(&["summary", "status"]), "summary,status");
    assert_eq!(
        fields_param(DETAIL_FIELDS),
        "summary,status,assignee,reporter,priority,issuetype,updated,created,labels,description"
    );
}

#[test]
fn fields_param_handles_single_and_empty() {
    assert_eq!(fields_param(&["summary"]), "summary");
    assert_eq!(fields_param(&[]), "");
}

// ---------------------------------------------------------------------------
// 상수 — 성능 목표와 연결됨
// ---------------------------------------------------------------------------

#[test]
fn default_max_results_matches_decisions_document() {
    // DECISIONS 11.2 "표시 개수: 30"
    assert_eq!(DEFAULT_MAX_RESULTS, 30);
}

#[test]
fn timeouts_are_tight_enough_for_the_one_second_goal() {
    // 위젯 새로고침 체감 목표가 1초다. 30초씩 매달려 있으면
    // 백오프가 시작조차 못 하고 사용자는 멈춘 화면을 본다.
    assert!(DEFAULT_TIMEOUT.as_secs() <= 20, "전체 타임아웃이 너무 길다");
    assert!(
        DEFAULT_CONNECT_TIMEOUT < DEFAULT_TIMEOUT,
        "연결 타임아웃은 전체보다 짧아야 한다"
    );
}

#[test]
fn client_construction_succeeds_with_plain_credentials() {
    // 클라이언트는 키체인을 모른다 — 평문 파라미터만 받는다.
    let client = JiraClient::new(JiraCredentials::new(
        "https://your-team.atlassian.net",
        "me@example.com",
        "token",
    ));
    assert!(client.is_ok());
}

#[test]
fn client_can_share_an_existing_http_client() {
    // 커넥션 풀 재사용 경로가 살아 있는지.
    let http = reqwest::Client::new();
    let client = JiraClient::with_http_client(
        http,
        JiraCredentials::new("https://your-team.atlassian.net", "e", "t"),
    );
    assert_eq!(client.base_url(), "https://your-team.atlassian.net");
}

// ---------------------------------------------------------------------------
// 응답 본문 미리보기 (디코드 실패 진단용)
// ---------------------------------------------------------------------------

#[test]
fn preview_truncates_at_char_boundary() {
    // 한글 응답을 byte로 자르면 패닉이 난다.
    let body = "가".repeat(1000);
    let shown = preview(&body);
    assert!(shown.chars().count() <= 201);
    assert!(shown.ends_with('…'));
}

#[test]
fn preview_leaves_short_bodies_intact() {
    assert_eq!(preview("{\"ok\":true}"), "{\"ok\":true}");
    assert_eq!(preview(""), "");
}
