//! TypeScript 바인딩 생성.
//!
//! 앱 실행 시점이 아니라 **테스트에서** 생성한다. 실행 파일은 작업 디렉토리가
//! 어디일지 알 수 없어 상대 경로가 조용히 빗나가지만, `cargo test`는 항상
//! 크레이트 루트에서 돈다. 생성물이 커밋된 것과 다르면 테스트가 실패하므로
//! Rust를 고치고 바인딩 갱신을 잊는 일이 막힌다.

#[cfg(test)]
mod tests {
    use crate::commands;
    use tauri_specta::{collect_commands, Builder};

    #[test]
    fn typescript_bindings_are_up_to_date() {
        let builder = Builder::<tauri::Wry>::new().commands(collect_commands![
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
            .export(
                specta_typescript::Typescript::default()
                    .bigint(specta_typescript::BigIntExportBehavior::Number)
                    // 생성물에는 미사용 심볼이 섞여 있고 noUnusedLocals에 걸린다.
                    // 우리가 고칠 수 없는 파일이므로 생성 단계에서 검사를 끈다.
                    .header("// @ts-nocheck\n// tauri-specta 생성물. 손으로 고치지 말 것 — cargo test가 다시 만든다."),
                "../src/ipc/bindings.ts",
            )
            .expect("TypeScript 바인딩을 생성할 수 없습니다");
    }
}
