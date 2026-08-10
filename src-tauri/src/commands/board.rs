//! 보드 저장/불러오기 IPC.
//!
//! 디바운스는 프론트가 한다 — 드래그 중 초당 수십 번 들어오는 이벤트를
//! 여기서 받으면 이미 늦다. 이 커맨드는 "지금 저장하라"만 수행한다.

use std::fs;

use chrono::{NaiveDate, Utc};
use tauri::{AppHandle, Manager, State};
use tauri_plugin_dialog::DialogExt;
use uuid::Uuid;

use crate::state::AppState;
use crate::storage::atomic::write_json_atomic;
use crate::storage::board::{
    build_import_result, validate_export, validate_import, BoardExportFile, BoardFile,
    BoardImportApplyResult, BoardImportCandidate, BoardImportMode, BoardImportPreview,
    BoardImportWidgetCount,
};
use crate::storage::error::StorageResult;

#[tauri::command]
#[specta::specta]
pub fn board_load(state: State<'_, AppState>) -> Result<BoardFile, String> {
    let store = state.board.lock().map_err(|_| "상태 잠금 실패")?;
    Ok(store.data().clone())
}

#[tauri::command]
#[specta::specta]
pub fn board_save(state: State<'_, AppState>, file: BoardFile) -> Result<(), String> {
    let mut store = state.board.lock().map_err(|_| "상태 잠금 실패")?;
    *store.data_mut() = file;
    store
        .save()
        .map_err(|e| format!("보드를 저장할 수 없습니다: {e}"))?;

    // 사라진 위젯의 캐시 파일을 정리한다. 안 하면 디스크에 영원히 남는다.
    let ids = store.all_widget_ids();
    if let Ok(cache) = state.cache.lock() {
        if let Ok(removed) = cache.evict_orphans(&ids) {
            if !removed.is_empty() {
                tracing::info!(count = removed.len(), "고아 캐시 정리");
            }
        }
    }
    Ok(())
}

pub fn default_export_filename(date: NaiveDate) -> String {
    format!("my-pegboard-board-settings-{date}.json")
}

/// Dialog-independent JSON boundary. `None` represents a cancelled picker.
pub fn preview_from_json(
    selected_json: Option<&str>,
) -> Result<Option<BoardImportCandidate>, String> {
    let Some(selected_json) = selected_json else {
        return Ok(None);
    };
    let file: BoardExportFile = serde_json::from_str(selected_json)
        .map_err(|e| format!("가져오기 파일을 읽을 수 없습니다: {e}"))?;
    validate_import(&file).map_err(|e| format!("가져오기 파일을 검증할 수 없습니다: {e}"))?;
    let preview = build_preview(&file).map_err(|e| e.to_string())?;
    Ok(Some(BoardImportCandidate { file, preview }))
}

fn build_preview(file: &BoardExportFile) -> StorageResult<BoardImportPreview> {
    validate_import(file)?;
    let mut counts = std::collections::BTreeMap::<String, usize>::new();
    let widget_count = file
        .board
        .boards
        .iter()
        .flat_map(|board| board.widgets.iter())
        .inspect(|widget| {
            *counts.entry(widget.widget_type.to_string()).or_default() += 1;
        })
        .count();

    let widget_counts = counts
        .into_iter()
        .map(|(widget_type, count)| BoardImportWidgetCount { widget_type, count })
        .collect();

    Ok(BoardImportPreview {
        board_count: file.board.boards.len(),
        widget_count,
        widget_counts,
        format_version: file.format_version,
        board_schema_version: file.board.version,
        album_path_warnings: crate::providers::album::missing_path_warnings(&file.board),
    })
}

pub fn apply_board_import(
    current: &BoardFile,
    candidate: &BoardExportFile,
    mode: BoardImportMode,
) -> Result<BoardFile, String> {
    validate_import(candidate).map_err(|e| format!("가져오기 파일을 검증할 수 없습니다: {e}"))?;
    build_import_result(current, &candidate.board, mode, || {
        Uuid::new_v4().to_string()
    })
    .map_err(|e| format!("보드를 가져올 수 없습니다: {e}"))
}

