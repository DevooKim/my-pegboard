//! 에러 분류 테스트 (DECISIONS 16장).
//!
//! 이 파일이 지키는 계약은 하나다: **호출자가 재시도할 것과 하지 않을 것을 절대 헷갈리지 않는다.**
//! 401을 재시도하면 계정이 잠기고, 429를 재시도하지 않으면 위젯이 영영 안 뜬다.

use super::*;

const BAD_JQL: &str = include_str!("fixtures/error_bad_jql.json");
const CREATE_REQUIRED: &str = include_str!("fixtures/error_create_required.json");
const UNAUTHORIZED: &str = include_str!("fixtures/error_unauthorized.json");

// ---------------------------------------------------------------------------
// 상태코드 → 분류
// ---------------------------------------------------------------------------

#[test]
fn status_400_is_permanent_bad_request() {
    let err = JiraError::from_response(400, BAD_JQL, None);
    assert!(matches!(err, JiraError::BadRequest { .. }));
    assert_eq!(err.kind(), ErrorKind::Permanent);
    assert!(err.is_permanent());
    assert!(!err.is_transient());
}

#[test]
fn status_401_is_permanent_and_flags_auth_failure() {
    let err = JiraError::from_response(401, UNAUTHORIZED, None);
    assert!(matches!(err, JiraError::Unauthorized { .. }));
    assert_eq!(err.kind(), ErrorKind::Permanent);
    // 전역 배너 1회 규칙의 트리거. 401만 true여야 한다.
    assert!(err.is_auth_failure());
}

