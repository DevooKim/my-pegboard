//! Linear 메타 캐시 테스트.
//!
//! 이 캐시가 조용히 사라지면 설정 폼의 팀 목록이 매번 네트워크를 기다린다.
//! 손상 복구가 앱을 실패시키지 않는 것도 여기서 고정한다.

use std::fs;

use chrono::{TimeZone, Utc};
use tempfile::TempDir;

use crate::providers::linear::LinearTeam;
use crate::storage::linear_meta::{LinearMetaStore, LINEAR_META_FILE};
use crate::storage::migrate::LoadOutcome;

fn team(id: &str, key: &str) -> LinearTeam {
    LinearTeam {
        id: id.to_string(),
        key: key.to_string(),
        name: format!("{key} 팀"),
    }
}

#[test]
fn missing_file_starts_empty_without_writing() {
    let dir = TempDir::new().unwrap();
    let (store, outcome) = LinearMetaStore::load(dir.path()).unwrap();

    assert_eq!(outcome, LoadOutcome::Missing);
    assert!(!store.has_teams());
    assert_eq!(store.fetched_at(), None);
    assert!(
        !dir.path().join(LINEAR_META_FILE).exists(),
        "읽기만 했는데 파일을 만들면 안 된다"
    );
}

#[test]
fn round_trips_teams() {
    let dir = TempDir::new().unwrap();
    let at = Utc.with_ymd_and_hms(2026, 8, 7, 12, 0, 0).unwrap();

    let (mut store, _) = LinearMetaStore::load(dir.path()).unwrap();
    store.set_teams(vec![team("t1", "ENG"), team("t2", "DES")], at);
    store.save().unwrap();

    let (reloaded, outcome) = LinearMetaStore::load(dir.path()).unwrap();
    assert_eq!(outcome, LoadOutcome::Loaded);
    assert_eq!(reloaded.teams().len(), 2);
    assert_eq!(reloaded.teams()[0].id, "t1");
    assert_eq!(reloaded.teams()[0].key, "ENG");
    assert_eq!(reloaded.fetched_at(), Some(at));
}

/// 캐시는 재구성 가능하다. 손상됐다고 앱을 실패시키지 않는다.
#[test]
fn corrupt_file_starts_empty_instead_of_failing() {
    let dir = TempDir::new().unwrap();
    fs::write(dir.path().join(LINEAR_META_FILE), b"{ this is not json").unwrap();

    let (store, outcome) = LinearMetaStore::load(dir.path()).unwrap();

    assert!(matches!(outcome, LoadOutcome::Recovered { .. }));
    assert!(!store.has_teams());
}

/// 갱신은 이전 목록을 대체한다. 지워진 팀이 남으면 안 된다.
#[test]
fn set_teams_replaces_rather_than_appends() {
    let dir = TempDir::new().unwrap();
    let at = Utc.with_ymd_and_hms(2026, 8, 7, 12, 0, 0).unwrap();

    let (mut store, _) = LinearMetaStore::load(dir.path()).unwrap();
    store.set_teams(vec![team("old", "OLD")], at);
    store.set_teams(vec![team("new", "NEW")], at);

    assert_eq!(store.teams().len(), 1);
    assert_eq!(store.teams()[0].id, "new");
}
