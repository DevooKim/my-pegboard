//! `board.json` — layout and widget configuration.
//!
//! DECISIONS 10 / 14: the on-disk shape is multi-board ready even though only
//! one board is ever shown. Adding the array later would mean migrating every
//! existing file; adding it now costs one level of nesting.
//!
//! ```json
//! { "version": 1, "activeBoardId": "default",
//!   "boards": [{ "id": "default", "name": "Board", "widgets": [] }] }
//! ```
//!
//! # Debouncing is not this module's job
//!
//! CLAUDE.md calls for a 500ms debounce on layout writes, because dragging
//! emits layout events dozens of times a second. That belongs in the
//! scheduler/command layer, which owns the timer and the async runtime.
//! [`BoardStore::save`] is plain and synchronous, and writes every time it is
//! called. **Callers must debounce.**

use std::collections::HashSet;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use serde_json::Value;
use specta::Type;

use crate::storage::atomic::write_json_atomic;
use crate::storage::error::{StorageError, StorageResult};
use crate::storage::migrate::{load_or_default, Loaded, Migration, MigrationSet};

pub const BOARD_FILE: &str = "board.json";
pub const BOARD_SCHEMA_VERSION: u32 = 1;
pub const DEFAULT_BOARD_ID: &str = "default";
pub const BOARD_EXPORT_FORMAT_VERSION: u32 = 1;

/// Only v1 exists. When v2 arrives, add the struct change and register the
/// function here — the walk in [`MigrationSet::migrate`] picks it up.
///
/// ```ignore
/// static MIGRATIONS: &[Migration] = &[Migration {
///     from: 1,
///     to: 2,
///     apply: |mut value| { /* reshape */ Ok(value) },
/// }];
/// ```
static MIGRATIONS: &[Migration] = &[];

static MIGRATION_SET: MigrationSet = MigrationSet {
    current_version: BOARD_SCHEMA_VERSION,
    migrations: MIGRATIONS,
};

/// Widget type. DECISIONS 3 caps instances per type, not overall — Todo widgets
/// are free while Jira widgets cost API quota.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, Type)]
#[serde(rename_all = "lowercase")]
pub enum WidgetType {
    Jira,
    Github,
    Todo,
    /// Spike: iframe widget. Without this variant `board_save` rejects the whole
    /// board file, so a web widget would vanish on restart.
    Web,
    /// Local photo album — a mood background, not a viewer (DECISIONS 24).
    Album,
    /// Linear issues — read + status change + detail modal (DECISIONS 25).
    Linear,
}

impl WidgetType {
    /// DECISIONS 3: Jira 4 / GitHub 4 / Todo 1 / Web 4 / Album 4 / Linear 4.
    ///
    /// Todo was 8 until 2026-08-01. Every Todo widget reads the same
    /// `todos.json`, so a second one shows the same list twice while adding
    /// cross-widget sync cost — DECISIONS 21.
    pub const fn instance_limit(self) -> usize {
        match self {
            WidgetType::Jira => 4,
            WidgetType::Github => 4,
            WidgetType::Todo => 1,
            WidgetType::Web => 4,
            // Todo와 다르다. 앨범 위젯은 각자 다른 폴더를 보므로 두 번째가
            // 같은 것을 두 번 그리는 상황이 아니다.
            WidgetType::Album => 4,
            // Jira·GitHub과 같은 이유로 4다. 위젯마다 다른 쿼리를 본다
            // ("내게 할당된 것" / "팀에서 최근 움직인 것").
            WidgetType::Linear => 4,
        }
    }

    pub const fn as_str(self) -> &'static str {
        match self {
            WidgetType::Jira => "jira",
            WidgetType::Github => "github",
            WidgetType::Todo => "todo",
            WidgetType::Web => "web",
            WidgetType::Album => "album",
            WidgetType::Linear => "linear",
        }
    }
}

impl std::fmt::Display for WidgetType {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.as_str())
    }
}

