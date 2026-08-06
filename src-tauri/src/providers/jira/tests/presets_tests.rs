//! 프리셋 JQL 생성 테스트 (DECISIONS 11.1).
//!
//! 프리셋 id는 위젯 config에 저장된다. **id를 바꾸면 사용자가 배치해둔 위젯이 조용히 깨진다** —
//! 그 사고를 막는 것이 이 파일의 절반이다.

use super::*;

#[test]
fn required_presets_exist() {
    // DECISIONS 11.1이 최소한으로 요구한 세 개.
    for id in ["assigned-to-me", "reported-by-me", "my-projects-recent"] {
        assert!(Preset::by_id(id).is_some(), "프리셋 {id}가 없다");
    }
}

#[test]
fn assigned_to_me_matches_decisions_document() {
    // DECISIONS 11.1에 문자 그대로 적힌 JQL.
    let jql = Preset::by_id("assigned-to-me").unwrap().jql;
    assert!(jql.contains("assignee = currentUser()"));
    assert!(jql.contains("resolution = Unresolved"));
}

#[test]
fn reported_by_me_uses_reporter() {
    let jql = Preset::by_id("reported-by-me").unwrap().jql;
    assert!(jql.contains("reporter = currentUser()"));
    assert!(jql.contains("resolution = Unresolved"));
}

#[test]
fn user_scoped_presets_use_current_user_function() {
    // 진짜 목적은 "accountId를 미리 조회하지 않는다"이다 (DECISIONS 11.1).
    // 하나라도 accountId를 박아두면 위젯마다 /myself 호출이 붙는다.
    //
    // 사용자 범위가 아닌 프리셋(예: 스프린트 전체)은 currentUser()가 필요 없다.
    // 그런 프리셋도 accountId를 쓰지 않는다는 것은 아래 테스트가 따로 보장한다.
    const TEAM_SCOPED: &[&str] = &["current-sprint-team"];

    for preset in Preset::all() {
        if TEAM_SCOPED.contains(&preset.id) {
            continue;
        }
        assert!(
            preset.jql.contains("currentUser()"),
            "프리셋 {}가 currentUser()를 쓰지 않는다: {}",
            preset.id,
            preset.jql
        );
    }
}

#[test]
fn no_preset_hardcodes_an_account_id() {
    for preset in Preset::all() {
        assert!(
            !preset.jql.contains("accountId"),
            "프리셋 {}에 accountId가 박혀 있다",
            preset.id
        );
        // 이 사이트의 실제 계정 id 조각이 새어 들어가지 않았는지도 본다.
        assert!(!preset.jql.contains("5f8a1b2c"));
    }
}

#[test]
fn every_preset_orders_by_updated_desc() {
    // 기본 정렬은 최근 업데이트순 (DECISIONS 11.2).
    // 프리셋이 완성된 JQL을 들고 있어야 위젯이 문자열을 이어붙이다 깨지지 않는다.
    for preset in Preset::all() {
        assert!(
            preset.jql.contains("ORDER BY updated DESC"),
            "프리셋 {}에 정렬이 없다",
            preset.id
        );
    }
}

#[test]
fn preset_ids_are_unique() {
    let mut ids: Vec<&str> = Preset::all().iter().map(|p| p.id).collect();
    let count = ids.len();
    ids.sort_unstable();
    ids.dedup();
    assert_eq!(ids.len(), count, "프리셋 id가 중복됐다");
}

#[test]
fn preset_ids_are_stable_identifiers() {
    // 저장된 위젯 config가 이 id들을 참조한다. 이름을 바꾸려면
    // 마이그레이션을 같이 써야 하고, 그 사실을 이 테스트가 상기시킨다.
    let ids: Vec<&str> = Preset::all().iter().map(|p| p.id).collect();
    assert_eq!(
        ids,
        vec![
            "assigned-to-me",
            "current-sprint-mine",
            "current-sprint-team",
            "reported-by-me",
            "my-projects-recent",
            "watched-by-me",
            "mentioned-recently",
        ]
    );
}

#[test]
fn preset_names_and_descriptions_are_present() {
    // 설정 UI가 빈 드롭다운 항목을 그리는 일이 없게.
    for preset in Preset::all() {
        assert!(!preset.name.is_empty(), "{} 이름 없음", preset.id);
        assert!(!preset.description.is_empty(), "{} 설명 없음", preset.id);
        assert!(!preset.jql.is_empty(), "{} JQL 없음", preset.id);
    }
}

