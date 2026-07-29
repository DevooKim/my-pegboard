//! Per-widget disk cache for the last successful API response.
//!
//! This module backs the single most important performance promise in the
//! project (CLAUDE.md, DECISIONS 17):
//!
//! > 앱을 켜면 즉시 지난 데이터가 보이고, 그 뒤에 조용히 갱신된다.
//!
//! The target for showing cached data is **0ms** — the board renders from these
//! files before any network call starts. That is the decisive difference from
//! the Jira web UI the user is escaping.
//!
//! It also serves DECISIONS 16: during a transient failure the widget keeps
//! showing the last good response with a faded "5분 전 데이터" marker, which is
//! why [`fetched_at`](CacheEntry::fetched_at) is stored alongside the payload.
//!
//! # Layout
//!
//! One file per widget under `<base_dir>/cache/`, rather than a single combined
//! file. Widgets refresh on independent timers (DECISIONS 11.2: 새로고침 주기는
//! 위젯별로 다름); one file per widget means a refresh rewrites only its own
//! data and cannot lose a concurrent write from another widget.

use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use specta::Type;

use crate::storage::atomic::write_json_atomic;
use crate::storage::error::{StorageError, StorageResult};
use crate::storage::migrate::{load_or_default, Loaded, Migration, MigrationSet};

pub const CACHE_DIR: &str = "cache";
pub const CACHE_SCHEMA_VERSION: u32 = 1;

static MIGRATIONS: &[Migration] = &[];

static MIGRATION_SET: MigrationSet = MigrationSet {
    current_version: CACHE_SCHEMA_VERSION,
    migrations: MIGRATIONS,
};

/// One widget's last successful response.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct CacheEntry {
    pub version: u32,
    pub widget_id: String,
    /// When the response was received. Drives the "N분 전 데이터" label.
    pub fetched_at: DateTime<Utc>,
    /// The provider's already-reduced payload.
    ///
    /// Untyped for the same reason as `Widget::config` — DECISIONS 6 has Rust
    /// strip Jira's ~200 fields down to the handful the widget needs, and the
    /// provider owns that shape. Storage persists bytes; it does not interpret.
    #[specta(type = serde_json::Value)]
    pub payload: Value,
}

impl CacheEntry {
    /// How old this data is relative to `now`.
    ///
    /// Clamped at zero: a clock adjustment between write and read could
    /// otherwise produce a negative age and a "-3분 전 데이터" label.
    pub fn age_seconds(&self, now: DateTime<Utc>) -> i64 {
        (now - self.fetched_at).num_seconds().max(0)
    }
}

impl Default for CacheEntry {
    fn default() -> Self {
        Self {
            version: CACHE_SCHEMA_VERSION,
            widget_id: String::new(),
            fetched_at: DateTime::<Utc>::UNIX_EPOCH,
            payload: Value::Null,
        }
    }
}

/// Disk cache rooted at `<base_dir>/cache/`.
pub struct CacheStore {
    dir: PathBuf,
}

impl CacheStore {
    /// `base_dir` is a parameter rather than Tauri's `app_data_dir()` so tests
    /// can use a tempdir.
    pub fn new(base_dir: &Path) -> Self {
        Self {
            dir: base_dir.join(CACHE_DIR),
        }
    }

    pub fn dir(&self) -> &Path {
        &self.dir
    }

    /// Path for a widget's cache file.
    ///
    /// Widget ids are app-generated, but this is the one place a value from a
    /// hand-edited `board.json` becomes a filesystem path. Sanitizing keeps an
    /// id like `../../board` from escaping the cache directory.
    fn entry_path(&self, widget_id: &str) -> PathBuf {
        let safe: String = widget_id
            .chars()
            .map(|c| {
                if c.is_ascii_alphanumeric() || c == '-' || c == '_' {
                    c
                } else {
                    '_'
                }
            })
            .collect();
        self.dir.join(format!("{safe}.json"))
    }

