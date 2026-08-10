//! Linear 메타 캐시 테스트.
//!
//! 이 캐시가 조용히 사라지면 설정 폼의 팀 목록이 매번 네트워크를 기다린다.
//! 손상 복구가 앱을 실패시키지 않는 것도 여기서 고정한다.

use std::fs;

use chrono::{TimeZone, Utc};
use tempfile::TempDir;

use crate::providers::linear::{
    LinearGlobalMetadata, LinearKnownIds, LinearMetadataList, LinearProjectOption, LinearTeam,
    LinearTeamMetadata, LinearUserOption, LinearWorkflowState,
};
use crate::storage::linear_meta::{LinearMetaStore, LINEAR_META_FILE};
use crate::storage::migrate::LoadOutcome;

fn team(id: &str, key: &str) -> LinearTeam {
    LinearTeam {
        id: id.to_string(),
        key: key.to_string(),
        name: format!("{key} 팀"),
    }
}

fn list<T>(items: Vec<T>) -> LinearMetadataList<T> {
    LinearMetadataList {
        items,
        fetched_at: Some(Utc.with_ymd_and_hms(2026, 8, 10, 12, 0, 0).unwrap()),
        truncated: false,
    }
}

fn global_metadata(teams: Vec<LinearTeam>) -> LinearGlobalMetadata {
    LinearGlobalMetadata {
        teams: list(teams),
        viewer: None,
        labels: list(Vec::new()),
    }
}

fn team_metadata(team_id: &str, state_name: &str) -> LinearTeamMetadata {
    LinearTeamMetadata {
        team_id: team_id.into(),
        states: list(vec![LinearWorkflowState {
            id: format!("state-{team_id}"),
            name: state_name.into(),
            color: "#8a8f98".into(),
            type_name: "unstarted".into(),
            position: 0.0,
        }]),
        members: list(vec![LinearUserOption {
            id: format!("member-{team_id}"),
            name: format!("{team_id} member"),
            avatar_url: None,
        }]),
        projects: list(vec![LinearProjectOption {
            id: format!("project-{team_id}"),
            name: format!("{team_id} project"),
            team_id: team_id.into(),
        }]),
    }
}

#[test]
fn migrates_v1_team_list_into_v2_global_metadata() {
    let dir = TempDir::new().unwrap();
    fs::write(
        dir.path().join(LINEAR_META_FILE),
        r#"{
          "version":1,
          "teamsFetchedAt":"2026-08-07T12:00:00Z",
          "teams":[{"id":"t1","key":"ENG","name":"Engineering"}]
        }"#,
    )
    .unwrap();

    let (store, outcome) = LinearMetaStore::load(dir.path()).unwrap();

    assert_eq!(outcome, LoadOutcome::Migrated { from: 1, to: 2 });
    assert_eq!(store.global().teams.items[0].id, "t1");
    assert_eq!(
        store.global().teams.fetched_at,
        Some("2026-08-07T12:00:00Z".parse().unwrap())
    );
}

#[test]
fn replacing_one_team_preserves_global_and_other_teams() {
    let dir = TempDir::new().unwrap();
    let (mut store, _) = LinearMetaStore::load(dir.path()).unwrap();
    store.set_global(global_metadata(vec![
        team("team-eng", "ENG"),
        team("team-design", "DES"),
    ]));
    store.set_team(team_metadata("team-design", "Design Todo"));
    let global_before = store.global().clone();
    let other_before = store.team("team-design").cloned();

    store.set_team(team_metadata("team-eng", "Engineering Todo"));

    assert_eq!(store.global(), &global_before);
    assert_eq!(store.team("team-design"), other_before.as_ref());
}

#[test]
fn replacing_global_preserves_cached_team_scopes() {
    let dir = TempDir::new().unwrap();
    let (mut store, _) = LinearMetaStore::load(dir.path()).unwrap();
    store.set_global(global_metadata(vec![team("team-eng", "ENG")]));
    store.set_team(team_metadata("team-eng", "Engineering Todo"));
    let team_before = store.team("team-eng").cloned();

    store.set_global(global_metadata(vec![team("team-design", "DES")]));

    assert_eq!(store.team("team-eng"), team_before.as_ref());
    assert!(store.team("team-design").is_none());
}

#[test]
fn known_ids_union_cached_teams_and_team_choices() {
    let dir = TempDir::new().unwrap();
    let (mut store, _) = LinearMetaStore::load(dir.path()).unwrap();
    store.set_global(global_metadata(vec![team("team-eng", "ENG")]));
    store.set_team(team_metadata("team-eng", "Todo"));

    let known: LinearKnownIds = store.known_ids();

    assert!(known.team_ids.contains("team-eng"));
    assert!(known.project_ids.contains("project-team-eng"));
    assert!(known.state_types.contains("unstarted"));
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

#[test]
fn clearing_for_token_rotation_removes_all_metadata_from_memory_and_disk() {
    let dir = TempDir::new().unwrap();
    let (mut store, _) = LinearMetaStore::load(dir.path()).unwrap();
    let mut global = global_metadata(vec![team("old-account-team", "OLD")]);
    global.viewer = Some(LinearUserOption {
        id: "old-viewer".into(),
        name: "Old account".into(),
        avatar_url: None,
    });
    store.set_global(global);
    store.set_team(team_metadata("old-account-team", "Old Todo"));
    store.save().unwrap();

    store.clear();
    assert!(store.global().teams.items.is_empty());
    assert!(store.global().viewer.is_none());
    assert!(store.team("old-account-team").is_none());

    store.save().unwrap();
    let (reloaded, _) = LinearMetaStore::load(dir.path()).unwrap();
    assert!(reloaded.global().teams.items.is_empty());
    assert!(reloaded.global().viewer.is_none());
    assert!(reloaded.team("old-account-team").is_none());
}
