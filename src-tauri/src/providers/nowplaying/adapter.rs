//! mediaremote-adapter 스트림 출력의 파싱과 병합.
//!
//! 전부 순수 함수다 — `State`도 `AppHandle`도 받지 않으므로 앱 없이 테스트한다
//! (화면에 드러나지 않는 영역은 테스트로 보장한다는 원칙).
//!
//! # 스트림 계약 (업스트림 README + 실측 2026-08-22)
//!
//! 한 줄 = JSON 하나: `{"type":"data","diff":bool,"payload":{…}}`
//!
//! - 시작 직후 `diff:false` 페이로드가 **즉시** 온다 (실측). 재생 중인 것이
//!   없으면 페이로드가 빈 객체다 — 그래서 "첫 줄이 왔는가"가 어댑터 생존
//!   판정이고, 빈 페이로드는 "재생 없음"이다. 이 구분이 조용한 실패를 막는다.
//! - `diff:true`면 바뀐 키만 온다. 사라진 키는 `null`로 온다 → 제거.
//! - `--micros` 옵션을 쓰므로 시간 키는 `durationMicros` /
//!   `elapsedTimeMicros` / `timestampEpochMicros`다.

use std::collections::hash_map::DefaultHasher;
use std::hash::{Hash, Hasher};

use serde_json::{Map, Value};

use super::types::NowPlayingState;

/// 스트림 한 줄을 병합 상태에 반영한다.
///
/// 알 수 없는 `type`은 무시한다(에러가 아니다) — 업스트림이 새 타입을 추가해도
/// 스트림이 통째로 죽지 않게. JSON이 아니면 에러다.
pub fn apply_stream_line(merged: &mut Map<String, Value>, line: &str) -> Result<(), String> {
    let parsed: Value =
        serde_json::from_str(line).map_err(|e| format!("스트림 출력을 파싱할 수 없습니다: {e}"))?;

    if parsed.get("type").and_then(Value::as_str) != Some("data") {
        return Ok(());
    }

    let diff = parsed
        .get("diff")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let Some(payload) = parsed.get("payload").and_then(Value::as_object) else {
        return Err("스트림 출력에 payload가 없습니다".to_string());
    };

    if !diff {
        *merged = payload.clone();
        return Ok(());
    }

    for (key, value) in payload {
        if value.is_null() {
            merged.remove(key);
        } else {
            merged.insert(key.clone(), value.clone());
        }
    }
    Ok(())
}

/// 병합 상태 → 위젯 상태. 재생 중인 것이 없으면 `None`.
///
/// 어댑터 문서의 필수 키는 `bundleIdentifier`·`playing`·`title`이다.
/// 하나라도 없으면 유효한 미디어가 아니다.
///
/// 앨범아트는 **항상** 채워서 돌려준다. "직전 push와 같으면 뗀다"는 판단은
/// 전송 시점의 정책이라 여기(파싱)에 두지 않는다 — `mod.rs`의 push 조립이 한다.
pub fn to_state(merged: &Map<String, Value>) -> Option<NowPlayingState> {
    let bundle_id = merged.get("bundleIdentifier")?.as_str()?.to_string();
    let title = merged.get("title")?.as_str()?.to_string();
    let playing = merged.get("playing")?.as_bool()?;

    let artwork = artwork_data_uri(merged);
    let artwork_token = artwork.as_deref().map(token_of);

    Some(NowPlayingState {
        bundle_id,
        title,
        artist: non_empty_str(merged, "artist"),
        album: non_empty_str(merged, "album"),
        playing,
        duration_secs: micros_to_secs(merged, "durationMicros"),
        elapsed_secs: micros_to_secs(merged, "elapsedTimeMicros"),
        sampled_at_ms: merged
            .get("timestampEpochMicros")
            .and_then(Value::as_f64)
            .map(|micros| micros / 1000.0),
        playback_rate: merged.get("playbackRate").and_then(Value::as_f64),
        artwork,
        artwork_token,
    })
}

/// 앨범아트 동일성 토큰. base64 문자열 해시 — 이미지 자체를 비교할 필요는 없고
/// "직전 것과 같은가"만 알면 된다.
pub fn token_of(data_uri: &str) -> u32 {
    let mut hasher = DefaultHasher::new();
    data_uri.hash(&mut hasher);
    // u64 → u32 절단. 토큰 충돌은 "아트 한 장을 안 바꿔 그리는" 시각적 사소함이고,
    // 트랙이 바뀌면 어차피 새 diff가 온다.
    hasher.finish() as u32
}

fn artwork_data_uri(merged: &Map<String, Value>) -> Option<String> {
    let data = merged.get("artworkData")?.as_str()?;
    if data.is_empty() {
        return None;
    }
    // MIME이 안 왔으면 jpeg로 둔다 — 실측상 대부분 jpeg이고, 틀려도 브라우저가
    // 시그니처로 알아서 그리는 경우가 많다. 아예 안 그리는 것보다 낫다.
    let mime = merged
        .get("artworkMimeType")
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
        .unwrap_or("image/jpeg");
    Some(format!("data:{mime};base64,{data}"))
}

fn non_empty_str(merged: &Map<String, Value>, key: &str) -> Option<String> {
    merged
        .get(key)
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
}

fn micros_to_secs(merged: &Map<String, Value>, key: &str) -> Option<f64> {
    merged
        .get(key)
        .and_then(Value::as_f64)
        .map(|micros| micros / 1_000_000.0)
}
