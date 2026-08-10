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

use std::path::{Path, PathBuf};

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use specta::Type;

use crate::providers::linear::LinearTeam;
use crate::storage::atomic::write_json_atomic;
use crate::storage::error::StorageResult;
use crate::storage::migrate::{load_or_default, Loaded, Migration, MigrationSet};

pub const LINEAR_META_FILE: &str = "linear_meta.json";
pub const LINEAR_META_SCHEMA_VERSION: u32 = 1;

static MIGRATIONS: &[Migration] = &[];

static MIGRATION_SET: MigrationSet = MigrationSet {
    current_version: LINEAR_META_SCHEMA_VERSION,
    migrations: MIGRATIONS,
};

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct LinearMetaFile {
    pub version: u32,
    /// 마지막으로 네트워크에서 받아온 시각. ↻ 옆의 "3일 전" 표시에 쓴다.
    #[serde(default)]
    pub teams_fetched_at: Option<DateTime<Utc>>,
    #[serde(default)]
    pub teams: Vec<LinearTeam>,
}

impl Default for LinearMetaFile {
    fn default() -> Self {
        Self {
            version: LINEAR_META_SCHEMA_VERSION,
            teams_fetched_at: None,
            teams: Vec::new(),
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
        &self.data.teams
    }

    pub fn fetched_at(&self) -> Option<DateTime<Utc>> {
        self.data.teams_fetched_at
    }

    /// 캐시에 쓸 만한 것이 있는가. 빈 목록은 "아직 받은 적 없음"과 같게 본다.
    pub fn has_teams(&self) -> bool {
        !self.data.teams.is_empty()
    }

    /// 팀 목록을 갈아끼운다.
    ///
    /// GitHub의 `set_repos`처럼 걸러내는 것이 없다 — 아카이브에 해당하는
    /// 개념이 팀에 없고, 팀 수는 대개 한 자리다.
    pub fn set_teams(&mut self, teams: Vec<LinearTeam>, fetched_at: DateTime<Utc>) {
        self.data.version = LINEAR_META_SCHEMA_VERSION;
        self.data.teams = teams;
        self.data.teams_fetched_at = Some(fetched_at);
    }

    pub fn save(&self) -> StorageResult<()> {
        write_json_atomic(&self.path, &self.data)
    }
}

#[cfg(test)]
#[path = "tests/linear_meta_tests.rs"]
mod linear_meta_tests;