/// Grid position. DECISIONS 2: 12-column grid, so `x + w <= 12`.
///
/// Not enforced here — react-grid-layout owns collision and compaction, and a
/// store that rejected layouts RGL considers valid would fight it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
pub struct WidgetLayout {
    pub x: u32,
    pub y: u32,
    pub w: u32,
    pub h: u32,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct Widget {
    pub id: String,
    #[serde(rename = "type")]
    pub widget_type: WidgetType,
    pub layout: WidgetLayout,
    /// Type-specific settings — JQL, GitHub query, refresh interval, and so on.
    ///
    /// Deliberately untyped. DECISIONS 4: 위젯 하나 = 프론트 폴더 하나 + Rust
    /// provider 하나. If this module named every provider's config type, adding
    /// a widget would mean editing storage, which is exactly the coupling the
    /// decision forbids. Providers own their own shapes and parse this
    /// themselves.
    #[serde(default)]
    #[specta(type = serde_json::Value)]
    pub config: Value,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct Board {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub locked: bool,
    #[serde(default)]
    pub widgets: Vec<Widget>,
}

impl Board {
    pub fn count_of(&self, widget_type: WidgetType) -> usize {
        self.widgets
            .iter()
            .filter(|w| w.widget_type == widget_type)
            .count()
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct BoardFile {
    pub version: u32,
    pub active_board_id: String,
    pub boards: Vec<Board>,
}

impl Default for BoardFile {
    fn default() -> Self {
        Self {
            version: BOARD_SCHEMA_VERSION,
            active_board_id: DEFAULT_BOARD_ID.to_string(),
            boards: vec![Board {
                id: DEFAULT_BOARD_ID.to_string(),
                name: "Board".to_string(),
                locked: false,
                widgets: Vec::new(),
            }],
        }
    }
}

impl BoardFile {
    pub fn board(&self, id: &str) -> Option<&Board> {
        self.boards.iter().find(|b| b.id == id)
    }

    pub fn board_mut(&mut self, id: &str) -> Option<&mut Board> {
        self.boards.iter_mut().find(|b| b.id == id)
    }

    /// The board the UI is showing.
    ///
    /// Falls back to the first board when `activeBoardId` names one that does
    /// not exist — a hand-edited file should not leave the app with no board to
    /// draw. DECISIONS 10 lists hand-editing as a feature of using JSON.
    pub fn active_board(&self) -> Option<&Board> {
        self.board(&self.active_board_id)
            .or_else(|| self.boards.first())
    }

    pub fn active_board_mut(&mut self) -> Option<&mut Board> {
        // Resolve the id first to avoid holding a borrow across the fallback.
        let id = self
            .board(&self.active_board_id)
            .map(|b| b.id.clone())
            .or_else(|| self.boards.first().map(|b| b.id.clone()))?;
        self.board_mut(&id)
    }
}

/// The only file shape that leaves the app for board transfer.
/// Deliberately does not contain `TodoFile`, caches, connections, or secrets.
/// Those stores are owned by separate files/services and are not part of board
/// settings. Unknown envelope fields are rejected on import so a hand-edited
/// file cannot smuggle another store into this boundary.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct BoardExportFile {
    pub format_version: u32,
    pub exported_at: String,
    pub board: BoardFile,
}

impl BoardExportFile {
    pub fn new(board: BoardFile, exported_at: String) -> Self {
        Self {
            format_version: BOARD_EXPORT_FORMAT_VERSION,
            exported_at,
            board,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum BoardImportMode {
    Replace,
    Merge,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct AlbumPathWarning {
    pub path: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct BoardImportWidgetCount {
    pub widget_type: String,
    pub count: usize,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct BoardImportPreview {
    pub board_count: usize,
    pub widget_count: usize,
    pub widget_counts: Vec<BoardImportWidgetCount>,
    pub format_version: u32,
    pub board_schema_version: u32,
    pub album_path_warnings: Vec<AlbumPathWarning>,
}

/// Candidate returned by the preview command. The UI sends the exact typed
/// `file` back when the user confirms; it never reconstructs settings locally.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct BoardImportCandidate {
    pub file: BoardExportFile,
    pub preview: BoardImportPreview,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum BoardImportSignal {
    RelaunchRequired,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct BoardImportApplyResult {
    pub board: BoardFile,
    pub orphan_cache_cleanup_warning: Option<String>,
    pub signal: Option<BoardImportSignal>,
}

/// Validate an untrusted board transfer before it can reach `BoardStore`.
pub fn validate_import(file: &BoardExportFile) -> StorageResult<()> {
    if file.format_version > BOARD_EXPORT_FORMAT_VERSION {
        return Err(StorageError::FutureExportVersion {
            found: file.format_version,
            supported: BOARD_EXPORT_FORMAT_VERSION,
        });
    }
    if file.format_version != BOARD_EXPORT_FORMAT_VERSION {
        return Err(StorageError::InvalidImport {
            reason: format!("지원하지 않는 export 형식 버전 {}", file.format_version),
        });
    }
    validate_sensitive_configs(&file.board)?;
    validate_board_file(&file.board)
}

/// Reject sensitive values at the actual export boundary. Provider configs are
/// intentionally opaque to storage, so this defensive walk prevents a future
/// provider from accidentally placing credentials, Todo data, or API caches in
/// a board config and then exporting them.
pub fn validate_export(board: &BoardFile) -> StorageResult<()> {
    validate_sensitive_configs(board)
}

fn validate_sensitive_configs(board: &BoardFile) -> StorageResult<()> {
    for current_board in &board.boards {
        for widget in &current_board.widgets {
            reject_sensitive_config_keys(&widget.config)?;
        }
    }
    Ok(())
}

fn reject_sensitive_config_keys(value: &Value) -> StorageResult<()> {
    match value {
        Value::Object(fields) => {
            for (key, value) in fields {
                let normalized = key
                    .chars()
                    .filter(char::is_ascii_alphanumeric)
                    .flat_map(char::to_lowercase)
                    .collect::<String>();
                if is_sensitive_config_key(&normalized) {
                    return Err(StorageError::InvalidExport { key: key.clone() });
                }
                reject_sensitive_config_keys(value)?;
            }
        }
        Value::Array(values) => {
            for value in values {
                reject_sensitive_config_keys(value)?;
            }
        }
        Value::Null | Value::Bool(_) | Value::Number(_) | Value::String(_) => {}
    }
    Ok(())
}

fn is_sensitive_config_key(normalized: &str) -> bool {
    normalized.contains("token")
        || normalized.contains("apikey")
        || normalized.contains("email")
        || normalized.contains("password")
        || normalized.contains("secret")
        || normalized.contains("credential")
        || normalized.contains("cache")
        || normalized.starts_with("todo")
}

pub fn validate_board_file(board: &BoardFile) -> StorageResult<()> {
    if board.version > BOARD_SCHEMA_VERSION {
        return Err(StorageError::FutureBoardVersion {
            found: board.version,
            supported: BOARD_SCHEMA_VERSION,
        });
    }
    if board.version != BOARD_SCHEMA_VERSION {
        return Err(StorageError::InvalidImport {
            reason: format!("지원하지 않는 board 스키마 버전 {}", board.version),
        });
    }
    if board.boards.is_empty() {
        return Err(StorageError::EmptyImport);
    }
    if board.board(&board.active_board_id).is_none() {
        return Err(StorageError::InvalidImport {
            reason: format!("활성 보드 {}를 찾을 수 없습니다", board.active_board_id),
        });
    }

    let mut board_ids = HashSet::new();
    let mut widget_ids = HashSet::new();
    for current_board in &board.boards {
        if current_board.id.trim().is_empty() {
            return Err(StorageError::InvalidImport {
                reason: "보드 ID가 비어 있습니다".to_string(),
            });
        }
        if !board_ids.insert(&current_board.id) {
            return Err(StorageError::DuplicateBoard {
                id: current_board.id.clone(),
            });
        }
        for widget in &current_board.widgets {
            if !widget_ids.insert(&widget.id) {
                return Err(StorageError::DuplicateWidget {
                    id: widget.id.clone(),
                });
            }
            let limit = widget.widget_type.instance_limit();
            let current = current_board.count_of(widget.widget_type);
            if current > limit {
                return Err(StorageError::WidgetLimitReached {
                    widget_type: widget.widget_type.to_string(),
                    limit,
                    current,
                });
            }
        }
    }
    Ok(())
}

/// Build the complete post-import file without touching disk or app state.
pub fn build_import_result<F>(
    current: &BoardFile,
    imported: &BoardFile,
    mode: BoardImportMode,
    mut new_id: F,
) -> StorageResult<BoardFile>
where
    F: FnMut() -> String,
{
    validate_board_file(imported)?;
    match mode {
        BoardImportMode::Replace => Ok(imported.clone()),
        BoardImportMode::Merge => {
            let mut result = current.clone();
            validate_board_file(&result)?;
            let mut names = result
                .boards
                .iter()
                .map(|board| board.name.clone())
                .collect::<HashSet<_>>();

            for source_board in &imported.boards {
                let board_id = new_id();
                let name = unique_import_name(&source_board.name, &mut names);
                let widgets = source_board
                    .widgets
                    .iter()
                    .cloned()
                    .map(|mut widget| {
                        widget.id = new_id();
                        widget
                    })
                    .collect();
                result.boards.push(Board {
                    id: board_id,
                    name,
                    locked: source_board.locked,
                    widgets,
                });
            }

            result.active_board_id = result
                .boards
                .get(current.boards.len())
                .map(|board| board.id.clone())
                .ok_or_else(|| StorageError::InvalidImport {
                    reason: "병합할 보드가 없습니다".to_string(),
                })?;
            result.version = BOARD_SCHEMA_VERSION;
            validate_board_file(&result)?;
            Ok(result)
        }
    }
}

fn unique_import_name(base: &str, names: &mut HashSet<String>) -> String {
    if names.insert(base.to_string()) {
        return base.to_string();
    }
    let mut suffix = 2;
    loop {
        let candidate = format!("{base} (가져옴 {suffix})");
        if names.insert(candidate.clone()) {
            return candidate;
        }
        suffix += 1;
    }
}

/// Reads and writes `board.json`.
///
/// Holds the parsed document in memory; mutations are in-memory until
/// [`save`](BoardStore::save) is called.
pub struct BoardStore {
    path: PathBuf,
    data: BoardFile,
}

impl BoardStore {
    /// Load from `<base_dir>/board.json`.
    ///
    /// `base_dir` is a parameter rather than a call to Tauri's `app_data_dir()`
    /// so tests can point at a tempdir. In the app this is
    /// `~/Library/Application Support/io.mypegboard.app/`.
    pub fn load(base_dir: &Path) -> StorageResult<(Self, crate::storage::migrate::LoadOutcome)> {
        let path = base_dir.join(BOARD_FILE);
        let Loaded { value, outcome } = load_or_default::<BoardFile>(&path, &MIGRATION_SET)?;

        let mut data = value;
        // A file with an empty `boards` array parses fine but leaves the app
        // with nothing to render. Restore the default board rather than making
        // every caller handle `Option<&Board>` being None.
        if data.boards.is_empty() {
            data.boards = BoardFile::default().boards;
        }

        Ok((Self { path, data }, outcome))
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    pub fn data(&self) -> &BoardFile {
        &self.data
    }

    pub fn data_mut(&mut self) -> &mut BoardFile {
        &mut self.data
    }

    /// Write to disk atomically.
    ///
    /// Synchronous and unconditional. **Callers must debounce** — see the
    /// module docs.
    pub fn save(&self) -> StorageResult<()> {
        write_json_atomic(&self.path, &self.data)
    }

    /// Validate and persist a complete replacement before swapping memory.
    pub fn replace_atomically(&mut self, next: BoardFile) -> StorageResult<()> {
        self.replace_atomically_with(next, write_json_atomic)
    }

    /// Testable seam for proving save-before-swap behavior without changing the
    /// production atomic writer or touching an app data directory.
    pub fn replace_atomically_with<F>(&mut self, next: BoardFile, writer: F) -> StorageResult<()>
    where
        F: FnOnce(&Path, &BoardFile) -> StorageResult<()>,
    {
        validate_board_file(&next)?;
        writer(&self.path, &next)?;
        self.data = next;
        Ok(())
    }

    /// Add a widget to a board, enforcing the DECISIONS 3 instance cap.
    ///
    /// Returns [`StorageError::WidgetLimitReached`] rather than panicking, so
    /// the UI can show "Jira 위젯은 최대 4개까지" instead of taking the app down.
    pub fn add_widget(&mut self, board_id: &str, widget: Widget) -> StorageResult<()> {
        // Duplicate ids would make removal and cache eviction ambiguous.
        if self
            .data
            .boards
            .iter()
            .any(|b| b.widgets.iter().any(|w| w.id == widget.id))
        {
            return Err(StorageError::DuplicateWidget { id: widget.id });
        }

        let board = self
            .data
            .board_mut(board_id)
            .ok_or_else(|| StorageError::BoardNotFound {
                id: board_id.to_string(),
            })?;

        let limit = widget.widget_type.instance_limit();
        let current = board.count_of(widget.widget_type);
        if current >= limit {
            return Err(StorageError::WidgetLimitReached {
                widget_type: widget.widget_type.to_string(),
                limit,
                current,
            });
        }

        board.widgets.push(widget);
        Ok(())
    }

    /// Add to the active board.
    pub fn add_widget_to_active(&mut self, widget: Widget) -> StorageResult<()> {
        let id = self
            .data
            .active_board()
            .map(|b| b.id.clone())
            .ok_or_else(|| StorageError::BoardNotFound {
                id: self.data.active_board_id.clone(),
            })?;
        self.add_widget(&id, widget)
    }

    /// Remove a widget by id from whichever board holds it.
    ///
    /// Returns the removed widget so the caller can evict its disk cache.
    pub fn remove_widget(&mut self, widget_id: &str) -> StorageResult<Widget> {
        for board in &mut self.data.boards {
            if let Some(pos) = board.widgets.iter().position(|w| w.id == widget_id) {
                return Ok(board.widgets.remove(pos));
            }
        }
        Err(StorageError::WidgetNotFound {
            id: widget_id.to_string(),
        })
    }

    pub fn widget(&self, widget_id: &str) -> Option<&Widget> {
        self.data
            .boards
            .iter()
            .flat_map(|b| b.widgets.iter())
            .find(|w| w.id == widget_id)
    }

    pub fn widget_mut(&mut self, widget_id: &str) -> Option<&mut Widget> {
        self.data
            .boards
            .iter_mut()
            .flat_map(|b| b.widgets.iter_mut())
            .find(|w| w.id == widget_id)
    }

    /// Apply new grid geometry after a drag or resize.
    ///
    /// This is the call that arrives dozens of times per second while dragging.
    /// It only touches memory; the debounced caller decides when to `save`.
    pub fn update_layout(&mut self, widget_id: &str, layout: WidgetLayout) -> StorageResult<()> {
        let widget = self
            .widget_mut(widget_id)
            .ok_or_else(|| StorageError::WidgetNotFound {
                id: widget_id.to_string(),
            })?;
        widget.layout = layout;
        Ok(())
    }

    /// Replace a widget's provider-specific config.
    pub fn update_config(&mut self, widget_id: &str, config: Value) -> StorageResult<()> {
        let widget = self
            .widget_mut(widget_id)
            .ok_or_else(|| StorageError::WidgetNotFound {
                id: widget_id.to_string(),
            })?;
        widget.config = config;
        Ok(())
    }

    /// Every widget id across all boards.
    ///
    /// Feeds [`crate::storage::cache::CacheStore::evict_orphans`].
    pub fn all_widget_ids(&self) -> Vec<String> {
        self.data
            .boards
            .iter()
            .flat_map(|b| b.widgets.iter())
            .map(|w| w.id.clone())
            .collect()
    }
}
