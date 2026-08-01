//! `todos.json` — daily todos with carry-over.
//!
//! DECISIONS 13. Todo is the only data in the app with no upstream copy, so
//! this module is the most conservative one here: every save leaves a
//! one-generation backup at `todos.json.bak`, and nothing is ever auto-deleted.

use std::collections::BTreeSet;
use std::fs;
use std::path::{Path, PathBuf};

use chrono::NaiveDate;
use serde::{Deserialize, Serialize};
use specta::Type;

use crate::storage::atomic::write_json_atomic;
use crate::storage::error::{StorageError, StorageResult};
use crate::storage::migrate::{load_or_default, Loaded, Migration, MigrationSet};

pub const TODOS_FILE: &str = "todos.json";
pub const TODOS_BACKUP_FILE: &str = "todos.json.bak";
pub const TODOS_SCHEMA_VERSION: u32 = 1;

/// DECISIONS 13: `carriedCount >= 7`이면 "이거 정말 할 건가요?" 힌트.
/// A hint only — [`TodoStore`] never deletes on this threshold.
pub const ZOMBIE_THRESHOLD: u32 = 7;

static MIGRATIONS: &[Migration] = &[];

static MIGRATION_SET: MigrationSet = MigrationSet {
    current_version: TODOS_SCHEMA_VERSION,
    migrations: MIGRATIONS,
};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct TodoItem {
    pub id: String,
    pub text: String,
    pub done: bool,
    /// The date this item currently sits on. Carry-over mutates this field.
    pub date: NaiveDate,
    /// The date it was first created. Never changes — it is what makes
    /// "N일째" meaningful after several carries.
    pub origin_date: NaiveDate,
    /// How many times this item has been carried forward.
    pub carried_count: u32,
}

impl TodoItem {
    pub fn new(id: impl Into<String>, text: impl Into<String>, date: NaiveDate) -> Self {
        Self {
            id: id.into(),
            text: text.into(),
            done: false,
            date,
            origin_date: date,
            carried_count: 0,
        }
    }

    /// DECISIONS 13: 이월 항목은 `↻` + `N일째` 배지.
    pub fn is_carried(&self) -> bool {
        self.carried_count > 0
    }

    /// Whether to show the "이거 정말 할 건가요?" hint. Never a delete trigger.
    pub fn is_zombie(&self) -> bool {
        self.carried_count >= ZOMBIE_THRESHOLD
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct TodoFile {
    pub version: u32,
    #[serde(default)]
    pub items: Vec<TodoItem>,
}

impl Default for TodoFile {
    fn default() -> Self {
        Self {
            version: TODOS_SCHEMA_VERSION,
            items: Vec::new(),
        }
    }
}

/// One item's before-state, enough to put it back.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct CarriedItem {
    pub id: String,
    /// The date it was on before the sweep.
    pub from_date: NaiveDate,
    /// The date it landed on (always the `today` passed to the sweep).
    pub to_date: NaiveDate,
    /// `carried_count` before the increment.
    pub previous_carried_count: u32,
}

/// Result of a carry-over sweep.
///
/// DECISIONS 13: 자동 실행 + 되돌리기 가능. This carries enough state for the
/// caller to offer an undo, and to decide whether to say anything at all.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct CarryOverReport {
    pub carried: Vec<CarriedItem>,
    /// Distinct source dates the items came from, ascending. Lets the UI say
    /// "3일치 항목을 가져왔습니다" after a weekend.
    pub source_dates: Vec<NaiveDate>,
    pub target_date: NaiveDate,
}

impl CarryOverReport {
    pub fn is_empty(&self) -> bool {
        self.carried.is_empty()
    }

    pub fn count(&self) -> usize {
        self.carried.len()
    }
}

/// Reads and writes `todos.json`.
pub struct TodoStore {
    path: PathBuf,
    backup_path: PathBuf,
    data: TodoFile,
}

