//! GitHub provider 테스트.
//!
//! GraphQL 쿼리가 Rust 문자열 상수라 오타가 컴파일에 안 잡힌다. 그 대가를
//! **실제 응답 fixture로 파싱을 검증**해서 갚는다.
//!
//! - `search.json` — 진짜 응답이다(2026-08-02, `gh api graphql`로 캡처).
//!   실물이 어떤 모양인지가 유일한 진실이다.
//! - `variants.json` — 실물에 안 나온 조합(초안·변경요청·CI 실패·이슈·깨진 노드).
//!   손으로 썼다. 실제 계정에 그런 항목이 없어서 캡처할 수 없었다.

use super::error::{classify_status, ErrorKind, GithubError};
use super::presets::{apply_repo_filter, GithubPreset, GithubQuery, DEFAULT_PRESET_ID, PRESETS};
use super::types::{CheckState, GqlEnvelope, ItemState, ReviewState, SearchData};

/// fixture를 파싱해 평평한 항목 목록으로 만든다. 클라이언트가 하는 일과 같다.
fn parse(json: &str) -> (Vec<super::types::GithubItem>, i64) {
    let envelope: GqlEnvelope<SearchData> =
        serde_json::from_str(json).expect("fixture 파싱 실패");
    let data = envelope.data.expect("data 없음");
    let items = data
        .search
        .nodes
        .into_iter()
        .flatten()
        .filter_map(|n| n.flatten())
        .collect();
    (items, data.search.issue_count)
}

// ─────────────────────────── 실제 응답 ───────────────────────────

/// 실물 응답이 우리 타입으로 들어오는가. 이게 깨지면 스키마가 바뀐 것이다.
#[test]
fn parses_real_search_response() {
    let (items, total) = parse(include_str!("fixtures/search.json"));

    assert_eq!(total, 217, "issueCount를 못 읽었다");
    assert_eq!(items.len(), 8, "8개를 요청했는데 다 안 들어왔다");

    let first = &items[0];
    assert_eq!(first.repository, "hmu332233/herdr-f1");
    assert_eq!(first.number, 7);
    assert!(first.is_pull_request);
    assert_eq!(first.state, ItemState::Open);
    assert_eq!(first.author.as_deref(), Some("DevooKim"));
    assert_eq!(first.additions, Some(411));
    assert_eq!(first.deletions, Some(66));
}

/// id는 목록에서 유일해야 한다. React key로 쓴다.
#[test]
fn ids_are_unique() {
    let (items, _) = parse(include_str!("fixtures/search.json"));
    let mut ids: Vec<&str> = items.iter().map(|i| i.id.as_str()).collect();
    ids.sort_unstable();
    let before = ids.len();
    ids.dedup();
    assert_eq!(ids.len(), before, "중복 id가 있다 — React key가 깨진다");
}

/// CI는 `commits(last: 1)` 아래 깊은 곳에 있다. 경로가 틀리면 조용히 None이 된다.
#[test]
fn reads_ci_from_nested_commit() {
    let (items, _) = parse(include_str!("fixtures/search.json"));
    assert_eq!(
        items[0].ci,
        Some(CheckState::Success),
        "statusCheckRollup 경로가 틀렸다 (commits.nodes[0].commit 아래에 있다)"
    );
}

/// merged=true면 state가 뭐라고 오든 Merged다.
#[test]
fn merged_wins_over_state() {
    let (items, _) = parse(include_str!("fixtures/search.json"));
    let merged = items.iter().find(|i| i.number == 6).expect("6번 PR 없음");
    assert_eq!(merged.state, ItemState::Merged);
}

// ─────────────────────────── 변형 ───────────────────────────

#[test]
fn maps_draft_and_review_and_ci_variants() {
    let (items, _) = parse(include_str!("fixtures/variants.json"));

    let draft = &items[0];
    assert_eq!(draft.state, ItemState::Draft, "isDraft가 무시됐다");
    assert_eq!(draft.review, Some(ReviewState::ReviewRequired));
    assert_eq!(draft.ci, Some(CheckState::Pending));
    assert_eq!(draft.comments, 3);

    let changes = &items[1];
    assert_eq!(changes.review, Some(ReviewState::ChangesRequested));
    assert_eq!(changes.ci, Some(CheckState::Failure));

    let approved = &items[2];
    assert_eq!(approved.review, Some(ReviewState::Approved));
    assert_eq!(approved.ci, None, "CI를 안 돌리는 저장소는 None이어야 한다");
}

#[test]
fn maps_issues_without_pr_fields() {
    let (items, _) = parse(include_str!("fixtures/variants.json"));

    let open_issue = items.iter().find(|i| i.number == 4).expect("4번 없음");
    assert!(!open_issue.is_pull_request);
    assert_eq!(open_issue.state, ItemState::Open);
    assert_eq!(open_issue.review, None);
    assert_eq!(open_issue.ci, None);
    assert_eq!(open_issue.additions, None);

    let closed = items.iter().find(|i| i.number == 5).expect("5번 없음");
    assert_eq!(closed.state, ItemState::Closed);
    // author가 null인 경우(삭제된 계정)에도 항목은 살아야 한다.
    assert_eq!(closed.author, None);
}

/// **목록이 사라지면 안 된다** (CLAUDE.md). 이상한 노드는 그것만 버린다.
#[test]
fn drops_broken_nodes_without_failing_the_list() {
    let (items, total) = parse(include_str!("fixtures/variants.json"));

    // 노드 7개 중 빈 객체 1개와 repository가 null인 1개가 빠져 5개.
    assert_eq!(items.len(), 5, "깨진 노드 때문에 멀쩡한 항목까지 잃었다");
    assert_eq!(total, 7, "총 건수는 서버가 준 값 그대로여야 한다");
    assert!(
        !items.iter().any(|i| i.number == 6),
        "repository가 없는 항목은 id를 만들 수 없어 버려야 한다"
    );
}

