import type { JiraIssue } from '#/ipc/bindings'
import { relativeTime } from '#/ui/relativeTime'
import {
  type ColumnWidths,
  gridTemplate,
  renderedColumns,
  type ToggleableColumn,
} from '#/widgets/jira/columns'

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
  widths,
  visible,
  onOpen,
}: {
  issue: JiraIssue
  density: 'compact' | 'normal' | 'wide'
  widths: ColumnWidths
  visible: ToggleableColumn[]
  onOpen: (key: string) => void
}) {
  // 색의 근거는 상태 '이름'이 아니라 카테고리 키다 — 이름은 프로젝트마다 다르다.
  const statusCategory = issue.status?.statusCategory?.key ?? 'new'
  const shown = renderedColumns(density, visible)
  const has = (c: ToggleableColumn) => shown.includes(c)

  return (
    <button
      type="button"
      onClick={() => onOpen(issue.key)}
      className="group grid w-full items-center gap-2 rounded px-2 py-1.5 text-left
                 transition-colors duration-fast hover:bg-surface-inset
                 focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-accent"
      style={{
        borderLeft: `2px solid ${priorityColor(issue.priority?.name)}`,
        gridTemplateColumns: gridTemplate(widths, density, visible),
      }}
    >
      {has('key') && (
        <span className="min-w-0 truncate font-mono text-ticket-key text-text-tertiary tabular-nums">
          {issue.key}
        </span>
      )}

      <span
        className="min-w-0 truncate text-body text-text-primary leading-tight-ko"
        title={issue.summary}
      >
        {issue.summary}
      </span>

      {has('issueType') && (
        <span
          className="min-w-0 truncate text-caption text-text-tertiary"
          title={issue.issueType?.name ?? undefined}
        >
          {issue.issueType?.name ?? '—'}
        </span>
      )}

      {has('status') &&
        (density === 'compact' ? (
          <span
            role="img"
            className="size-1.5 rounded-full"
            style={{ backgroundColor: statusColor(statusCategory) }}
            title={issue.status?.name ?? '상태 없음'}
            aria-label={issue.status?.name ?? '상태 없음'}
          />
        ) : (
          <span
            className="min-w-0 truncate rounded px-1.5 py-0.5 text-center text-caption"
            style={{
              color: statusColor(statusCategory),
              backgroundColor: statusMuted(statusCategory),
            }}
          >
            {issue.status?.name ?? '—'}
          </span>
        ))}

      {has('priority') && (
        <span
          className="min-w-0 truncate text-caption"
          style={{ color: priorityColor(issue.priority?.name) || undefined }}
          title={issue.priority?.name ?? undefined}
        >
          {priorityLabel(issue.priority?.name)}
        </span>
      )}

      {has('assignee') && <Assignee issue={issue} showName={density === 'wide'} />}

      {/*
        티켓이 마지막으로 수정된 시각. 헤더의 "갱신 시각"과 헷갈리지 않도록
        title로 무엇의 시간인지 밝힌다. 목록이 updated DESC로 정렬돼 있으므로
        정보 가치가 크지 않아 넓을 때만 보여준다.
      */}
      {has('updated') && (
        <span
          className="min-w-0 truncate text-caption text-text-quaternary tabular-nums"
          title={
            issue.updated
              ? `티켓 수정: ${new Date(issue.updated).toLocaleString('ko-KR')}`
              : undefined
          }
        >
          {issue.updated ? relativeTime(issue.updated) : '—'}
        </span>
      )}

      {has('created') && (
        <span
          className="min-w-0 truncate text-caption text-text-quaternary tabular-nums"
          title={
            issue.created ? `생성: ${new Date(issue.created).toLocaleString('ko-KR')}` : undefined
          }
        >
          {issue.created ? relativeTime(issue.created) : '—'}
        </span>
      )}

      {has('dueDate') && <DueDate value={issue.dueDate} />}
    </button>
  )
}

function Assignee({ issue, showName }: { issue: JiraIssue; showName: boolean }) {
  const assignee = issue.assignee
  if (!assignee) {
    return (
      <span
        role="img"
        className="size-5 rounded-full border border-dashed border-border-subtle"
        title="미할당"
        aria-label="미할당"
      />
    )
  }
  return (
    <span className="flex min-w-0 items-center gap-1.5" title={assignee.displayName ?? undefined}>
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
      {/* 고정 max-w를 두면 열을 넓혀도 말줄임이 그대로다. 열 폭을 따라가야 한다. */}
      {showName && (
        <span className="min-w-0 truncate text-caption text-text-tertiary">
          {assignee.displayName}
        </span>
      )}
    </span>
  )
}

/**
 * 마감일. 지났으면 빨강, 오늘·내일이면 앰버.
 * 실측상 절반 이하만 채워져 있어 없는 경우가 흔하다.
 */
function DueDate({ value }: { value: string | null | undefined }) {
  if (!value) return <span className="text-caption text-text-quaternary">—</span>

  const due = new Date(`${value}T23:59:59`)
  const days = Math.ceil((due.getTime() - Date.now()) / 86_400_000)
  const color = days < 0 ? 'text-danger' : days <= 1 ? 'text-stale' : 'text-text-quaternary'

  return (
    <span
      className={`min-w-0 truncate text-caption tabular-nums ${color}`}
      title={`마감: ${value}`}
    >
      {days < 0 ? `${-days}일 지남` : days === 0 ? '오늘' : `${days}일 남음`}
    </span>
  )
}

/** 우선순위 짧은 표기. 열 폭이 좁으므로 전체 이름을 쓰지 않는다. */
function priorityLabel(name: string | null | undefined): string {
  switch (name) {
    case 'Highest':
      return '최상'
    case 'High':
      return '높음'
    case 'Medium':
      return '보통'
    case 'Low':
      return '낮음'
    case 'Lowest':
      return '최하'
    default:
      return '—'
  }
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