impl TodoStore {
    /// Load from `<base_dir>/todos.json`.
    ///
    /// `base_dir` is a parameter rather than Tauri's `app_data_dir()` so tests
    /// can use a tempdir.
    pub fn load(base_dir: &Path) -> StorageResult<(Self, crate::storage::migrate::LoadOutcome)> {
        let path = base_dir.join(TODOS_FILE);
        let backup_path = base_dir.join(TODOS_BACKUP_FILE);

        let Loaded { value, outcome } = load_or_default::<TodoFile>(&path, &MIGRATION_SET)?;

        // If the main file was corrupt, the backup is the only surviving copy
        // of this uniquely-irreplaceable data. Try it before accepting an empty
        // list. The corrupt original is already quarantined by `load_or_default`.
        let (data, outcome) = if matches!(
            outcome,
            crate::storage::migrate::LoadOutcome::Recovered { .. }
        ) {
            match load_or_default::<TodoFile>(&backup_path, &MIGRATION_SET) {
                Ok(Loaded {
                    value: backup_value,
                    outcome: backup_outcome,
                }) if !backup_value.items.is_empty()
                    && !matches!(
                        backup_outcome,
                        crate::storage::migrate::LoadOutcome::Recovered { .. }
                    ) =>
                {
                    (backup_value, outcome)
                }
                _ => (value, outcome),
            }
        } else {
            (value, outcome)
        };

        Ok((
            Self {
                path,
                backup_path,
                data,
            },
            outcome,
        ))
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    pub fn backup_path(&self) -> &Path {
        &self.backup_path
    }

    pub fn items(&self) -> &[TodoItem] {
        &self.data.items
    }

    pub fn items_mut(&mut self) -> &mut Vec<TodoItem> {
        &mut self.data.items
    }

    /// Items on a given date, in insertion order.
    pub fn items_on(&self, date: NaiveDate) -> Vec<&TodoItem> {
        self.data.items.iter().filter(|i| i.date == date).collect()
    }

    pub fn add(&mut self, item: TodoItem) {
        self.data.items.push(item);
    }

    pub fn get_mut(&mut self, id: &str) -> Option<&mut TodoItem> {
        self.data.items.iter_mut().find(|i| i.id == id)
    }

    /// Toggle completion. Returns the new state.
    pub fn set_done(&mut self, id: &str, done: bool) -> StorageResult<bool> {
        let item = self
            .get_mut(id)
            .ok_or_else(|| StorageError::WidgetNotFound { id: id.to_string() })?;
        item.done = done;
        Ok(item.done)
    }

    /// Move `id` to position `to_index` **among the items sharing its date**,
    /// leaving every other item's relative order untouched.
    ///
    /// The UI shows one date at a time, so a drag expresses intent within that
    /// day. Translating a within-day index into a whole-array position is this
    /// function's entire job — callers never deal with global indices.
    ///
    /// Returns whether anything moved. `false` means the id was unknown or it
    /// was already in place, so the caller can skip the disk write.
    ///
    /// Order *is* the array order (see [`items_on`](TodoStore::items_on)), so
    /// there is no separate sort key to keep in sync — which is why reordering
    /// has to happen here rather than in the view.
    pub fn reorder_within_date(&mut self, id: &str, to_index: usize) -> bool {
        let Some(from) = self.data.items.iter().position(|i| i.id == id) else {
            return false;
        };
        let date = self.data.items[from].date;

        // Where that day's items sit in the whole array, in order.
        let slots: Vec<usize> = self
            .data
            .items
            .iter()
            .enumerate()
            .filter(|(_, i)| i.date == date)
            .map(|(idx, _)| idx)
            .collect();

        // Clamp rather than reject. An out-of-range index means the view and
        // the store disagree about the list; landing at the end is closer to
        // the user's intent than silently doing nothing.
        let clamped = to_index.min(slots.len().saturating_sub(1));
        if slots.get(clamped) == Some(&from) {
            return false;
        }

        // Pull the item out first, then read the destination from the slot
        // list *as it is after removal*. Adjusting the pre-removal index by
        // hand is where this goes wrong: for a downward move the slots after
        // the source all shift left, so the naive `target - 1` lands one short.
        let item = self.data.items.remove(from);

        let remaining: Vec<usize> = self
            .data
            .items
            .iter()
            .enumerate()
            .filter(|(_, i)| i.date == date)
            .map(|(idx, _)| idx)
            .collect();

        // `clamped` counts positions in the day's list including the dragged
        // item, so it can be one past the end of what remains — that means
        // "after the last one".
        let insert_at = match remaining.get(clamped) {
            Some(&slot) => slot,
            None => remaining.last().map_or(self.data.items.len(), |&l| l + 1),
        };
        self.data.items.insert(insert_at, item);
        true
    }

    /// Remove an item. Only ever called by explicit user action —
    /// DECISIONS 13: 자동 삭제 절대 안 함.
    pub fn remove(&mut self, id: &str) -> StorageResult<TodoItem> {
        let pos = self
            .data
            .items
            .iter()
            .position(|i| i.id == id)
            .ok_or_else(|| StorageError::WidgetNotFound { id: id.to_string() })?;
        Ok(self.data.items.remove(pos))
    }

    /// Move every undone item from any date before `today` onto `today`.
    ///
    /// DECISIONS 13, precisely:
    ///
    /// - **Range** — all past dates, not just yesterday. Skipping a weekend
    ///   must still pull Friday's items forward.
    /// - **Move, not copy** — mutates `date` in place. Copying would leave
    ///   undone ghosts on past dates and make "어제 뭐 했지" noise. Exactly one
    ///   row per item continues to exist.
    /// - **`origin_date` is never touched** — it is what `N일째` counts from.
    /// - **Completed items are never touched** — a finished item belongs to the
    ///   day it was finished; that is the historical record.
    /// - **Future items are never touched** — "내일 이거 해야지" stays on tomorrow.
    /// - **Nothing is ever deleted**, no matter how large `carried_count` gets.
    /// - **Idempotent** — after a sweep no undone item is in the past, so an
    ///   immediate second sweep finds nothing and returns an empty report.
    ///   This matters because the sweep runs both at app start and at midnight,
    ///   and those can fire seconds apart.
    ///
    /// `today` is a parameter, not `Local::now()`, so the caller controls the
    /// clock and tests are deterministic.
    ///
    /// Does not save. The caller persists, so a sweep and a user edit can share
    /// one write.
    ///
    /// DECISIONS 13 also says 과거 편집 중에는 실행하지 않는다 — that is a UI
    /// condition, so the decision to call this lives with the caller.
    pub fn carry_over(&mut self, today: NaiveDate) -> CarryOverReport {
        let mut carried = Vec::new();
        let mut source_dates = BTreeSet::new();

        for item in &mut self.data.items {
            if item.done || item.date >= today {
                continue;
            }

            carried.push(CarriedItem {
                id: item.id.clone(),
                from_date: item.date,
                to_date: today,
                previous_carried_count: item.carried_count,
            });
            source_dates.insert(item.date);

            item.date = today;
            // Counts carries, not days elapsed: a single move across a
            // three-day weekend is one carry. The badge reads "N일째" but the
            // pressure being applied is "you deferred this N times".
            item.carried_count = item.carried_count.saturating_add(1);
        }

        CarryOverReport {
            carried,
            source_dates: source_dates.into_iter().collect(),
            target_date: today,
        }
    }

    /// Reverse a [`carry_over`](TodoStore::carry_over), restoring dates and counts.
    ///
    /// Items deleted or edited since the sweep are skipped rather than
    /// recreated — an undo should not resurrect something the user removed on
    /// purpose. Returns how many were actually restored.
    pub fn undo_carry_over(&mut self, report: &CarryOverReport) -> usize {
        let mut restored = 0;

        for entry in &report.carried {
            if let Some(item) = self.data.items.iter_mut().find(|i| i.id == entry.id) {
                // Only undo if the item is still where the sweep left it. If
                // the user has since moved it, their action wins.
                if item.date == entry.to_date {
                    item.date = entry.from_date;
                    item.carried_count = entry.previous_carried_count;
                    restored += 1;
                }
            }
        }

        restored
    }

    /// Write to disk atomically, rotating the previous file to `todos.json.bak`.
    ///
    /// DECISIONS 10 (필수 안전장치 4): `todos.json.bak` 1세대.
    /// Todo는 원본이 딴 데 없는 유일본 데이터.
    ///
    /// Rotation happens **before** the new write, so the backup always holds
    /// the last known-good contents rather than a copy of what we are about to
    /// write. Backing up afterward would make the `.bak` useless for recovering
    /// from a bad save.
    pub fn save(&self) -> StorageResult<()> {
        self.rotate_backup()?;
        write_json_atomic(&self.path, &self.data)
    }

    /// Copy the current file to `.bak`, if there is one.
    ///
    /// Reads and rewrites rather than `fs::copy` so the backup is written
    /// atomically too. A backup that can itself be torn by a crash is not a
    /// backup.
    ///
    /// A missing main file is not an error — first run has nothing to back up.
    /// A *corrupt* main file is deliberately still backed up: we do not know it
    /// is corrupt at this level, and preserving bytes we cannot parse is
    /// strictly better than dropping them.
    fn rotate_backup(&self) -> StorageResult<()> {
        let existing = match fs::read(&self.path) {
            Ok(bytes) => bytes,
            Err(source) if source.kind() == std::io::ErrorKind::NotFound => return Ok(()),
            Err(source) => {
                return Err(StorageError::Io {
                    path: self.path.clone(),
                    action: "read todos for backup",
                    source,
                })
            }
        };

        // Never overwrite a good backup with an empty file.
        if existing.is_empty() {
            return Ok(());
        }

        crate::storage::atomic::write_atomic(&self.backup_path, &existing)
    }
}
