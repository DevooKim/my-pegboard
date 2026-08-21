import { useCallback, useEffect, useRef, useState } from 'react'
import { commands, events, type NowPlayingPush, type NowPlayingState } from '#/ipc/bindings'
import { IN_TAURI } from '#/ipc/env'
import type { WidgetEnvelope } from '#/widgets/types'
import { envelopeFrom } from './state'

const IDLE: WidgetEnvelope<NowPlayingState> = {
  status: 'idle',
  data: null,
  fetchedAt: null,
  error: null,
}

const BROWSER: WidgetEnvelope<NowPlayingState> = {
  status: 'error-permanent',
  data: null,
  fetchedAt: null,
  error: {
    status: 'error-permanent',
    message: '브라우저에서는 시스템 재생 정보를 읽을 수 없습니다. 앱으로 실행하세요.',
  },
}

/**
 * "지금 재생 중" 데이터 수명주기.
 *
 * ## 다른 위젯 훅과 다른 두 가지
 *
 * 1. **폴링이 없다.** Rust가 시스템 미디어 변화를 이벤트로 push한다 —
 *    `setInterval`도 새로고침 주기 설정도 없다. 마운트 = 구독, 언마운트 = 해지이며
 *    구독자가 0이면 Rust가 어댑터 프로세스를 내린다("언마운트 = 폴링 중단"의
 *    이벤트판).
 * 2. **디스크 캐시가 없다.** "지금 재생 중"은 지난 데이터를 그리면 거짓말이 되는
 *    유일한 위젯이다 (대전제 1의 명시적 예외 — DECISIONS 27). 대신 구독 응답이
 *    현재 상태를 즉시 돌려주므로 리마운트(보드 탭 복귀)에도 빈 화면이 없다.
 *
 * ## 순서가 중요하다
 *
 * 이벤트 리스너를 **먼저** 걸고 나서 구독한다. 반대로 하면 구독 직후의 첫 push를
 * 놓칠 수 있다. 또 push가 이미 도착했다면 (더 오래된) 구독 응답으로 덮지 않는다.
 */
export function useNowPlaying(): {
  envelope: WidgetEnvelope<NowPlayingState>
  refresh: () => void
} {
  const [envelope, setEnvelope] = useState<WidgetEnvelope<NowPlayingState>>(
    IN_TAURI ? IDLE : BROWSER,
  )
  // 이벤트 push가 한 번이라도 왔는가. 구독 응답(스냅샷)이 이벤트보다 늦게
  // 도착했을 때 더 신선한 화면을 낡은 스냅샷으로 되돌리지 않기 위한 것.
  const gotPush = useRef(false)

  const apply = useCallback((push: NowPlayingPush) => {
    setEnvelope((prev) => envelopeFrom(push, prev.data))
  }, [])

  useEffect(() => {
    if (!IN_TAURI) return
    let cancelled = false
    let unlisten: (() => void) | null = null
    gotPush.current = false

    void events.nowPlayingPush
      .listen((event) => {
        if (cancelled) return
        gotPush.current = true
        apply(event.payload)
      })
      .then((un) => {
        if (cancelled) {
          un()
          return
        }
        unlisten = un
        return commands.nowplayingSubscribe().then((result) => {
          if (cancelled || gotPush.current) return
          if (result.status === 'ok') {
            apply(result.data)
          } else {
            apply({ state: null, error: result.error })
          }
        })
      })

    return () => {
      cancelled = true
      unlisten?.()
      // 해지 실패는 복구할 방법이 없고(창이 닫히는 중일 수도 있다),
      // 최악의 경우도 어댑터 프로세스 하나가 유휴로 남는 것뿐이다.
      void commands.nowplayingUnsubscribe()
    }
  }, [apply])

  // 새로고침 = 재연결. 스트림이 죽었거나 이상할 때의 복구 경로다.
  // 반환값(초기화된 빈 상태)을 그리지 않고 새 스트림의 첫 push를 기다린다 —
  // 그리면 정상 재생 중에도 "재생 없음"이 한 번 깜빡인다.
  const refresh = useCallback(() => {
    if (!IN_TAURI) return
    setEnvelope((prev) => ({ ...prev, status: prev.data ? prev.status : 'loading' }))
    void commands.nowplayingReconnect().then((result) => {
      if (result.status !== 'ok') apply({ state: null, error: result.error })
    })
  }, [apply])

  return { envelope, refresh }
}
