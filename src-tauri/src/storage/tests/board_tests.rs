//! Board store tests — instance caps, layout, multi-board-ready shape.

use std::fs;

use serde_json::json;
use tempfile::TempDir;

use crate::storage::board::{
    BoardStore, Widget, WidgetLayout, WidgetType, BOARD_FILE, DEFAULT_BOARD_ID,
};
use crate::storage::error::StorageError;

fn layout() -> WidgetLayout {
    WidgetLayout {
        x: 0,
        y: 0,
        w: 4,
        h: 3,
    }
}

fn widget(id: &str, widget_type: WidgetType) -> Widget {
    Widget {
        id: id.to_string(),
        widget_type,
        layout: layout(),
        config: json!({}),
    }
}

fn store(dir: &TempDir) -> BoardStore {
    BoardStore::load(dir.path()).unwrap().0
}

// ------------------------------------------------------------------ defaults

#[test]
fn missing_file_yields_the_default_single_board() {
    let dir = TempDir::new().unwrap();
    let (s, outcome) = BoardStore::load(dir.path()).unwrap();

    assert_eq!(outcome, crate::storage::migrate::LoadOutcome::Missing);
    assert_eq!(s.data().version, 1);
    assert_eq!(s.data().active_board_id, DEFAULT_BOARD_ID);
    assert_eq!(s.data().boards.len(), 1);
    assert!(s.data().boards[0].widgets.is_empty());
    assert!(!dir.path().join(BOARD_FILE).exists());
}

/// DECISIONS 10 / 14: the on-disk shape is multi-board ready from day one so
/// adding boards later needs no migration.
#[test]
fn on_disk_shape_matches_the_decisions_document() {
    let dir = TempDir::new().unwrap();
    let s = store(&dir);
    s.save().unwrap();

    let raw = fs::read_to_string(dir.path().join(BOARD_FILE)).unwrap();
    let parsed: serde_json::Value = serde_json::from_str(&raw).unwrap();

    assert_eq!(parsed["version"], 1);
    assert_eq!(parsed["activeBoardId"], "default");
    assert!(parsed["boards"].is_array());
    assert_eq!(parsed["boards"][0]["id"], "default");
    assert_eq!(parsed["boards"][0]["name"], "Board");
    assert!(parsed["boards"][0]["widgets"].is_array());
}

#[test]
fn widget_serializes_with_type_and_camel_case_layout() {
    let dir = TempDir::new().unwrap();
    let mut s = store(&dir);

    let mut w = widget("w1", WidgetType::Jira);
    w.config = json!({ "jql": "assignee = currentUser()", "connectionId": "default" });
    s.add_widget_to_active(w).unwrap();
    s.save().unwrap();

    let raw = fs::read_to_string(dir.path().join(BOARD_FILE)).unwrap();
    let parsed: serde_json::Value = serde_json::from_str(&raw).unwrap();
    let w = &parsed["boards"][0]["widgets"][0];

    assert_eq!(w["id"], "w1");
    assert_eq!(w["type"], "jira");
    assert_eq!(w["layout"]["w"], 4);
    // Provider-owned config passes through untouched.
    assert_eq!(w["config"]["jql"], "assignee = currentUser()");
}

// -------------------------------------------------------------------- caps

/// DECISIONS 3: Jira 4 / GitHub 4 / Todo 1 / Web 4 / Album 4.
#[test]
fn instance_limits_match_decisions() {
    assert_eq!(WidgetType::Jira.instance_limit(), 4);
    assert_eq!(WidgetType::Github.instance_limit(), 4);
    assert_eq!(WidgetType::Todo.instance_limit(), 1);
    assert_eq!(WidgetType::Web.instance_limit(), 4);
    // 앨범은 Todo와 다르다. 폴더가 다르면 다른 내용이므로 여러 개가 의미 있다.
    assert_eq!(WidgetType::Album.instance_limit(), 4);
}

/// `as_str`은 프론트의 문자열 리터럴과 정확히 일치해야 한다. 어긋나면
/// serde가 board.json 전체를 거부하고 **위젯이 재시작 때 사라진다.**
#[test]
fn type_strings_match_the_frontend_literals() {
    assert_eq!(WidgetType::Jira.as_str(), "jira");
    assert_eq!(WidgetType::Github.as_str(), "github");
    assert_eq!(WidgetType::Todo.as_str(), "todo");
    assert_eq!(WidgetType::Web.as_str(), "web");
    assert_eq!(WidgetType::Album.as_str(), "album");
}

