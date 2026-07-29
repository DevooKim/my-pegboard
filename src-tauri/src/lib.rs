//! my-pegboard — 페그보드처럼 위젯을 배치하는 개인용 데스크톱 대시보드
//!
//! 아키텍처: **Rust가 데이터의 주인이고, React는 표시만 한다.**
//! 모든 외부 API 호출·캐시·폴링·rate limit·재시도가 여기에 있으며,
//! 토큰은 절대 WebView로 내려가지 않는다.

pub mod commands;
pub mod logging;
pub mod providers;
pub mod state;
mod bindings_export;
pub mod secrets;
pub mod storage;

use tauri::Manager;
use tauri_specta::{collect_commands, Builder as SpectaBuilder};

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

    let specta = SpectaBuilder::<tauri::Wry>::new().commands(collect_commands![
        commands::app_info,
        commands::jira::jira_presets,
            commands::jira::jira_projects,
        commands::jira::jira_is_configured,
            commands::jira::jira_connection,
        commands::jira::jira_verify,
        commands::jira::jira_save_credentials,
        commands::jira::jira_fetch,
        commands::jira::jira_cached,
            commands::board::board_load,
            commands::board::board_save,
    ]);


    builder
        .invoke_handler(specta.invoke_handler())
        .setup(|app| {
            let log_dir = app
                .path()
                .app_log_dir()
                .expect("로그 디렉토리 경로를 확인할 수 없습니다");
            logging::init(&log_dir);

            let data_dir = app
                .path()
                .app_data_dir()
                .expect("앱 데이터 디렉토리 경로를 확인할 수 없습니다");
            std::fs::create_dir_all(&data_dir).ok();
            let state = state::AppState::new(data_dir)?;
            app.manage(state);

            tracing::info!("my-pegboard 시작");
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("Tauri 앱 실행에 실패했습니다");
}