// ─────────────────────────── 에러 분류 ───────────────────────────

/// GitHub은 rate limit에 403을 쓰기도 한다. remaining이 유일한 단서다.
#[test]
fn distinguishes_rate_limited_403_from_forbidden() {
    let limited = classify_status(403, "quota".into(), Some(60), Some(0));
    assert!(
        matches!(limited, GithubError::RateLimited { .. }),
        "remaining=0인 403은 rate limit이다"
    );
    assert!(limited.is_transient(), "rate limit은 재시도 대상이다");
    assert_eq!(limited.retry_after_secs(), Some(60));

    // SSO 미인증이 이 경로로 온다. 재시도하면 안 된다.
    let forbidden = classify_status(403, "SAML enforcement".into(), None, Some(4999));
    assert!(matches!(forbidden, GithubError::Forbidden { .. }));
    assert!(
        forbidden.is_permanent(),
        "권한 문제를 재시도하면 시간만 버린다"
    );
}

#[test]
fn classifies_by_status() {
    assert!(classify_status(401, "bad creds".into(), None, None).is_auth_failure());
    assert!(classify_status(404, "nope".into(), None, None).is_permanent());
    assert!(classify_status(422, "bad query".into(), None, None).is_permanent());
    assert!(classify_status(503, "down".into(), None, None).is_transient());
}

/// 알 수 없는 상태 코드: 5xx면 서버 문제로 보고 재시도를 허용한다.
#[test]
fn unknown_status_splits_on_5xx() {
    assert_eq!(
        classify_status(599, "?".into(), None, None).kind(),
        ErrorKind::Transient
    );
    assert_eq!(
        classify_status(418, "?".into(), None, None).kind(),
        ErrorKind::Permanent
    );
}

/// GraphQL 에러는 영구다 — 같은 쿼리를 다시 보내도 같은 자리에서 깨진다.
#[test]
fn graphql_errors_are_permanent() {
    let e = GithubError::GraphqlErrors {
        message: "Field 'foo' doesn't exist".into(),
    };
    assert!(e.is_permanent());
    assert!(!e.is_auth_failure());
}

/// 200 + errors 본문을 파싱할 수 있어야 한다. GraphQL 고유의 실패 경로다.
#[test]
fn parses_graphql_error_envelope() {
    let json = r#"{"data":null,"errors":[{"message":"Bad query"},{"message":"또 하나"}]}"#;
    let envelope: GqlEnvelope<SearchData> = serde_json::from_str(json).expect("파싱 실패");
    assert!(envelope.data.is_none());
    assert_eq!(envelope.errors.len(), 2);
    assert_eq!(envelope.errors[0].message, "Bad query");
}

// ─────────────────────────── 프리셋 ───────────────────────────

#[test]
fn default_preset_exists() {
    assert!(
        GithubPreset::by_id(DEFAULT_PRESET_ID).is_some(),
        "기본 프리셋 id가 목록에 없다 — 새 위젯이 빈 화면으로 시작한다"
    );
}

/// id는 config에 저장된다. 바꾸면 이미 배치된 위젯이 깨진다.
#[test]
fn preset_ids_are_stable_and_unique() {
    let expected = [
        "involves-me",
        "review-requested",
        "my-prs",
        "assigned-issues",
        "my-issues",
    ];
    let actual: Vec<&str> = PRESETS.iter().map(|p| p.id).collect();
    assert_eq!(actual, expected, "프리셋 id가 바뀌면 기존 위젯이 깨진다");
}

/// 모든 프리셋이 열린 것만 본다 — 닫힌 것까지 섞이면 "지금 볼 것"이 흐려진다.
#[test]
fn all_presets_filter_open() {
    for p in PRESETS {
        assert!(
            p.query.contains("is:open"),
            "{}에 is:open이 없다",
            p.id
        );
    }
}

#[test]
fn unknown_preset_yields_none() {
    let q = GithubQuery::Preset {
        id: "없는-프리셋".into(),
    };
    assert_eq!(q.to_search(), None);
    assert_eq!(q.default_title(), "GitHub");
}

#[test]
fn raw_query_passes_through_untouched() {
    let q = GithubQuery::Raw {
        query: "is:pr author:someone".into(),
    };
    assert_eq!(q.to_search().as_deref(), Some("is:pr author:someone"));
}

// ─────────────────────────── 저장소 필터 ───────────────────────────

#[test]
fn empty_filter_leaves_query_alone() {
    assert_eq!(apply_repo_filter("is:open", &[]), "is:open");
}

/// `repo:`가 여러 개면 GitHub 검색에서 OR로 동작한다 — "이 저장소들 중에서".
#[test]
fn repo_filter_appends_each_repo() {
    let repos = vec!["o/a".to_string(), "o/b".to_string()];
    assert_eq!(
        apply_repo_filter("is:open", &repos),
        "is:open repo:o/a repo:o/b"
    );
}

// ─────────────────────────── 토큰 마스킹 ───────────────────────────

/// 토큰이 로그에 찍히면 그걸로 끝이다 (CLAUDE.md: 마스킹 필수).
#[test]
fn credentials_debug_never_leaks_token() {
    let creds = super::client::GithubCredentials::new("ghp_supersecrettokenvalue");
    let rendered = format!("{creds:?}");
    assert!(
        !rendered.contains("supersecret"),
        "Debug에 토큰이 노출됐다: {rendered}"
    );
}