/// 앨범 위젯이 든 board.json이 왕복하는지. 등록 1번(Rust enum)의 회귀 테스트다 —
/// enum에 변형이 없으면 파일 **전체**가 거부되어 다른 위젯까지 같이 날아간다.
#[test]
fn an_album_widget_survives_a_disk_round_trip() {
    let dir = TempDir::new().unwrap();

    {
        let mut s = store(&dir);
        let mut w = widget("a1", WidgetType::Album);
        w.config = json!({
            "source": { "kind": "folder", "path": "/Users/me/Pictures" },
            "intervalSecs": 10,
        });
        s.add_widget_to_active(w).unwrap();
        // 다른 타입이 섞여 있어도 함께 살아남아야 한다.
        s.add_widget_to_active(widget("j1", WidgetType::Jira))
            .unwrap();
        s.save().unwrap();
    }

    let s = store(&dir);
    assert_eq!(s.data().boards[0].widgets.len(), 2);
    let w = s.widget("a1").expect("앨범 위젯이 사라졌다");
    assert_eq!(w.widget_type, WidgetType::Album);
    assert_eq!(w.config["source"]["kind"], "folder");
}

#[test]
fn enforces_the_jira_cap_with_a_typed_error() {
    let dir = TempDir::new().unwrap();
    let mut s = store(&dir);

    for n in 0..4 {
        s.add_widget_to_active(widget(&format!("jira-{n}"), WidgetType::Jira))
            .unwrap();
    }

    let result = s.add_widget_to_active(widget("jira-4", WidgetType::Jira));

    // A typed error, not a panic — the UI has to render this.
    let Err(StorageError::WidgetLimitReached {
        widget_type,
        limit,
        current,
    }) = result
    else {
        panic!("expected WidgetLimitReached, got {result:?}");
    };
    assert_eq!(widget_type, "jira");
    assert_eq!(limit, 4);
    assert_eq!(current, 4);

    // The rejected widget was not added.
    assert_eq!(s.data().boards[0].widgets.len(), 4);
}

#[test]
fn enforces_the_github_and_todo_caps() {
    let dir = TempDir::new().unwrap();
    let mut s = store(&dir);

    for n in 0..4 {
        s.add_widget_to_active(widget(&format!("gh-{n}"), WidgetType::Github))
            .unwrap();
    }
    assert!(s
        .add_widget_to_active(widget("gh-4", WidgetType::Github))
        .is_err());

    // Todo는 1개다 (2026-08-01, DECISIONS 21). 모든 Todo 위젯이 같은
    // todos.json을 읽으므로 두 번째는 같은 목록을 한 번 더 그릴 뿐이다.
    s.add_widget_to_active(widget("todo-0", WidgetType::Todo))
        .unwrap();
    assert!(s
        .add_widget_to_active(widget("todo-1", WidgetType::Todo))
        .is_err());
}

/// DECISIONS 3: 타입별로 나눈 이유 — 부담의 성격이 다름.
/// A full Todo quota must never block adding a Jira widget.
#[test]
fn caps_are_per_type_not_shared() {
    let dir = TempDir::new().unwrap();
    let mut s = store(&dir);

    // Todo 한도를 채운다 (1개).
    s.add_widget_to_active(widget("todo-0", WidgetType::Todo))
        .unwrap();
    assert!(s
        .add_widget_to_active(widget("todo-1", WidgetType::Todo))
        .is_err());

    // Todo가 꽉 찼어도 다른 타입은 자기 예산을 그대로 쓴다.
    s.add_widget_to_active(widget("jira-0", WidgetType::Jira))
        .unwrap();
    s.add_widget_to_active(widget("gh-0", WidgetType::Github))
        .unwrap();

    assert_eq!(s.data().boards[0].widgets.len(), 3);
}

