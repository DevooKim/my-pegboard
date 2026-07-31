//! Jira 메타 캐시 테스트.
//!
//! 이 캐시가 조용히 사라지면 생성 폼이 매번 네트워크를 기다린다 — 0ms 약속이 깨진다.
//! 손상 복구가 앱을 실패시키지 않는 것도 여기서 고정한다.

use std::fs;

use chrono::{TimeZone, Utc};
use tempfile::TempDir;

use crate::providers::jira::{JiraIssueTypeOption, JiraProjectWithTypes};
use crate::storage::jira_meta::{JiraMetaStore, JIRA_META_FILE};
use crate::storage::migrate::LoadOutcome;

fn project(key: &str) -> JiraProjectWithTypes {
    JiraProjectWithTypes {
        key: key.to_string(),
        name: format!("{key} 프로젝트"),
        issue_types: vec![JiraIssueTypeOption {
            id: "10082".into(),
            name: "기능".into(),
            description: None,
            icon_url: None,
            subtask: false,
            hierarchy_level: 0,
        }],
    }
}

#[test]
fn missing_file_starts_empty_without_writing() {
    let dir = TempDir::new().unwrap();
    let (store, outcome) = JiraMetaStore::load(dir.path()).unwrap();

    assert_eq!(outcome, LoadOutcome::Missing);
    assert!(!store.has_projects());
    assert_eq!(store.fetched_at(), None);
    assert!(!dir.path().join(JIRA_META_FILE).exists());
}

#[test]
fn round_trips_through_disk() {
    let dir = TempDir::new().unwrap();
    let at = Utc.with_ymd_and_hms(2026, 7, 31, 9, 0, 0).unwrap();

    let (mut store, _) = JiraMetaStore::load(dir.path()).unwrap();
    store.set_projects(vec![project("DTH"), project("EDU")], at);
    store.save().unwrap();

    let (reloaded, outcome) = JiraMetaStore::load(dir.path()).unwrap();
    assert_eq!(outcome, LoadOutcome::Loaded);
    assert_eq!(reloaded.projects().len(), 2);
    assert_eq!(reloaded.projects()[0].key, "DTH");
    assert_eq!(reloaded.projects()[0].issue_types[0].id, "10082");
    assert_eq!(reloaded.fetched_at(), Some(at));
}

/// 캐시는 재구성 가능하다. 손상됐다고 앱을 못 켜게 하면 안 된다.
#[test]
fn corrupt_file_recovers_to_empty_and_keeps_the_original() {
    let dir = TempDir::new().unwrap();
    fs::write(dir.path().join(JIRA_META_FILE), "{ 이건 JSON이 아니다").unwrap();

    let (store, outcome) = JiraMetaStore::load(dir.path()).unwrap();

    assert!(!store.has_projects(), "손상 파일은 빈 캐시로 시작해야 한다");
    match outcome {
        LoadOutcome::Recovered { backup, .. } => {
            assert!(backup.exists(), "원본이 격리 보존돼야 한다");
        }
        other => panic!("복구 결과를 기대했다: {other:?}"),
    }
}

/// 버전 없는 파일(손으로 만든 것)도 앱을 실패시키지 않는다.
#[test]
fn file_without_version_does_not_fail_the_app() {
    let dir = TempDir::new().unwrap();
    fs::write(
        dir.path().join(JIRA_META_FILE),
        r#"{"projects": [], "projectsFetchedAt": null}"#,
    )
    .unwrap();

    let (store, _) = JiraMetaStore::load(dir.path()).unwrap();
    assert!(!store.has_projects());
}

/// 갱신은 이전 목록을 통째로 갈아끼운다. 남은 프로젝트가 섞이면
/// 접근 권한을 잃은 프로젝트가 드롭다운에 계속 남는다.
#[test]
fn set_projects_replaces_rather_than_merges() {
    let dir = TempDir::new().unwrap();
    let at = Utc.with_ymd_and_hms(2026, 7, 31, 9, 0, 0).unwrap();
    let later = Utc.with_ymd_and_hms(2026, 8, 1, 9, 0, 0).unwrap();

    let (mut store, _) = JiraMetaStore::load(dir.path()).unwrap();
    store.set_projects(vec![project("DTH"), project("EDU")], at);
    store.set_projects(vec![project("PX")], later);

    assert_eq!(store.projects().len(), 1);
    assert_eq!(store.projects()[0].key, "PX");
    assert_eq!(store.fetched_at(), Some(later));
}
