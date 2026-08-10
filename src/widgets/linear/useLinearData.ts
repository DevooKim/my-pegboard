import { useCallback, useEffect, useRef, useState } from 'react'
import { commands, type LinearIssue, type LinearWidgetConfig } from '#/ipc/bindings'
import { IN_TAURI } from '#/ipc/env'
import { useConnectionStore } from '#/store/connection'
import type { WidgetEnvelope } from '#/widgets/types'
import { LINEAR_STATE_CHANGED_EVENT } from './StatePopover'

type Data = { issues: LinearIssue[]; hasMore: boolean }

const IDLE: WidgetEnvelope<Data> = { status: 'idle', data: null, fetchedAt: null, error: null }
const MAX_TRANSIENT_RETRIES = 3
const RETRY_BASE_MS = 1_000
type FetchReason = 'regular' | 'retry' | 'mutation'

/**
 * 위젯 id → 마지막 envelope. **보드 탭을 오갈 때의 깜빡임을 없앤다.**
 *
 * 비활성 보드는 렌더하지 않으므로(그게 폴링을 멈추는 방식이다) 탭을 돌아오면
 * 이 훅이 새로 마운트되고 `useState(IDLE)`부터 시작한다. 캐시 읽기는 비동기라
 * 그 사이 한 프레임 이상 "불러오는 중…"이 그려지고, 데이터가 도착하면 목록이
 * 튀어 들어온다 — 방금 보고 있던 탭으로 돌아왔는데도 그렇다.
 *
 * 모듈 스코프에 마지막 결과를 남겨두면 리마운트가 **데이터를 든 상태로**
 * 시작한다. 디스크 캐시를 대신하는 게 아니라 그 앞단이다(디스크는 앱을 새로
 * 켤 때, 이건 세션 안에서 탭을 오갈 때).
 *
 * `useJiraData`·`useGithubData`·`useAlbumData`에 같은 맵이 있다.
 *
 * 위젯을 지우면 항목이 남지만 위젯 id는 재사용되지 않으므로 다시 읽히지 않는다.
 */
const lastEnvelopes = new Map<string, WidgetEnvelope<Data>>()

/** 테스트에서 맵을 비운다. 프로덕션 코드에서는 부르지 않는다. */
export function __resetLinearEnvelopes() {
  lastEnvelopes.clear()
}

/**
 * 위젯 하나의 데이터 수명주기.
 *
 * `useGithubData`와 같은 순서다 — **캐시 먼저, 네트워크 나중** (DECISIONS 17장):
 *   1. 마운트 즉시 디스크 캐시를 읽어 그린다 (0ms 목표)
 *   2. 그 다음 네트워크 갱신을 시작한다
 *   3. 실패해도 1에서 그린 목록을 지우지 않는다
 *
 * GitHub 훅과 다른 것이 하나 있다: **상태 변경 후 재조회**다. Linear 위젯은
 * 읽기 전용이 아니라 상태를 바꿀 수 있어서(DECISIONS 25.1), 성공 뒤 목록을
 * 다시 불러온다. Jira 위젯의 `pegboard:jira-transitioned`와 같은 구조다.
 */
