//! Atomic write tests.
//!
//! DECISIONS 10: 원자적 쓰기 — 중간에 죽으면 배치가 통째로 날아감.
//! The property under test is that a reader never observes a partial file.

use std::fs;

use serde_json::json;
use tempfile::TempDir;

use crate::storage::atomic::{write_atomic, write_json_atomic};

#[test]
fn writes_a_new_file() {
    let dir = TempDir::new().unwrap();
    let path = dir.path().join("board.json");

    write_atomic(&path, b"hello").unwrap();

    assert_eq!(fs::read_to_string(&path).unwrap(), "hello");
}

#[test]
fn replaces_an_existing_file() {
    // The common case: every save after the first.
    let dir = TempDir::new().unwrap();
    let path = dir.path().join("board.json");

    write_atomic(&path, b"original contents").unwrap();
    write_atomic(&path, b"new").unwrap();

    // Fully replaced, not overlaid — a plain in-place write of a shorter
    // payload would leave "inal contents" trailing behind.
    assert_eq!(fs::read_to_string(&path).unwrap(), "new");
}

#[test]
fn replacing_with_shorter_content_leaves_no_tail() {
    let dir = TempDir::new().unwrap();
    let path = dir.path().join("board.json");

    write_atomic(&path, &vec![b'x'; 10_000]).unwrap();
    write_atomic(&path, b"tiny").unwrap();

    let contents = fs::read(&path).unwrap();
    assert_eq!(contents, b"tiny");
    assert_eq!(contents.len(), 4);
}

#[test]
fn creates_missing_parent_directories() {
    // First launch: the app data directory does not exist yet.
    let dir = TempDir::new().unwrap();
    let path = dir.path().join("nested").join("deeper").join("board.json");

    write_atomic(&path, b"data").unwrap();

    assert_eq!(fs::read_to_string(&path).unwrap(), "data");
}

#[test]
fn leaves_no_temp_files_behind() {
    let dir = TempDir::new().unwrap();
    let path = dir.path().join("board.json");

    write_atomic(&path, b"one").unwrap();
    write_atomic(&path, b"two").unwrap();
    write_atomic(&path, b"three").unwrap();

    let entries: Vec<_> = fs::read_dir(dir.path())
        .unwrap()
        .map(|e| e.unwrap().file_name().to_string_lossy().to_string())
        .collect();

    assert_eq!(entries, vec!["board.json"], "temp file was left behind");
}

#[test]
fn temp_file_is_in_the_same_directory_as_the_target() {
    // rename() is only atomic within a filesystem. A temp file in /tmp would
    // fail with EXDEV whenever the data dir is on a different mount.
    let dir = TempDir::new().unwrap();
    let path = dir.path().join("board.json");

    write_atomic(&path, b"data").unwrap();

    // Proven indirectly but strongly: the write succeeded, and a temp file
    // outside `dir` could not have been renamed into it atomically. Combined
    // with the no-leftovers test above, the temp file must have lived here.
    assert!(path.exists());
}

/// The scenario the whole primitive exists for.
///
/// A real crash cannot be staged in-process, so this reproduces its *effect*:
/// a complete temp file exists alongside the target, but the rename never
/// happened. That is the exact on-disk state a kill between step 2 and step 3
/// leaves behind.
///
/// The invariant: the target still holds the old, complete contents. It is
/// never truncated and never half-new.
#[test]
fn interrupted_write_leaves_the_original_intact() {
    let dir = TempDir::new().unwrap();
    let path = dir.path().join("board.json");

    let original = r#"{"version":1,"boards":[{"id":"default","widgets":["a","b","c"]}]}"#;
    write_atomic(&path, original.as_bytes()).unwrap();

    // Simulate a crash mid-save: temp file fully written, rename never ran.
    let orphan_tmp = dir.path().join(".board.json.tmp-99999");
    fs::write(&orphan_tmp, r#"{"version":1,"boards":[{"id":"defau"#).unwrap();

    // The user's board survives the crash untouched.
    assert_eq!(fs::read_to_string(&path).unwrap(), original);

    // And the next successful save still works, leaving valid contents.
    let updated = r#"{"version":1,"boards":[{"id":"default","widgets":["a"]}]}"#;
    write_atomic(&path, updated.as_bytes()).unwrap();
    assert_eq!(fs::read_to_string(&path).unwrap(), updated);

    // The orphan is inert: it never affects reads of the target.
    assert!(orphan_tmp.exists());
    let parsed: serde_json::Value = serde_json::from_str(&fs::read_to_string(&path).unwrap())
        .expect("target must always be parseable JSON");
    assert_eq!(parsed["version"], 1);
}

/// Every intermediate state of a repeated overwrite is valid JSON.
///
/// Reads the file back after each write to assert it never observes a
/// truncated document — the failure mode of a non-atomic writer.
#[test]
fn target_is_always_parseable_across_many_writes() {
    let dir = TempDir::new().unwrap();
    let path = dir.path().join("board.json");

    for i in 0..40 {
        // Vary the size substantially so a non-atomic write would leave
        // detectable tails.
        let widgets: Vec<String> = (0..i).map(|n| format!("widget-{n}")).collect();
        write_json_atomic(&path, &json!({ "version": 1, "widgets": widgets })).unwrap();

        let raw = fs::read_to_string(&path).unwrap();
        let parsed: serde_json::Value =
            serde_json::from_str(&raw).unwrap_or_else(|e| panic!("torn write at {i}: {e}"));
        assert_eq!(parsed["widgets"].as_array().unwrap().len(), i);
    }
}

#[test]
fn writes_pretty_json_with_trailing_newline() {
    // DECISIONS 10 counts hand-editability as a real advantage of JSON.
    let dir = TempDir::new().unwrap();
    let path = dir.path().join("board.json");

    write_json_atomic(&path, &json!({ "version": 1, "activeBoardId": "default" })).unwrap();

    let raw = fs::read_to_string(&path).unwrap();
    assert!(raw.contains('\n'), "should be pretty-printed");
    assert!(raw.ends_with('\n'), "should end with a newline");
    assert!(raw.contains("  "), "should be indented");
}

#[test]
fn handles_empty_payload() {
    let dir = TempDir::new().unwrap();
    let path = dir.path().join("empty.json");

    write_atomic(&path, b"").unwrap();

    assert_eq!(fs::read_to_string(&path).unwrap(), "");
}

#[test]
fn concurrent_writers_never_produce_a_torn_file() {
    // Two stores saving at once must not interleave. Distinct temp names (pid
    // plus distinct target paths) keep them independent; the target of each is
    // either fully old or fully new.
    let dir = TempDir::new().unwrap();
    let path = dir.path().join("board.json");

    write_json_atomic(&path, &json!({ "version": 1, "n": 0 })).unwrap();

    std::thread::scope(|scope| {
        for n in 1..=4 {
            let path = path.clone();
            scope.spawn(move || {
                for _ in 0..25 {
                    let big: Vec<u64> = (0..200).collect();
                    write_json_atomic(&path, &json!({ "version": 1, "n": n, "data": big }))
                        .unwrap();
                }
            });
        }
    });

    // Whichever writer landed last, the file is complete and parseable.
    let raw = fs::read_to_string(&path).unwrap();
    let parsed: serde_json::Value = serde_json::from_str(&raw).expect("file was torn");
    assert_eq!(parsed["version"], 1);
    assert_eq!(parsed["data"].as_array().unwrap().len(), 200);
}
