//! Disk cache tests.
//!
//! DECISIONS 17: 앱을 켜면 즉시 지난 데이터가 보이고, 그 뒤에 조용히 갱신된다.
//! These files are what make the 0ms launch promise possible.

use std::fs;

use chrono::{DateTime, Duration, Utc};
use serde_json::json;
use tempfile::TempDir;

use crate::storage::cache::CacheStore;

fn now() -> DateTime<Utc> {
    "2026-07-29T12:00:00Z".parse().unwrap()
}

#[test]
fn cold_widget_returns_none_rather_than_erroring() {
    // First launch is a normal state, not a failure.
    let dir = TempDir::new().unwrap();
    let cache = CacheStore::new(dir.path());

    assert!(cache.get("never-fetched").unwrap().is_none());
}

#[test]
fn round_trips_a_payload_with_its_timestamp() {
    let dir = TempDir::new().unwrap();
    let cache = CacheStore::new(dir.path());

    let payload = json!({
        "issues": [
            { "key": "ABC-1", "summary": "first", "status": "In Progress" },
            { "key": "ABC-2", "summary": "second", "status": "To Do" }
        ]
    });

    cache.put("jira-widget-1", payload.clone(), now()).unwrap();

    let entry = cache.get("jira-widget-1").unwrap().unwrap();
    assert_eq!(entry.widget_id, "jira-widget-1");
    assert_eq!(entry.fetched_at, now());
    assert_eq!(entry.payload, payload);
    assert_eq!(entry.payload["issues"][0]["key"], "ABC-1");
}

/// DECISIONS 16: 재시도 중 직전 성공 데이터를 계속 표시 + "5분 전 데이터".
#[test]
fn age_drives_the_stale_data_label() {
    let dir = TempDir::new().unwrap();
    let cache = CacheStore::new(dir.path());

    let fetched = now();
    cache.put("w1", json!({ "ok": true }), fetched).unwrap();

    let entry = cache.get("w1").unwrap().unwrap();

    assert_eq!(entry.age_seconds(fetched), 0);
    assert_eq!(entry.age_seconds(fetched + Duration::minutes(5)), 300);
    assert_eq!(entry.age_seconds(fetched + Duration::hours(2)), 7200);
}

#[test]
fn age_is_clamped_at_zero_when_the_clock_moves_backwards() {
    // NTP correction or a manual clock change would otherwise render
    // "-3분 전 데이터".
    let dir = TempDir::new().unwrap();
    let cache = CacheStore::new(dir.path());

    cache.put("w1", json!({}), now()).unwrap();
    let entry = cache.get("w1").unwrap().unwrap();

    assert_eq!(entry.age_seconds(now() - Duration::hours(1)), 0);
}

#[test]
fn put_overwrites_the_previous_response() {
    let dir = TempDir::new().unwrap();
    let cache = CacheStore::new(dir.path());

    cache.put("w1", json!({ "n": 1 }), now()).unwrap();
    let later = now() + Duration::minutes(5);
    cache.put("w1", json!({ "n": 2 }), later).unwrap();

    let entry = cache.get("w1").unwrap().unwrap();
    assert_eq!(entry.payload["n"], 2);
    assert_eq!(entry.fetched_at, later);

    // One file per widget, not one per refresh.
    assert_eq!(fs::read_dir(cache.dir()).unwrap().count(), 1);
}

#[test]
fn widgets_have_independent_cache_files() {
    // DECISIONS 11.2: 새로고침 주기는 위젯별로 다름. One widget's refresh must
    // not be able to clobber another's data.
    let dir = TempDir::new().unwrap();
    let cache = CacheStore::new(dir.path());

    cache.put("jira-1", json!({ "src": "jira" }), now()).unwrap();
    cache.put("gh-1", json!({ "src": "github" }), now()).unwrap();
    cache.put("todo-1", json!({ "src": "todo" }), now()).unwrap();

    assert_eq!(cache.get("jira-1").unwrap().unwrap().payload["src"], "jira");
    assert_eq!(cache.get("gh-1").unwrap().unwrap().payload["src"], "github");
    assert_eq!(cache.get("todo-1").unwrap().unwrap().payload["src"], "todo");
    assert_eq!(fs::read_dir(cache.dir()).unwrap().count(), 3);
}

#[test]
fn remove_is_idempotent() {
    let dir = TempDir::new().unwrap();
    let cache = CacheStore::new(dir.path());

    cache.put("w1", json!({}), now()).unwrap();
    cache.remove("w1").unwrap();
    assert!(cache.get("w1").unwrap().is_none());

    // Removing again is fine.
    cache.remove("w1").unwrap();
    cache.remove("never-existed").unwrap();
}

/// Without eviction, deleting and re-adding widgets leaks a file forever.
#[test]
fn evict_orphans_removes_caches_for_deleted_widgets() {
    let dir = TempDir::new().unwrap();
    let cache = CacheStore::new(dir.path());

    cache.put("alive-1", json!({}), now()).unwrap();
    cache.put("alive-2", json!({}), now()).unwrap();
    cache.put("deleted-1", json!({}), now()).unwrap();
    cache.put("deleted-2", json!({}), now()).unwrap();

    let live = vec!["alive-1".to_string(), "alive-2".to_string()];
    let removed = cache.evict_orphans(&live).unwrap();

    assert_eq!(removed.len(), 2);
    assert!(cache.get("alive-1").unwrap().is_some());
    assert!(cache.get("alive-2").unwrap().is_some());
    assert!(cache.get("deleted-1").unwrap().is_none());
    assert!(cache.get("deleted-2").unwrap().is_none());
}

