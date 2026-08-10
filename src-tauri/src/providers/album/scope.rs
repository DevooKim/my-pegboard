//! `asset:` 프로토콜 스코프 허용 — **이 위젯에서 가장 조용히 깨지는 부분이다.**
//!
//! # 왜 스코프가 필요한가
//!
//! 프론트는 `convertFileSrc(path)`로 `asset://localhost/...` URL을 만들어
//! `<img src>`에 넣는다. 네이티브가 파일을 스트리밍하므로 IPC 페이로드가 0이고
//! 원본 화질이 그대로 나온다 (base64로 내리면 "필요한 필드만 남긴다"는 원칙을
//! 정면으로 위반한다 — DECISIONS 24.2).
//!
//! 그런데 `tauri.conf.json`의 정적 `assetProtocol.scope`는 **빈 배열**이다.
//! 기본으로는 아무 경로도 열리지 않는다. `$HOME/**`를 넣으면 웹뷰가 사용자
//! 홈 전체를 읽을 수 있게 되고, 그건 사진 위젯 하나가 요구할 권한이 아니다.
//!
//! 대신 **사용자가 고른 경로만** 런타임에 허용한다.
//!
//! # 재시작이 함정이다
//!
//! 런타임 스코프는 메모리에만 있다. 앱을 껐다 켜면 사라진다. `board.json`에
//! 저장된 설정은 그대로 남아 있으므로 위젯은 사진 경로를 알고 있고, `<img>`도
//! URL을 만들어 넣는다 — 그런데 스코프가 없어서 **에러 없이 깨진 이미지**가 된다.
//! CSP는 `asset:`을 허용하므로 콘솔에도 아무 말이 없다.
//!
//! 그래서 `lib.rs`의 setup이 [`restore_scopes`]로 board.json의 **모든** 앨범
//! 위젯을 훑어 다시 허용한다. `Files` 위젯은 파일을 하나도 빠뜨리면 안 되는데,
//! 빠진 그 한 장만 안 보이므로 눈으로는 거의 못 잡는다. 그래서 테스트가 있다.

use std::collections::HashSet;
use std::path::{Path, PathBuf, MAIN_SEPARATOR};
use tauri::scope::fs::{Pattern, Scope};