#[tauri::command]
#[specta::specta]
pub async fn board_export(
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<Option<String>, String> {
    let now = Utc::now();
    let Some(selected) = app
        .dialog()
        .file()
        .set_title("보드 설정 내보내기")
        .set_file_name(default_export_filename(now.date_naive()))
        .add_filter("JSON", &["json"])
        .blocking_save_file()
    else {
        return Ok(None);
    };
    let path = selected
        .into_path()
        .map_err(|e| format!("내보내기 경로를 해석할 수 없습니다: {e}"))?;
    let board = {
        let store = state.board.lock().map_err(|_| "상태 잠금 실패")?;
        store.data().clone()
    };
    validate_export(&board).map_err(|e| format!("보드 설정을 내보낼 수 없습니다: {e}"))?;
    let file = BoardExportFile::new(board, now.to_rfc3339());
    write_json_atomic(&path, &file).map_err(|e| format!("보드 설정을 내보낼 수 없습니다: {e}"))?;
    Ok(Some(path.to_string_lossy().into_owned()))
}

#[tauri::command]
#[specta::specta]
pub async fn board_import_preview(app: AppHandle) -> Result<Option<BoardImportCandidate>, String> {
    let Some(selected) = app
        .dialog()
        .file()
        .set_title("보드 설정 가져오기")
        .add_filter("JSON", &["json"])
        .blocking_pick_file()
    else {
        return Ok(None);
    };
    let path = selected
        .into_path()
        .map_err(|e| format!("가져오기 경로를 해석할 수 없습니다: {e}"))?;
    let json = fs::read_to_string(&path)
        .map_err(|e| format!("가져오기 파일을 읽을 수 없습니다 ({}): {e}", path.display()))?;
    preview_from_json(Some(&json))
}

#[tauri::command]
#[specta::specta]
pub fn board_import_apply(
    app: AppHandle,
    state: State<'_, AppState>,
    candidate: BoardExportFile,
    mode: BoardImportMode,
) -> Result<BoardImportApplyResult, String> {
    let mut store = state.board.lock().map_err(|_| "상태 잠금 실패")?;
    let next = apply_board_import(store.data(), &candidate, mode)?;

    let transition = crate::providers::album::plan_scope_transition(store.data(), &next);
    let scope = app.asset_protocol_scope();
    crate::providers::album::allow_scope_paths(&scope, &transition)
        .map_err(|e| format!("앨범 경로 권한을 적용할 수 없습니다: {e}"))?;

    store
        .replace_atomically(next.clone())
        .map_err(|e| format!("보드를 저장할 수 없습니다: {e}"))?;

    // Tauri's Scope has no remove-allowed-pattern API. Its forbid_* methods add
    // deny patterns that take precedence over allows, which is the supported
    // runtime revocation mechanism for paths no longer in the replacement.
    if let Err(error) = crate::providers::album::revoke_scope_paths(&scope, &transition) {
        tracing::warn!(error = %error, "앨범 경로 스코프를 완전히 철회하지 못했습니다");
    }

    let ids = store.all_widget_ids();
    let orphan_cache_cleanup_warning = match state.cache.lock() {
        Ok(cache) => match cache.evict_orphans(&ids) {
            Ok(removed) => {
                if !removed.is_empty() {
                    tracing::info!(count = removed.len(), "고아 캐시 정리");
                }
                None
            }
            Err(error) => Some(format!(
                "보드는 저장됐지만 고아 캐시를 정리하지 못했습니다: {error}"
            )),
        },
        Err(_) => Some("보드는 저장됐지만 고아 캐시 정리를 위해 상태를 잠글 수 없습니다".into()),
    };

    Ok(BoardImportApplyResult {
        board: next,
        orphan_cache_cleanup_warning,
    })
}

#[cfg(test)]
mod tests {
    use chrono::NaiveDate;
    use serde_json::json;

    use super::*;
    use crate::storage::board::{
        Board, BoardExportFile, BoardFile, BoardImportMode, Widget, WidgetLayout, WidgetType,
        BOARD_SCHEMA_VERSION, DEFAULT_BOARD_ID,
    };

    fn test_file() -> BoardExportFile {
        BoardExportFile::new(
            BoardFile {
                version: BOARD_SCHEMA_VERSION,
                active_board_id: DEFAULT_BOARD_ID.into(),
                boards: vec![Board {
                    id: DEFAULT_BOARD_ID.into(),
                    name: "Board".into(),
                    widgets: vec![Widget {
                        id: "w1".into(),
                        widget_type: WidgetType::Album,
                        layout: WidgetLayout {
                            x: 0,
                            y: 0,
                            w: 4,
                            h: 3,
                        },
                        config: json!({
                            "source": {"kind": "folder", "path": "/missing/photos"}
                        }),
                    }],
                }],
            },
            "2026-08-10T00:00:00Z".into(),
        )
    }

    #[test]
    fn default_export_filename_is_stable_for_a_calendar_date() {
        assert_eq!(
            default_export_filename(NaiveDate::from_ymd_opt(2026, 8, 10).unwrap()),
            "my-pegboard-board-settings-2026-08-10.json"
        );
    }

    #[test]
    fn cancelled_import_selection_returns_none_without_parsing_or_side_effects() {
        assert_eq!(preview_from_json(None).unwrap(), None);
    }

    #[test]
    fn preview_summarizes_counts_versions_and_album_warnings() {
        let candidate = preview_from_json(Some(&serde_json::to_string(&test_file()).unwrap()))
            .unwrap()
            .unwrap();

        assert_eq!(candidate.preview.board_count, 1);
        assert_eq!(candidate.preview.widget_count, 1);
        assert_eq!(candidate.preview.format_version, 1);
        assert_eq!(candidate.preview.board_schema_version, 1);
        assert_eq!(candidate.preview.widget_counts[0].widget_type, "album");
        assert_eq!(candidate.preview.widget_counts[0].count, 1);
        assert_eq!(
            candidate.preview.album_path_warnings[0].path,
            "/missing/photos"
        );
    }

    #[test]
    fn replace_apply_returns_the_exact_board_file_that_will_be_persisted() {
        let candidate = test_file();
        let result =
            apply_board_import(&BoardFile::default(), &candidate, BoardImportMode::Replace)
                .unwrap();
        assert_eq!(result, candidate.board);
    }
}
