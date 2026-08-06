//! 폴더/파일 목록 → 사진 경로 목록.
//!
//! # 하지 않는 것
//!
//! - **재귀하지 않는다.** 사진 폴더는 `~/Pictures` 하나만 재귀해도 라이브러리
//!   전체(수만 장)를 만난다. 그러면 스캔이 앱 시작을 붙잡는다. 폴더 하나를
//!   고른다는 건 "그 폴더에 있는 것"을 보고 싶다는 뜻이다.
//! - **리사이즈·EXIF 파싱을 하지 않는다.** `image` crate를 넣지 않는다는 뜻이다.
//!   `<img>`는 대개 EXIF 회전을 존중하고, 원본을 `asset:`으로 스트리밍하면
//!   썸네일을 만들 이유가 없다 (DECISIONS 24.3).
//! - **파일을 열지 않는다.** 확장자만 본다. 매직 바이트를 읽으려면 파일 1000개를
//!   여는데, 그 비용으로 얻는 건 "확장자를 속인 파일"을 걸러내는 것뿐이다.
//!   그건 `<img onError>`가 이미 잡는다.

use std::path::{Path, PathBuf};

use super::error::{AlbumError, AlbumResult};
use super::types::{AlbumPhoto, AlbumScan, AlbumSource};

/// 표시할 수 있는 확장자. **대소문자를 무시한다** — 카메라·스캐너가 `.JPG`를
/// 쓰는 일이 흔하고, 그걸 빠뜨리면 폴더 전체가 빈 것처럼 보인다.
pub const IMAGE_EXTENSIONS: &[&str] = &["jpg", "jpeg", "png", "gif", "webp", "heic"];

/// 한 위젯이 들고 있을 사진의 상한.
///
/// 1000장이면 10초 주기로 2.7시간이 걸린다 — 배경으로서 충분히 다양하다.
/// 상한이 있는 진짜 이유는 IPC 페이로드와 셔플 배열이 무한정 커지지 않게
/// 하는 것이고, 넘긴 장수는 `skipped`로 **화면에 드러낸다.**
pub const MAX_PHOTOS: usize = 1000;

/// 표시할 수 있는 이미지 파일명인가.
///
/// 순수 함수로 뽑은 이유: 확장자 규칙이 이 위젯에서 가장 조용히 틀리기 쉬운
/// 부분이다. `.JPG`를 빠뜨려도 에러가 없고 그냥 "사진이 없다"가 된다.
pub fn is_image_file(name: &str) -> bool {
    // 숨김 파일 제외. `.DS_Store`는 확장자 검사에서 어차피 걸리지만,
    // `.hidden.jpg` 같은 것도 사용자가 보이길 기대하지 않는다.
    if name.starts_with('.') {
        return false;
    }

    let Some((stem, ext)) = name.rsplit_once('.') else {
        // 확장자가 없다. `README`, `photo` 같은 것.
        return false;
    };
    // `.jpg`처럼 이름이 비면 위의 숨김 검사에 걸리지만, 방어적으로 한 번 더.
    if stem.is_empty() {
        return false;
    }

    let ext = ext.to_ascii_lowercase();
    IMAGE_EXTENSIONS.contains(&ext.as_str())
}

/// 소스를 훑어 사진 목록을 만든다.
///
/// 정렬은 **파일명순**이다. 셔플은 프론트가 한다 — 목록이 진실이고 순서는
/// 표시 방식일 뿐이므로, Rust에 `rand` 의존성을 넣지 않는다 (DECISIONS 24.5).
pub fn scan(source: &AlbumSource) -> AlbumResult<AlbumScan> {
    let mut paths = match source {
        AlbumSource::Folder { path } => scan_folder(Path::new(path))?,
        AlbumSource::Files { paths } => collect_files(paths),
    };

    // 파일명순. 같은 폴더를 두 번 훑으면 같은 순서가 나와야 한다 —
    // `read_dir`의 순서는 파일시스템이 정하고 보장이 없다.
    paths.sort();

    let total = paths.len();
    let skipped = total.saturating_sub(MAX_PHOTOS);
    paths.truncate(MAX_PHOTOS);

    Ok(AlbumScan {
        photos: paths
            .into_iter()
            .map(|p| AlbumPhoto {
                path: p.to_string_lossy().to_string(),
            })
            .collect(),
        skipped: skipped as u32,
        source: source.clone(),
    })
}

/// 폴더 하나를 비재귀로 훑는다.
fn scan_folder(dir: &Path) -> AlbumResult<Vec<PathBuf>> {
    if !dir.exists() {
        return Err(AlbumError::NotFound {
            path: dir.to_path_buf(),
        });
    }
    if !dir.is_dir() {
        return Err(AlbumError::NotADirectory {
            path: dir.to_path_buf(),
        });
    }

    let entries = std::fs::read_dir(dir).map_err(|source| AlbumError::Io {
        path: dir.to_path_buf(),
        source,
    })?;

    let mut found = Vec::new();
    for entry in entries {
        // 항목 하나를 못 읽는다고 폴더 전체를 실패시키지 않는다. 사진 999장이
        // 멀쩡한데 한 장 때문에 배경이 안 나오는 것이 더 나쁘다.
        let Ok(entry) = entry else { continue };
        let path = entry.path();

        // 하위 폴더는 건너뛴다(비재귀). `file_type`이 실패하면 무시한다.
        if entry.file_type().map(|t| t.is_dir()).unwrap_or(false) {
            continue;
        }

        let Some(name) = path.file_name().and_then(|n| n.to_str()) else {
            continue;
        };
        if is_image_file(name) {
            found.push(path);
        }
    }

    Ok(found)
}

/// 사용자가 직접 고른 파일 목록을 정리한다.
///
/// **여기서는 실패시키지 않는다.** 파일 다이얼로그로 고른 직후에는 전부
/// 존재하고, 나중에 한 장이 사라지는 것은 `<img onError>`가 다음 장으로
/// 넘기며 "N장을 표시할 수 없습니다"로 드러낸다. 목록에서 미리 지우면
/// 사용자가 고른 것과 보이는 것이 조용히 달라진다.
fn collect_files(paths: &[String]) -> Vec<PathBuf> {
    paths
        .iter()
        .filter(|p| {
            Path::new(p)
                .file_name()
                .and_then(|n| n.to_str())
                .is_some_and(is_image_file)
        })
        .map(PathBuf::from)
        .collect()
}
