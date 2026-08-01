//! Todo IPC 커맨드.
//!
//! # 왜 모든 커맨드가 전체 목록을 돌려주나
//!
//! Todo는 **원본이 딴 데 없는 유일본 데이터**다(DECISIONS 13). 프론트가 부분
//! 갱신을 하다 한 번 어긋나면 그 어긋난 상태가 다음 저장에 그대로 실린다.
//! 매번 전체를 돌려주면 프론트 스토어가 항상 디스크와 일치한다는 보장이 생긴다.
//!
//! 비용은 무시할 만하다 — 하루 몇 개씩 1년을 써도 수백 건이고, IPC는 로컬이다.
//!
//! # 왜 통짜 `todo_save(items)`가 아닌가
//!
//! 그 반대 방향이 위험하다. 프론트가 가진 배열을 통째로 덮어쓰면 프론트 상태가
//! 비어 있던 순간에 저장이 한 번 나가는 것만으로 전부 사라진다. `.bak` 1세대는
//! 그런 사고를 두 번 겪으면 같이 오염된다.
//!
//! # 저장 시점
//!
//! `TodoStore`는 일부러 저장을 분리해 뒀다(`todos.rs` — "The caller persists").
//! 여기서 매 변경마다 `save()`를 부른다. 디스크 쓰기는 수 ms이고, 사용자가
//! 체크한 것이 저장됐는지 의심하게 만드는 편이 훨씬 나쁘다.

use chrono::NaiveDate;
use serde::Serialize;
use tauri::State;

use crate::state::AppState;
use crate::storage::todos::{CarryOverReport, TodoItem};

/// 이월 결과 + 갱신된 전체 목록.
///
/// 둘을 함께 주는 이유: 프론트가 목록을 다시 요청하는 왕복을 없애고,
/// 배너("3개를 가져왔습니다")와 목록이 **같은 시점의 상태**임을 보장한다.
#[derive(Debug, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct CarryOverResult {
    pub items: Vec<TodoItem>,
    pub report: CarryOverReport,
}

/// 되돌리기 결과. `restored`가 report의 개수보다 적을 수 있다 —
/// 이월 뒤에 사용자가 지우거나 옮긴 항목은 건드리지 않는다.
#[derive(Debug, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct UndoCarryResult {
    pub items: Vec<TodoItem>,
    pub restored: usize,
}

/// 잠금 → 저장 → 전체 목록. 모든 변경 커맨드가 같은 꼬리를 갖는다.
macro_rules! mutate {
    ($state:expr, |$store:ident| $body:expr) => {{
        let mut $store = $state.todos.lock().map_err(|_| "상태 잠금 실패".to_string())?;
        let result = $body;
        $store
            .save()
            .map_err(|e| format!("할 일을 저장할 수 없습니다: {e}"))?;
        result
    }};
}

#[tauri::command]
#[specta::specta]
pub fn todo_list(state: State<'_, AppState>) -> Result<Vec<TodoItem>, String> {
    let store = state.todos.lock().map_err(|_| "상태 잠금 실패")?;
    Ok(store.items().to_vec())
}

/// 항목 추가. id는 **Rust가 만든다** — 생성 규칙이 한 곳에 있어야 한다.
#[tauri::command]
#[specta::specta]
pub fn todo_add(
    state: State<'_, AppState>,
    text: String,
    date: NaiveDate,
) -> Result<Vec<TodoItem>, String> {
    // 빈 항목은 목록에 쓰레기만 남긴다. 프론트도 막지만 여기서도 거절한다.
    let text = normalize_text(&text)?;

    let item = TodoItem::new(uuid::Uuid::new_v4().to_string(), text, date);
    let items = mutate!(state, |store| {
        store.add(item);
        store.items().to_vec()
    });
    Ok(items)
}

#[tauri::command]
#[specta::specta]
pub fn todo_set_done(
    state: State<'_, AppState>,
    id: String,
    done: bool,
) -> Result<Vec<TodoItem>, String> {
    let items = mutate!(state, |store| {
        store
            .set_done(&id, done)
            .map_err(|e| format!("항목을 찾을 수 없습니다: {e}"))?;
        store.items().to_vec()
    });
    Ok(items)
}

/// 텍스트 수정. 프론트는 Enter/blur에서만 부른다 — 글자마다 디스크를 때리지 않는다.
#[tauri::command]
#[specta::specta]
pub fn todo_set_text(
    state: State<'_, AppState>,
    id: String,
    text: String,
) -> Result<Vec<TodoItem>, String> {
    // 빈 문자열로 지우는 경로를 만들지 않는다. 삭제는 todo_remove로 명시적으로.
    let text = normalize_text(&text)?;

    let items = mutate!(state, |store| {
        let item = store
            .get_mut(&id)
            .ok_or_else(|| format!("항목을 찾을 수 없습니다: {id}"))?;
        item.text = text;
        store.items().to_vec()
    });
    Ok(items)
}