#[test]
fn preset_jql_has_no_stray_whitespace_from_line_continuation() {
    // 소스에서 `\` 줄바꿈으로 이어붙인 JQL이 있다. 들여쓰기가 딸려오면
    // JQL 자체는 유효하지만 로그와 설정 UI가 지저분해진다.
    for preset in Preset::all() {
        assert!(
            !preset.jql.contains("  "),
            "프리셋 {}에 연속 공백이 있다: {:?}",
            preset.id,
            preset.jql
        );
        assert_eq!(preset.jql.trim(), preset.jql);
    }
}

// ---------------------------------------------------------------------------
// JiraQuery — 프리셋과 생 JQL
// ---------------------------------------------------------------------------

#[test]
fn preset_query_resolves_to_its_jql() {
    let query = JiraQuery::Preset {
        id: "assigned-to-me".into(),
    };
    assert_eq!(
        query.to_jql().as_deref(),
        Some("assignee = currentUser() AND resolution = Unresolved ORDER BY updated DESC")
    );
}

#[test]
fn unknown_preset_id_yields_none_rather_than_bad_jql() {
    // 프리셋을 제거한 뒤 옛 config를 읽으면 여기로 온다.
    // 빈 JQL을 보내면 Jira가 전체 이슈를 준다 — 조용한 오작동. None이 맞다.
    let query = JiraQuery::Preset {
        id: "was-removed".into(),
    };
    assert!(query.to_jql().is_none());
}

#[test]
fn raw_query_passes_through_verbatim() {
    // 탈출구는 손대지 않는다. 검증도 하지 않는다 — Jira가 더 나은 에러를 준다.
    let jql = "project = PRD AND labels IN (urgent, \"needs review\") ORDER BY created ASC";
    let query = JiraQuery::Raw { jql: jql.into() };
    assert_eq!(query.to_jql().as_deref(), Some(jql));
}

#[test]
fn raw_query_preserves_even_invalid_jql() {
    // 우리가 JQL 파서를 쓰지 않는다는 계약. 틀린 건 Jira가 400으로 알려주고
    // 그 메시지를 우리는 원문 그대로 사용자에게 보여준다 (DECISIONS 16장).
    let broken = "assignee = = currentUser()";
    let query = JiraQuery::Raw { jql: broken.into() };
    assert_eq!(query.to_jql().as_deref(), Some(broken));
}

#[test]
fn preset_query_supplies_default_widget_title() {
    let query = JiraQuery::Preset {
        id: "reported-by-me".into(),
    };
    assert_eq!(query.default_title(), "내가 보고한 티켓");
}

#[test]
fn raw_and_unknown_preset_fall_back_to_generic_title() {
    assert_eq!(
        JiraQuery::Raw {
            jql: "project = X".into()
        }
        .default_title(),
        "Jira"
    );
    assert_eq!(
        JiraQuery::Preset { id: "nope".into() }.default_title(),
        "Jira"
    );
}

#[test]
fn default_query_is_assigned_to_me() {
    // 위젯을 새로 추가했을 때 바로 쓸모 있는 게 보여야 한다.
    assert_eq!(
        default_query(),
        JiraQuery::Preset {
            id: "assigned-to-me".into()
        }
    );
    assert!(default_query().to_jql().is_some());
}

// ---------------------------------------------------------------------------
// 저장된 필터 (DECISIONS 11.1)
// ---------------------------------------------------------------------------

#[test]
fn saved_filter_delegates_resolution_to_jira() {
    // `filter = <id>`는 JQL 문법 자체다. 필터 id를 JQL로 풀기 위해 우리가
    // 네트워크를 타지 않는다는 것이 이 설계의 핵심 — 추가 조회 0회.
    let query = JiraQuery::SavedFilter {
        id: "10001".into(),
        name: "우리 팀 스프린트".into(),
    };
    assert_eq!(
        query.to_jql().as_deref(),
        Some("filter = 10001 ORDER BY updated DESC")
    );
}

#[test]
fn saved_filter_does_not_inline_the_filters_jql() {
    // 프리셋과 같은 이유(위 `preset_stores_id_not_expanded_jql`): JQL을 굳혀
    // 저장하면 Jira에서 필터를 고쳐도 위젯이 따라가지 못한다.
    let jql = JiraQuery::SavedFilter {
        id: "10001".into(),
        name: "x".into(),
    }
    .to_jql()
    .unwrap();
    assert!(
        jql.starts_with("filter = 10001"),
        "필터 id를 그대로 넘겨야 한다: {jql}"
    );
}

