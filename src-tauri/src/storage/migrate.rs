//! Schema versioning and migration.
//!
//! DECISIONS 10 (필수 안전장치 3): `{ "version": 1, ... }`.
//! 없으면 나중에 구조 변경 시 구파일을 읽을 방법이 없다.
//!
//! Three failure modes are handled explicitly, because the shared rule across
//! all of them is **never silently discard user data**:
//!
//! | On disk                | Behavior                                          |
//! |------------------------|---------------------------------------------------|
//! | missing                | return `T::default()`, write nothing              |
//! | older version          | run registered migrations forward, in order       |
//! | current version        | deserialize                                       |
//! | newer version          | hard error ([`StorageError::FutureVersion`])      |
//! | unparseable            | quarantine to `<name>.corrupt-<ts>`, then default |
//!
//! The newer-version case is the subtle one. serde drops unknown fields by
//! default, so a v2 file read by a v1 binary parses *fine* — and the next save
//! writes back a v1 file with the v2 fields silently deleted. Checking the
//! version number before deserializing is what prevents that.

use std::fs;
use std::path::{Path, PathBuf};

use chrono::Local;
use serde::de::DeserializeOwned;
use serde_json::Value;

use crate::storage::error::{StorageError, StorageResult};

/// A migration from one schema version to the next.
///
/// Operates on `serde_json::Value` rather than typed structs on purpose: the
/// whole point is to read a shape this binary has no Rust type for anymore.
pub struct Migration {
    pub from: u32,
    pub to: u32,
    pub apply: fn(Value) -> Result<Value, String>,
}

/// An ordered set of migrations plus the version this binary writes.
pub struct MigrationSet {
    pub current_version: u32,
    pub migrations: &'static [Migration],
}

impl MigrationSet {
    /// Walk `value` forward from `from_version` to `current_version`.
    fn migrate(&self, path: &Path, mut value: Value, from_version: u32) -> StorageResult<Value> {
        let mut version = from_version;

        while version < self.current_version {
            let step = self
                .migrations
                .iter()
                .find(|m| m.from == version)
                .ok_or_else(|| StorageError::MissingMigration {
                    path: path.to_path_buf(),
                    from: version,
                    to: self.current_version,
                })?;

            value = (step.apply)(value).map_err(|reason| StorageError::MigrationFailed {
                path: path.to_path_buf(),
                from: step.from,
                to: step.to,
                reason,
            })?;

            // Keep the embedded version field in step with the walk, so the
            // migrated value round-trips correctly if it is written back.
            if let Value::Object(ref mut map) = value {
                map.insert("version".to_string(), Value::from(step.to));
            }

            version = step.to;
        }

        Ok(value)
    }
}

/// Outcome of a load, so callers can tell the user what happened.
///
/// CLAUDE.md: 조용한 실패 금지. A load that quietly returned defaults after
/// quarantining the user's board would be exactly that.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum LoadOutcome {
    /// File did not exist. Defaults returned; nothing written.
    Missing,
    /// Loaded at the current schema version.
    Loaded,
    /// Loaded and migrated forward. Not yet persisted — the caller decides.
    Migrated { from: u32, to: u32 },
    /// File was unreadable. Preserved at `backup`, defaults returned.
    Recovered { backup: PathBuf, reason: String },
}