/// 삭제. **사용자가 명시적으로 요청했을 때만** 호출된다 (DECISIONS 13: 자동 삭제 금지).
#[tauri::command]
#[specta::specta]
pub fn todo_remove(state: State<'_, AppState>, id: String) -> Result<Vec<TodoItem>, String> {
    let items = mutate!(state, |store| {
        store
            .remove(&id)
            .map_err(|e| format!("항목을 찾을 수 없습니다: {e}"))?;
        store.items().to_vec()
    });
    Ok(items)
}

/// 과거의 미완료 항목을 `today`로 옮긴다.
///
/// `today`를 프론트가 넘기는 이유: 자정 넘김 감지와 "과거를 보는 중에는 미룬다"는
/// 판단이 전부 UI 조건이다(`todos.rs`의 `carry_over` 주석). Rust는 시계를 모른다.
///
/// 멱등이다 — 이월 직후 다시 불러도 빈 report가 온다. 앱 시작과 자정 감지가
/// 몇 초 차이로 겹쳐도 안전한 이유다.
#[tauri::command]
#[specta::specta]
pub fn todo_carry_over(
    state: State<'_, AppState>,
    today: NaiveDate,
) -> Result<CarryOverResult, String> {
    let mut store = state.todos.lock().map_err(|_| "상태 잠금 실패")?;
    let report = store.carry_over(today);

    // 옮긴 게 없으면 디스크를 건드리지 않는다. 앱 시작마다 무의미한 쓰기와
    // .bak 회전이 일어나면 백업 세대가 헛돈다.
    if !report.is_empty() {
        store
            .save()
            .map_err(|e| format!("할 일을 저장할 수 없습니다: {e}"))?;
        tracing::info!(
            count = report.count(),
            days = report.source_dates.len(),
            "할 일 이월"
        );
    }

    Ok(CarryOverResult {
        items: store.items().to_vec(),
        report,
    })
}

#[tauri::command]
#[specta::specta]
pub fn todo_undo_carry_over(
    state: State<'_, AppState>,
    report: CarryOverReport,
) -> Result<UndoCarryResult, String> {
    let mut store = state.todos.lock().map_err(|_| "상태 잠금 실패")?;
    let restored = store.undo_carry_over(&report);

    if restored > 0 {
        store
            .save()
            .map_err(|e| format!("할 일을 저장할 수 없습니다: {e}"))?;
        tracing::info!(restored, "이월 되돌림");
    }

    Ok(UndoCarryResult {
        items: store.items().to_vec(),
        restored,
    })
}

/// 저장 전 텍스트 정규화. 커맨드 두 개(`todo_add`, `todo_set_text`)가 공유한다.
///
/// 순수 함수로 뽑은 이유: 커맨드 본체는 `State<AppState>`를 받아 실제 Tauri 앱
/// 없이는 부를 수 없다. 검증 규칙만 떼어내면 네트워크도 앱도 없이 테스트된다.
/// `TodoStore` 자체는 `storage/tests/todos_tests.rs`가 이미 덮고 있으므로
/// 여기서 다시 검증하지 않는다.
fn normalize_text(raw: &str) -> Result<String, String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Err("할 일 내용이 비어 있습니다".to_string());
    }
    Ok(trimmed.to_string())
}

#[cfg(test)]
mod normalize_tests {
    use super::normalize_text;

    #[test]
    fn trims_surrounding_whitespace() {
        assert_eq!(normalize_text("  배포 스크립트  ").unwrap(), "배포 스크립트");
    }

    #[test]
    fn rejects_empty() {
        assert!(normalize_text("").is_err());
    }

    /// 공백만 입력하고 Enter를 누르는 일은 실제로 자주 일어난다.
    /// 통과시키면 목록에 보이지 않는 빈 행이 남는다.
    #[test]
    fn rejects_whitespace_only() {
        for raw in ["   ", "\t", "\n", " \t\n "] {
            assert!(normalize_text(raw).is_err(), "{raw:?}가 통과했다");
        }
    }

    /// 내부 공백과 줄바꿈은 사용자가 쓴 그대로 둔다 — 앞뒤만 다듬는다.
    #[test]
    fn keeps_inner_content_untouched() {
        assert_eq!(normalize_text(" a  b ").unwrap(), "a  b");
    }
}