#[test]
fn status_403_is_permanent_but_not_auth_failure() {
    // 403은 인증은 됐고 권한만 없는 것이라, 전역 "로그인하세요" 배너를 띄우면 틀린 안내가 된다.
    let err = JiraError::from_response(403, r#"{"errorMessages":["권한이 없습니다."]}"#, None);
    assert!(matches!(err, JiraError::Forbidden { .. }));
    assert_eq!(err.kind(), ErrorKind::Permanent);
    assert!(!err.is_auth_failure());
}

#[test]
fn status_404_is_permanent() {
    let err = JiraError::from_response(404, r#"{"errorMessages":["Issue does not exist"]}"#, None);
    assert!(matches!(err, JiraError::NotFound { .. }));
    assert_eq!(err.kind(), ErrorKind::Permanent);
}

#[test]
fn status_429_is_transient() {
    let err = JiraError::from_response(429, "", None);
    assert!(matches!(err, JiraError::RateLimited { .. }));
    assert_eq!(err.kind(), ErrorKind::Transient);
    assert!(err.is_transient());
}

#[test]
fn status_5xx_is_transient() {
    for status in [500u16, 502, 503, 504] {
        let err = JiraError::from_response(status, "", None);
        assert!(
            matches!(err, JiraError::ServerError { .. }),
            "{status} should map to ServerError"
        );
        assert_eq!(
            err.kind(),
            ErrorKind::Transient,
            "{status} should be transient"
        );
    }
}

#[test]
fn network_error_is_transient() {
    let err = JiraError::Network {
        message: "connection refused".into(),
    };
    assert_eq!(err.kind(), ErrorKind::Transient);
}

#[test]
fn decode_error_is_permanent() {
    // 스키마가 바뀌었으면 재시도해도 같은 자리에서 깨진다. 재시도는 시간 낭비다.
    let err = JiraError::decode("search/jql", "missing field `key`");
    assert!(matches!(err, JiraError::Decode { .. }));
    assert_eq!(err.kind(), ErrorKind::Permanent);
    assert!(err.message().contains("search/jql"));
    assert!(err.message().contains("missing field"));
}

#[test]
fn unexpected_4xx_is_permanent_but_unexpected_5xx_is_transient() {
    // 418처럼 우리가 모르는 4xx는 재시도해도 같을 것으로 본다.
    let teapot = JiraError::from_response(418, "", None);
    assert!(matches!(teapot, JiraError::Unexpected { status: 418, .. }));
    assert_eq!(teapot.kind(), ErrorKind::Permanent);

    // 599 같은 비표준 5xx는 게이트웨이 문제일 가능성이 높으니 재시도를 허용한다.
    // (from_response는 500..600을 ServerError로 잡으므로 Unexpected를 직접 만든다)
    let weird = JiraError::Unexpected {
        status: 599,
        message: "gateway".into(),
    };
    assert_eq!(weird.kind(), ErrorKind::Transient);
}

#[test]
fn status_3xx_is_permanent_unexpected() {
    // 리다이렉트가 그대로 올라오면 base_url 설정이 잘못된 것 — 재시도로 고쳐지지 않는다.
    let err = JiraError::from_response(302, "", None);
    assert_eq!(err.kind(), ErrorKind::Permanent);
}

// ---------------------------------------------------------------------------
// Retry-After
// ---------------------------------------------------------------------------

#[test]
fn rate_limit_carries_retry_after_when_present() {
    let err = JiraError::from_response(429, "", Some(30));
    assert_eq!(err.retry_after_secs(), Some(30));
    // 사용자에게 보이는 문자열에도 초가 들어가야 한다.
    assert!(err.to_string().contains("30초"));
}

#[test]
fn rate_limit_without_retry_after_yields_none() {
    // 헤더가 없으면 호출자가 자기 백오프 스케줄을 쓴다.
    let err = JiraError::from_response(429, "", None);
    assert_eq!(err.retry_after_secs(), None);
}

#[test]
fn only_rate_limit_exposes_retry_after() {
    assert_eq!(
        JiraError::from_response(500, "", Some(10)).retry_after_secs(),
        None
    );
    assert_eq!(
        JiraError::from_response(401, "", Some(10)).retry_after_secs(),
        None
    );
}

#[test]
fn parse_retry_after_accepts_integer_seconds() {
    assert_eq!(parse_retry_after("30"), Some(30));
    assert_eq!(parse_retry_after("  120 "), Some(120));
    assert_eq!(parse_retry_after("0"), Some(0));
}

#[test]
fn parse_retry_after_rejects_http_date_and_garbage() {
    // RFC 7231은 HTTP-date도 허용하지만 Atlassian Cloud는 초를 쓴다.
    // 파싱 실패는 패닉이 아니라 None이어야 한다 — 호출자가 기본 백오프로 넘어간다.
    assert_eq!(parse_retry_after("Wed, 21 Oct 2026 07:28:00 GMT"), None);
    assert_eq!(parse_retry_after(""), None);
    assert_eq!(parse_retry_after("-5"), None);
    assert_eq!(parse_retry_after("1.5"), None);
}

// ---------------------------------------------------------------------------
// Jira 원문 메시지 보존 — DECISIONS 16장 "Jira 메시지가 친절함"
// ---------------------------------------------------------------------------

#[test]
fn preserves_jira_error_messages_verbatim() {
    let err = JiraError::from_response(400, BAD_JQL, None);
    // 한 글자도 바꾸지 않는다. 우리가 다시 쓰면 나빠지기만 한다.
    assert_eq!(
        err.message(),
        "Field 'asignee' does not exist or you do not have permission to view it."
    );
}

#[test]
fn preserves_field_level_errors_sorted_deterministically() {
    let err = JiraError::from_response(400, CREATE_REQUIRED, None);
    // `errors` 맵은 순서가 보장되지 않으므로 키로 정렬해 결정적으로 만든다.
    assert_eq!(
        err.message(),
        "reporter: Reporter is required.\nsummary: You must specify a summary of the issue."
    );
}

#[test]
fn joins_multiple_error_messages_with_newline() {
    let body = r#"{"errorMessages":["첫 번째 문제","두 번째 문제"],"errors":{}}"#;
    let err = JiraError::from_response(400, body, None);
    assert_eq!(err.message(), "첫 번째 문제\n두 번째 문제");
}

#[test]
fn combines_error_messages_and_field_errors() {
    let body = r#"{"errorMessages":["전반적 오류"],"errors":{"summary":"필수입니다"}}"#;
    let err = JiraError::from_response(400, body, None);
    assert_eq!(err.message(), "전반적 오류\nsummary: 필수입니다");
}

#[test]
fn falls_back_to_bare_message_field() {
    // 게이트웨이 레벨 응답은 Jira 봉투 대신 `message` 하나만 준다.
    let err = JiraError::from_response(503, r#"{"message":"Service Unavailable"}"#, None);
    assert_eq!(err.message(), "Service Unavailable");
}

#[test]
fn falls_back_to_raw_body_when_not_jira_envelope() {
    // Cloudflare가 HTML 에러 페이지를 반환하는 경우.
    let err = JiraError::from_response(502, "<html><body>Bad Gateway</body></html>", None);
    assert!(err.message().contains("Bad Gateway"));
    assert_eq!(err.kind(), ErrorKind::Transient);
}

#[test]
fn empty_body_still_produces_a_message() {
    // 조용한 실패 금지 — 본문이 없어도 사용자에게 보여줄 문자열은 있어야 한다.
    let err = JiraError::from_response(500, "", None);
    assert!(err.message().contains("500"));
    assert!(!err.message().is_empty());
}

#[test]
fn empty_envelope_falls_back_rather_than_yielding_empty_message() {
    // errorMessages와 errors가 둘 다 비어 있으면 원문 JSON이라도 보여준다.
    let err = JiraError::from_response(400, r#"{"errorMessages":[],"errors":{}}"#, None);
    assert!(!err.message().is_empty());
}

#[test]
fn long_body_is_truncated_at_char_boundary() {
    // 한글 본문을 byte로 자르면 패닉이 난다. 이 테스트가 그걸 막는다.
    let body = "가".repeat(2000);
    let err = JiraError::from_response(500, &body, None);
    let msg = err.message();
    assert!(msg.chars().count() <= 501, "잘려야 한다");
    assert!(msg.ends_with('…'));
}

#[test]
fn non_object_json_body_falls_back_to_raw_text() {
    // 본문이 배열이나 문자열이면 get()이 None을 주고 fallback으로 가야 한다.
    let err = JiraError::from_response(400, r#"["nope"]"#, None);
    assert!(err.message().contains("nope"));
}

// ---------------------------------------------------------------------------
// 토큰 마스킹 (CLAUDE.md "로그에 토큰을 찍지 않는다")
// ---------------------------------------------------------------------------

#[test]
fn sanitize_strips_credentials_from_urls() {
    let dirty = "error sending request for url (https://me%40example.com:secret-token@your-team.atlassian.net/rest/api/3/myself)";
    let clean = sanitize(dirty);
    assert!(!clean.contains("secret-token"), "토큰이 남아 있다: {clean}");
    assert!(clean.contains("***@your-team.atlassian.net"));
    assert!(clean.contains("/rest/api/3/myself"));
}

#[test]
fn response_bodies_echoing_credentials_are_masked() {
    // 프록시/게이트웨이가 요청 URL을 그대로 에코하는 에러 페이지를 돌려주는 경우.
    // 그 본문이 사용자 화면과 로그에 그대로 가면 토큰이 새어나간다.
    let body = "Bad Gateway while fetching https://me%40example.com:ATATT-secret@your-team.atlassian.net/rest/api/3/myself";
    let err = JiraError::from_response(502, body, None);
    assert!(
        !err.message().contains("ATATT-secret"),
        "토큰이 남아 있다: {}",
        err.message()
    );
    assert!(err.message().contains("***@your-team.atlassian.net"));
}

#[test]
fn credentials_are_masked_before_truncation_at_every_cut_point() {
    // 회귀 방지. 자르기를 먼저 하면 잘림 지점이 URL의 종결 '@' 앞에 떨어졌을 때
    // sanitize가 authority를 못 알아보고 토큰이 통째로 살아남는다.
    // (이 순서를 뒤집으면 아래에서 반드시 실패한다 — 실측으로 확인한 유출이다.)
    let secret = "ATATT-SUPERSECRET-TOKEN-VALUE";
    for pad in 400..520usize {
        let body = format!(
            "{} https://me:{secret}@your-team.atlassian.net/rest/api/3/myself",
            "X".repeat(pad)
        );
        let err = JiraError::from_response(502, &body, None);
        let msg = err.message();
        // 토큰 조각이 8자 이상 남으면 유출로 본다.
        for n in 8..=secret.len() {
            assert!(
                !msg.contains(&secret[..n]),
                "pad={pad}에서 토큰 앞 {n}자가 유출됨: {msg}"
            );
        }
    }
}

#[test]
fn sanitizing_does_not_alter_ordinary_jira_messages() {
    // Jira 자신의 메시지에는 URL이 없다. 마스킹이 원문을 건드리면 안 된다
    // (DECISIONS 16장 — 400 메시지는 한 글자도 바꾸지 않는다).
    let err = JiraError::from_response(400, BAD_JQL, None);
    assert_eq!(
        err.message(),
        "Field 'asignee' does not exist or you do not have permission to view it."
    );
}

#[test]
fn sanitize_leaves_plain_urls_untouched() {
    let text = "error connecting to https://your-team.atlassian.net/rest/api/3/search/jql";
    assert_eq!(sanitize(text), text);
}

#[test]
fn sanitize_handles_text_without_urls() {
    assert_eq!(sanitize("operation timed out"), "operation timed out");
    assert_eq!(sanitize(""), "");
}

#[test]
fn sanitize_handles_multiple_urls() {
    let dirty = "https://a:b@one.example.com/x and https://c:d@two.example.com/y";
    let clean = sanitize(dirty);
    assert!(!clean.contains(":b@"));
    assert!(!clean.contains(":d@"));
    assert!(clean.contains("***@one.example.com"));
    assert!(clean.contains("***@two.example.com"));
}

// ---------------------------------------------------------------------------
// 표시 및 직렬화
// ---------------------------------------------------------------------------

#[test]
fn display_includes_status_context_for_every_variant() {
    // 사용자가 보는 문자열에 "무슨 일인지"가 항상 들어가야 한다.
    let cases: Vec<(JiraError, &str)> = vec![
        (
            JiraError::Unauthorized {
                message: "m".into(),
            },
            "401",
        ),
        (
            JiraError::Forbidden {
                message: "m".into(),
            },
            "403",
        ),
        (
            JiraError::NotFound {
                message: "m".into(),
            },
            "404",
        ),
        (
            JiraError::BadRequest {
                message: "m".into(),
            },
            "400",
        ),
        (
            JiraError::RateLimited {
                message: "m".into(),
                retry_after_secs: None,
            },
            "429",
        ),
        (
            JiraError::ServerError {
                status: 503,
                message: "m".into(),
            },
            "503",
        ),
        (
            JiraError::Network {
                message: "m".into(),
            },
            "네트워크",
        ),
        (
            JiraError::Decode {
                message: "m".into(),
            },
            "해석",
        ),
        (
            JiraError::Unexpected {
                status: 418,
                message: "m".into(),
            },
            "418",
        ),
    ];
    for (err, needle) in cases {
        let shown = err.to_string();
        assert!(
            shown.contains(needle),
            "{shown:?} should contain {needle:?}"
        );
    }
}

#[test]
fn every_variant_exposes_its_message() {
    // message()가 어떤 variant에서도 빈 문자열을 주지 않는지 — 조용한 실패 방지.
    let all = [
        JiraError::Unauthorized {
            message: "a".into(),
        },
        JiraError::Forbidden {
            message: "b".into(),
        },
        JiraError::NotFound {
            message: "c".into(),
        },
        JiraError::BadRequest {
            message: "d".into(),
        },
        JiraError::RateLimited {
            message: "e".into(),
            retry_after_secs: Some(1),
        },
        JiraError::ServerError {
            status: 500,
            message: "f".into(),
        },
        JiraError::Network {
            message: "g".into(),
        },
        JiraError::Decode {
            message: "h".into(),
        },
        JiraError::Unexpected {
            status: 0,
            message: "i".into(),
        },
    ];
    for err in &all {
        assert!(!err.message().is_empty());
    }
}

#[test]
fn kind_partitions_every_variant_exactly_once() {
    // transient와 permanent는 상보적이어야 한다. 둘 다 false인 variant가 생기면
    // 스케줄러가 그 에러를 어떻게 다룰지 모른다.
    let all = [
        JiraError::Unauthorized {
            message: "a".into(),
        },
        JiraError::Forbidden {
            message: "b".into(),
        },
        JiraError::NotFound {
            message: "c".into(),
        },
        JiraError::BadRequest {
            message: "d".into(),
        },
        JiraError::RateLimited {
            message: "e".into(),
            retry_after_secs: None,
        },
        JiraError::ServerError {
            status: 500,
            message: "f".into(),
        },
        JiraError::Network {
            message: "g".into(),
        },
        JiraError::Decode {
            message: "h".into(),
        },
        JiraError::Unexpected {
            status: 418,
            message: "i".into(),
        },
    ];
    for err in &all {
        assert_ne!(
            err.is_transient(),
            err.is_permanent(),
            "{err:?} must be exactly one of transient/permanent"
        );
    }
}

#[test]
fn error_serializes_with_tagged_type_for_frontend() {
    // 프론트가 `type`으로 분기해 어떤 UI를 그릴지 고른다.
    let err = JiraError::RateLimited {
        message: "too many".into(),
        retry_after_secs: Some(15),
    };
    let json = serde_json::to_value(&err).unwrap();
    assert_eq!(json["type"], "rateLimited");
    assert_eq!(json["retryAfterSecs"], 15);
    assert_eq!(json["message"], "too many");
}

#[test]
fn error_kind_serializes_camel_case() {
    assert_eq!(
        serde_json::to_value(ErrorKind::Transient).unwrap(),
        serde_json::json!("transient")
    );
    assert_eq!(
        serde_json::to_value(ErrorKind::Permanent).unwrap(),
        serde_json::json!("permanent")
    );
}

#[test]
fn error_roundtrips_through_json() {
    let original = JiraError::BadRequest {
        message: "Field 'x' does not exist".into(),
    };
    let json = serde_json::to_string(&original).unwrap();
    let back: JiraError = serde_json::from_str(&json).unwrap();
    assert_eq!(original, back);
}
