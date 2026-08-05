import { useCallback, useEffect, useRef, useState } from 'react'
import { commands, type JiraIssue, type JiraWidgetConfig } from '#/ipc/bindings'
import { IN_TAURI } from '#/ipc/env'
import { useConnectionStore } from '#/store/connection'
import { JIRA_TRANSITIONED_EVENT } from '#/widgets/jira/StatusTransitionPopover'
import type { WidgetEnvelope } from '#/widgets/types'

type Data = { issues: JiraIssue[] }

const IDLE: WidgetEnvelope<Data> = { status: 'idle', data: null, fetchedAt: null, error: null }

/**
 * 티켓을 만든 뒤 다시 조회하기까지 기다리는 시간.
 *
 * Jira의 JQL 검색은 Lucene 인덱스를 읽는데, 그 인덱스는 쓰기보다 늦게
 * 따라온다. 생성 응답(201)을 받은 직후에 검색하면 방금 만든 티켓이 아직
 * 안 잡히는 일이 흔하다.
 *
 * 2초는 넉넉한 편이다. 짧으면 놓치고, 길면 사용자가 "왜 안 나오지" 하는
 * 구간이 길어진다. 즉시 조회도 함께 하므로 이 타이머가 헛돌아도 손해가 없다.
 */
const INDEX_LAG_MS = 2000

/**
 * 위젯 하나의 데이터 수명주기.
 *
 * 핵심 순서 — **캐시 먼저, 네트워크 나중** (DECISIONS 17장):
 *   1. 마운트 즉시 디스크 캐시를 동기에 가깝게 읽어 그린다 (0ms 목표)
 *   2. 그 다음 네트워크 갱신을 시작한다
 *   3. 실패해도 1에서 그린 목록을 지우지 않는다
 *
 * 폴링 주기는 위젯별로 다르다. 지금은 프론트 인터벌이지만,
 * 트레이 상주(4차)로 갈 때 Rust 스케줄러로 옮긴다 — 그때 이 훅은
 * 이벤트 구독으로 바뀌고 View는 안 바뀐다.
 */
export function useJiraData(
  widgetId: string,
  config: JiraWidgetConfig,
  refreshMs: number,
): { envelope: WidgetEnvelope<Data>; refresh: () => void } {
  const [envelope, setEnvelope] = useState<WidgetEnvelope<Data>>(IDLE)
  const setAuthFailed = useConnectionStore((s) => s.setJiraAuthFailed)

  // 설정 객체는 매 렌더 새로 만들어질 수 있으므로 값으로 비교한다.
  const configKey = JSON.stringify(config)
  const inFlight = useRef(false)
  /** 생성 후 예약된 재조회. 언마운트 때 정리한다. */
  const timers = useRef(new Set<ReturnType<typeof setTimeout>>())

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
          message: '브라우저에서는 Jira를 불러올 수 없습니다. 앱으로 실행하세요.',
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
      const result = await commands.jiraFetch(widgetId, JSON.parse(configKey))
      if (result.status === 'ok') {
        setAuthFailed(false)
        setEnvelope({
          status: result.data.issues.length === 0 ? 'empty' : 'ready',
          data: { issues: result.data.issues },
          fetchedAt: result.data.fetchedAt,
          error: null,
        })
      } else {
        const e = result.error
        if (e.isAuthFailure) setAuthFailed(true)
        setEnvelope((prev) => {
          // Rust가 직전 성공 데이터를 함께 줬으면 그것을, 없으면 지금 것을 유지.
          const kept = e.stale ? { issues: e.stale.issues } : prev.data
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
    void commands.jiraCached(widgetId).then((result) => {
      if (cancelled || result.status !== 'ok' || !result.data) return
      const cached = result.data
      setEnvelope((prev) => {
        if (prev.data) return prev // 네트워크가 이미 이겼으면 덮지 않는다
        return {
          status: 'stale',
          data: { issues: cached.issues },
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

  // 티켓 생성 직후의 갱신.
  //
  // `refresh-all`과 따로 두는 이유는 **Jira 검색 인덱스가 쓰기보다 늦기
  // 때문**이다. 생성 응답을 받은 즉시 JQL로 물으면 방금 만든 티켓이 아직
  // 안 잡힌다 — 목록이 그대로라 "갱신이 안 된다"로 보인다.
  //
  // 그래서 두 번 조회한다: 즉시 한 번(다른 변경사항을 빨리 반영), 잠시 뒤
  // 한 번(인덱스가 따라잡은 뒤). 폴링 루프를 도는 것보다 단순하고,
  // 두 번째가 헛돌아도 비용이 조회 한 번이다.
  useEffect(() => {
    const onCreated = () => {
      void fetchNow()
      const id = setTimeout(() => void fetchNow(), INDEX_LAG_MS)
      timers.current.add(id)
    }
    window.addEventListener('pegboard:jira-created', onCreated)
    return () => window.removeEventListener('pegboard:jira-created', onCreated)
  }, [fetchNow])

  // 상태 전이 직후의 갱신 (DECISIONS 11.5 개정).
  //
  // 생성과 달리 **즉시 한 번만** 조회한다. 전이는 이슈를 새로 만드는 것이 아니라
  // 이미 인덱스에 있는 문서를 갱신하는 것이라, 검색 인덱스 지연을 기다릴 이유가
  // 적다. 갱신이 늦어 옛 상태가 한 번 더 보여도 다음 폴링이 잡는다.
  //
  // **낙관적 업데이트를 하지 않는다.** 도달 상태는 Rust가 알려주지만
  // 워크플로우 후처리(자동 담당자 변경 등)는 예측할 수 없다.
  useEffect(() => {
    const onTransitioned = () => void fetchNow()
    window.addEventListener(JIRA_TRANSITIONED_EVENT, onTransitioned)
    return () => window.removeEventListener(JIRA_TRANSITIONED_EVENT, onTransitioned)
  }, [fetchNow])

  // 언마운트될 때 예약된 재조회를 정리한다. 안 하면 위젯을 지운 뒤에도
  // 타이머가 살아 setState를 호출한다.
  useEffect(() => {
    const pending = timers.current
    return () => {
      for (const id of pending) clearTimeout(id)
      pending.clear()
    }
  }, [])

  return { envelope, refresh: () => void fetchNow() }
}
