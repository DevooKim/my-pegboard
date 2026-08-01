//! `github_meta.json` — GitHub 저장소 목록 디스크 캐시.
//!
//! # 왜 `cache/`가 아니라 별도 파일인가
//!
//! [`CacheStore`](crate::storage::cache::CacheStore)는 **위젯별** 캐시다.
//! `board_save`가 매번 `evict_orphans(&live_widget_ids)`를 불러 위젯 id와
//! 매칭되지 않는 파일을 전부 지운다. 저장소 목록은 위젯에 속하지 않으므로
//! 거기에 넣으면 다음 레이아웃 저장에서 조용히 사라진다.
//!
//! `jira_meta.rs`와 같은 이유·같은 구조다.
//!
//! # 왜 자동 갱신하지 않는가
//!
//! 저장소 목록은 자주 바뀌지 않는다. 앱을 켤 때마다 68개를 조회하면 시작이
//! 느려지고(0ms 표시 약속을 깬다) 얻는 것이 없다. 명시적 ↻ 버튼과
//! "마지막 갱신 N일 전" 표시로 사용자가 판단하게 한다.
//!
//! 손상되거나 미래 버전이면 빈 값으로 시작한다 — 캐시는 재구성 가능하므로
//! 앱을 실패시킬 이유가 없다.

use std::path::{Path, PathBuf};

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use specta::Type;

use crate::providers::github::GithubRepo;
use crate::storage::atomic::write_json_atomic;
use crate::storage::error::StorageResult;
use crate::storage::migrate::{load_or_default, Loaded, Migration, MigrationSet};

pub const GITHUB_META_FILE: &str = "github_meta.json";
pub const GITHUB_META_SCHEMA_VERSION: u32 = 1;

static MIGRATIONS: &[Migration] = &[];

static MIGRATION_SET: MigrationSet = MigrationSet {
    current_version: GITHUB_META_SCHEMA_VERSION,
    migrations: MIGRATIONS,
};

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct GithubMetaFile {
    pub version: u32,
    /// 마지막으로 네트워크에서 받아온 시각. ↻ 옆의 "3일 전" 표시에 쓴다.
    #[serde(default)]
    pub repos_fetched_at: Option<DateTime<Utc>>,
    #[serde(default)]
    pub repos: Vec<GithubRepo>,
}

impl Default for GithubMetaFile {
    fn default() -> Self {
        Self {
            version: GITHUB_META_SCHEMA_VERSION,
            repos_fetched_at: None,
            repos: Vec::new(),
        }
    }
}

pub struct GithubMetaStore {
    path: PathBuf,
    data: GithubMetaFile,
}

impl GithubMetaStore {
    pub fn load(base_dir: &Path) -> StorageResult<(Self, crate::storage::migrate::LoadOutcome)> {
        let path = base_dir.join(GITHUB_META_FILE);
        let Loaded { value, outcome } = load_or_default::<GithubMetaFile>(&path, &MIGRATION_SET)?;
        Ok((Self { path, data: value }, outcome))
    }

    pub fn repos(&self) -> &[GithubRepo] {
        &self.data.repos
    }

    pub fn fetched_at(&self) -> Option<DateTime<Utc>> {
        self.data.repos_fetched_at
    }

    /// 캐시에 쓸 만한 것이 있는가. 빈 목록은 "아직 받은 적 없음"과 같게 본다.
    pub fn has_repos(&self) -> bool {
        !self.data.repos.is_empty()
    }

    /// 저장소 목록을 갈아끼운다.
    ///
    /// **아카이브된 저장소는 여기서 버린다.** 설정 목록에 넣어봐야 고를 일이
    /// 없는데 68개를 더 길게 만들 뿐이다. 이미 필터에 들어가 있던 것이
    /// 아카이브되면 필터 자체는 남아 검색에 계속 쓰인다 — 목록에서 사라졌다고
    /// 설정을 조용히 지우면 그게 더 놀랍다.
    pub fn set_repos(&mut self, repos: Vec<GithubRepo>, fetched_at: DateTime<Utc>) {
        self.data.version = GITHUB_META_SCHEMA_VERSION;
        self.data.repos = repos.into_iter().filter(|r| !r.is_archived).collect();
        self.data.repos_fetched_at = Some(fetched_at);
    }

    pub fn save(&self) -> StorageResult<()> {
        write_json_atomic(&self.path, &self.data)
    }
}

#[cfg(test)]
#[path = "tests/github_meta_tests.rs"]
mod github_meta_tests;
