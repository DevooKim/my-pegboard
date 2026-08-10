//! 앨범 provider 테스트.
//!
//! 사용자는 코드를 읽지 않고 동작만 본다(CLAUDE.local.md). 이 위젯에서 조용히
//! 깨질 수 있는 곳은 셋이고, 셋 다 여기서 고정한다:
//!
//! 1. **확장자 필터** — `.JPG`를 빠뜨리면 에러 없이 "사진이 없다"가 된다
//! 2. **1000장 상한** — 조용히 자르면 사용자는 없는 사진을 기다린다
//! 3. **스코프 복원** — 하나 빠뜨리면 "재시작 후에만 안 뜨는" 실패가 된다.
//!    개발 중에는 런타임 허용이 살아 있어 절대 재현되지 않는다

use std::fs;
use std::path::Path;

use serde_json::json;
use tempfile::TempDir;

use super::error::AlbumError;
use super::scan::{is_image_file, scan, MAX_PHOTOS};
use super::scope::{
    album_scope_membership, album_scope_membership_changed, album_sources,
    validate_album_scope_paths,
};
use super::types::AlbumSource;

fn touch(dir: &Path, name: &str) {
    fs::write(dir.join(name), b"not a real image").unwrap();
}

fn folder(dir: &Path) -> AlbumSource {
    AlbumSource::Folder {
        path: dir.to_string_lossy().to_string(),
    }
}

// ─────────────────────────── 확장자 필터 ───────────────────────────

#[test]
fn accepts_every_supported_extension() {
    for name in ["a.jpg", "b.jpeg", "c.png", "d.gif", "e.webp", "f.heic"] {
        assert!(is_image_file(name), "{name}이 거부됐다");
    }
}

/// 카메라·스캐너가 대문자 확장자를 쓴다. 빠뜨리면 폴더 전체가 빈 것처럼 보인다.
#[test]
fn extension_matching_ignores_case() {
    for name in ["a.JPG", "b.JPEG", "c.PNG", "d.Gif", "e.WebP", "f.HEIC"] {
        assert!(
            is_image_file(name),
            "{name}이 거부됐다 — 대소문자 처리 누락"
        );
    }
}

#[test]
fn rejects_non_image_extensions() {
    for name in ["a.txt", "b.mov", "c.pdf", "d.tiff", "e.raw", "f.jpg.txt"] {
        assert!(!is_image_file(name), "{name}이 통과했다");
    }
}

/// 확장자가 없는 파일. `rsplit_once('.')`가 None이 되는 경로다.
#[test]
fn rejects_files_without_an_extension() {
    for name in ["README", "photo", "IMG_0001"] {
        assert!(!is_image_file(name), "{name}이 통과했다");
    }
}

/// `.DS_Store`가 대표적이다. `.hidden.jpg`도 사용자가 보이길 기대하지 않는다.
#[test]
fn rejects_hidden_files() {
    for name in [".DS_Store", ".hidden.jpg", ".jpg", "._IMG_1.jpg"] {
        assert!(!is_image_file(name), "{name}이 통과했다");
    }
}

// ───────────────────────────── 폴더 스캔 ─────────────────────────────

#[test]
fn scans_a_folder_and_keeps_only_images() {
    let dir = TempDir::new().unwrap();
    for name in ["b.jpg", "a.PNG", "notes.txt", ".DS_Store", "movie.mov"] {
        touch(dir.path(), name);
    }

    let result = scan(&folder(dir.path())).unwrap();

    assert_eq!(result.photos.len(), 2);
    assert_eq!(result.skipped, 0);
    // 파일명순으로 안정적이어야 한다 — read_dir 순서는 보장이 없다.
    assert!(result.photos[0].path.ends_with("a.PNG"));
    assert!(result.photos[1].path.ends_with("b.jpg"));
}

/// **비재귀다.** 하위 폴더를 훑으면 `~/Pictures` 하나로 라이브러리 전체를 만난다.
#[test]
fn does_not_recurse_into_subfolders() {
    let dir = TempDir::new().unwrap();
    touch(dir.path(), "top.jpg");
    let sub = dir.path().join("sub");
    fs::create_dir(&sub).unwrap();
    touch(&sub, "deep.jpg");

    let result = scan(&folder(dir.path())).unwrap();

    assert_eq!(result.photos.len(), 1, "하위 폴더까지 훑었다");
    assert!(result.photos[0].path.ends_with("top.jpg"));
}