#[test]
fn non_numeric_filter_id_yields_none_rather_than_injectable_jql() {
    // **인젝션 방지.** 이 값은 JQL에 그대로 들어가므로 숫자만 허용한다.
    // 손으로 고친 board.json 말고는 이런 값이 올 수 없지만, 오면 막아야 한다.
    for bad in [
        "10001 OR project = SECRET",
        "10001; DROP",
        "abc",
        "",
        " 10001",
        "10001 ",
        "1e5",
        "-1",
        "10_001",
        "١٠٠٠١", // 아라비아-인도 숫자. `is_numeric`이면 통과한다 — ascii여야 한다.
    ] {
        let query = JiraQuery::SavedFilter {
            id: bad.into(),
            name: "필터".into(),
        };
        assert!(
            query.to_jql().is_none(),
            "숫자가 아닌 필터 id가 JQL을 만들었다: {bad:?}"
        );
    }
}

#[test]
fn numeric_filter_ids_are_accepted() {
    for good in ["1", "10001", "99999999"] {
        assert!(
            is_numeric_filter_id(good),
            "숫자 id가 거부됐다: {good:?}"
        );
    }
}

#[test]
fn saved_filter_title_comes_from_the_stored_name() {
    // name은 표시용 캐시다. 여기서 서버에 물어보면 위젯 제목 하나에 네트워크가 붙고,
    // 앱 시작 0ms 시점에 제목이 "Jira"로 떨어졌다가 바뀌는 깜빡임이 생긴다.
    let query = JiraQuery::SavedFilter {
        id: "10001".into(),
        name: "우리 팀 스프린트".into(),
    };
    assert_eq!(query.default_title(), "우리 팀 스프린트");
}

#[test]
fn saved_filter_without_a_name_falls_back_to_generic_title() {
    // 옛 config나 손으로 고친 파일에서 올 수 있다. 빈 제목을 그리지 않는다.
    assert_eq!(
        JiraQuery::SavedFilter {
            id: "10001".into(),
            name: String::new(),
        }
        .default_title(),
        "Jira"
    );
}

// ---------------------------------------------------------------------------
// 직렬화 — 위젯 config에 저장되는 모양
// ---------------------------------------------------------------------------

#[test]
fn query_serializes_as_tagged_union() {
    let preset = JiraQuery::Preset {
        id: "assigned-to-me".into(),
    };
    assert_eq!(
        serde_json::to_value(&preset).unwrap(),
        serde_json::json!({ "kind": "preset", "id": "assigned-to-me" })
    );

    let raw = JiraQuery::Raw {
        jql: "project = ABC".into(),
    };
    assert_eq!(
        serde_json::to_value(&raw).unwrap(),
        serde_json::json!({ "kind": "raw", "jql": "project = ABC" })
    );

    // 저장된 필터는 id와 name **둘 다** 저장된다. name이 빠지면 시작 시점에
    // 제목을 풀 방법이 없어진다.
    let saved = JiraQuery::SavedFilter {
        id: "10001".into(),
        name: "우리 팀 스프린트".into(),
    };
    assert_eq!(
        serde_json::to_value(&saved).unwrap(),
        serde_json::json!({ "kind": "savedFilter", "id": "10001", "name": "우리 팀 스프린트" })
    );
}

#[test]
fn query_roundtrips_through_config_json() {
    for query in [
        JiraQuery::Preset {
            id: "watched-by-me".into(),
        },
        JiraQuery::SavedFilter {
            id: "10001".into(),
            name: "우리 팀 스프린트".into(),
        },
        JiraQuery::Raw {
            jql: "text ~ \"배포\"".into(),
        },
    ] {
        let json = serde_json::to_string(&query).unwrap();
        let back: JiraQuery = serde_json::from_str(&json).unwrap();
        assert_eq!(query, back);
    }
}

#[test]
fn preset_stores_id_not_expanded_jql() {
    // 프리셋 정의를 나중에 고치면 이미 배치된 위젯도 같이 고쳐져야 한다.
    // JQL을 굳혀 저장하면 그게 안 된다.
    let json = serde_json::to_value(JiraQuery::Preset {
        id: "assigned-to-me".into(),
    })
    .unwrap();
    assert!(
        json.get("jql").is_none(),
        "config에 JQL이 굳어 있으면 안 된다"
    );
}
