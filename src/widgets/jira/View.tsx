import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { JiraIssue, JiraWidgetConfig } from '#/ipc/bindings'
import { useBoardStore } from '#/store/board'
import { useConnectionStore } from '#/store/connection'
import { useNow } from '#/ui/relativeTime'
import type { WidgetViewProps } from '#/widgets/types'
import { ColumnHeader } from './ColumnHeader'
import { type ColumnWidths, visibleColumns, withDefaults } from './columns'
import { IssueDetailModal } from './IssueDetailModal'
import { IssueRow } from './IssueRow'

/**
 * Jira 위젯 본문.
 *
 * **한 번 데이터가 그려진 뒤로는 본문을 비우지 않는다** (DESIGN.md).
 * 갱신 중이든 일시적 실패든 직전 목록을 계속 보여준다. 이것이 Jira 웹과의
 * 차이이자 이 앱의 존재 이유다.
 */
export function JiraView({
  widgetId,
  config,
  envelope,
  width,
}: WidgetViewProps<JiraWidgetConfig, { issues: JiraIssue[] }>) {
  const baseUrl = useConnectionStore((s) => s.jiraBaseUrl)
  const updateConfig = useBoardStore((s) => s.updateWidgetConfig)

  // 열 너비는 위젯 설정에 저장된다 — 위젯마다 다르게 둘 수 있다.
  const widths = withDefaults(
    (config as JiraWidgetConfig & { columnWidths?: Partial<ColumnWidths> }).columnWidths,
  )

  // 행의 상대 시간도 1분마다 갱신한다. key로 넘겨 IssueRow를 다시 그린다.
  const now = useNow()
  const visible = visibleColumns(config.columns)

  // 목록에 스크롤바가 생기면 그만큼 헤더를 밀어줘야 열이 어긋나지 않는다.
  // macOS는 오버레이 스크롤바라 보통 0이지만, 마우스를 연결하면 폭이 생긴다.
  // 열려 있는 상세 모달. seed는 목록이 이미 가진 값 — 0ms 골격의 재료다 (D2).
  const [detail, setDetail] = useState<{ key: string; seed: JiraIssue | null } | null>(null)

  const listRef = useRef<HTMLUListElement | null>(null)
  const [scrollbar, setScrollbar] = useState(0)
  useEffect(() => {
    const el = listRef.current
    if (!el) return
    const measure = () => setScrollbar(el.offsetWidth - el.clientWidth)
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => ro.disconnect()
  })

  const resizeColumn = useCallback(
    (col: keyof ColumnWidths, px: number) => {
      updateConfig(widgetId, {
        ...(config as unknown as Record<string, unknown>),
        columnWidths: { ...widths, [col]: px },
      })
    },
    [widgetId, config, widths, updateConfig],
  )

  const density = useMemo<'compact' | 'normal' | 'wide'>(() => {
    // DESIGN.md 4.7 — 실측 기준. 3열≈240px, 5열≈420px.
    if (width < 300) return 'compact'
    if (width < 420) return 'normal'
    return 'wide'
  }, [width])

  // 티켓 키 → Jira 웹 URL. 연결 설정이 없으면 링크가 아니라 평범한 텍스트가 된다.
  const browseUrl = useCallback(
    (key: string) => (baseUrl ? `${baseUrl.replace(/\/$/, '')}/browse/${key}` : null),
    [baseUrl],
  )

  const issues = envelope.data?.issues ?? []

  // 아직 한 번도 데이터를 못 받은 상태에서만 로딩/에러가 본문을 차지한다.
  if (issues.length === 0) {
    if (envelope.status === 'loading' || envelope.status === 'idle') {
      return <Centered>불러오는 중…</Centered>
    }
    if (envelope.error) {
      return <ErrorBody message={envelope.error.message} />
    }
    return <Centered>조건에 맞는 티켓이 없습니다</Centered>
  }

  return (
    <div
      className="flex h-full flex-col"
      style={{ ['--pegboard-scrollbar' as string]: `${scrollbar}px` }}
    >
      {/* 목록에 스크롤바가 생기면 그만큼 헤더를 좁혀야 열이 어긋나지 않는다.
          헤더 안쪽 패딩으로 하면 1fr이 넓어져 뒤 트랙이 밀리므로 바깥에서 준다. */}
      <div style={{ paddingRight: scrollbar }}>
        <ColumnHeader widths={widths} density={density} visible={visible} onResize={resizeColumn} />
      </div>
      <ul ref={listRef} className="min-h-0 flex-1 overflow-y-auto">
        {issues.map((issue) => (
          <li key={issue.key}>
            <IssueRow
              issue={issue}
              density={density}
              widths={widths}
              visible={visible}
              now={now}
              browseUrl={browseUrl}
              onOpen={() => setDetail({ key: issue.key, seed: issue })}
            />
          </li>
        ))}
      </ul>

      {/* Modal이 포털이라 위치는 무관하다. 목록 뒤에 두어 읽는 순서를 맞춘다. */}
      <IssueDetailModal
        issueKey={detail?.key ?? null}
        seed={detail?.seed ?? null}
        onClose={() => setDetail(null)}
      />

      {/* 목록은 그대로 두고 실패만 아래에 얇게 알린다 */}
      {envelope.status === 'error-transient' && envelope.error && (
        <p className="shrink-0 border-t border-border-subtle px-2 py-1 text-caption text-stale">
          갱신 실패 — 재시도 중
        </p>
      )}
      {envelope.status === 'error-permanent' && envelope.error && (
        <p className="shrink-0 border-t border-border-subtle px-2 py-1 text-caption text-danger">
          {envelope.error.message}
        </p>
      )}
      {config.maxResults > 0 && issues.length >= config.maxResults && (
        <p className="shrink-0 px-2 py-1 text-caption text-text-quaternary">
          {config.maxResults}건까지 표시
        </p>
      )}
    </div>
  )
}

function Centered({ children }: { children: React.ReactNode }) {
  return (
    <div className="grid h-full place-items-center px-3 text-center text-caption text-text-tertiary">
      {children}
    </div>
  )
}

function ErrorBody({ message }: { message: string }) {
  return (
    <div className="grid h-full place-items-center px-3">
      {/* Jira의 JQL 오류 메시지는 그대로 보여준다 — 우리가 고쳐 쓰면 더 나빠진다 */}
      <p className="text-center text-caption text-danger leading-relaxed-ko">{message}</p>
    </div>
  )
}
