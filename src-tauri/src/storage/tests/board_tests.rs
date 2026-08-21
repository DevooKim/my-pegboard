//! Board store tests — instance caps, layout, multi-board-ready shape.

use std::fs;

use serde_json::json;
use tempfile::TempDir;

use crate::storage::board::{
    build_import_result, validate_import, AlbumPathWarning, Board, BoardExportFile, BoardFile,
    BoardImportMode, BoardStore, Widget, WidgetLayout, WidgetType, BOARD_FILE,
    BOARD_SCHEMA_VERSION, DEFAULT_BOARD_ID,
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

#[test]
fn board_without_locked_field_defaults_to_unlocked() {
    let file: BoardFile = serde_json::from_value(json!({
        "version": 1,
        "activeBoardId": "default",
        "boards": [{ "id": "default", "name": "Board", "widgets": [] }]
    }))
    .unwrap();

    assert!(!file.boards[0].locked);
}

#[test]
fn board_lock_round_trips_through_json() {
    let file: BoardFile = serde_json::from_value(json!({
        "version": 1,
        "activeBoardId": "default",
        "boards": [{ "id": "default", "name": "Board", "locked": true, "widgets": [] }]
    }))
    .unwrap();

    assert!(file.boards[0].locked);
    assert_eq!(serde_json::to_value(file).unwrap()["boards"][0]["locked"], true);
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

/// DECISIONS 3: Jira 4 / GitHub 4 / Todo 1 / Web 4 / Album 4 / Linear 4.
#[test]
fn instance_limits_match_decisions() {
    assert_eq!(WidgetType::Jira.instance_limit(), 4);
    assert_eq!(WidgetType::Github.instance_limit(), 4);
    assert_eq!(WidgetType::Todo.instance_limit(), 1);
    assert_eq!(WidgetType::Web.instance_limit(), 4);
    // 앨범은 Todo와 다르다. 폴더가 다르면 다른 내용이므로 여러 개가 의미 있다.
    assert_eq!(WidgetType::Album.instance_limit(), 4);
    // Linear는 Jira·GitHub과 같다. 위젯마다 다른 쿼리를 본다.
    assert_eq!(WidgetType::Linear.instance_limit(), 4);
    // 지금 재생 중은 Todo와 같다. 시스템 재생 상태는 전역 하나뿐이다.
    assert_eq!(WidgetType::Nowplaying.instance_limit(), 1);
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
    assert_eq!(WidgetType::Linear.as_str(), "linear");
    assert_eq!(WidgetType::Nowplaying.as_str(), "nowplaying");
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

/// Linear 위젯이 든 board.json이 왕복하는지. 등록 1번의 회귀 테스트다 —
/// enum에 변형이 없으면 파일 **전체**가 거부되어 다른 위젯까지 같이 날아간다.
/// 개발 중에는 프론트만 고쳐도 잘 도는 것처럼 보이고, 앱을 껐다 켤 때 드러난다.
#[test]
fn a_linear_widget_survives_a_disk_round_trip() {
    let dir = TempDir::new().unwrap();

    {
        let mut s = store(&dir);
        let mut w = widget("l1", WidgetType::Linear);
        w.config = json!({
            "query": { "kind": "preset", "id": "assigned-to-me" },
            "maxResults": 30,
            "teams": ["team-eng"],
            "sort": "updatedAt",
            "groupByTeam": true,
            "refreshSecs": 300,
        });
        s.add_widget_to_active(w).unwrap();
        // 다른 타입이 섞여 있어도 함께 살아남아야 한다.
        s.add_widget_to_active(widget("j1", WidgetType::Jira))
            .unwrap();
        s.save().unwrap();
    }

    let s = store(&dir);
    assert_eq!(s.data().boards[0].widgets.len(), 2);
    let w = s.widget("l1").expect("Linear 위젯이 사라졌다");
    assert_eq!(w.widget_type, WidgetType::Linear);
    assert_eq!(w.config["query"]["id"], "assigned-to-me");
    assert_eq!(w.config["teams"][0], "team-eng");
}

/// "지금 재생 중" 위젯이 든 board.json이 왕복하는지. 등록 1번의 회귀 테스트다 —
/// enum에 변형이 없으면 파일 **전체**가 거부되어 다른 위젯까지 같이 날아간다.
#[test]
fn a_nowplaying_widget_survives_a_disk_round_trip() {
    let dir = TempDir::new().unwrap();

    {
        let mut s = store(&dir);
        let mut w = widget("n1", WidgetType::Nowplaying);
        w.config = json!({ "title": "음악" });
        s.add_widget_to_active(w).unwrap();
        // 다른 타입이 섞여 있어도 함께 살아남아야 한다.
        s.add_widget_to_active(widget("j1", WidgetType::Jira))
            .unwrap();
        s.save().unwrap();
    }

    let s = store(&dir);
    assert_eq!(s.data().boards[0].widgets.len(), 2);
    let w = s.widget("n1").expect("지금 재생 중 위젯이 사라졌다");
    assert_eq!(w.widget_type, WidgetType::Nowplaying);
    assert_eq!(w.config["title"], "음악");
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
        locked: false,
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
        locked: false,
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

// ---------------------------------------------------------- board transfer

fn export(file: BoardFile) -> BoardExportFile {
    BoardExportFile::new(file, "2026-08-10T00:00:00Z".to_string())
}

#[test]
fn export_envelope_contains_only_board_metadata_and_board_settings() {
    let value = serde_json::to_value(export(BoardFile::default())).unwrap();
    let keys = value
        .as_object()
        .unwrap()
        .keys()
        .cloned()
        .collect::<Vec<_>>();

    assert_eq!(keys, vec!["board", "exportedAt", "formatVersion"]);
    let serialized = value.to_string();
    for forbidden in ["token", "email", "apiKey", "todos", "cache"] {
        assert!(
            !serialized.contains(forbidden),
            "export envelope leaked {forbidden}"
        );
    }
}

#[test]
fn export_rejects_sensitive_widget_config_instead_of_serializing_it() {
    for key in [
        "apiKey",
        "accessToken",
        "refreshToken",
        "authToken",
        "clientSecret",
        "secretKey",
        "emailAddress",
        "credential",
        "cachedResponse",
    ] {
        let mut board = BoardFile::default();
        let mut jira = widget("sensitive", WidgetType::Jira);
        jira.config = json!({ key: "must-not-leave-the-app" });
        board.boards[0].widgets.push(jira);

        let error = crate::storage::board::validate_export(&board).unwrap_err();
        assert!(error.to_string().contains(key), "{key} was not rejected");
    }
}

#[test]
fn import_rejects_the_same_sensitive_widget_config_keys_as_export() {
    for key in [
        "apiKey",
        "accessToken",
        "refreshToken",
        "authToken",
        "clientSecret",
        "secretKey",
        "emailAddress",
        "credential",
        "cachedResponse",
        "TodoItems",
    ] {
        let mut board = BoardFile::default();
        let mut jira = widget("sensitive", WidgetType::Jira);
        jira.config = json!({ key: "must-not-enter-the-app" });
        board.boards[0].widgets.push(jira);

        let error = validate_import(&export(board)).unwrap_err();
        assert!(error.to_string().contains(key), "{key} was not rejected");
    }
}

#[test]
fn import_rejects_future_versions_empty_boards_duplicate_ids_unknown_types_and_caps() {
    let mut future_format = export(BoardFile::default());
    future_format.format_version += 1;
    assert!(validate_import(&future_format).is_err());

    let mut future_board = export(BoardFile::default());
    future_board.board.version = BOARD_SCHEMA_VERSION + 1;
    assert!(validate_import(&future_board).is_err());

    let mut empty = BoardFile::default();
    empty.boards.clear();
    assert!(validate_import(&export(empty)).is_err());

    let mut duplicate_boards = BoardFile::default();
    duplicate_boards
        .boards
        .push(duplicate_boards.boards[0].clone());
    assert!(validate_import(&export(duplicate_boards)).is_err());

    let mut duplicate_widgets = BoardFile::default();
    duplicate_widgets.boards.push(Board {
        id: "second".into(),
        name: "Second".into(),
        locked: false,
        widgets: vec![widget("same", WidgetType::Jira)],
    });
    duplicate_widgets.boards[0]
        .widgets
        .push(widget("same", WidgetType::Todo));
    assert!(validate_import(&export(duplicate_widgets)).is_err());

    let unknown_type = serde_json::from_value::<BoardExportFile>(json!({
        "formatVersion": 1,
        "exportedAt": "2026-08-10T00:00:00Z",
        "board": {
            "version": 1,
            "activeBoardId": "default",
            "boards": [{
                "id": "default",
                "name": "Board",
                "widgets": [{
                    "id": "w1",
                    "type": "future-widget",
                    "layout": {"x": 0, "y": 0, "w": 4, "h": 3},
                    "config": {}
                }]
            }]
        }
    }));
    assert!(unknown_type.is_err());

    let mut capped = BoardFile::default();
    capped.boards[0].widgets = (0..=WidgetType::Jira.instance_limit())
        .map(|n| widget(&format!("jira-{n}"), WidgetType::Jira))
        .collect();
    assert!(validate_import(&export(capped)).is_err());
}

#[test]
fn merge_regenerates_ids_activates_first_imported_board_and_resolves_names() {
    let current = BoardFile {
        version: BOARD_SCHEMA_VERSION,
        active_board_id: "existing".into(),
        boards: vec![Board {
            id: "existing".into(),
            name: "업무".into(),
            locked: false,
            widgets: vec![widget("existing-widget", WidgetType::Jira)],
        }],
    };
    let imported = BoardFile {
        version: BOARD_SCHEMA_VERSION,
        active_board_id: "imported-a".into(),
        boards: vec![
            Board {
                id: "imported-a".into(),
                name: "업무".into(),
                locked: true,
                widgets: vec![widget("imported-widget-a", WidgetType::Github)],
            },
            Board {
                id: "imported-b".into(),
                name: "업무".into(),
                locked: false,
                widgets: vec![widget("imported-widget-b", WidgetType::Todo)],
            },
        ],
    };

    let mut ids = 0;
    let merged = build_import_result(&current, &imported, BoardImportMode::Merge, || {
        ids += 1;
        format!("new-{ids}")
    })
    .unwrap();

    assert_eq!(merged.active_board_id, "new-1");
    assert_eq!(merged.boards[0].name, "업무");
    assert_eq!(merged.boards[1].name, "업무 (가져옴 2)");
    assert_eq!(merged.boards[2].name, "업무 (가져옴 3)");
    assert_eq!(merged.boards[1].id, "new-1");
    assert_eq!(merged.boards[2].id, "new-3");
    assert_eq!(merged.boards[1].widgets[0].id, "new-2");
    assert_eq!(merged.boards[2].widgets[0].id, "new-4");
    assert!(merged.boards[1].locked);
    assert!(!merged.boards[2].locked);
    assert_eq!(current.boards[0].id, "existing");
    assert_eq!(current.boards[0].widgets[0].id, "existing-widget");
}

#[test]
fn replace_atomically_preserves_memory_and_disk_when_writer_fails() {
    let dir = TempDir::new().unwrap();
    let mut store = store(&dir);
    store
        .add_widget_to_active(widget("before", WidgetType::Jira))
        .unwrap();
    store.save().unwrap();
    let before_memory = store.data().clone();
    let before_disk = fs::read(dir.path().join(BOARD_FILE)).unwrap();

    let next = BoardFile::default();
    let result = store.replace_atomically_with(next, |_path, _file| {
        Err(crate::storage::error::StorageError::InvalidPath {
            path: "injected".into(),
            reason: "test writer failure".into(),
        })
    });

    assert!(result.is_err());
    assert_eq!(store.data(), &before_memory);
    assert_eq!(fs::read(dir.path().join(BOARD_FILE)).unwrap(), before_disk);
}

#[test]
fn album_path_warnings_report_each_missing_folder_or_file() {
    let dir = TempDir::new().unwrap();
    let existing = dir.path().join("exists.jpg");
    fs::write(&existing, b"image").unwrap();
    let missing_folder = dir.path().join("missing-folder");
    let missing_file = dir.path().join("missing.jpg");

    let board = BoardFile {
        version: BOARD_SCHEMA_VERSION,
        active_board_id: DEFAULT_BOARD_ID.into(),
        boards: vec![Board {
            id: DEFAULT_BOARD_ID.into(),
            name: "Board".into(),
            locked: false,
            widgets: vec![
                {
                    let mut album = widget("album", WidgetType::Album);
                    album.config = json!({
                        "source": {"kind": "folder", "path": missing_folder},
                    });
                    album
                },
                {
                    let mut album = widget("album-files", WidgetType::Album);
                    album.config = json!({
                        "source": {"kind": "files", "paths": [existing, missing_file]},
                    });
                    album
                },
            ],
        }],
    };

    let warnings = crate::providers::album::missing_path_warnings(&board);
    assert_eq!(
        warnings,
        vec![
            AlbumPathWarning {
                path: missing_folder.to_string_lossy().into()
            },
            AlbumPathWarning {
                path: missing_file.to_string_lossy().into()
            },
        ]
    );
}