export function useLinearData(
  widgetId: string,
  config: LinearWidgetConfig,
  refreshMs: number,
): { envelope: WidgetEnvelope<Data>; refresh: () => void } {
  // 리마운트(탭 복귀)면 마지막 결과에서 이어 시작한다. 위 주석 참조.
  const [envelope, setEnvelope] = useState<WidgetEnvelope<Data>>(
    () => lastEnvelopes.get(widgetId) ?? IDLE,
  )
  const setAuthFailed = useConnectionStore((s) => s.setLinearAuthFailed)

  // 화면에 그려진 마지막 상태를 기억해 둔다.
  useEffect(() => {
    if (envelope.data) lastEnvelopes.set(widgetId, envelope)
  }, [widgetId, envelope])

  // 설정 객체는 매 렌더 새로 만들어질 수 있으므로 값으로 비교한다.
  const configKey = JSON.stringify(config)
  const inFlight = useRef(false)
  const retryAttempt = useRef(0)
  const retryTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const fetchNowRef = useRef<(reason?: FetchReason) => Promise<void>>(async () => {})
  const pendingMutationRefresh = useRef(false)
  const active = useRef(true)

  const cancelRetry = useCallback(() => {
    if (retryTimer.current !== null) clearTimeout(retryTimer.current)
    retryTimer.current = null
    retryAttempt.current = 0
  }, [])

  const fetchNow = useCallback(
    async (reason: FetchReason = 'regular') => {
      if (inFlight.current) {
        if (reason === 'mutation') pendingMutationRefresh.current = true
        return
      }
      const retrying = reason === 'retry'
      // rate-limit 리셋을 기다리는 중이면 정기 폴링도 그 시각을 앞당기지 않는다.
      if (!retrying && retryTimer.current !== null) {
        if (reason === 'mutation') pendingMutationRefresh.current = true
        return
      }
      // 지금 시작하는 조회가 그 전에 밀린 상태 변경까지 함께 반영한다.
      pendingMutationRefresh.current = false
      // 사용자가 누른 새로고침·정기 폴링·상태 변경은 새 시도 묶음이다.
      if (!retrying) cancelRetry()
      // Tauri 밖(브라우저 dev)에서는 IPC가 없다. 영원한 로딩 대신 이유를 말한다.
      if (!IN_TAURI) {
        setEnvelope({
          status: 'error-permanent',
          data: null,
          fetchedAt: null,
          error: {
            status: 'error-permanent',
            message: '브라우저에서는 Linear를 불러올 수 없습니다. 앱으로 실행하세요.',
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
        const result = await commands.linearFetch(widgetId, JSON.parse(configKey))
        if (!active.current) return
        if (result.status === 'ok') {
          cancelRetry()
          setAuthFailed(false)
          setEnvelope({
            status: result.data.issues.length === 0 ? 'empty' : 'ready',
            data: { issues: result.data.issues, hasMore: result.data.hasMore ?? false },
            fetchedAt: result.data.fetchedAt,
            error: null,
          })
        } else {
          const e = result.error
          if (e.isAuthFailure) setAuthFailed(true)
          const shouldRetry = e.kind === 'transient' && retryAttempt.current < MAX_TRANSIENT_RETRIES
          if (shouldRetry) {
            const attempt = retryAttempt.current + 1
            retryAttempt.current = attempt
            const backoffMs = RETRY_BASE_MS * 2 ** (attempt - 1)
            const serverDelayMs = (e.retryAfterSecs ?? 0) * 1_000
            retryTimer.current = setTimeout(
              () => {
                retryTimer.current = null
                void fetchNowRef.current('retry')
              },
              Math.max(backoffMs, serverDelayMs),
            )
          } else {
            cancelRetry()
          }
          setEnvelope((prev) => {
            // Rust가 직전 성공 데이터를 함께 줬으면 그것을, 없으면 지금 것을 유지.
            const kept = e.stale
              ? { issues: e.stale.issues, hasMore: e.stale.hasMore ?? false }
              : prev.data
            return {
              status: e.kind === 'transient' ? 'error-transient' : 'error-permanent',
              data: kept,
              fetchedAt: e.stale?.fetchedAt ?? prev.fetchedAt,
              error: {
                status: e.kind === 'transient' ? 'error-transient' : 'error-permanent',
                message: e.message,
                retrying: shouldRetry,
                ...(e.isAuthFailure
                  ? { action: { label: '설정 열기', kind: 'open-settings' as const } }
                  : {}),
              },
            }
          })
        }
      } finally {
        inFlight.current = false
        // 상태 변경 직후의 전용 조회는 버리지 않는다. 다만 rate limit 대기
        // 중이면 예약된 재시도가 곧 최신 상태를 읽으므로 그때 함께 처리한다.
        if (active.current && pendingMutationRefresh.current && retryTimer.current === null) {
          pendingMutationRefresh.current = false
          void fetchNowRef.current('mutation')
        }
      }
    },
    [widgetId, configKey, setAuthFailed, cancelRetry],
  )

  fetchNowRef.current = fetchNow

  // 위젯이 사라진 뒤 예약 재시도와 늦게 끝난 IPC 응답을 모두 버린다.
  useEffect(() => {
    active.current = true
    return () => {
      active.current = false
      cancelRetry()
    }
  }, [cancelRetry])

  // 1단계: 캐시를 먼저 그린다.
  useEffect(() => {
    if (!IN_TAURI) return
    let cancelled = false
    void commands.linearCached(widgetId).then((result) => {
      if (cancelled || result.status !== 'ok' || !result.data) return
      const cached = result.data
      setEnvelope((prev) => {
        if (prev.data) return prev // 네트워크가 이미 이겼으면 덮지 않는다
        return {
          status: 'stale',
          data: { issues: cached.issues, hasMore: cached.hasMore ?? false },
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

  // 상태 변경·생성 직후의 갱신.
  //
  // **낙관적 업데이트를 하지 않는다.** 목표 상태는 알지만 Linear의 자동화
  // (상태가 바뀌면 담당자를 붙이는 등)를 예측할 수 없다. 다시 조회하는 편이
  // 정직하다 — Jira 전이와 같은 판단(DECISIONS 11.5 / 25.5).
  //
  // `refresh-all`을 쓰지 않는 이유: 그쪽은 Jira·GitHub·Web 위젯까지 전부 다시
  // 부른다. 이슈 하나의 상태가 바뀐 것으로 보드 전체를 두들길 이유가 없다.
  useEffect(() => {
    const onMutation = () => void fetchNow('mutation')
    window.addEventListener(LINEAR_STATE_CHANGED_EVENT, onMutation)
    window.addEventListener('pegboard:linear-created', onMutation)
    return () => {
      window.removeEventListener(LINEAR_STATE_CHANGED_EVENT, onMutation)
      window.removeEventListener('pegboard:linear-created', onMutation)
    }
  }, [fetchNow])

  return { envelope, refresh: () => void fetchNow() }
}