#[test]
fn an_empty_folder_is_not_an_error() {
    let dir = TempDir::new().unwrap();
    let result = scan(&folder(dir.path())).unwrap();
    assert!(result.photos.is_empty());
    assert_eq!(result.skipped, 0);
}

// ───────────────────────────── 1000장 상한 ─────────────────────────────

#[test]
fn caps_at_the_maximum_and_reports_what_it_dropped() {
    let dir = TempDir::new().unwrap();
    let total = MAX_PHOTOS + 7;
    for n in 0..total {
        // 자리수를 맞춰 파일명순 정렬이 숫자순과 같아지게 한다.
        touch(dir.path(), &format!("{n:05}.jpg"));
    }

    let result = scan(&folder(dir.path())).unwrap();

    assert_eq!(result.photos.len(), MAX_PHOTOS);
    // **조용히 자르지 않는다.** 위젯이 "7장은 표시하지 않음"을 그리는 근거다.
    assert_eq!(result.skipped, 7);
}

#[test]
fn exactly_at_the_cap_skips_nothing() {
    // 경계에서 1을 더하거나 빼는 실수를 잡는다.
    let dir = TempDir::new().unwrap();
    for n in 0..MAX_PHOTOS {
        touch(dir.path(), &format!("{n:05}.jpg"));
    }

    let result = scan(&folder(dir.path())).unwrap();

    assert_eq!(result.photos.len(), MAX_PHOTOS);
    assert_eq!(result.skipped, 0);
}

// ───────────────────────────── 실패 경로 ─────────────────────────────

#[test]
fn a_missing_folder_errors_with_the_path_in_the_message() {
    let dir = TempDir::new().unwrap();
    let gone = dir.path().join("사라진-폴더");

    let err = scan(&AlbumSource::Folder {
        path: gone.to_string_lossy().to_string(),
    })
    .unwrap_err();

    assert!(matches!(err, AlbumError::NotFound { .. }));
    // 경로가 메시지에 있어야 한다 — 외장 디스크가 빠진 것인지 폴더를 옮긴
    // 것인지 판단하는 건 사용자다.
    assert!(err.to_string().contains("사라진-폴더"));
}

#[test]
fn a_file_path_given_as_a_folder_errors() {
    let dir = TempDir::new().unwrap();
    touch(dir.path(), "one.jpg");
    let file = dir.path().join("one.jpg");

    let err = scan(&AlbumSource::Folder {
        path: file.to_string_lossy().to_string(),
    })
    .unwrap_err();

    assert!(matches!(err, AlbumError::NotADirectory { .. }));
    assert!(
        err.to_string().contains("사진 선택"),
        "무엇을 해야 하는지가 없다"
    );
}

// ───────────────────────────── 파일 목록 ─────────────────────────────

#[test]
fn a_file_list_keeps_only_images_and_sorts_them() {
    let result = scan(&AlbumSource::Files {
        paths: vec![
            "/photos/b.jpg".into(),
            "/photos/a.HEIC".into(),
            "/photos/notes.txt".into(),
        ],
    })
    .unwrap();

    assert_eq!(result.photos.len(), 2);
    assert_eq!(result.photos[0].path, "/photos/a.HEIC");
    assert_eq!(result.photos[1].path, "/photos/b.jpg");
}

/// 파일 하나만 고르면 자연히 "고정 한 장 배경"이 된다. 별도 모드가 없는 이유다.
#[test]
fn a_single_file_is_a_valid_album() {
    let result = scan(&AlbumSource::Files {
        paths: vec!["/photos/only.png".into()],
    })
    .unwrap();
    assert_eq!(result.photos.len(), 1);
}

/// 파일 목록은 **존재를 검사하지 않는다.** 사라진 한 장은 `<img onError>`가
/// 다음 장으로 넘기며 "N장을 표시할 수 없습니다"로 드러낸다. 목록에서 미리
/// 지우면 사용자가 고른 것과 보이는 것이 조용히 달라진다.
#[test]
fn a_file_list_does_not_drop_paths_that_no_longer_exist() {
    let result = scan(&AlbumSource::Files {
        paths: vec!["/nowhere/gone.jpg".into()],
    })
    .unwrap();
    assert_eq!(result.photos.len(), 1);
}