use super::types::AlbumSource;
use crate::storage::board::{BoardFile, WidgetType};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AlbumScopePathKind {
    Directory,
    File,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AlbumScopePath {
    pub path: String,
    pub kind: AlbumScopePathKind,
}

/// board.json에서 앨범 위젯의 소스를 전부 뽑는다.
///
/// `Scope`를 받지 않는 순수 함수로 뽑은 이유: 실제 Tauri 앱 없이 테스트할 수
/// 있어야 한다. 스코프에 넣는 것은 한 줄이고, 틀리기 쉬운 쪽은 **무엇을 넣을지
/// 고르는 것**이다.
///
/// 설정을 파싱할 수 없는 위젯은 조용히 건너뛴다 — 손으로 편집한 board.json이나
/// 아직 소스를 고르지 않은 새 위젯이 그렇다. 그 위젯은 애초에 보여줄 사진이
/// 없으므로 스코프도 필요 없다.
pub fn album_sources(board: &BoardFile) -> Vec<AlbumSource> {
    board
        .boards
        .iter()
        .flat_map(|b| b.widgets.iter())
        .filter(|w| w.widget_type == WidgetType::Album)
        .filter_map(|w| w.config.get("source"))
        .filter_map(|v| serde_json::from_value::<AlbumSource>(v.clone()).ok())
        .collect()
}

fn scope_paths_for_source(source: &AlbumSource) -> Vec<AlbumScopePath> {
    let kind = if source.is_folder() {
        AlbumScopePathKind::Directory
    } else {
        AlbumScopePathKind::File
    };

    source
        .paths()
        .into_iter()
        .map(|path| AlbumScopePath {
            path: path.to_string(),
            kind: kind.clone(),
        })
        .collect()
}

/// Return the exact path/kind membership restored at app startup.
///
/// The kind is part of membership: allowing a path as a directory is not the
/// same permission as allowing that path as one file. Keeping this pure lets
/// board import detect a relaunch requirement without touching the live scope.
pub fn album_scope_membership(board: &BoardFile) -> Vec<AlbumScopePath> {
    let mut paths = Vec::new();
    for source in album_sources(board) {
        for path in scope_paths_for_source(&source) {
            if !paths.contains(&path) {
                paths.push(path);
            }
        }
    }
    paths
}

pub fn album_scope_membership_changed(old: &BoardFile, new: &BoardFile) -> bool {
    album_scope_membership(old) != album_scope_membership(new)
}

/// Validate the escaped literal patterns Tauri would build, without
/// constructing or mutating an app-owned scope.
pub fn validate_album_scope_paths(board: &BoardFile) -> Result<(), String> {
    for membership in album_scope_membership(board) {
        let path = Path::new(&membership.path);
        if membership.path.trim().is_empty() {
            return Err("앨범 경로가 비어 있습니다".to_string());
        }
        if !path.is_absolute() {
            return Err(format!(
                "앨범 경로는 절대 경로여야 합니다: {}",
                membership.path
            ));
        }

        let normalized: PathBuf = path.components().collect();
        let literal = Pattern::escape(&normalized.to_string_lossy());
        Pattern::new(&literal).map_err(|error| {
            format!(
                "앨범 경로 권한 패턴을 만들 수 없습니다 ({}): {error}",
                membership.path
            )
        })?;

        if membership.kind == AlbumScopePathKind::Directory {
            let child_pattern = if literal.ends_with(MAIN_SEPARATOR) {
                format!("{literal}*")
            } else {
                format!("{literal}{MAIN_SEPARATOR}*")
            };
            Pattern::new(&child_pattern).map_err(|error| {
                format!(
                    "앨범 폴더 권한 패턴을 만들 수 없습니다 ({}): {error}",
                    membership.path
                )
            })?;
        }
    }
    Ok(())
}

/// Return stable, unique warnings for album paths that disappeared after an
/// export. Missing paths are warnings rather than import failures: the user may
/// reconnect an external disk or restore a folder later.
pub fn missing_path_warnings(board: &BoardFile) -> Vec<crate::storage::board::AlbumPathWarning> {
    let mut seen = HashSet::new();
    album_sources(board)
        .into_iter()
        .flat_map(|source| {
            source
                .paths()
                .into_iter()
                .map(str::to_owned)
                .collect::<Vec<_>>()
        })
        .filter(|path| !std::path::Path::new(path).exists())
        .filter(|path| seen.insert(path.clone()))
        .map(|path| crate::storage::board::AlbumPathWarning { path })
        .collect()
}

/// 소스 하나를 스코프에 허용한다.
///
/// - `Folder` → `allow_directory(path, false)` — **비재귀**다. 스캔이 비재귀이므로
///   하위 폴더를 열어줄 이유가 없다.
/// - `Files` → 각 파일마다 `allow_file`. 디렉터리를 열면 고르지 않은 형제
///   파일까지 읽히므로 파일 단위로 준다.
///
/// 실패한 경로도 모두 시도한 뒤 오류를 반환한다. 폴더/파일 선택 커맨드는
/// 스코프와 스캔을 같은 Rust 경계에서 처리하므로 부분 허용을 성공으로 삼지 않는다.
pub fn allow_source(scope: &Scope, source: &AlbumSource) -> Result<(), String> {
    allow_paths(scope, &scope_paths_for_source(source))
}

fn allow_path(scope: &Scope, path: &AlbumScopePath) -> Result<(), String> {
    let result = match path.kind {
        AlbumScopePathKind::Directory => scope.allow_directory(&path.path, false),
        AlbumScopePathKind::File => scope.allow_file(&path.path),
    };
    result.map_err(|error| format!("{}: {error}", path.path))
}

fn allow_paths(scope: &Scope, paths: &[AlbumScopePath]) -> Result<(), String> {
    let mut errors = Vec::new();
    for path in paths {
        if let Err(error) = allow_path(scope, path) {
            errors.push(format!(
                "앨범 경로를 스코프에 허용하지 못했습니다 ({error})"
            ));
        }
    }
    if errors.is_empty() {
        Ok(())
    } else {
        Err(errors.join("; "))
    }
}

/// 앱 시작 시 저장된 모든 앨범 위젯의 경로를 다시 허용한다.
///
/// **하나라도 빠뜨리면 "재시작 후에만 안 뜨는" 실패가 된다.** 개발 중에는
/// 위젯을 방금 만들어서 런타임 허용이 살아 있으므로 절대 재현되지 않는다.
pub fn restore_scopes(scope: &Scope, board: &BoardFile) {
    let sources = album_sources(board);
    for source in &sources {
        if let Err(error) = allow_source(scope, source) {
            tracing::warn!(error = %error, "앨범 위젯 경로를 스코프에 복원하지 못했습니다");
        }
    }
    if !sources.is_empty() {
        tracing::info!(count = sources.len(), "앨범 위젯 경로를 스코프에 복원");
    }
}
