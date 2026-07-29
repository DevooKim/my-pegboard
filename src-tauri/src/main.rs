// Windows 릴리스 빌드에서 콘솔 창이 뜨지 않도록 (macOS 전용이지만 관례상 유지)
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    my_pegboard_lib::run()
}
