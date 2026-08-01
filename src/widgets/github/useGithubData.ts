import { useCallback, useEffect, useRef, useState } from 'react'
import { commands, type GithubItem, type GithubWidgetConfig } from '#/ipc/bindings'
import { IN_TAURI } from '#/ipc/env'
import { useConnectionStore } from '#/store/connection'
import type { WidgetEnvelope } from '#/widgets/types'

type Data = { items: GithubItem[]; total: number }

const IDLE: WidgetEnvelope<Data> = { status: 'idle', data: null, fetchedAt: null, error: null }

/**
 * 위젯 하나의 데이터 수명주기.
 *
 * `useJiraData`와 같은 순서다 — **캐시 먼저, 네트워크 나중** (DECISIONS 17장):
 *   1. 마운트 즉시 디스크 캐시를 읽어 그린다 (0ms 목표)
 *   2. 그 다음 네트워크 갱신을 시작한다
 *   3. 실패해도 1에서 그린 목록을 지우지 않는다
 *
 * Jira 훅에 있는 `pegboard:jira-created` 처리가 여기엔 없다. GitHub 위젯은
 * 읽기 전용이라 우리가 만드는 것이 없고, 따라서 인덱스 지연을 기다릴 이유도 없다.
 */
export function useGithubData(
  widgetId: string,
  config: GithubWidgetConfig,
  refreshMs: number,
): { envelope: WidgetEnvelope<Data>; refresh: () => void } {
  const [envelope, setEnvelope] = useState<WidgetEnvelope<Data>>(IDLE)
  const setAuthFailed = useConnectionStore((s) => s.setGithubAuthFailed)

  // 설정 객체는 매 렌더 새로 만들어질 수 있으므로 값으로 비교한다.
  const configKey = JSON.stringify(config)
  const inFlight = useRef(false)

  const fetchNow = useCallback(async () => {
    if (inFlight.current) return
    // Tauri 밖(브라우저 dev)에서는 IPC가 없다. 영원한 로딩 대신 이유를 말한다.
    if (!IN_TAURI) {
      setEnvelope({
        status: 'error-permanent',
        data: null,
        fetchedAt: null,
        error: {
          status: 'error-permanent',
          message: '브라우저에서는 GitHub을 불러올 수 없습니다. 앱으로 실행하세요.',
        },
      })
      return
    }
    inFlight.current = true

    // 데이터가 이미 있으면 status만 바꾸고 목록은 유지한다.
    setEnvelope((prev) => ({
      ...prev,
      status: prev.data ? prev.status : 'loading',
    }))

    try {
      const result = await commands.githubFetch(widgetId, JSON.parse(configKey))
      if (result.status === 'ok') {
        setAuthFailed(false)
        setEnvelope({
          status: result.data.items.length === 0 ? 'empty' : 'ready',
          data: { items: result.data.items, total: result.data.total },
          fetchedAt: result.data.fetchedAt,
          error: null,
        })
      } else {
        const e = result.error
        if (e.isAuthFailure) setAuthFailed(true)
        setEnvelope((prev) => {
          // Rust가 직전 성공 데이터를 함께 줬으면 그것을, 없으면 지금 것을 유지.
          const kept = e.stale ? { items: e.stale.items, total: e.stale.total } : prev.data
          return {
            status: e.kind === 'transient' ? 'error-transient' : 'error-permanent',
            data: kept,
            fetchedAt: e.stale?.fetchedAt ?? prev.fetchedAt,
            error: {
              status: e.kind === 'transient' ? 'error-transient' : 'error-permanent',
              message: e.message,
              ...(e.isAuthFailure
                ? { action: { label: '설정 열기', kind: 'open-settings' as const } }
                : {}),
            },
          }
        })
      }
    } finally {
      inFlight.current = false
    }
  }, [widgetId, configKey, setAuthFailed])

  // 1단계: 캐시를 먼저 그린다.
  useEffect(() => {
    if (!IN_TAURI) return
    let cancelled = false
    void commands.githubCached(widgetId).then((result) => {
      if (cancelled || result.status !== 'ok' || !result.data) return
      const cached = result.data
      setEnvelope((prev) => {
        if (prev.data) return prev // 네트워크가 이미 이겼으면 덮지 않는다
        return {
          status: 'stale',
          data: { items: cached.items, total: cached.total },
          fetchedAt: cached.fetchedAt,
          error: null,
        }
      })
    })
    return () => {
      cancelled = true
    }
  }, [widgetId])

  // 2단계: 네트워크 갱신 + 주기 폴링.
  useEffect(() => {
    void fetchNow()
    if (refreshMs <= 0) return
    const id = setInterval(() => void fetchNow(), refreshMs)
    return () => clearInterval(id)
  }, [fetchNow, refreshMs])

  // 전역 새로고침 (설정 저장 직후, ⌘R).
  useEffect(() => {
    const onRefreshAll = () => void fetchNow()
    window.addEventListener('pegboard:refresh-all', onRefreshAll)
    return () => window.removeEventListener('pegboard:refresh-all', onRefreshAll)
  }, [fetchNow])

  return { envelope, refresh: () => void fetchNow() }
}
