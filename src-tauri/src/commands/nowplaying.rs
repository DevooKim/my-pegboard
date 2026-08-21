//! "지금 재생 중" IPC 커맨드.
//!
//! 다른 위젯의 `*_fetch`/`*_cached` 쌍이 여기 없다 — 이 위젯은 폴링도 디스크
//! 캐시도 없다(providers/nowplaying 주석). 대신 구독/해지가 있다:
//! 마운트가 구독이고, 데이터는 `NowPlayingPush` 이벤트로 밀려온다.
//! 커맨드는 수명 관리(구독·재연결)와 쓰기(재생 제어·앱 열기)만 한다.

use tauri::AppHandle;

use crate::providers::nowplaying::{self, NowPlayingCommand, NowPlayingPush};

// 이 커맨드들이 전부 `async`인 이유: 동기 커맨드는 **메인 스레드**에서 돌고,
// 어댑터 프로세스 spawn(`tokio::process`)은 tokio 런타임 컨텍스트가 필요하다.
// 동기로 두면 "no reactor running" panic으로 앱이 통째로 죽는다 —
// 실제로 겪었다 (2026-08-22 크래시, 위젯 추가 즉시 SIGABRT).

/// 위젯 마운트. 구독을 등록하고 현재 상태를 즉시 돌려준다 —
/// 첫 이벤트를 기다리며 빈 화면을 보이지 않기 위한 것.
#[tauri::command]
#[specta::specta]
pub async fn nowplaying_subscribe(app: AppHandle) -> Result<NowPlayingPush, String> {
    nowplaying::subscribe(&app)
}

/// 위젯 언마운트. 구독자가 0이 되면 어댑터 프로세스를 내린다 —
/// "언마운트 = 폴링 중단" 규칙의 이벤트판.
#[tauri::command]
#[specta::specta]
pub async fn nowplaying_unsubscribe(app: AppHandle) -> Result<(), String> {
    nowplaying::unsubscribe(&app)
}

/// 재연결. 새로고침 버튼이 부른다 — 스트림이 죽었을 때의 복구 경로.
#[tauri::command]
#[specta::specta]
pub async fn nowplaying_reconnect(app: AppHandle) -> Result<NowPlayingPush, String> {
    nowplaying::reconnect(&app)
}

/// 재생 제어. **자동 재시도 없음** — "다음 곡"은 멱등이 아니다.
#[tauri::command]
#[specta::specta]
pub async fn nowplaying_send(app: AppHandle, command: NowPlayingCommand) -> Result<(), String> {
    nowplaying::send_command(&app, command).await
}

/// 재생 중인 앱을 앞으로. 앨범아트/곡명 클릭의 목적지다 —
/// "더 보고 싶으면 원본 앱으로"라는 GitHub 위젯과 같은 패턴.
#[tauri::command]
#[specta::specta]
pub async fn nowplaying_open_app(bundle_id: String) -> Result<(), String> {
    nowplaying::open_app(&bundle_id).await
}
