//! nowplaying provider 테스트.
//!
//! 픽스처는 이 기기에서 실측한 스트림 출력(2026-08-22)을 `--micros` 키로 옮긴
//! 것이다. 어댑터 계약이 바뀌면 여기가 먼저 깨져야 한다 — 위젯이 조용히
//! 빈 화면이 되는 것보다 낫다.

use serde_json::{Map, Value};

use super::adapter::{apply_stream_line, to_state, token_of};
use super::types::NowPlayingCommand;
use super::valid_bundle_id;

fn merged_from(lines: &[&str]) -> Map<String, Value> {
    let mut merged = Map::new();
    for line in lines {
        apply_stream_line(&mut merged, line).expect("픽스처 줄이 파싱돼야 한다");
    }
    merged
}

/// 실측: 스트림 시작 직후 오는 빈 페이로드. "재생 없음"이지 에러가 아니다.
#[test]
fn initial_empty_payload_means_no_media() {
    let merged = merged_from(&[r#"{"type":"data","diff":false,"payload":{}}"#]);
    assert!(to_state(&merged).is_none());
}

/// 실측 전체 페이로드 → 상태. 브라우저 미디어는 artist/album이 빈 문자열로
/// 오는데(실측), 그걸 None으로 바꿔야 프론트가 "표시할 게 있나"를 한 가지
/// 방법으로만 판단한다.
#[test]
fn full_payload_maps_to_state() {
    let merged = merged_from(&[
        r#"{"type":"data","diff":false,"payload":{"artist":"","playbackRate":1,"title":"쿠팡플레이","elapsedTimeMicros":5836915391,"durationMicros":5850611066,"playing":true,"bundleIdentifier":"company.thebrowser.Browser","album":"","timestampEpochMicros":1755806715000000}}"#,
    ]);
    let state = to_state(&merged).expect("필수 키가 다 있다");

    assert_eq!(state.bundle_id, "company.thebrowser.Browser");
    assert_eq!(state.title, "쿠팡플레이");
    assert_eq!(state.artist, None, "빈 문자열은 None이어야 한다");
    assert_eq!(state.album, None);
    assert!(state.playing);
    assert_eq!(state.duration_secs, Some(5850.611066));
    assert_eq!(state.elapsed_secs, Some(5836.915391));
    assert_eq!(state.sampled_at_ms, Some(1755806715000000.0 / 1000.0));
    assert_eq!(state.playback_rate, Some(1.0));
    assert!(state.artwork.is_none());
    assert!(state.artwork_token.is_none());
}

/// diff는 바뀐 키만 갱신하고 나머지를 유지한다. 이게 틀리면 타임라인 갱신마다
/// 제목·아티스트가 사라진다.
#[test]
fn diff_updates_only_changed_keys() {
    let merged = merged_from(&[
        r#"{"type":"data","diff":false,"payload":{"title":"곡 A","artist":"가수","playing":true,"bundleIdentifier":"com.spotify.client","elapsedTimeMicros":1000000}}"#,
        r#"{"type":"data","diff":true,"payload":{"elapsedTimeMicros":5000000}}"#,
    ]);
    let state = to_state(&merged).unwrap();
    assert_eq!(state.title, "곡 A", "diff가 기존 키를 지우면 안 된다");
    assert_eq!(state.artist.as_deref(), Some("가수"));
    assert_eq!(state.elapsed_secs, Some(5.0));
}

/// diff에서 null은 "키가 사라졌다"는 뜻이다 (업스트림 README).
/// 필수 키(title)가 사라지면 상태 전체가 무효다.
#[test]
fn diff_null_removes_key() {
    let merged = merged_from(&[
        r#"{"type":"data","diff":false,"payload":{"title":"곡 A","playing":true,"bundleIdentifier":"com.spotify.client"}}"#,
        r#"{"type":"data","diff":true,"payload":{"title":null}}"#,
    ]);
    assert!(to_state(&merged).is_none(), "title 없는 미디어는 무효다");
}

/// diff:false는 전체 교체다. 이전 트랙의 잔여 키가 남으면 안 된다.
#[test]
fn non_diff_replaces_everything() {
    let merged = merged_from(&[
        r#"{"type":"data","diff":false,"payload":{"title":"곡 A","artist":"가수","playing":true,"bundleIdentifier":"com.spotify.client"}}"#,
        r#"{"type":"data","diff":false,"payload":{"title":"곡 B","playing":true,"bundleIdentifier":"com.spotify.client"}}"#,
    ]);
    let state = to_state(&merged).unwrap();
    assert_eq!(state.title, "곡 B");
    assert_eq!(state.artist, None, "전체 교체 후 이전 artist가 남으면 안 된다");
}

/// 모르는 type은 무시한다 — 업스트림이 새 타입을 추가해도 스트림이 죽지 않게.
/// JSON이 아니면 에러다.
#[test]
fn unknown_type_is_ignored_and_garbage_is_an_error() {
    let mut merged = Map::new();
    apply_stream_line(
        &mut merged,
        r#"{"type":"heartbeat","payload":{"title":"x"}}"#,
    )
    .expect("모르는 타입은 에러가 아니다");
    assert!(merged.is_empty());

    assert!(apply_stream_line(&mut merged, "not json").is_err());
}

/// 앨범아트 → data URI + 토큰. MIME이 없으면 jpeg로 둔다.
#[test]
fn artwork_becomes_data_uri_with_token() {
    let merged = merged_from(&[
        r#"{"type":"data","diff":false,"payload":{"title":"곡","playing":true,"bundleIdentifier":"com.spotify.client","artworkData":"QUJD","artworkMimeType":"image/png"}}"#,
    ]);
    let state = to_state(&merged).unwrap();
    assert_eq!(state.artwork.as_deref(), Some("data:image/png;base64,QUJD"));
    assert_eq!(
        state.artwork_token,
        Some(token_of("data:image/png;base64,QUJD"))
    );

    let no_mime = merged_from(&[
        r#"{"type":"data","diff":false,"payload":{"title":"곡","playing":true,"bundleIdentifier":"com.spotify.client","artworkData":"QUJD"}}"#,
    ]);
    let state = to_state(&no_mime).unwrap();
    assert_eq!(state.artwork.as_deref(), Some("data:image/jpeg;base64,QUJD"));
}

/// 같은 아트는 같은 토큰, 다른 아트는 (사실상) 다른 토큰.
#[test]
fn artwork_token_is_stable() {
    assert_eq!(token_of("data:image/jpeg;base64,AAA"), token_of("data:image/jpeg;base64,AAA"));
    assert_ne!(token_of("data:image/jpeg;base64,AAA"), token_of("data:image/jpeg;base64,BBB"));
}

/// send 명령 ID는 업스트림 README의 표와 일치해야 한다. 여기가 틀리면
/// "다음 곡" 버튼이 엉뚱한 일(정지 등)을 조용히 한다.
#[test]
fn command_ids_match_upstream_table() {
    assert_eq!(NowPlayingCommand::PlayPause.adapter_id(), 2); // kMRTogglePlayPause
    assert_eq!(NowPlayingCommand::Next.adapter_id(), 4); // kMRNextTrack
    assert_eq!(NowPlayingCommand::Previous.adapter_id(), 5); // kMRPreviousTrack
}

#[test]
fn bundle_id_validation() {
    assert!(valid_bundle_id("com.spotify.client"));
    assert!(valid_bundle_id("company.thebrowser.Browser"));
    assert!(valid_bundle_id("com.google.Chrome-Beta"));
    assert!(!valid_bundle_id(""));
    assert!(!valid_bundle_id("com.spotify.client; rm -rf /"));
    assert!(!valid_bundle_id("한글번들"));
}
