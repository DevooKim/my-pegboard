//! IPC 커맨드.
//!
//! 프론트엔드가 Rust에 접근하는 유일한 경로. 모든 외부 API 호출이 여기를 거치며,
//! 토큰은 이 경계를 넘어가지 않는다.

use serde::Serialize;

#[derive(Debug, Serialize, specta::Type)]
pub struct AppInfo {
    pub version: String,
    /// 유휴 메모리 목표 150MB 대비 실측치를 설정창에 노출하기 위한 자리.
    /// 실제 측정은 후속 작업.
    pub memory_bytes: Option<u64>,
}

#[tauri::command]
#[specta::specta]
pub fn app_info() -> AppInfo {
    AppInfo {
        version: env!("CARGO_PKG_VERSION").to_string(),
        memory_bytes: None,
    }
}
