//! Storage error types.
//!
//! Every variant carries enough context to say *which file* and *what we were
//! doing* — CLAUDE.md forbids silent failure, and an error the UI cannot
//! explain is only marginally better than no error at all.

use std::path::PathBuf;

use thiserror::Error;

pub type StorageResult<T> = Result<T, StorageError>;

#[derive(Debug, Error)]
pub enum StorageError {
    #[error("failed to {action} at {path}: {source}")]
    Io {
        path: PathBuf,
        action: &'static str,
        #[source]
        source: std::io::Error,
    },

    #[error("failed to serialize data for {path}: {source}")]
    Serialize {
        path: PathBuf,
        #[source]
        source: serde_json::Error,
    },

    /// A file existed but did not parse. The caller is expected to have already
    /// quarantined it — see [`crate::storage::migrate::load_or_default`].
    #[error("{path} is not valid JSON: {source}")]
    Corrupt {
        path: PathBuf,
        #[source]
        source: serde_json::Error,
    },

    /// The file was written by a newer build than this one.
    ///
    /// DECISIONS 10: we fail loudly rather than let serde drop the fields it
    /// does not recognize and write the truncated result back.
    #[error(
        "{path} has schema version {found}, but this build only understands up to {supported}. \
         Refusing to read it — a newer version of my-pegboard wrote this file, and opening it \
         here would discard the fields this build does not know about. Update the app."
    )]
    FutureVersion {
        path: PathBuf,
        found: u32,
        supported: u32,
    },

    /// No migration path is registered between two versions.
    #[error("no migration registered from schema version {from} to {to} for {path}")]
    MissingMigration { path: PathBuf, from: u32, to: u32 },

    /// A registered migration ran but failed.
    #[error("migration v{from} -> v{to} failed for {path}: {reason}")]
    MigrationFailed {
        path: PathBuf,
        from: u32,
        to: u32,
        reason: String,
    },

    #[error("{path} is not usable: {reason}")]
    InvalidPath { path: PathBuf, reason: String },

    /// DECISIONS 3: per-type instance caps.
    #[error("cannot add another {widget_type} widget: the limit is {limit} (currently {current})")]
    WidgetLimitReached {
        widget_type: String,
        limit: usize,
        current: usize,
    },

    #[error("no board with id {id}")]
    BoardNotFound { id: String },

    #[error("no widget with id {id}")]
    WidgetNotFound { id: String },

    #[error("a widget with id {id} already exists")]
    DuplicateWidget { id: String },
}