// ───────────────────── ★ 스코프 복원 (가장 중요) ─────────────────────

/// board.json을 파싱해 만든 소스 목록의 경로를 전부 펼친다.
///
/// `allow_source`가 실제로 넣는 것과 같은 집합이다 — `Folder`는 경로 하나,
/// `Files`는 파일 전부.
fn all_scope_paths(board: &crate::storage::board::BoardFile) -> Vec<String> {
    let sources = album_sources(board);
    let mut paths: Vec<String> = sources
        .iter()
        .flat_map(|s| s.paths())
        .map(str::to_string)
        .collect();
    paths.sort();
    paths
}

/// `assert_eq!`에서 `Vec<String>`과 `Vec<&str>`은 비교되지 않는다. 기대값을
/// 문자열 리터럴로 쓸 수 있게 변환만 해준다.
fn owned(paths: &[&str]) -> Vec<String> {
    let mut v: Vec<String> = paths.iter().map(|s| s.to_string()).collect();
    v.sort();
    v
}

fn board_with(widgets: Vec<serde_json::Value>) -> crate::storage::board::BoardFile {
    let raw = json!({
        "version": 1,
        "activeBoardId": "default",
        "boards": [{ "id": "default", "name": "Board", "widgets": widgets }],
    });
    serde_json::from_value(raw).unwrap()
}

fn album_widget(id: &str, source: serde_json::Value) -> serde_json::Value {
    json!({
        "id": id,
        "type": "album",
        "layout": { "x": 0, "y": 0, "w": 4, "h": 6 },
        "config": { "source": source, "intervalSecs": 10, "title": null },
    })
}

/// **이 테스트가 이 파일의 존재 이유다.**
///
/// Folder 위젯과 Files 위젯이 섞여 있을 때 복원이 **모든** 경로를 훑는지 본다.
/// 하나만 빠뜨리면 그 위젯(또는 그 한 장)만 재시작 후에 안 뜨고, 개발 중에는
/// 런타임 허용이 살아 있어 절대 재현되지 않는다.
#[test]
fn restore_covers_every_path_of_every_album_widget() {
    let board = board_with(vec![
        album_widget(
            "a1",
            json!({ "kind": "folder", "path": "/Users/me/Pictures/여행" }),
        ),
        album_widget(
            "a2",
            json!({ "kind": "files", "paths": ["/Users/me/a.jpg", "/Users/me/b.png", "/Users/me/c.heic"] }),
        ),
        album_widget(
            "a3",
            json!({ "kind": "folder", "path": "/Volumes/NAS/사진" }),
        ),
        // 다른 타입은 섞여 있어도 무시된다.
        json!({
            "id": "j1", "type": "jira",
            "layout": { "x": 0, "y": 0, "w": 4, "h": 6 },
            "config": { "jql": "assignee = currentUser()" },
        }),
    ]);

    assert_eq!(
        all_scope_paths(&board),
        // 빠뜨림도 여분도 잡는다.
        owned(&[
            "/Users/me/Pictures/여행",
            "/Users/me/a.jpg",
            "/Users/me/b.png",
            "/Users/me/c.heic",
            "/Volumes/NAS/사진",
        ]),
        "복원이 경로를 빠뜨렸다 — 재시작 후에만 안 뜨는 실패가 된다"
    );
}

#[test]
fn folder_to_file_is_a_scope_membership_change() {
    let old = board_with(vec![album_widget(
        "album",
        json!({ "kind": "folder", "path": "/photos" }),
    )]);
    let new = board_with(vec![album_widget(
        "album",
        json!({ "kind": "files", "paths": ["/photos"] }),
    )]);

    assert!(album_scope_membership_changed(&old, &new));
    assert_ne!(album_scope_membership(&old), album_scope_membership(&new));
}

