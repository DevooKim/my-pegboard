//! 앨범 IPC 커맨드.
//!
//! # 왜 다이얼로그를 Rust가 여나
//!
//! `tauri-plugin-dialog`에는 JS 쪽 npm 패키지가 있고, 그걸 쓰면 프론트에서
//! `open()`을 부르는 편이 짧다. 그런데 그러면 **세 가지가 프론트로 흘러온다**:
//! 다이얼로그 호출, `asset:` 스코프 허용, 폴더 스캔. 스코프 허용은 Rust만 할 수
//! 있으므로 결국 왕복이 두 번이 되고, 그 사이에 "경로는 골랐는데 스코프가 아직
//! 없는" 상태가 존재하게 된다.
//!
//! 그래서 커맨드 하나가 **다이얼로그 → 스코프 허용 → 스캔 → 캐시 저장**을 전부
//! 하고 결과만 내려보낸다. npm 의존성이 0개이고, capabilities에 dialog 권한도
//! 필요 없다(프론트가 플러그인을 직접 부르지 않으므로). "Rust가 데이터의 주인"
//! 구조와 정확히 맞는다 (DECISIONS 24.4).
//!
//! # 폴링이 없다
//!
//! `album_fetch`에 해당하는 주기 갱신이 없다. 사진 폴더는 5분마다 바뀌지 않는다.
//! 새로고침 버튼은 재스캔이고, 그것으로 충분하다.

use serde::{Deserialize, Serialize};
use tauri::{Manager, State};
use tauri_plugin_dialog::DialogExt;

use crate::providers::album::{
    allow_source, scan, AlbumScan, AlbumSource, IMAGE_EXTENSIONS,
};
use crate::state::AppState;

/// 위젯 데이터 봉투. 프론트의 `WidgetEnvelope<T>`와 짝을 이룬다.
///
/// GitHub/Jira의 봉투와 달리 `total`이 없다 — 사진 장수는 `photos.len()`이
/// 곧 전부이고, 상한을 넘긴 몫은 `skipped`가 말한다.
#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct AlbumWidgetData {
    pub photos: Vec<crate::providers::album::AlbumPhoto>,
    /// 상한을 넘겨 버린 장수. 0이 아니면 위젯이 화면에 적는다.
    pub skipped: u32,
    pub fetched_at: String,
    /// 디스크 캐시에서 왔는가. NAS가 잠들어 있는 동안 이게 true다.
    pub from_cache: bool,
}

// 위젯 설정 타입(`AlbumWidgetConfig`)은 **프론트가 소유한다**
// (`src/widgets/album/index.ts`). Rust가 설정에서 쓰는 것은 `source`뿐이고,
// 나머지(제목·순환 주기)는 표시 방식이라 Rust가 알 이유가 없다. GitHub 위젯이
// 반대인 것은 거기서 쿼리·범위·최대 건수를 전부 Rust가 해석하기 때문이다.

/// 폴더를 고른다. 다이얼로그를 취소하면 `None`.
///
/// `async`인 이유: `blocking_pick_folder`는 메인 스레드에서 부르면 교착한다.
/// Tauri는 `async` 커맨드를 별도 스레드에서 돌리므로 여기서는 안전하다
/// (플러그인 문서의 예시가 정확히 이 형태다).
#[tauri::command]
#[specta::specta]
pub async fn album_pick_folder(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    widget_id: String,
) -> Result<Option<AlbumScan>, String> {
    let Some(picked) = app
        .dialog()
        .file()
        .set_title("사진 폴더 선택")
        .blocking_pick_folder()
    else {
        return Ok(None);
    };

    let path = picked
        .into_path()
        .map_err(|e| format!("폴더 경로를 해석할 수 없습니다: {e}"))?;
    let source = AlbumSource::Folder {
        path: path.to_string_lossy().to_string(),
    };

    scan_and_cache(&app, &state, &widget_id, source).map(Some)
}

/// 사진 파일들을 고른다. **다중 선택**이다.
#[tauri::command]
#[specta::specta]
pub async fn album_pick_files(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    widget_id: String,
) -> Result<Option<AlbumScan>, String> {
    let Some(picked) = app
        .dialog()
        .file()
        .set_title("사진 선택")
        // 다이얼로그에서 미리 걸러준다. 스캔도 확장자를 다시 보므로
        // 이건 편의이고 검증이 아니다.
        .add_filter("이미지", IMAGE_EXTENSIONS)
        .blocking_pick_files()
    else {
        return Ok(None);
    };

    let mut paths = Vec::with_capacity(picked.len());
    for p in picked {
        let path = p
            .into_path()
            .map_err(|e| format!("파일 경로를 해석할 수 없습니다: {e}"))?;
        paths.push(path.to_string_lossy().to_string());
    }

    // 다이얼로그를 열었지만 아무것도 고르지 않은 경우. 취소와 같이 취급한다 —
    // 빈 목록을 저장하면 기존 설정이 날아간다.
    if paths.is_empty() {
        return Ok(None);
    }

    scan_and_cache(&app, &state, &widget_id, AlbumSource::Files { paths }).map(Some)
}