impl LoadOutcome {
    /// True when the user should be told something happened to their file.
    pub fn is_noteworthy(&self) -> bool {
        matches!(
            self,
            LoadOutcome::Migrated { .. } | LoadOutcome::Recovered { .. }
        )
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Loaded<T> {
    pub value: T,
    pub outcome: LoadOutcome,
}

/// Read a versioned JSON document, migrating or recovering as needed.
///
/// Returns `T::default()` for a missing or corrupt file. Corrupt files are
/// always preserved first — see [`quarantine`].
pub fn load_or_default<T>(path: &Path, set: &MigrationSet) -> StorageResult<Loaded<T>>
where
    T: DeserializeOwned + Default,
{
    let raw = match fs::read_to_string(path) {
        Ok(raw) => raw,
        Err(source) if source.kind() == std::io::ErrorKind::NotFound => {
            return Ok(Loaded {
                value: T::default(),
                outcome: LoadOutcome::Missing,
            });
        }
        Err(source) => {
            return Err(StorageError::Io {
                path: path.to_path_buf(),
                action: "read file",
                source,
            })
        }
    };

    // An empty or whitespace-only file is a plausible outcome of a crash on a
    // filesystem that lost the data blocks but kept the rename. Treat it as
    // missing rather than corrupt: there is nothing in it worth preserving,
    // and quarantining a zero-byte file just litters the data directory.
    if raw.trim().is_empty() {
        return Ok(Loaded {
            value: T::default(),
            outcome: LoadOutcome::Missing,
        });
    }

    let value: Value = match serde_json::from_str(&raw) {
        Ok(value) => value,
        Err(source) => {
            let backup = quarantine(path, &raw)?;
            return Ok(Loaded {
                value: T::default(),
                outcome: LoadOutcome::Recovered {
                    backup,
                    reason: source.to_string(),
                },
            });
        }
    };

    // A missing `version` means a pre-versioning file. None ever shipped, so
    // treat it as v1 rather than inventing a v0 migration.
    //
    // Saturating rather than `as u32`: a hand-edited version beyond u32 would
    // wrap (2^32 truncates to 0) and be read as an *older* schema, silently
    // running migrations over a file from the future — the exact data loss the
    // version gate exists to prevent. Saturating keeps it above
    // `current_version` so it fails loudly instead.
    let found_version = value
        .get("version")
        .and_then(Value::as_u64)
        .map(|v| u32::try_from(v).unwrap_or(u32::MAX))
        .unwrap_or(1);

    // Loud failure, before deserialization can drop anything.
    if found_version > set.current_version {
        return Err(StorageError::FutureVersion {
            path: path.to_path_buf(),
            found: found_version,
            supported: set.current_version,
        });
    }

    let migrated = found_version < set.current_version;
    let value = if migrated {
        set.migrate(path, value, found_version)?
    } else {
        value
    };

    // Structurally valid JSON can still fail to fit the target type (a string
    // where an object belongs, say). That is corruption too, and gets the same
    // preserve-then-default treatment rather than propagating as a hard error
    // that would leave the app unable to start.
    match serde_json::from_value::<T>(value) {
        Ok(value) => Ok(Loaded {
            value,
            outcome: if migrated {
                LoadOutcome::Migrated {
                    from: found_version,
                    to: set.current_version,
                }
            } else {
                LoadOutcome::Loaded
            },
        }),
        Err(source) => {
            let backup = quarantine(path, &raw)?;
            Ok(Loaded {
                value: T::default(),
                outcome: LoadOutcome::Recovered {
                    backup,
                    reason: source.to_string(),
                },
            })
        }
    }
}

/// Copy a bad file aside as `<name>.corrupt-<timestamp>`.
///
/// Uses the original bytes we already read rather than `fs::copy`, so what is
/// preserved is exactly what we failed to parse even if something rewrites the
/// file in between.
///
/// Never overwrites an existing quarantine file — if two corruptions land in
/// the same second, a counter is appended. Clobbering an earlier corrupt file
/// would destroy user data, which is the one thing this function exists to
/// prevent.
pub fn quarantine(path: &Path, contents: &str) -> StorageResult<PathBuf> {
    let stamp = Local::now().format("%Y%m%d-%H%M%S");
    let file_name = path
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_else(|| "data.json".to_string());

    let mut backup = path.with_file_name(format!("{file_name}.corrupt-{stamp}"));
    let mut counter = 1;
    while backup.exists() {
        backup = path.with_file_name(format!("{file_name}.corrupt-{stamp}-{counter}"));
        counter += 1;
    }

    // Written atomically as well: a half-copied quarantine file would defeat
    // the purpose of making one.
    crate::storage::atomic::write_atomic(&backup, contents.as_bytes())?;

    Ok(backup)
}