#[test]
fn removing_a_widget_frees_a_slot() {
    let dir = TempDir::new().unwrap();
    let mut s = store(&dir);

    for n in 0..4 {
        s.add_widget_to_active(widget(&format!("jira-{n}"), WidgetType::Jira))
            .unwrap();
    }
    assert!(s
        .add_widget_to_active(widget("jira-4", WidgetType::Jira))
        .is_err());

    s.remove_widget("jira-0").unwrap();
    s.add_widget_to_active(widget("jira-4", WidgetType::Jira))
        .unwrap();

    assert_eq!(s.data().boards[0].count_of(WidgetType::Jira), 4);
}

#[test]
fn cap_error_message_is_understandable() {
    // CLAUDE.md: the user only sees behavior, so the message is the UI.
    let err = StorageError::WidgetLimitReached {
        widget_type: "jira".to_string(),
        limit: 4,
        current: 4,
    };
    let message = err.to_string();
    assert!(message.contains("jira"));
    assert!(message.contains('4'));
}

#[test]
fn duplicate_widget_ids_are_rejected() {
    // Duplicates would make removal and cache eviction ambiguous.
    let dir = TempDir::new().unwrap();
    let mut s = store(&dir);

    s.add_widget_to_active(widget("w1", WidgetType::Jira))
        .unwrap();
    assert!(matches!(
        s.add_widget_to_active(widget("w1", WidgetType::Todo)),
        Err(StorageError::DuplicateWidget { .. })
    ));
}

#[test]
fn adding_to_an_unknown_board_errors() {
    let dir = TempDir::new().unwrap();
    let mut s = store(&dir);

    assert!(matches!(
        s.add_widget("no-such-board", widget("w1", WidgetType::Jira)),
        Err(StorageError::BoardNotFound { .. })
    ));
}

// ------------------------------------------------------------------ layout

#[test]
fn update_layout_changes_geometry_only() {
    let dir = TempDir::new().unwrap();
    let mut s = store(&dir);

    let mut w = widget("w1", WidgetType::Jira);
    w.config = json!({ "jql": "project = ABC" });
    s.add_widget_to_active(w).unwrap();

    s.update_layout(
        "w1",
        WidgetLayout {
            x: 6,
            y: 2,
            w: 6,
            h: 8,
        },
    )
    .unwrap();

    let w = s.widget("w1").unwrap();
    assert_eq!(w.layout.x, 6);
    assert_eq!(w.layout.h, 8);
    assert_eq!(w.config["jql"], "project = ABC", "config was disturbed");
}

#[test]
fn update_config_replaces_config_only() {
    let dir = TempDir::new().unwrap();
    let mut s = store(&dir);

    s.add_widget_to_active(widget("w1", WidgetType::Jira))
        .unwrap();
    s.update_config("w1", json!({ "jql": "new query", "maxResults": 30 }))
        .unwrap();

    let w = s.widget("w1").unwrap();
    assert_eq!(w.config["maxResults"], 30);
    assert_eq!(w.layout, layout(), "layout was disturbed");
}

#[test]
fn operations_on_unknown_widgets_error() {
    let dir = TempDir::new().unwrap();
    let mut s = store(&dir);

    assert!(matches!(
        s.update_layout("nope", layout()),
        Err(StorageError::WidgetNotFound { .. })
    ));
    assert!(matches!(
        s.update_config("nope", json!({})),
        Err(StorageError::WidgetNotFound { .. })
    ));
    assert!(matches!(
        s.remove_widget("nope"),
        Err(StorageError::WidgetNotFound { .. })
    ));
}

#[test]
fn remove_widget_returns_it_so_the_caller_can_evict_its_cache() {
    let dir = TempDir::new().unwrap();
    let mut s = store(&dir);

    s.add_widget_to_active(widget("w1", WidgetType::Jira))
        .unwrap();
    let removed = s.remove_widget("w1").unwrap();

    assert_eq!(removed.id, "w1");
    assert_eq!(removed.widget_type, WidgetType::Jira);
}

// ------------------------------------------------------------- persistence

#[test]
fn round_trips_through_disk() {
    let dir = TempDir::new().unwrap();

    {
        let mut s = store(&dir);
        let mut w = widget("w1", WidgetType::Github);
        w.layout = WidgetLayout {
            x: 3,
            y: 1,
            w: 6,
            h: 4,
        };
        w.config = json!({ "query": "is:pr author:@me", "connectionId": "default" });
        s.add_widget_to_active(w).unwrap();
        s.add_widget_to_active(widget("w2", WidgetType::Todo))
            .unwrap();
        s.save().unwrap();
    }

    let s = store(&dir);
    assert_eq!(s.data().boards[0].widgets.len(), 2);

    let w = s.widget("w1").unwrap();
    assert_eq!(w.widget_type, WidgetType::Github);
    assert_eq!(w.layout.x, 3);
    assert_eq!(w.config["query"], "is:pr author:@me");
    assert_eq!(s.widget("w2").unwrap().widget_type, WidgetType::Todo);
}

