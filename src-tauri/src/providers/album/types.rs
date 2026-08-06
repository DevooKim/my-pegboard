//! 앨범 위젯이 IPC 경계로 내보내는 타입.
//!
//! 이름에 `Album` 접두사를 붙인 이유: specta는 모듈 경로를 버리고 struct
//! 이름만 가져간다. 다른 provider가 `Source`나 `Photo` 같은 이름을 쓰면
//! 생성물에 같은 타입이 두 번 나와 유효하지 않은 TypeScript가 된다
//! (new-widget 스킬 registration.md 9장).

use serde::{Deserialize, Serialize};
use specta::Type;

/// 사진을 어디서 가져오나.
///
/// 폴더 하나 또는 파일 목록, 둘뿐이다. **"고정 한 장" 모드를 따로 만들지 않는다** —
/// `Files`에 하나만 담으면 자연히 그게 된다. 모드를 늘리면 설정 UI가 늘고
/// 사용자가 "지금 어느 모드지"를 기억해야 한다.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum AlbumSource {
    /// 폴더 하나. 비재귀로 훑는다.
    #[serde(rename_all = "camelCase")]
    Folder { path: String },
    /// 사용자가 직접 고른 파일들. 순서는 스캔이 파일명순으로 다시 정한다.
    #[serde(rename_all = "camelCase")]
    Files { paths: Vec<String> },
}

impl AlbumSource {
    /// 스코프에 허용해야 하는 경로들.
    ///
    /// 재시작 복원(`lib.rs` setup)과 최초 선택(`commands/album.rs`)이 **같은
    /// 함수**를 쓰게 하려고 여기 둔다. 둘이 갈라지면 "재시작 후에만 이미지가
    /// 안 뜨는" 실패가 생긴다 — 화면에는 깨진 이미지 아이콘만 남고 에러가 없다.
    pub fn paths(&self) -> Vec<&str> {
        match self {
            AlbumSource::Folder { path } => vec![path.as_str()],
            AlbumSource::Files { paths } => paths.iter().map(String::as_str).collect(),
        }
    }

    /// 이 경로가 디렉터리로 허용돼야 하는가.
    ///
    /// `Folder`면 디렉터리 스코프(비재귀), `Files`면 파일 스코프다. 파일 목록에
    /// 디렉터리 스코프를 주면 고르지 않은 형제 파일까지 열리므로 구분한다.
    pub fn is_folder(&self) -> bool {
        matches!(self, AlbumSource::Folder { .. })
    }
}

/// 사진 한 장.
///
/// **파일명·촬영일·EXIF를 담지 않는다.** 이 위젯은 기분 전환용 배경이고,
/// 사진을 제대로 보려면 미리보기 앱이 낫다 (DECISIONS 24). 프론트에 필요한
/// 것은 절대 경로 하나뿐이다 — `convertFileSrc()`가 그것으로 `asset:` URL을
/// 만든다.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct AlbumPhoto {
    /// 절대 경로. 프론트는 이걸 `convertFileSrc()`에 넣는다.
    pub path: String,
}

/// 스캔 결과.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct AlbumScan {
    pub photos: Vec<AlbumPhoto>,
    /// 상한(1000장)을 넘겨 **버린** 장수.
    ///
    /// 0이 아니면 위젯이 "N장은 표시하지 않음"을 그린다. 조용히 자르면
    /// 사용자는 없는 사진을 계속 기다린다 (CLAUDE.md 대전제 2).
    pub skipped: u32,
    /// 스캔한 소스. 프론트가 에러 화면에 경로를 적는 데 쓴다.
    pub source: AlbumSource,
}
