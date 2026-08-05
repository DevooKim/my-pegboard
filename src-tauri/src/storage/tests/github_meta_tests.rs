//! GitHub 메타 캐시 테스트.
//!
//! 이 캐시가 조용히 사라지면 설정창의 저장소 목록이 매번 네트워크를 기다린다.
//! 손상 복구가 앱을 실패시키지 않는 것도 여기서 고정한다.

use std::fs;

use chrono::{TimeZone, Utc};
use tempfile::TempDir;

use crate::providers::github::GithubRepo;
use crate::storage::github_meta::{GithubMetaStore, GITHUB_META_FILE};
use crate::storage::migrate::LoadOutcome;

fn repo(name: &str, archived: bool) -> GithubRepo {
    GithubRepo {
        name_with_owner: name.to_string(),
        pushed_at: Some("2026-08-01T00:00:00Z".into()),
        is_private: false,
        is_archived: archived,
        owner: name.split_once('/').map_or(String::new(), |(o, _)| o.to_string()),
        is_organization: false,
    }
}

#[test]
fn missing_file_starts_empty_without_writing() {
    let dir = TempDir::new().unwrap();
    let (store, outcome) = GithubMetaStore::load(dir.path()).unwrap();

    assert_eq!(outcome, LoadOutcome::Missing);
    assert!(!store.has_repos());
    assert_eq!(store.fetched_at(), None);
    assert!(
        !dir.path().join(GITHUB_META_FILE).exists(),
        "읽기만 했는데 파일을 만들면 안 된다"
    );
}

#[test]
fn round_trips_repos() {
    let dir = TempDir::new().unwrap();
    let at = Utc.with_ymd_and_hms(2026, 8, 2, 12, 0, 0).unwrap();

    let (mut store, _) = GithubMetaStore::load(dir.path()).unwrap();
    store.set_repos(vec![repo("o/a", false), repo("o/b", false)], at);
    store.save().unwrap();

    let (reloaded, outcome) = GithubMetaStore::load(dir.path()).unwrap();
    assert_eq!(outcome, LoadOutcome::Loaded);
    assert_eq!(reloaded.repos().len(), 2);
    assert_eq!(reloaded.repos()[0].name_with_owner, "o/a");
    assert_eq!(reloaded.fetched_at(), Some(at));
}

/// 아카이브된 저장소는 고를 일이 없다. 목록만 길어진다.
#[test]
fn drops_archived_repos() {
    let dir = TempDir::new().unwrap();
    let at = Utc.with_ymd_and_hms(2026, 8, 2, 12, 0, 0).unwrap();

    let (mut store, _) = GithubMetaStore::load(dir.path()).unwrap();
    store.set_repos(
        vec![repo("o/live", false), repo("o/dead", true)],
        at,
    );

    assert_eq!(store.repos().len(), 1);
    assert_eq!(store.repos()[0].name_with_owner, "o/live");
}

/// 캐시는 재구성 가능하다. 손상됐다고 앱을 실패시키지 않는다.
#[test]
fn corrupt_file_starts_empty_instead_of_failing() {
    let dir = TempDir::new().unwrap();
    fs::write(dir.path().join(GITHUB_META_FILE), b"{ this is not json").unwrap();

    let (store, outcome) = GithubMetaStore::load(dir.path()).unwrap();

    assert!(matches!(outcome, LoadOutcome::Recovered { .. }));
    assert!(!store.has_repos());
}

/// 갱신은 이전 목록을 대체한다. 지워진 저장소가 남으면 안 된다.
#[test]
fn set_repos_replaces_rather_than_appends() {
    let dir = TempDir::new().unwrap();
    let at = Utc.with_ymd_and_hms(2026, 8, 2, 12, 0, 0).unwrap();

    let (mut store, _) = GithubMetaStore::load(dir.path()).unwrap();
    store.set_repos(vec![repo("o/old", false)], at);
    store.set_repos(vec![repo("o/new", false)], at);

    assert_eq!(store.repos().len(), 1);
    assert_eq!(store.repos()[0].name_with_owner, "o/new");
}
