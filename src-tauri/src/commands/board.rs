//! 보드 저장/불러오기 IPC.
//!
//! 디바운스는 프론트가 한다 — 드래그 중 초당 수십 번 들어오는 이벤트를
//! 여기서 받으면 이미 늦다. 이 커맨드는 "지금 저장하라"만 수행한다.

use tauri::State;

use crate::state::AppState;
use crate::storage::board::BoardFile;

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
