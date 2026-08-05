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
    let builder = tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        // 앨범 위젯의 폴더/파일 선택. **프론트는 이 플러그인을 부르지 않는다** —
        // Rust 커맨드가 다이얼로그·스코프 허용·스캔을 한 번에 한다.
        .plugin(tauri_plugin_dialog::init());

    // 업데이트는 앱 안에서 받아 설치한다 (DECISIONS 23장).
    // 서명 검증은 minisign 공개키(tauri.conf.json)로 하며, 개인키가 없으면
    // 빌드가 updater 번들을 **조용히 만들지 않는다** — verify-release.sh가 막는다.
    #[cfg(desktop)]
    let builder = builder
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init());

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
            commands::jira::jira_filters,
            commands::jira::jira_projects,
        commands::jira::jira_is_configured,
            commands::jira::jira_connection,
        commands::jira::jira_verify,
        commands::jira::jira_save_credentials,
        commands::jira::jira_fetch,
        commands::jira::jira_cached,
        commands::jira::jira_issue,
        commands::jira::jira_comments,
        commands::jira::jira_create_options,
        commands::jira::jira_createmeta,
        commands::jira::jira_myself,
        commands::jira::jira_create_issue,
        commands::github::github_presets,
        commands::github::github_is_configured,
        commands::github::github_save_token,
        commands::github::github_delete_token,
        commands::github::github_import_gh_token,
        commands::github::github_verify,
        commands::github::github_fetch,
        commands::github::github_cached,
        commands::github::github_repos,
        commands::todo::todo_list,
        commands::todo::todo_add,
        commands::todo::todo_set_done,
        commands::todo::todo_set_text,
        commands::todo::todo_remove,
        commands::todo::todo_carry_over,
            commands::todo::todo_reorder,
        commands::album::album_pick_folder,
        commands::album::album_pick_files,
        commands::album::album_rescan,
        commands::album::album_cached,
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

            // ★ 앨범 위젯의 `asset:` 스코프 복원.
            //
            // 런타임 스코프는 메모리에만 있어서 재시작하면 사라진다. board.json에
            // 저장된 경로는 그대로 남아 있으므로 위젯은 `<img src>`를 만들어 넣는데,
            // 스코프가 없으면 **에러 없이 깨진 이미지**가 된다. CSP는 `asset:`을
            // 허용하므로 콘솔에도 아무 말이 없다.
            //
            // 개발 중에는 위젯을 방금 만들어 런타임 허용이 살아 있으므로 절대
            // 재현되지 않는다. 그래서 테스트가 있다
            // (`providers/album/tests/mod.rs`의 restore_covers_every_path…).
            {
                let board = state
                    .board
                    .lock()
                    .map_err(|_| "보드 상태 잠금에 실패했습니다")?;
                providers::album::restore_scopes(&app.asset_protocol_scope(), board.data());
            }

            app.manage(state);

            tracing::info!("my-pegboard 시작");
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("Tauri 앱 실행에 실패했습니다");
}
