//! `linear_meta.json` — Linear 팀 목록 디스크 캐시.
//!
//! # 왜 `cache/`가 아니라 별도 파일인가
//!
//! [`CacheStore`](crate::storage::cache::CacheStore)는 **위젯별** 캐시다.
//! `board_save`가 매번 `evict_orphans(&live_widget_ids)`를 불러 위젯 id와
//! 매칭되지 않는 파일을 전부 지운다. 팀 목록은 위젯에 속하지 않으므로
//! 거기에 넣으면 다음 레이아웃 저장에서 조용히 사라진다.
//!
//! `github_meta.rs`·`jira_meta.rs`와 같은 이유·같은 구조다.
//!
//! # 왜 자동 갱신하지 않는가
//!
//! 팀 목록은 거의 바뀌지 않는다. 앱을 켤 때마다 조회하면 시작이 느려지고
//! (0ms 표시 약속을 깬다) 얻는 것이 없다. 명시적 ↻ 버튼과 "마지막 갱신 N일 전"
//! 표시로 사용자가 판단하게 한다.
//!
//! 손상되거나 미래 버전이면 빈 값으로 시작한다 — 캐시는 재구성 가능하므로
//! 앱을 실패시킬 이유가 없다.

use std::collections::{BTreeMap, BTreeSet};
use std::path::{Path, PathBuf};

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use specta::Type;

use crate::providers::linear::{
    LinearGlobalMetadata, LinearKnownIds, LinearTeam, LinearTeamMetadata, LinearUserOption,
};
use crate::storage::atomic::write_json_atomic;
use crate::storage::error::StorageResult;
use crate::storage::migrate::{load_or_default, Loaded, Migration, MigrationSet};

pub const LINEAR_META_FILE: &str = "linear_meta.json";
pub const LINEAR_META_SCHEMA_VERSION: u32 = 2;

static MIGRATIONS: &[Migration] = &[Migration {
    from: 1,
    to: 2,
    apply: migrate_v1_to_v2,
}];

static MIGRATION_SET: MigrationSet = MigrationSet {
    current_version: LINEAR_META_SCHEMA_VERSION,
    migrations: MIGRATIONS,
};

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct LinearMetaFile {
    pub version: u32,
    #[serde(default)]
    pub global: LinearGlobalMetadata,
    #[serde(default)]
    pub teams: BTreeMap<String, LinearTeamMetadata>,
}

impl Default for LinearMetaFile {
    fn default() -> Self {
        Self {
            version: LINEAR_META_SCHEMA_VERSION,
            global: LinearGlobalMetadata::default(),
            teams: BTreeMap::new(),
        }
    }
}

pub struct LinearMetaStore {
    path: PathBuf,
    data: LinearMetaFile,
}

impl LinearMetaStore {
    pub fn load(base_dir: &Path) -> StorageResult<(Self, crate::storage::migrate::LoadOutcome)> {
        let path = base_dir.join(LINEAR_META_FILE);
        let Loaded { value, outcome } = load_or_default::<LinearMetaFile>(&path, &MIGRATION_SET)?;
        Ok((Self { path, data: value }, outcome))
    }

    pub fn teams(&self) -> &[LinearTeam] {
        &self.data.global.teams.items
    }

    pub fn fetched_at(&self) -> Option<DateTime<Utc>> {
        self.data.global.teams.fetched_at
    }

    /// 캐시에 쓸 만한 것이 있는가. 빈 목록은 "아직 받은 적 없음"과 같게 본다.
    pub fn has_teams(&self) -> bool {
        !self.data.global.teams.items.is_empty()
    }

    /// 팀 목록을 갈아끼운다.
    ///
    /// GitHub의 `set_repos`처럼 걸러내는 것이 없다 — 아카이브에 해당하는
    /// 개념이 팀에 없고, 팀 수는 대개 한 자리다.
    pub fn set_teams(&mut self, teams: Vec<LinearTeam>, fetched_at: DateTime<Utc>) {
        self.data.version = LINEAR_META_SCHEMA_VERSION;
        let team_ids = teams
            .iter()
            .map(|team| team.id.clone())
            .collect::<BTreeSet<_>>();
        self.data
            .teams
            .retain(|team_id, _| team_ids.contains(team_id));
        self.data.global.teams.items = teams;
        self.data.global.teams.fetched_at = Some(fetched_at);
        self.data.global.teams.truncated = false;
    }