#[test]
fn save_is_repeatable_and_leaves_one_file() {
    let dir = TempDir::new().unwrap();
    let mut s = store(&dir);

    // Stands in for the debounced caller saving repeatedly during a drag.
    for n in 0..20 {
        s.update_layout("w1", layout()).ok();
        s.add_widget_to_active(widget(&format!("w{n}"), WidgetType::Todo))
            .ok();
        s.save().unwrap();
    }

    let names: Vec<String> = fs::read_dir(dir.path())
        .unwrap()
        .map(|e| e.unwrap().file_name().to_string_lossy().to_string())
        .collect();
    assert_eq!(names, vec![BOARD_FILE]);
}

#[test]
fn all_widget_ids_spans_every_board() {
    let dir = TempDir::new().unwrap();
    let mut s = store(&dir);

    s.add_widget_to_active(widget("w1", WidgetType::Jira))
        .unwrap();
    s.add_widget_to_active(widget("w2", WidgetType::Todo))
        .unwrap();

    // Multi-board is structurally supported even with no UI for it.
    s.data_mut().boards.push(crate::storage::board::Board {
        id: "second".to_string(),
        name: "Second".to_string(),
        widgets: vec![widget("w3", WidgetType::Github)],
    });

    let mut ids = s.all_widget_ids();
    ids.sort();
    assert_eq!(ids, vec!["w1", "w2", "w3"]);
}

#[test]
fn remove_widget_finds_it_on_any_board() {
    let dir = TempDir::new().unwrap();
    let mut s = store(&dir);

    s.data_mut().boards.push(crate::storage::board::Board {
        id: "second".to_string(),
        name: "Second".to_string(),
        widgets: vec![widget("w3", WidgetType::Github)],
    });

    assert_eq!(s.remove_widget("w3").unwrap().id, "w3");
    assert!(s.data().boards[1].widgets.is_empty());
}

// ------------------------------------------------- hand-edited file recovery

/// DECISIONS 10 counts hand-editing as a feature, so a plausible hand-edit
/// must not leave the app with nothing to draw.
#[test]
fn an_empty_boards_array_falls_back_to_a_default_board() {
    let dir = TempDir::new().unwrap();
    fs::write(
        dir.path().join(BOARD_FILE),
        r#"{"version": 1, "activeBoardId": "default", "boards": []}"#,
    )
    .unwrap();

    let (s, _) = BoardStore::load(dir.path()).unwrap();

    assert_eq!(s.data().boards.len(), 1);
    assert!(s.data().active_board().is_some());
}

#[test]
fn a_dangling_active_board_id_falls_back_to_the_first_board() {
    let dir = TempDir::new().unwrap();
    fs::write(
        dir.path().join(BOARD_FILE),
        r#"{"version": 1, "activeBoardId": "deleted-board",
            "boards": [{"id": "real", "name": "Real", "widgets": []}]}"#,
    )
    .unwrap();

    let (mut s, _) = BoardStore::load(dir.path()).unwrap();

    assert_eq!(s.data().active_board().unwrap().id, "real");
    // And it stays usable for mutation.
    assert_eq!(s.data_mut().active_board_mut().unwrap().id, "real");
}

#[test]
fn a_widget_with_no_config_key_defaults_to_null() {
    // Easy to drop by hand; must not fail the whole load.
    let dir = TempDir::new().unwrap();
    fs::write(
        dir.path().join(BOARD_FILE),
        r#"{"version": 1, "activeBoardId": "default", "boards": [
            {"id": "default", "name": "Board", "widgets": [
                {"id": "w1", "type": "todo", "layout": {"x":0,"y":0,"w":4,"h":3}}
            ]}]}"#,
    )
    .unwrap();

    let (s, _) = BoardStore::load(dir.path()).unwrap();

    assert_eq!(s.widget("w1").unwrap().config, serde_json::Value::Null);
}
