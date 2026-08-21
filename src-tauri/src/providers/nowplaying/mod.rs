//! "지금 재생 중" provider — macOS 시스템 Now Playing을 읽고 제어한다.
//!
//! # 데이터 원천
//!
//! 다른 provider와 달리 외부 API가 아니라 **로컬 서브프로세스**다.
//! macOS 15.4부터 Apple이 MediaRemote 프레임워크를 막아서, 엔타이틀먼트가 있는
//! 시스템 바이너리(`/usr/bin/perl`)로 헬퍼 프레임워크를 로드하는
//! mediaremote-adapter(vendor/, BSD-3)를 스트림 모드로 띄운다.
//!
//! ```text
//! [perl + MediaRemoteAdapter.framework] --stdout JSON--> [리더 태스크] --emit--> [위젯]
//! ```
//!
//! # 폴링이 없다
//!
//! 어댑터가 변화를 실시간으로 push하므로 `setInterval`형 갱신이 없다.
//! CLAUDE.md의 "Rust가 이벤트를 push → 해당 위젯만 리렌더"를 처음 실제로 쓰는 곳.
//!
//! # 캐시가 없다 (대전제 1의 명시적 예외)
//!
//! "지금 재생 중"은 지난 데이터를 그리면 거짓말이 되는 유일한 위젯이다.
//! 어제 듣던 곡을 캐시로 그려 놓으면 그건 "지금"이 아니다 (DECISIONS 27).
//!
//! # 구독 수명
//!
//! 위젯 마운트가 구독, 언마운트가 해지다. 구독자가 0이 되면 프로세스를 내린다 —
//! "언마운트 = 폴링 중단"이라는 기존 규칙의 이벤트판. `kill_on_drop`이라
//! child를 버리는 것이 곧 종료다.
//!
//! # 실패는 push로 드러난다
//!
//! Apple이 다음 업데이트에서 이 기법을 막으면 프로세스가 죽거나 첫 페이로드가
//! 안 온다. 그때 error를 담은 push를 보내 위젯 본문에 에러가 뜬다 —
//! 실측(2026-08-22)으로 스트림은 시작 직후 빈 페이로드라도 반드시 한 줄을
//! 내보내므로, "첫 줄 타임아웃 = 고장"과 "빈 페이로드 = 재생 없음"이 구분된다.

pub mod adapter;
pub mod types;

pub use types::{NowPlayingCommand, NowPlayingPush, NowPlayingState};

use std::path::PathBuf;
use std::process::Stdio;
use std::time::Duration;

use serde_json::{Map, Value};
use tauri::path::BaseDirectory;
use tauri::{AppHandle, Manager};
use tauri_specta::Event;
use tokio::io::{AsyncBufReadExt, BufReader};

use crate::state::AppState;

/// 실측상 첫 페이로드는 즉시 온다. 10초는 "느린 기기 + 첫 dlopen"까지 봐준 값.
const FIRST_LINE_TIMEOUT: Duration = Duration::from_secs(10);

/// 이벤트 폭주 방지. 어댑터가 이 시간 안의 변경을 한 번으로 합쳐 준다.
const STREAM_DEBOUNCE_MS: u32 = 150;

/// 지금 재생 중 런타임. `AppState.nowplaying`에 산다.
#[derive(Default)]
pub struct NowPlayingRuntime {
    /// 마운트된 위젯 수. 0이 되면 프로세스를 내린다.
    subscribers: usize,
    /// worker 세대. 죽어가는 옛 worker의 늦은 push가 새 세대의 상태를 덮지
    /// 않게 한다 — 재연결 직후가 그 경합이 실제로 나는 순간이다.
    generation: u64,
    /// `kill_on_drop(true)`로 띄운 어댑터 프로세스. None으로 만들면 죽는다.
    child: Option<tokio::process::Child>,
    /// 마지막 push (앨범아트 **항상 포함**). 새 구독자의 초기 화면이 된다.
    last: Option<NowPlayingPush>,
    /// 직전에 emit한 앨범아트 토큰. 같은 아트를 IPC로 반복 전송하지 않기 위한 것.
    last_pushed_artwork_token: Option<u32>,
}

/// 위젯 마운트. 구독을 늘리고 (필요하면) 어댑터를 띄우고, 현재 상태를 돌려준다.
pub fn subscribe(app: &AppHandle) -> Result<NowPlayingPush, String> {
    let state = app.state::<AppState>();
    let mut rt = state.nowplaying.lock().map_err(|_| "상태 잠금 실패")?;
    rt.subscribers += 1;
    if let Err(e) = ensure_worker_locked(app, &mut rt) {
        // 시작 자체가 실패해도 조용히 넘어가지 않는다 — 에러를 상태로 남겨
        // 구독자(지금 것 포함)가 화면에 그리게 한다.
        let push = NowPlayingPush::failed(e);
        rt.last = Some(push.clone());
        return Ok(push);
    }
    Ok(rt.last.clone().unwrap_or_else(NowPlayingPush::empty))
}