    /// Read a widget's cached response.
    ///
    /// Returns `Ok(None)` when there is nothing cached — a cold widget is a
    /// normal state, not an error.
    ///
    /// A corrupt or future-version cache file also yields `Ok(None)`: cache is
    /// by definition reconstructible from the network, so failing the app's
    /// startup path over it would trade the 0ms promise for nothing. This is
    /// the deliberate exception to the loud-failure rule — and the reason it is
    /// safe here is precisely that no user data is at stake.
    pub fn get(&self, widget_id: &str) -> StorageResult<Option<CacheEntry>> {
        let path = self.entry_path(widget_id);
        if !path.exists() {
            return Ok(None);
        }

        match load_or_default::<CacheEntry>(&path, &MIGRATION_SET) {
            Ok(Loaded { value, outcome }) => match outcome {
                crate::storage::migrate::LoadOutcome::Loaded
                | crate::storage::migrate::LoadOutcome::Migrated { .. } => Ok(Some(value)),
                // Missing/Recovered both mean "nothing usable here".
                _ => Ok(None),
            },
            // Includes FutureVersion. Discardable, so treat as a cache miss.
            Err(_) => Ok(None),
        }
    }

    /// Store a widget's successful response.
    ///
    /// Only ever called on success — DECISIONS 16 requires the last *good* data
    /// to survive a failed refresh, so an error path must never reach here.
    pub fn put(
        &self,
        widget_id: &str,
        payload: Value,
        fetched_at: DateTime<Utc>,
    ) -> StorageResult<()> {
        let entry = CacheEntry {
            version: CACHE_SCHEMA_VERSION,
            widget_id: widget_id.to_string(),
            fetched_at,
            payload,
        };
        write_json_atomic(&self.entry_path(widget_id), &entry)
    }

    /// Drop one widget's cache. Idempotent.
    pub fn remove(&self, widget_id: &str) -> StorageResult<()> {
        let path = self.entry_path(widget_id);
        match fs::remove_file(&path) {
            Ok(()) => Ok(()),
            Err(source) if source.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(source) => Err(StorageError::Io {
                path,
                action: "remove cache entry",
                source,
            }),
        }
    }

    /// Delete cache files for widgets that no longer exist.
    ///
    /// Without this, deleting and re-adding widgets leaks a file per widget
    /// forever. Returns the paths removed.
    ///
    /// Matching is by sanitized filename against sanitized live ids, so an
    /// entry written under a sanitized name is still recognized as live.
    pub fn evict_orphans(&self, live_widget_ids: &[String]) -> StorageResult<Vec<PathBuf>> {
        if !self.dir.exists() {
            return Ok(Vec::new());
        }

        let live: HashSet<PathBuf> = live_widget_ids
            .iter()
            .map(|id| self.entry_path(id))
            .collect();

        let entries = fs::read_dir(&self.dir).map_err(|source| StorageError::Io {
            path: self.dir.clone(),
            action: "read cache directory",
            source,
        })?;

        let mut removed = Vec::new();

        for entry in entries {
            let entry = entry.map_err(|source| StorageError::Io {
                path: self.dir.clone(),
                action: "read cache directory entry",
                source,
            })?;
            let path = entry.path();

            // Only touch our own files. Leaves temp files from an in-flight
            // atomic write, and anything else, alone.
            if path.extension().and_then(|e| e.to_str()) != Some("json") {
                continue;
            }
            if path
                .file_name()
                .and_then(|n| n.to_str())
                .is_some_and(|n| n.starts_with('.'))
            {
                continue;
            }

            if !live.contains(&path) {
                fs::remove_file(&path).map_err(|source| StorageError::Io {
                    path: path.clone(),
                    action: "evict orphaned cache entry",
                    source,
                })?;
                removed.push(path);
            }
        }

        Ok(removed)
    }

    /// Delete every cache file. Backs 설정 → 데이터 → 초기화 (DECISIONS 15).
    pub fn clear(&self) -> StorageResult<Vec<PathBuf>> {
        self.evict_orphans(&[])
    }
}
