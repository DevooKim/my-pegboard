import { openUrl } from '@tauri-apps/plugin-opener'
import { useCallback, useMemo } from 'react'
import type { JiraIssue, JiraWidgetConfig } from '#/ipc/bindings'
import { useConnectionStore } from '#/store/connection'
import type { WidgetViewProps } from '#/widgets/types'
import { IssueRow } from './IssueRow'

/**
 * Jira 위젯 본문.
 *
 * **한 번 데이터가 그려진 뒤로는 본문을 비우지 않는다** (DESIGN.md).
 * 갱신 중이든 일시적 실패든 직전 목록을 계속 보여준다. 이것이 Jira 웹과의
 * 차이이자 이 앱의 존재 이유다.
 */
export function JiraView({
  config,
  envelope,
  width,
}: WidgetViewProps<JiraWidgetConfig, { issues: JiraIssue[] }>) {
  const baseUrl = useConnectionStore((s) => s.jiraBaseUrl)

  const density = useMemo<'compact' | 'normal' | 'wide'>(() => {
    // DESIGN.md 4.7 — 실측 기준. 3열≈240px, 5열≈420px.
    if (width < 300) return 'compact'
    if (width < 420) return 'normal'
    return 'wide'
  }, [width])

  const openIssue = useCallback(
    (key: string) => {
      if (!baseUrl) return
      void openUrl(`${baseUrl.replace(/\/$/, '')}/browse/${key}`)
    },
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
    <div className="flex h-full flex-col">
      <ul className="min-h-0 flex-1 overflow-y-auto">
        {issues.map((issue) => (
          <li key={issue.key}>
            <IssueRow issue={issue} density={density} onOpen={openIssue} />
          </li>
        ))}
      </ul>

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