#[test]
fn file_to_folder_is_a_scope_membership_change() {
    let old = board_with(vec![album_widget(
        "album",
        json!({ "kind": "files", "paths": ["/photos"] }),
    )]);
    let new = board_with(vec![album_widget(
        "album",
        json!({ "kind": "folder", "path": "/photos" }),
    )]);

    assert!(album_scope_membership_changed(&old, &new));
    assert_ne!(album_scope_membership(&old), album_scope_membership(&new));
}

#[test]
fn reordering_album_scope_membership_does_not_require_a_relaunch() {
    let old = board_with(vec![
        album_widget("first", json!({ "kind": "folder", "path": "/first" })),
        album_widget("second", json!({ "kind": "folder", "path": "/second" })),
    ]);
    let new = board_with(vec![
        album_widget("second", json!({ "kind": "folder", "path": "/second" })),
        album_widget("first", json!({ "kind": "folder", "path": "/first" })),
    ]);

    assert!(!album_scope_membership_changed(&old, &new));
}

#[test]
fn nested_album_paths_are_validated_as_individual_scope_patterns() {
    let board = board_with(vec![
        album_widget(
            "folder",
            json!({ "kind": "folder", "path": "/photos/trips" }),
        ),
        album_widget(
            "files",
            json!({
                "kind": "files",
                "paths": [
                    "/photos/trips/2026/seoul.jpg",
                    "/photos/trips/2026/busan/night.png"
                ]
            }),
        ),
    ]);

    validate_album_scope_paths(&board)
        .expect("Tauri asset scope pattern validation should be pure");
    assert_eq!(album_scope_membership(&board).len(), 3);
}

/// `Folder`와 `Files`는 스코프 종류가 다르다. 파일 목록에 디렉터리 스코프를
/// 주면 고르지 않은 형제 파일까지 열린다.
#[test]
fn folder_and_file_sources_are_distinguishable() {
    let board = board_with(vec![
        album_widget("a1", json!({ "kind": "folder", "path": "/p" })),
        album_widget("a2", json!({ "kind": "files", "paths": ["/p/one.jpg"] })),
    ]);

    let sources = album_sources(&board);
    assert_eq!(sources.len(), 2);
    assert!(sources.iter().filter(|s| s.is_folder()).count() == 1);
    assert!(sources.iter().filter(|s| !s.is_folder()).count() == 1);
}

/// 여러 보드에 흩어져 있어도 전부 찾는다. 다중 보드는 UI만 없고 구조는
/// 준비돼 있다(DECISIONS 14) — `all_widget_ids`가 그러는 것과 같은 이유다.
#[test]
fn restore_spans_every_board() {
    let raw = json!({
        "version": 1,
        "activeBoardId": "default",
        "boards": [
            { "id": "default", "name": "Board", "widgets": [
                album_widget("a1", json!({ "kind": "folder", "path": "/first" }))
            ]},
            { "id": "second", "name": "Second", "widgets": [
                album_widget("a2", json!({ "kind": "folder", "path": "/second" }))
            ]},
        ],
    });
    let board: crate::storage::board::BoardFile = serde_json::from_value(raw).unwrap();

    assert_eq!(all_scope_paths(&board), owned(&["/first", "/second"]));
}

/// 소스를 아직 고르지 않은 새 위젯. 스코프에 넣을 것이 없으므로 건너뛴다 —
/// 여기서 실패하면 앨범 위젯 하나 때문에 앱 시작이 멈춘다.
#[test]
fn a_widget_without_a_source_is_skipped_not_fatal() {
    let board = board_with(vec![
        json!({
            "id": "a1", "type": "album",
            "layout": { "x": 0, "y": 0, "w": 4, "h": 6 },
            "config": { "source": null, "intervalSecs": 10, "title": null },
        }),
        album_widget("a2", json!({ "kind": "folder", "path": "/real" })),
    ]);

    assert_eq!(all_scope_paths(&board), owned(&["/real"]));
}

/// 손으로 편집한 board.json에 알 수 없는 소스가 들어 있어도 나머지는 복원된다.
#[test]
fn an_unparseable_source_does_not_stop_the_others() {
    let board = board_with(vec![
        album_widget("a1", json!({ "kind": "icloud", "album": "여행" })),
        album_widget("a2", json!({ "kind": "folder", "path": "/real" })),
    ]);

    assert_eq!(all_scope_paths(&board), owned(&["/real"]));
}
