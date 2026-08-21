//! "지금 재생 중" 위젯의 IPC 타입.
//!
//! IPC 경계로 나가는 타입에는 provider 접두사를 붙인다 — specta가 모듈 경로를
//! 버리고 struct 이름만 가져가므로, 다른 provider와 이름이 겹치면 생성물이
//! 유효하지 않은 TypeScript가 된다 (GithubPreset 사례).

use serde::{Deserialize, Serialize};

/// 시스템 "지금 재생 중" 상태. 어댑터가 주는 40여 개 키에서 위젯이 그릴 것만
/// 남겼다 — "필요한 필드만 남긴다" (CLAUDE.md).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct NowPlayingState {
    /// 재생 중인 앱의 번들 id (예: `com.spotify.client`). "앱 열기"에 쓴다.
    pub bundle_id: String,
    pub title: String,
    /// 어댑터가 빈 문자열을 줄 수 있다(실측: 브라우저 미디어). 빈 문자열은
    /// `None`으로 바꿔 프론트가 "표시할 게 있나"를 한 가지 방법으로만 판단하게 한다.
    pub artist: Option<String>,
    pub album: Option<String>,
    pub playing: bool,
    pub duration_secs: Option<f64>,
    /// `sampled_at_ms` 시점의 재생 위치. 진행바는 이 둘로 보간한다 —
    /// 어댑터가 초마다 push하지 않으므로(실측: 수 초 간격) 프론트가 시계를 돌린다.
    pub elapsed_secs: Option<f64>,
    /// `elapsed_secs`를 잰 시각 (Unix epoch 밀리초).
    pub sampled_at_ms: Option<f64>,
    pub playback_rate: Option<f64>,
    /// 앨범아트 data URI (`data:image/jpeg;base64,…`). **직전 push와 같은
    /// 아트면 None** — 타임라인 갱신마다 이미지를 IPC로 반복 전송하지 않는다.
    /// 같은지 여부는 `artwork_token`으로 판단한다.
    pub artwork: Option<String>,
    /// 앨범아트 식별 토큰. `None`이면 아트 자체가 없는 것.
    pub artwork_token: Option<u32>,
}

/// Rust → WebView push 봉투.
///
/// - `state: Some` → 재생 중 (일시정지 포함)
/// - `state: None, error: None` → 재생 중인 미디어 없음 (정상적인 빈 상태)
/// - `error: Some` → 어댑터 실패. macOS가 이 기법을 막았거나 프로세스가 죽었다.
///   조용한 실패 금지 원칙에 따라 이것도 반드시 push한다.
#[derive(Debug, Clone, Serialize, Deserialize, specta::Type, tauri_specta::Event)]
#[serde(rename_all = "camelCase")]
pub struct NowPlayingPush {
    pub state: Option<NowPlayingState>,
    pub error: Option<String>,
}

impl NowPlayingPush {
    pub fn empty() -> Self {
        Self {
            state: None,
            error: None,
        }
    }

    pub fn failed(message: impl Into<String>) -> Self {
        Self {
            state: None,
            error: Some(message.into()),
        }
    }
}

/// 위젯이 보낼 수 있는 재생 제어. 어댑터의 send 명령 ID로 변환된다.
///
/// 셔플·반복·탐색은 **일부러 없다** — 현재 셔플/반복 상태를 신뢰성 있게 읽지
/// 못하면 토글 버튼이 거짓말을 하고, seek는 플레이어별 지원 편차가 있다.
/// 핵심 3종만 노출한다 (사용자 결정, DECISIONS 27).
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub enum NowPlayingCommand {
    PlayPause,
    Next,
    Previous,
}

impl NowPlayingCommand {
    /// mediaremote-adapter `send COMMAND`의 ID (업스트림 README의 표).
    pub const fn adapter_id(self) -> u8 {
        match self {
            // kMRTogglePlayPause
            NowPlayingCommand::PlayPause => 2,
            // kMRNextTrack
            NowPlayingCommand::Next => 4,
            // kMRPreviousTrack
            NowPlayingCommand::Previous => 5,
        }
    }
}
