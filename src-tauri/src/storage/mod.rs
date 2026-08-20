//! File storage for my-pegboard.
//!
//! DECISIONS 10: JSON files, not SQLite. At this scale (≤16 widgets, a few
//! thousand todos a year) SQLite would add migration burden and take away the
//! real advantage of JSON — the user can open the file and fix it by hand when
//! a layout gets tangled.
//!
//! Everything here writes through [`atomic`], reads through [`migrate`], and
//! takes its base directory as a parameter rather than reaching for Tauri's
//! `app_data_dir()`. In the app that directory is
//! `~/Library/Application Support/io.devookim.MyPegboard/`; in tests it is a
//! tempdir.
//!
//! | Module     | File               | Notes                                  |
//! |------------|--------------------|----------------------------------------|
//! | [`board`]  | `board.json`       | layout + widget config, per-type caps   |
//! | [`todos`]  | `todos.json`       | daily todos, carry-over, `.bak`         |
//! | [`cache`]  | `cache/<id>.json`  | last good API response, per widget      |
//! | [`jira_meta`] | `jira_meta.json` | Jira 프로젝트/이슈타입, 명시 갱신만    |
//! | [`linear_meta`] | `linear_meta.json` | Linear 팀 목록, 명시 갱신만        |
//! | [`atomic`] | —                  | temp file → fsync → rename              |
//! | [`migrate`]| —                  | version dispatch, corrupt-file recovery |
//!
//! Saving is synchronous and unconditional everywhere. The 500ms debounce
//! CLAUDE.md requires belongs to the scheduler/command layer that owns the
//! timer — see [`board`] for the reasoning.

pub mod atomic;
pub mod board;
pub mod cache;
pub mod error;
pub mod github_meta;
pub mod jira_meta;
pub mod linear_meta;
pub mod migrate;
pub mod todos;

#[cfg(test)]
mod tests;

pub use board::{Board, BoardFile, BoardStore, Widget, WidgetLayout, WidgetType};
pub use cache::{CacheEntry, CacheStore};
pub use jira_meta::{JiraMetaFile, JiraMetaStore};
pub use linear_meta::{LinearMetaFile, LinearMetaStore};
pub use error::{StorageError, StorageResult};
pub use migrate::{LoadOutcome, Loaded, Migration, MigrationSet};
pub use todos::{CarriedItem, CarryOverReport, TodoFile, TodoItem, TodoStore};