#[test]
fn evict_orphans_keeps_everything_when_all_widgets_are_live() {
    let dir = TempDir::new().unwrap();
    let cache = CacheStore::new(dir.path());

    cache.put("w1", json!({}), now()).unwrap();
    cache.put("w2", json!({}), now()).unwrap();

    let removed = cache
        .evict_orphans(&["w1".to_string(), "w2".to_string()])
        .unwrap();

    assert!(removed.is_empty());
    assert_eq!(fs::read_dir(cache.dir()).unwrap().count(), 2);
}

#[test]
fn evict_orphans_on_a_missing_directory_is_a_no_op() {
    let dir = TempDir::new().unwrap();
    let cache = CacheStore::new(dir.path());

    assert!(cache.evict_orphans(&[]).unwrap().is_empty());
}

#[test]
fn evict_orphans_ignores_files_it_does_not_own() {
    // An in-flight atomic write from another process leaves a dotfile behind;
    // eviction must not delete it out from under that writer.
    let dir = TempDir::new().unwrap();
    let cache = CacheStore::new(dir.path());

    cache.put("w1", json!({}), now()).unwrap();
    fs::write(cache.dir().join(".w2.json.tmp-123"), "in flight").unwrap();
    fs::write(cache.dir().join("notes.txt"), "unrelated").unwrap();

    cache.evict_orphans(&[]).unwrap();

    assert!(cache.dir().join(".w2.json.tmp-123").exists());
    assert!(cache.dir().join("notes.txt").exists());
    assert!(cache.get("w1").unwrap().is_none());
}

#[test]
fn clear_removes_every_entry() {
    let dir = TempDir::new().unwrap();
    let cache = CacheStore::new(dir.path());

    for n in 0..5 {
        cache.put(&format!("w{n}"), json!({}), now()).unwrap();
    }

    let removed = cache.clear().unwrap();

    assert_eq!(removed.len(), 5);
    assert_eq!(fs::read_dir(cache.dir()).unwrap().count(), 0);
}

/// Cache is reconstructible from the network, so a bad file is a miss rather
/// than a startup failure. This is the deliberate exception to loud failure —
/// safe precisely because no user data is at stake.
#[test]
fn corrupt_cache_entry_reads_as_a_miss() {
    let dir = TempDir::new().unwrap();
    let cache = CacheStore::new(dir.path());

    cache.put("w1", json!({ "n": 1 }), now()).unwrap();
    fs::write(cache.dir().join("w1.json"), "{{{ truncated").unwrap();

    assert!(cache.get("w1").unwrap().is_none());

    // And the widget can refill it.
    cache.put("w1", json!({ "n": 2 }), now()).unwrap();
    assert_eq!(cache.get("w1").unwrap().unwrap().payload["n"], 2);
}

#[test]
fn future_version_cache_entry_reads_as_a_miss_rather_than_erroring() {
    // Unlike board.json, a newer cache file is safe to ignore — nothing is lost
    // by refetching, and failing startup over it would break the 0ms promise.
    let dir = TempDir::new().unwrap();
    let cache = CacheStore::new(dir.path());

    fs::create_dir_all(cache.dir()).unwrap();
    fs::write(
        cache.dir().join("w1.json"),
        r#"{"version": 99, "widgetId": "w1", "fetchedAt": "2026-07-29T12:00:00Z", "payload": {}}"#,
    )
    .unwrap();

    assert!(cache.get("w1").unwrap().is_none());
}

/// Widget ids come from the app, but `board.json` is hand-editable, so this is
/// the one place a user-supplied string becomes a path.
#[test]
fn path_traversal_in_a_widget_id_cannot_escape_the_cache_directory() {
    let dir = TempDir::new().unwrap();
    let cache = CacheStore::new(dir.path());

    cache
        .put("../../escaped", json!({ "evil": true }), now())
        .unwrap();

    // Nothing was written outside the cache directory.
    assert!(!dir.path().join("escaped.json").exists());
    assert!(!dir.path().parent().unwrap().join("escaped.json").exists());

    // The entry lives inside the cache dir under a sanitized name, and still
    // round-trips under the same id.
    let entries: Vec<_> = fs::read_dir(cache.dir())
        .unwrap()
        .map(|e| e.unwrap().file_name().to_string_lossy().to_string())
        .collect();
    assert_eq!(entries, vec!["______escaped.json"]);
    assert_eq!(
        cache.get("../../escaped").unwrap().unwrap().payload["evil"],
        true
    );
}

#[test]
fn sanitized_ids_are_still_recognized_as_live_during_eviction() {
    // Regression guard: if eviction compared raw ids to sanitized filenames it
    // would delete this entry as an orphan on every sweep.
    let dir = TempDir::new().unwrap();
    let cache = CacheStore::new(dir.path());

    cache.put("widget with spaces", json!({}), now()).unwrap();

    let removed = cache
        .evict_orphans(&["widget with spaces".to_string()])
        .unwrap();

    assert!(removed.is_empty());
    assert!(cache.get("widget with spaces").unwrap().is_some());
}

#[test]
fn survives_a_realistically_large_payload() {
    // 30 issues is the DECISIONS 11.2 default display count.
    let dir = TempDir::new().unwrap();
    let cache = CacheStore::new(dir.path());

    let issues: Vec<_> = (0..30)
        .map(|n| {
            json!({
                "key": format!("ABC-{n}"),
                "summary": "A reasonably long issue summary that resembles real data",
                "status": "In Progress",
                "assignee": { "accountId": "abc123", "displayName": "Someone" }
            })
        })
        .collect();

    cache
        .put("jira-1", json!({ "issues": issues }), now())
        .unwrap();

    let entry = cache.get("jira-1").unwrap().unwrap();
    assert_eq!(entry.payload["issues"].as_array().unwrap().len(), 30);
}