/// 저장된 소스를 다시 훑는다. 새로고침 버튼과 설정 저장 직후에 부른다.
///
/// **스코프도 여기서 다시 허용한다.** 재시작 복원(`lib.rs`)이 이미 했더라도
/// 한 번 더 하는 것은 무해하고, 빠뜨리는 경로가 하나 줄어든다.
///
/// 실패하면 에러 문자열을 준다. **캐시된 사진은 프론트가 계속 들고 있다** —
/// 위젯이 목록을 비우지 않는 것은 이 앱의 공통 약속이다.
#[tauri::command]
#[specta::specta]
pub fn album_rescan(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    widget_id: String,
    source: AlbumSource,
) -> Result<AlbumScan, String> {
    scan_and_cache(&app, &state, &widget_id, source)
}

/// 디스크 캐시만 읽는다. 네트워크도 파일시스템도 건드리지 않으므로 즉시 반환된다.
///
/// **앱 시작 시 이것을 먼저 부른다.** 0ms에 첫 장을 그리는 것이 이 앱의
/// 존재 이유다(DECISIONS 17). 외장 디스크가 잠들어 있으면 재스캔이 수 초
/// 걸리는데, 그동안 지난 사진이 보여야 배경으로서 고장나지 않는다.
#[tauri::command]
#[specta::specta]
pub fn album_cached(
    state: State<'_, AppState>,
    widget_id: String,
) -> Result<Option<AlbumWidgetData>, String> {
    let cache = state.cache.lock().map_err(|_| "상태 잠금 실패")?;
    Ok(cached_data(&cache, &widget_id))
}

// ---------------------------------------------------------------------------
// 내부 헬퍼
// ---------------------------------------------------------------------------

/// 스코프 허용 → 스캔 → 캐시 저장.
///
/// **스코프 허용이 스캔보다 먼저다.** 순서가 뒤바뀌면 스캔은 성공하는데(Rust는
/// 스코프와 무관하게 파일시스템을 읽는다) 웹뷰가 이미지를 못 불러오는 상태가
/// 잠깐 생긴다. 그리고 그건 에러가 아니라 깨진 이미지로 나타난다.
fn scan_and_cache(
    app: &tauri::AppHandle,
    state: &AppState,
    widget_id: &str,
    source: AlbumSource,
) -> Result<AlbumScan, String> {
    allow_source(&app.asset_protocol_scope(), &source);

    let result = scan(&source).map_err(|e| e.to_string())?;

    let fetched_at = chrono::Utc::now();
    let data = AlbumWidgetData {
        photos: result.photos.clone(),
        skipped: result.skipped,
        fetched_at: fetched_at.to_rfc3339(),
        from_cache: false,
    };

    // 캐시 저장 실패는 치명적이지 않다 — 다음 시작이 느려질 뿐이다.
    // 사진 목록 자체는 이미 손에 있다.
    if let Ok(cache) = state.cache.lock() {
        if let Ok(value) = serde_json::to_value(&data) {
            let _ = cache.put(widget_id, value, fetched_at);
        }
    }

    Ok(result)
}

fn cached_data(
    cache: &crate::storage::cache::CacheStore,
    widget_id: &str,
) -> Option<AlbumWidgetData> {
    let entry = cache.get(widget_id).ok().flatten()?;
    let mut data: AlbumWidgetData = serde_json::from_value(entry.payload).ok()?;
    data.fetched_at = entry.fetched_at.to_rfc3339();
    data.from_cache = true;
    Some(data)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 캐시에서 읽은 데이터는 **반드시** `from_cache: true`여야 한다.
    /// 아니면 "N분 전" 표시가 안 뜨고, 폴더가 사라진 것을 모른 채
    /// 낡은 목록을 최신으로 믿는다.
    #[test]
    fn cached_data_is_marked_as_cached() {
        let dir = tempfile::TempDir::new().unwrap();
        let cache = crate::storage::cache::CacheStore::new(dir.path());
        let at = chrono::Utc::now();

        let fresh = AlbumWidgetData {
            photos: vec![crate::providers::album::AlbumPhoto {
                path: "/p/a.jpg".into(),
            }],
            skipped: 3,
            fetched_at: at.to_rfc3339(),
            from_cache: false,
        };
        cache
            .put("w1", serde_json::to_value(&fresh).unwrap(), at)
            .unwrap();

        let got = cached_data(&cache, "w1").expect("캐시를 못 읽었다");
        assert!(got.from_cache, "캐시에서 왔는데 from_cache가 false다");
        assert_eq!(got.photos.len(), 1);
        // skipped가 캐시를 왕복하며 사라지면 "N장은 표시하지 않음"이 조용히 없어진다.
        assert_eq!(got.skipped, 3);
    }

    /// 소스는 `kind` 태그로 구분된다. 프론트가 만드는 모양과 같아야 한다.
    #[test]
    fn source_round_trips_through_json() {
        let folder: AlbumSource =
            serde_json::from_value(serde_json::json!({ "kind": "folder", "path": "/p" })).unwrap();
        assert!(folder.is_folder());

        let files: AlbumSource =
            serde_json::from_value(serde_json::json!({ "kind": "files", "paths": ["/p/a.jpg"] }))
                .unwrap();
        assert_eq!(files.paths(), vec!["/p/a.jpg"]);
    }
}