/// 위젯 언마운트. 구독자가 0이 되면 프로세스를 내린다.
pub fn unsubscribe(app: &AppHandle) -> Result<(), String> {
    let state = app.state::<AppState>();
    let mut rt = state.nowplaying.lock().map_err(|_| "상태 잠금 실패")?;
    rt.subscribers = rt.subscribers.saturating_sub(1);
    if rt.subscribers == 0 {
        stop_worker_locked(&mut rt);
    }
    Ok(())
}

/// 재연결. 새로고침 버튼이 부른다 — 스트림이 죽었거나 이상할 때의 복구 수단.
pub fn reconnect(app: &AppHandle) -> Result<NowPlayingPush, String> {
    let state = app.state::<AppState>();
    let mut rt = state.nowplaying.lock().map_err(|_| "상태 잠금 실패")?;
    stop_worker_locked(&mut rt);
    if rt.subscribers > 0 {
        ensure_worker_locked(app, &mut rt)?;
    }
    Ok(rt.last.clone().unwrap_or_else(NowPlayingPush::empty))
}

/// 재생 제어 한 번. 어댑터를 one-shot으로 실행한다 (~수십 ms).
///
/// **자동 재시도 금지.** "다음 곡"은 멱등이 아니다 — 두 번 나가면 두 곡을
/// 건너뛴다 (Jira transition과 같은 규칙).
pub async fn send_command(app: &AppHandle, command: NowPlayingCommand) -> Result<(), String> {
    let (script, framework) = adapter_paths(app)?;
    let output = tokio::process::Command::new("/usr/bin/perl")
        .arg(&script)
        .arg(&framework)
        .arg("send")
        .arg(command.adapter_id().to_string())
        .stdin(Stdio::null())
        .output()
        .await
        .map_err(|e| format!("재생 제어 프로세스를 실행할 수 없습니다: {e}"))?;
    if output.status.success() {
        Ok(())
    } else {
        let stderr = String::from_utf8_lossy(&output.stderr);
        Err(format!("재생 제어에 실패했습니다: {}", stderr.trim()))
    }
}

/// 재생 중인 앱을 앞으로 가져온다 (`open -b <bundle id>`).
pub async fn open_app(bundle_id: &str) -> Result<(), String> {
    if !valid_bundle_id(bundle_id) {
        return Err(format!("올바르지 않은 번들 id입니다: {bundle_id}"));
    }
    let status = tokio::process::Command::new("/usr/bin/open")
        .arg("-b")
        .arg(bundle_id)
        .status()
        .await
        .map_err(|e| format!("앱을 열 수 없습니다: {e}"))?;
    if status.success() {
        Ok(())
    } else {
        Err(format!("앱을 열 수 없습니다: {bundle_id}"))
    }
}

/// 번들 id 검증. 인자를 셸에 넘기지 않으므로(exec 직접 호출) 주입은 원리적으로
/// 없지만, 이상한 값으로 `open`이 엉뚱한 것을 여는 일은 막는다.
pub fn valid_bundle_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 255
        && id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '.' || c == '-')
}

// ---------------------------------------------------------------------------
// 내부
// ---------------------------------------------------------------------------

fn stop_worker_locked(rt: &mut NowPlayingRuntime) {
    rt.generation += 1;
    // kill_on_drop(true) → drop이 곧 SIGKILL. 리더 태스크는 EOF를 만나지만
    // 세대가 바뀌었으므로 에러를 push하지 않고 조용히 끝난다.
    rt.child = None;
    rt.last = None;
    rt.last_pushed_artwork_token = None;
}

fn ensure_worker_locked(app: &AppHandle, rt: &mut NowPlayingRuntime) -> Result<(), String> {
    if rt.child.is_some() {
        return Ok(());
    }

    let (script, framework) = adapter_paths(app)?;
    let mut child = tokio::process::Command::new("/usr/bin/perl")
        .arg(&script)
        .arg(&framework)
        .arg("stream")
        .arg("--micros")
        .arg(format!("--debounce={STREAM_DEBOUNCE_MS}"))
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .kill_on_drop(true)
        .spawn()
        .map_err(|e| format!("미디어 정보 프로세스를 시작할 수 없습니다: {e}"))?;
    let stdout = child
        .stdout
        .take()
        .ok_or("미디어 정보 프로세스의 출력을 열 수 없습니다")?;

    rt.child = Some(child);
    let generation = rt.generation;
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        read_stream(app, generation, stdout).await;
    });
    Ok(())
}

