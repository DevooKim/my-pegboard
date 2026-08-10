//! 앨범 provider — 로컬 사진 폴더/파일 스캔.
//!
//! 다른 provider와 달리 **네트워크가 없다.** HTTP 클라이언트도 자격증명도
//! 없고, 대신 `asset:` 프로토콜 스코프라는 이 위젯만의 관문이 있다
//! ([`scope`] 모듈의 주석이 그 함정을 설명한다).
//!
//! # 경계 (Jira·GitHub provider와 같다)
//!
//! - **캐시하지 않는다.** `commands/album.rs`가 `storage/cache.rs`에 쓴다.
//! - **다이얼로그를 열지 않는다.** 그것도 커맨드의 일이다. 이 모듈은
//!   "경로를 받아 사진 목록을 만드는 것"만 안다.
//! - **재시도 정책이 없다.** 로컬 파일시스템의 실패는 기다려서 풀리지 않는다
//!   ([`error`] 참조).

pub mod error;
pub mod scan;
pub mod scope;
pub mod types;

#[cfg(test)]
mod tests;

pub use error::{AlbumError, AlbumResult};
pub use scan::{is_image_file, scan, IMAGE_EXTENSIONS, MAX_PHOTOS};
pub use scope::{
    album_scope_membership, album_scope_membership_changed, album_sources, allow_source,
    missing_path_warnings, restore_scopes, validate_album_scope_paths, AlbumScopePath,
    AlbumScopePathKind,
};
pub use types::{AlbumPhoto, AlbumScan, AlbumSource};