    pub fn global(&self) -> &LinearGlobalMetadata {
        &self.data.global
    }

    pub fn team(&self, team_id: &str) -> Option<&LinearTeamMetadata> {
        self.data.teams.get(team_id)
    }

    pub fn known_ids(&self) -> LinearKnownIds {
        let team_ids = self
            .data
            .global
            .teams
            .items
            .iter()
            .map(|team| team.id.clone());
        let project_ids = self
            .data
            .teams
            .values()
            .flat_map(|team| team.projects.items.iter().map(|project| project.id.clone()));
        let label_ids = self
            .data
            .global
            .labels
            .items
            .iter()
            .map(|label| label.id.clone());
        let state_types = self.data.teams.values().flat_map(|team| {
            team.states
                .items
                .iter()
                .map(|state| state.type_name.clone())
        });

        LinearKnownIds::new(team_ids, project_ids, label_ids, state_types)
    }

    pub fn set_global(&mut self, global: LinearGlobalMetadata) {
        self.data.version = LINEAR_META_SCHEMA_VERSION;
        apply_global(&mut self.data, global);
    }

    /// 전역 메타데이터를 디스크에 먼저 저장하고 성공한 경우에만 메모리를 교체한다.
    ///
    /// 전역 팀 목록이 줄어들면 더 이상 존재하지 않는 팀의 프로젝트·상태·멤버
    /// 스코프도 함께 버린다. 그렇지 않으면 `known_ids()`가 삭제된 프로젝트를
    /// 유효하다고 판정해 이슈 생성 입력을 통과시킨다.
    pub fn replace_global_and_save(&mut self, global: LinearGlobalMetadata) -> StorageResult<()> {
        let mut next = self.data.clone();
        apply_global(&mut next, global);
        write_json_atomic(&self.path, &next)?;
        self.data = next;
        Ok(())
    }

    pub fn set_viewer(&mut self, viewer: LinearUserOption) {
        self.data.version = LINEAR_META_SCHEMA_VERSION;
        self.data.global.viewer = Some(viewer);
    }

    pub fn set_team(&mut self, team: LinearTeamMetadata) {
        self.data.version = LINEAR_META_SCHEMA_VERSION;
        self.data.teams.insert(team.team_id.clone(), team);
    }

    /// 팀 메타데이터를 디스크에 먼저 저장하고 성공한 경우에만 메모리를 교체한다.
    pub fn replace_team_and_save(&mut self, team: LinearTeamMetadata) -> StorageResult<()> {
        let mut next = self.data.clone();
        next.version = LINEAR_META_SCHEMA_VERSION;
        next.teams.insert(team.team_id.clone(), team);
        write_json_atomic(&self.path, &next)?;
        self.data = next;
        Ok(())
    }

    /// 자격증명이 바뀌면 이전 Linear 계정의 선택지를 전부 버린다.
    pub fn clear(&mut self) {
        self.data = LinearMetaFile::default();
    }

    pub fn save(&self) -> StorageResult<()> {
        write_json_atomic(&self.path, &self.data)
    }
}

fn apply_global(data: &mut LinearMetaFile, global: LinearGlobalMetadata) {
    data.version = LINEAR_META_SCHEMA_VERSION;
    let team_ids = global
        .teams
        .items
        .iter()
        .map(|team| team.id.clone())
        .collect::<BTreeSet<_>>();
    data.global = global;
    data.teams.retain(|team_id, _| team_ids.contains(team_id));
}

fn migrate_v1_to_v2(mut value: serde_json::Value) -> Result<serde_json::Value, String> {
    let object = value
        .as_object_mut()
        .ok_or_else(|| "Linear 메타데이터 v1이 객체가 아닙니다".to_owned())?;
    let teams = object
        .remove("teams")
        .unwrap_or_else(|| serde_json::json!([]));
    let fetched_at = object
        .remove("teamsFetchedAt")
        .unwrap_or(serde_json::Value::Null);

    object.insert(
        "global".to_owned(),
        serde_json::json!({
            "teams": {
                "items": teams,
                "fetchedAt": fetched_at,
                "truncated": false
            },
            "viewer": null,
            "labels": {
                "items": [],
                "fetchedAt": null,
                "truncated": false
            }
        }),
    );
    object.insert("teams".to_owned(), serde_json::json!({}));
    Ok(value)
}

#[cfg(test)]
#[path = "tests/linear_meta_tests.rs"]
mod linear_meta_tests;
