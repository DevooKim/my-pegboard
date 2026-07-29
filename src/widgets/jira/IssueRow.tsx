import type { JiraIssue } from '#/ipc/bindings'
import { relativeTime } from '#/ui/relativeTime'

/**
 * 티켓 행 하나.
 *
 * 폭에 따라 표현이 바뀐다 (DESIGN.md 4.7 — 실측으로 정한 경계):
 *   3열  상태를 6px 점으로 축약. 요약에 100px 확보.
 *   4열+ 텍스트 배지.
 *   5열+ 담당자 이름까지.
 */
export function IssueRow({
  issue,
  density,
  onOpen,
}: {
  issue: JiraIssue
  density: 'compact' | 'normal' | 'wide'
  onOpen: (key: string) => void
}) {
  // 색의 근거는 상태 '이름'이 아니라 카테고리 키다 — 이름은 프로젝트마다 다르다.
  const statusCategory = issue.status?.statusCategory?.key ?? 'new'

  return (
    <button
      type="button"
      onClick={() => onOpen(issue.key)}
      className="group flex w-full items-center gap-2 rounded px-2 py-1.5 text-left
                 transition-colors duration-fast hover:bg-surface-inset
                 focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-accent"
      style={{ borderLeft: `2px solid ${priorityColor(issue.priority?.name)}` }}
    >
      <span className="shrink-0 font-mono text-ticket-key text-text-tertiary tabular-nums">
        {issue.key}
      </span>

      <span
        className="min-w-0 flex-1 truncate text-body text-text-primary leading-tight-ko"
        title={issue.summary}
      >
        {issue.summary}
      </span>

      {density === 'compact' ? (
        <span
          role="img"
          className="size-1.5 shrink-0 rounded-full"
          style={{ backgroundColor: statusColor(statusCategory) }}
          title={issue.status?.name ?? '상태 없음'}
          aria-label={issue.status?.name ?? '상태 없음'}
        />
      ) : (
        <span
          className="shrink-0 rounded px-1.5 py-0.5 text-caption"
          style={{
            color: statusColor(statusCategory),
            backgroundColor: statusMuted(statusCategory),
          }}
        >
          {issue.status?.name ?? '—'}
        </span>
      )}

      <Assignee issue={issue} showName={density === 'wide'} />

      {density === 'wide' && issue.updated && (
        <span className="shrink-0 text-caption text-text-quaternary tabular-nums">
          {relativeTime(issue.updated)}
        </span>
      )}
    </button>
  )
}

function Assignee({ issue, showName }: { issue: JiraIssue; showName: boolean }) {
  const assignee = issue.assignee
  if (!assignee) {
    return (
      <span
        role="img"
        className="size-5 shrink-0 rounded-full border border-dashed border-border-subtle"
        title="미할당"
        aria-label="미할당"
      />
    )
  }
  return (
    <span className="flex shrink-0 items-center gap-1.5" title={assignee.displayName ?? undefined}>
      {assignee.avatarUrl ? (
        <img
          src={assignee.avatarUrl}
          alt=""
          className="size-5 rounded-full"
          loading="lazy"
          decoding="async"
        />
      ) : (
        <span className="grid size-5 place-items-center rounded-full bg-surface-inset text-caption text-text-tertiary">
          {(assignee.displayName ?? '?').slice(0, 1)}
        </span>
      )}
      {showName && (
        <span className="max-w-16 truncate text-caption text-text-tertiary">
          {assignee.displayName}
        </span>
      )}
    </span>
  )
}

/** Medium(P3)은 일부러 그리지 않는다 — 모든 행에 표시가 뜨면 신호가 죽는다. */
function priorityColor(name: string | null | undefined): string {
  switch (name) {
    case 'Highest':
      return 'var(--color-priority-highest)'
    case 'High':
      return 'var(--color-priority-high)'
    case 'Low':
      return 'var(--color-priority-low)'
    case 'Lowest':
      return 'var(--color-priority-lowest)'
    default:
      return 'transparent'
  }
}

/** Jira가 보장하는 고정 키: `new` | `indeterminate` | `done` */
function statusColor(key: string): string {
  if (key === 'done') return 'var(--color-status-done)'
  if (key === 'indeterminate') return 'var(--color-status-progress)'
  return 'var(--color-status-todo)'
}

function statusMuted(key: string): string {
  if (key === 'done') return 'var(--color-status-done-muted)'
  if (key === 'indeterminate') return 'var(--color-status-progress-muted)'
  return 'var(--color-status-todo-muted)'
}
