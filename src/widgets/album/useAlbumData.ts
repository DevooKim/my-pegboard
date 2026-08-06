import { useCallback, useEffect, useRef, useState } from 'react'
import { type AlbumPhoto, type AlbumSource, commands } from '#/ipc/bindings'
import { IN_TAURI } from '#/ipc/env'
import type { WidgetEnvelope } from '#/widgets/types'
import type { AlbumWidgetConfig } from './index'

export type AlbumData = { photos: AlbumPhoto[]; skipped: number }

const IDLE: WidgetEnvelope<AlbumData> = {
  status: 'idle',
  data: null,
  fetchedAt: null,
  error: null,
}

/**
 * 위젯 id → 마지막 envelope. 보드 탭을 오갈 때의 깜빡임을 없앤다.
 * 근거는 `useJiraData`의 같은 맵에 적어 뒀다.
 *
 * 앨범은 목록이 사라지는 것보다 **사진이 한 번 비는 것**이 더 눈에 띈다 —
 * 배경으로 쓰는 위젯이라 빈 칸이 그대로 화면 구멍이 된다.
 */
const lastEnvelopes = new Map<string, WidgetEnvelope<AlbumData>>()

/**
 * 앨범 위젯의 데이터 수명주기.
 *
 * `useGithubData`와 같은 순서다 — **캐시 먼저, 스캔 나중** (DECISIONS 17):
 *   1. 마운트 즉시 디스크 캐시를 읽어 첫 장을 그린다 (0ms 목표)
 *   2. 그 다음 폴더를 다시 훑는다
 *   3. 실패해도 1에서 그린 목록을 지우지 않는다
 *
 * 3번이 여기서 특히 중요하다. 외장 디스크나 NAS는 잠들어 있으면 스캔이 수 초
 * 걸리고, 분리돼 있으면 아예 실패한다. 그동안 사진이 사라지면 배경으로서
 * 고장난 것이다.
 *
 * # 주기 폴링이 없다
 *
 * GitHub·Jira 훅에 있는 `setInterval` 갱신이 여기엔 없다. 사진 폴더는 5분마다
 * 바뀌지 않는다. `refreshSecs` 대신 `intervalSecs`가 있는데, 그건 **사진을
 * 넘기는 주기**이지 데이터를 다시 가져오는 주기가 아니다 — 그 타이머는
 * View가 소유한다.
 *
 * # 설정 전체가 아니라 소스만 받는다
 *
 * `useGithubData`는 설정 전체를 받아 `configKey`로 비교하지만, 여기서는
 * **소스만** 본다. 순환 주기나 제목을 바꿨다고 폴더를 다시 훑을 이유가 없고,
 * 설정 전체를 의존성에 넣으면 사용자가 주기를 3초에서 4초로 고칠 때마다
 * 외장 디스크를 깨우게 된다.
 */
export function useAlbumData(
  widgetId: string,
  source: AlbumWidgetConfig['source'],
): { envelope: WidgetEnvelope<AlbumData>; refresh: () => void } {
  // 리마운트(탭 복귀)면 마지막 결과에서 이어 시작한다.
  const [envelope, setEnvelope] = useState<WidgetEnvelope<AlbumData>>(
    () => lastEnvelopes.get(widgetId) ?? IDLE,
  )

  useEffect(() => {
    if (envelope.data) lastEnvelopes.set(widgetId, envelope)
  }, [widgetId, envelope])

  // 소스 객체는 매 렌더 새로 만들어질 수 있으므로 값으로 비교한다.
  const sourceKey = JSON.stringify(source)
  const inFlight = useRef(false)

  const rescan = useCallback(async () => {
    if (inFlight.current) return
    // 값으로 비교하려면 의존성이 문자열이어야 한다. 다시 객체로 되돌린다.
    const source = JSON.parse(sourceKey) as AlbumSource | null

    // 아직 아무것도 고르지 않았다. 에러가 아니라 빈 상태다 —
    // View가 "폴더 선택" 버튼을 그린다.
    if (!source) {
      setEnvelope({ status: 'empty', data: null, fetchedAt: null, error: null })
      return
    }

    // 브라우저 dev 서버에는 IPC도 `asset:`도 없다. 영원한 로딩 대신 이유를 말한다.
    if (!IN_TAURI) {
      setEnvelope({
        status: 'error-permanent',
        data: null,
        fetchedAt: null,
        error: {
          status: 'error-permanent',
          message:
            '브라우저에서는 로컬 사진을 표시할 수 없습니다 (asset: 프로토콜이 없습니다). 앱으로 실행하세요.',
        },
      })
      return
    }
    inFlight.current = true

    // 사진이 이미 있으면 status만 바꾸고 목록은 유지한다.
    setEnvelope((prev) => ({ ...prev, status: prev.data ? prev.status : 'loading' }))

    try {
      const result = await commands.albumRescan(widgetId, source)
      if (result.status === 'ok') {
        setEnvelope({
          status: result.data.photos.length === 0 ? 'empty' : 'ready',
          data: { photos: result.data.photos, skipped: result.data.skipped },
          fetchedAt: new Date().toISOString(),
          error: null,
        })
      } else {
        // 로컬 파일시스템의 실패는 기다려서 풀리지 않는다 — 전부 영구적이다
        // (providers/album/error.rs 주석). 사용자가 디스크를 다시 꽂거나
        // 폴더를 다시 골라야 한다.
        setEnvelope((prev) => ({
          status: 'error-permanent',
          // **직전 목록을 유지한다.** NAS가 잠깐 사라져도 배경은 계속 돈다.
          data: prev.data,
          fetchedAt: prev.fetchedAt,
          error: {
            status: 'error-permanent',
            message: result.error,
            action: { label: '위젯 설정', kind: 'open-config' },
          },
        }))
      }
    } finally {
      inFlight.current = false
    }
  }, [widgetId, sourceKey])

  // 1단계: 캐시를 먼저 그린다.
  useEffect(() => {
    if (!IN_TAURI) return
    let cancelled = false
    void commands.albumCached(widgetId).then((result) => {
      if (cancelled || result.status !== 'ok' || !result.data) return
      const cached = result.data
      setEnvelope((prev) => {
        if (prev.data) return prev // 스캔이 이미 이겼으면 덮지 않는다
        return {
          status: 'stale',
          data: { photos: cached.photos, skipped: cached.skipped },
          fetchedAt: cached.fetchedAt,
          error: null,
        }
      })
    })
    return () => {
      cancelled = true
    }
  }, [widgetId])

  // 2단계: 스캔. **주기 폴링은 없다** (위 주석 참조).
  useEffect(() => {
    void rescan()
  }, [rescan])

  // 전역 새로고침 (⌘R, 설정 저장 직후).
  useEffect(() => {
    const onRefreshAll = () => void rescan()
    window.addEventListener('pegboard:refresh-all', onRefreshAll)
    return () => window.removeEventListener('pegboard:refresh-all', onRefreshAll)
  }, [rescan])

  return { envelope, refresh: () => void rescan() }
}
