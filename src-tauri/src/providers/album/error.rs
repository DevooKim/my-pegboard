//! 앨범 스캔 에러.
//!
//! # 왜 일시적/영구적 축이 없나
//!
//! Jira·GitHub의 에러는 429/5xx처럼 **기다리면 풀리는** 종류가 있어서 재시도
//! 정책을 결정하는 축(`ErrorKind`)이 필요했다. 로컬 파일시스템에는 그게 없다.
//! 폴더가 없거나 권한이 없으면 몇 번을 다시 훑어도 같은 결과다 — 사용자가
//! 외장 디스크를 다시 꽂거나 폴더를 다시 고르는 것 말고는 길이 없다.
//!
//! 그래서 모든 스캔 실패는 **영구적**으로 취급하고, 위젯은 경로와 함께
//! "다시 선택" 버튼을 그린다. 대신 **직전 스캔 결과(캐시)는 그대로 보여준다** —
//! NAS가 잠들어 있는 동안 사진이 사라지면 배경으로서 고장난 것이다.

use std::fmt;
use std::path::PathBuf;

#[derive(Debug)]
pub enum AlbumError {
    /// 경로가 존재하지 않는다. 폴더 삭제·이동·외장 디스크 분리.
    NotFound { path: PathBuf },
    /// 폴더를 기대했는데 파일이었다 (또는 그 반대).
    NotADirectory { path: PathBuf },
    /// 읽기 권한이 없거나 IO가 실패했다.
    Io { path: PathBuf, source: std::io::Error },
}

impl fmt::Display for AlbumError {
    /// 메시지에 **경로를 반드시 넣는다.** 외장 디스크가 빠진 것인지 폴더를
    /// 옮긴 것인지는 경로를 봐야 알 수 있고, 그걸 판단하는 건 사용자다.
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            AlbumError::NotFound { path } => write!(
                f,
                "폴더를 찾을 수 없습니다: {}\n외장 디스크가 분리됐거나 폴더가 이동·삭제됐을 수 있습니다.",
                path.display()
            ),
            AlbumError::NotADirectory { path } => write!(
                f,
                "폴더가 아닙니다: {}\n사진 한 장을 고르려면 '사진 선택'을 쓰세요.",
                path.display()
            ),
            AlbumError::Io { path, source } => write!(
                f,
                "폴더를 읽을 수 없습니다: {}\n{source}",
                path.display()
            ),
        }
    }
}

impl std::error::Error for AlbumError {}

pub type AlbumResult<T> = Result<T, AlbumError>;
