//! my-pegboard — 페그보드처럼 위젯을 배치하는 개인용 데스크톱 대시보드
//!
//! 아키텍처: **Rust가 데이터의 주인이고, React는 표시만 한다.**
//! 모든 외부 API 호출·캐시·폴링·rate limit·재시도가 여기에 있으며,
//! 토큰은 절대 WebView로 내려가지 않는다.

pub mod commands;
pub mod logging;

use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri::Builder::default().plugin(tauri_plugin_opener::init());

    #[cfg(desktop)]
    let builder = builder.plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
        // 이미 실행 중이면 새 인스턴스를 띄우는 대신 기존 창을 앞으로.
        if let Some(window) = app.get_webview_window("main") {
            let _ = window.unminimize();
            let _ = window.set_focus();
        }
    }));

    builder
        .setup(|app| {
            let log_dir = app
                .path()
                .app_log_dir()
                .expect("로그 디렉토리 경로를 확인할 수 없습니다");
            logging::init(&log_dir);
            tracing::info!("my-pegboard 시작");
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![commands::app_info,])
        .run(tauri::generate_context!())
        .expect("Tauri 앱 실행에 실패했습니다");
}
