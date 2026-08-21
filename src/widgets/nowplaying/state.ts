import type { NowPlayingPush, NowPlayingState } from '#/ipc/bindings'
import type { WidgetEnvelope } from '#/widgets/types'

/**
 * push 봉투 → 위젯 봉투. 순수 함수 — 훅을 거치지 않고 테스트한다.
 *
 * - `error` → error-permanent. 어댑터 실패는 기다려서 풀리지 않는다 —
 *   새로고침(재연결)이 복구 경로고, 그 안내는 View가 그린다.
 * - `state: null` → empty. 재생 중인 것이 없는 정상 상태다.
 */
export function envelopeFrom(
  push: NowPlayingPush,
  prev: NowPlayingState | null,
): WidgetEnvelope<NowPlayingState> {
  if (push.error) {
    return {
      status: 'error-permanent',
      data: null,
      fetchedAt: null,
      error: { status: 'error-permanent', message: push.error },
    }
  }
  const state = mergeArtwork(prev, push.state)
  return {
    status: state ? 'ready' : 'empty',
    data: state,
    fetchedAt: null,
    error: null,
  }
}

/**
 * 앨범아트 이어받기.
 *
 * Rust는 직전 push와 같은 아트면 `artwork: null`(토큰만)로 내려 이미지를
 * IPC로 반복 전송하지 않는다. 토큰이 같으면 직전 아트를 그대로 쓴다.
 * 이 병합이 빠지면 타임라인 갱신(수 초 간격)마다 아트가 깜빡 사라진다.
 */
export function mergeArtwork(
  prev: NowPlayingState | null,
  next: NowPlayingState | null,
): NowPlayingState | null {
  if (!next) return null
  if (
    next.artwork === null &&
    next.artworkToken !== null &&
    prev !== null &&
    prev.artworkToken === next.artworkToken &&
    prev.artwork !== null
  ) {
    return { ...next, artwork: prev.artwork }
  }
  return next
}

/**
 * 현재 재생 위치 추정.
 *
 * 어댑터는 초마다 push하지 않는다(실측: 수 초 간격). `elapsedSecs`는
 * `sampledAtMs` 시점의 값이므로, 재생 중이면 그 뒤로 흐른 시간을 배속과 함께
 * 더한다. duration을 넘지 않게 자른다 — 곡 끝에서 push가 늦으면 "3:31 / 3:30"
 * 같은 말이 안 되는 표시가 된다.
 */
export function estimateElapsedSecs(state: NowPlayingState, nowMs: number): number | null {
  if (state.elapsedSecs === null) return null
  let elapsed = state.elapsedSecs
  if (state.playing && state.sampledAtMs !== null) {
    const rate = state.playbackRate ?? 1
    elapsed += Math.max(0, (nowMs - state.sampledAtMs) / 1000) * rate
  }
  if (state.durationSecs !== null && state.durationSecs > 0) {
    elapsed = Math.min(elapsed, state.durationSecs)
  }
  return Math.max(0, elapsed)
}

/** 초 → `m:ss` (한 시간 넘으면 `h:mm:ss`). 진행 표시용. */
export function formatTime(secs: number): string {
  const total = Math.floor(secs)
  const s = total % 60
  const m = Math.floor(total / 60) % 60
  const h = Math.floor(total / 3600)
  const two = (n: number) => String(n).padStart(2, '0')
  return h > 0 ? `${h}:${two(m)}:${two(s)}` : `${m}:${two(s)}`
}