async fn read_stream(app: AppHandle, generation: u64, stdout: tokio::process::ChildStdout) {
    let mut lines = BufReader::new(stdout).lines();
    let mut merged: Map<String, Value> = Map::new();
    let mut got_first_line = false;

    loop {
        let next = if got_first_line {
            lines.next_line().await
        } else {
            // 실측: 정상이면 첫 페이로드가 즉시 온다. 타임아웃 = 어댑터 고장.
            // 이 판정이 없으면 고장이 "재생 없음"과 똑같이 보인다 — 조용한 실패.
            match tokio::time::timeout(FIRST_LINE_TIMEOUT, lines.next_line()).await {
                Ok(result) => result,
                Err(_) => {
                    fail(
                        &app,
                        generation,
                        "시스템 미디어 정보가 응답하지 않습니다. macOS 업데이트로 접근이 막혔을 수 있습니다 — 새로고침으로 다시 연결해 보고, 계속되면 앱 업데이트를 확인하세요.",
                    );
                    return;
                }
            }
        };

        match next {
            Ok(Some(line)) => {
                got_first_line = true;
                if let Err(e) = ingest_line(&app, generation, &mut merged, &line) {
                    tracing::warn!(error = %e, "지금 재생 중 스트림 처리 실패");
                }
            }
            // EOF(프로세스 종료) 또는 읽기 실패. 의도한 종료라면 fail()이
            // 세대 비교로 걸러낸다.
            Ok(None) | Err(_) => {
                fail(
                    &app,
                    generation,
                    "미디어 정보 프로세스가 종료되었습니다. 새로고침으로 다시 연결해 보세요.",
                );
                return;
            }
        }
    }
}

/// 스트림 한 줄 → 상태 병합 → push 한 번.
fn ingest_line(
    app: &AppHandle,
    generation: u64,
    merged: &mut Map<String, Value>,
    line: &str,
) -> Result<(), String> {
    adapter::apply_stream_line(merged, line)?;
    let full_state = adapter::to_state(merged);

    let state = app.state::<AppState>();
    let outgoing = {
        let mut rt = state.nowplaying.lock().map_err(|_| "상태 잠금 실패")?;
        if rt.generation != generation {
            return Ok(()); // 이미 교체된 worker다. 늦은 push를 버린다.
        }

        let full = NowPlayingPush {
            state: full_state,
            error: None,
        };
        rt.last = Some(full.clone());

        // 앨범아트가 직전 emit과 같으면 뗀다 — 타임라인 갱신(수 초 간격)마다
        // 수십 KB 이미지를 다시 보내지 않는다. 프론트는 토큰이 같으면
        // 직전 아트를 유지한다.
        let mut outgoing = full;
        match outgoing.state.as_mut() {
            Some(s) => {
                if s.artwork_token.is_some() && s.artwork_token == rt.last_pushed_artwork_token {
                    s.artwork = None;
                }
                rt.last_pushed_artwork_token = s.artwork_token;
            }
            None => rt.last_pushed_artwork_token = None,
        }
        outgoing
    };

    outgoing
        .emit(app)
        .map_err(|e| format!("이벤트 push 실패: {e}"))
}

/// 예상치 못한 종료를 화면에 드러낸다. 의도한 종료(세대 교체)는 조용히 무시.
fn fail(app: &AppHandle, generation: u64, message: &str) {
    let state = app.state::<AppState>();
    let push = {
        let Ok(mut rt) = state.nowplaying.lock() else {
            return;
        };
        if rt.generation != generation {
            return;
        }
        rt.child = None;
        rt.generation += 1;
        let push = NowPlayingPush::failed(message);
        rt.last = Some(push.clone());
        push
    };
    tracing::warn!(message, "지금 재생 중 어댑터 실패");
    let _ = push.emit(app);
}

/// 어댑터 스크립트와 프레임워크의 경로.
///
/// - 번들된 앱: 스크립트는 Resources, 프레임워크는 Contents/Frameworks
/// - dev: 둘 다 저장소의 vendor/ (프레임워크는 build.rs 산출물)
///
/// 존재하는 쪽을 쓴다. 둘 다 없으면 에러 — 그건 빌드가 잘못된 것이고,
/// 조용히 넘어가면 위젯이 영원히 빈 화면이 된다.
fn adapter_paths(app: &AppHandle) -> Result<(PathBuf, PathBuf), String> {
    let manifest = PathBuf::from(env!("CARGO_MANIFEST_DIR"));

    let script_candidates = [
        app.path()
            .resolve(
                "vendor/mediaremote-adapter/bin/mediaremote-adapter.pl",
                BaseDirectory::Resource,
            )
            .ok(),
        Some(manifest.join("vendor/mediaremote-adapter/bin/mediaremote-adapter.pl")),
    ];
    let script = first_existing(&script_candidates)
        .ok_or("mediaremote-adapter 스크립트를 찾을 수 없습니다 (앱 번들이 손상됐을 수 있습니다)")?;

    let bundled_framework = std::env::current_exe().ok().and_then(|exe| {
        // Contents/MacOS/my-pegboard → Contents/Frameworks/…
        Some(
            exe.parent()?
                .parent()?
                .join("Frameworks/MediaRemoteAdapter.framework"),
        )
    });
    let framework_candidates = [
        bundled_framework,
        Some(manifest.join("vendor/mediaremote-adapter/build/MediaRemoteAdapter.framework")),
    ];
    let framework = first_existing(&framework_candidates)
        .ok_or("MediaRemoteAdapter.framework를 찾을 수 없습니다 (앱 번들이 손상됐을 수 있습니다)")?;

    Ok((script, framework))
}

fn first_existing(candidates: &[Option<PathBuf>]) -> Option<PathBuf> {
    candidates
        .iter()
        .flatten()
        .find(|p| p.exists())
        .cloned()
}

#[cfg(test)]
mod tests;
