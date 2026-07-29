import { openUrl } from '@tauri-apps/plugin-opener'
import type { JiraIssue } from '#/ipc/bindings'
import { absoluteDate, absoluteTime, relativeTime } from '#/ui/relativeTime'
import {
  alignClass,
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
  now,
  browseUrl,
}: {
  issue: JiraIssue
  density: 'compact' | 'normal' | 'wide'
  widths: ColumnWidths
  visible: ToggleableColumn[]
  /** 현재 시각(ms). 1분마다 바뀌어 상대 시간을 다시 계산하게 한다. */
  now: number
  /** 티켓 키 → Jira 웹 URL. 연결이 없으면 null. */
  browseUrl: (key: string) => string | null
}) {
  // 색의 근거는 상태 '이름'이 아니라 카테고리 키다 — 이름은 프로젝트마다 다르다.
  const statusCategory = issue.status?.statusCategory?.key ?? 'new'
  const shown = renderedColumns(density, visible)

  return (
    // 행 자체는 클릭 대상이 아니다. 키와 상위만 Jira로 나가는 링크이고,
    // 제목 클릭(상세 모달)은 2차에서 붙는다.
    <div
      className="grid w-full items-center gap-2 rounded py-1.5 pr-2 pl-3 text-left
                 transition-colors duration-fast hover:bg-surface-inset"
      style={{
        // 우선순위 막대를 border가 아니라 배경 그라디언트로 그린다.
        // `border-left` + `rounded` 조합은 둥근 모서리에서 테두리가 네 변을 돌기
        // 때문에 오른쪽 끝에 색 조각이 잘린 채 남는다.
        backgroundImage: `linear-gradient(to right, ${priorityColor(
          issue.priority?.name,
        )} 0 2px, transparent 2px)`,
        gridTemplateColumns: gridTemplate(widths, density, visible),
      }}
    >
      {shown.map((col) =>
        col === 'key' ? (
          <IssueLink key={col} issueKey={issue.key} href={browseUrl(issue.key)} mono />
        ) : null,
      )}

      {/* 제목은 항상, 그리고 키 바로 다음에 온다 */}
      <span
        className={`w-full min-w-0 truncate text-body text-text-primary leading-tight-ko ${alignClass('summary')}`}
        title={issue.summary}
      >
        {issue.summary}
      </span>

      {shown
        .filter((c) => c !== 'key')
        .map((col) => (
          // 정렬은 셀 안이 아니라 래퍼가 담당한다. 셀마다 클래스를 붙이면
          // 새 열을 추가할 때 반드시 하나를 빠뜨린다.
          <div key={col} className="flex min-w-0 items-center">
            <Cell
              col={col}
              issue={issue}
              density={density}
              statusCategory={statusCategory}
              now={now}
              browseUrl={browseUrl}
            />
          </div>
        ))}
    </div>
  )
}

/**
 * Jira로 나가는 티켓 링크.
 *
 * 버튼이 아니라 링크인 이유: 실제로 다른 문서로 이동하는 동작이고,
 * 버튼처럼 보이지 않아야 목록의 밀도를 해치지 않는다. 평소에는 그냥
 * 텍스트이고 마우스를 올렸을 때만 밑줄이 생긴다.
 *
 * `href`를 두는 이유는 우클릭 메뉴와 상태바 미리보기를 살리기 위해서다.
 * 다만 기본 이동은 막는다 — 그대로 두면 Tauri 웹뷰가 **앱 창 안에서**
 * Jira를 열어버려서 돌아올 방법이 없다.
 */
function IssueLink({
  issueKey,
  href,
  mono,
  title,
}: {
  issueKey: string
  href: string | null
  mono?: boolean
  title?: string
}) {
  const base = `w-full min-w-0 truncate text-caption text-text-tertiary ${mono ? 'font-mono text-ticket-key tabular-nums' : ''}`

  if (!href) {
    return (
      <span className={base} title={title}>
        {issueKey}
      </span>
    )
  }

  return (
    <a
      href={href}
      title={title ?? `${issueKey} — Jira에서 열기`}
      onClick={(e) => {
        e.preventDefault()
        void openUrl(href)
      }}
      className={`${base} cursor-pointer hover:text-accent hover:underline
                  focus-visible:outline-2 focus-visible:outline-accent`}
    >
      {issueKey}
    </a>
  )
}

/**
 * 열 하나의 내용.
 *
 * 행과 헤더가 **같은 `renderedColumns()` 순서를 map으로 돌기 때문에** 어긋날 수 없다.
 * 예전에는 셀을 순서대로 하드코딩했는데, 열을 추가하면서 스프린트·상위를 빠뜨려
 * 뒤의 값들이 한 칸씩 밀렸다. 그 사고를 구조적으로 막는다.
 */
function Cell({
  col,
  issue,
  density,
  statusCategory,
  now,
  browseUrl,
}: {
  col: ToggleableColumn
  issue: JiraIssue
  density: 'compact' | 'normal' | 'wide'
  statusCategory: string
  now: number
  browseUrl: (key: string) => string | null
}) {
  switch (col) {
    case 'issueType':
      return (
        <span
          className="w-full min-w-0 truncate text-caption text-text-tertiary"
          title={issue.issueType?.name ?? undefined}
        >
          {issue.issueType?.name ?? '—'}
        </span>
      )

    case 'status':
      return density === 'compact' ? (
        <span
          role="img"
          className="size-1.5 rounded-full"
          style={{ backgroundColor: statusColor(statusCategory) }}
          title={issue.status?.name ?? '상태 없음'}
          aria-label={issue.status?.name ?? '상태 없음'}
        />
      ) : (
        // 배지는 글자만 감싼다 — min-w-0 + truncate를 주면 그리드 셀을 꽉 채워
        // 열 전체가 색칠된 것처럼 보인다.
        //
        // 음수 마진으로 패딩을 상쇄하지 않는다. 그러면 배지 배경이 트랙 밖으로
        // 삐져나가고 글자만 왼쪽으로 당겨져 오히려 이웃 열과 어긋나 보인다.
        // 트랙 자체는 이미 헤더와 픽셀 단위로 일치한다(실측).
        <span
          className="max-w-full truncate rounded px-1.5 py-0.5 text-caption"
          style={{
            color: statusColor(statusCategory),
            backgroundColor: statusMuted(statusCategory),
          }}
        >
          {issue.status?.name ?? '—'}
        </span>
      )

    case 'priority':
      // 왼쪽 막대는 '보통'을 일부러 그리지 않는다(모든 행에 표시가 뜨면 신호가 죽는다).
      // 그래서 이 열의 색은 중복이 아니라 막대가 못 하는 일을 한다 — 보통도 구분되고,
      // 색에만 기대지 않도록 글자로도 읽힌다.
      return (
        <span
          className="w-full truncate text-caption"
          style={{ color: priorityTextColor(issue.priority?.name) }}
          title={issue.priority?.name ?? undefined}
        >
          {priorityLabel(issue.priority?.name)}
        </span>
      )

    case 'assignee':
      return <Assignee issue={issue} showName={density === 'wide'} />

    case 'sprint':
      return (
        <span
          className="w-full min-w-0 truncate text-caption text-text-tertiary"
          title={issue.sprint?.name ?? undefined}
        >
          {issue.sprint?.name ?? '—'}
        </span>
      )

    case 'parent':
      return issue.parent ? (
        <IssueLink
          issueKey={issue.parent.key}
          href={browseUrl(issue.parent.key)}
          mono
          title={`${issue.parent.key} ${issue.parent.summary ?? ''}`.trim()}
        />
      ) : (
        <span className="w-full text-caption text-text-quaternary">—</span>
      )

    case 'updated':
      return <RelativeCell value={issue.updated} label="티켓 수정" now={now} />

    case 'created':
      return <RelativeCell value={issue.created} label="생성" now={now} />

    case 'dueDate':
      return <DueDate value={issue.dueDate} now={now} />

    default:
      return null
  }
}

function RelativeCell({
  value,
  label,
  now,
}: {
  value: string | null | undefined
  label: string
  now: number
}) {
  return (
    <span
      className="w-full min-w-0 truncate text-caption text-text-quaternary tabular-nums"
      title={value ? `${label}: ${absoluteTime(value)}` : undefined}
    >
      {value ? relativeTime(value, new Date(now)) : '—'}
    </span>
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
    <span
      className="flex w-full min-w-0 items-center gap-1"
      title={assignee.displayName ?? undefined}
    >
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
        <span className="w-full min-w-0 truncate text-caption text-text-tertiary">
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
function DueDate({ value, now }: { value: string | null | undefined; now: number }) {
  if (!value) return <span className="w-full text-caption text-text-quaternary">—</span>

  const due = new Date(`${value}T23:59:59`)
  const days = Math.ceil((due.getTime() - now) / 86_400_000)
  const color = days < 0 ? 'text-danger' : days <= 1 ? 'text-stale' : 'text-text-quaternary'

  return (
    <span
      className={`w-full min-w-0 truncate text-caption tabular-nums ${color}`}
      title={`마감: ${absoluteDate(value)}`}
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

/**
 * 우선순위 열의 글자색. 왼쪽 막대와 달리 **보통도 색을 갖는다** —
 * 열을 켠 사용자는 다섯 단계를 다 구분하고 싶은 것이다.
 */
function priorityTextColor(name: string | null | undefined): string {
  switch (name) {
    case 'Highest':
      return 'var(--color-priority-highest)'
    case 'High':
      return 'var(--color-priority-high)'
    case 'Medium':
      return 'var(--color-priority-medium)'
    case 'Low':
      return 'var(--color-priority-low)'
    case 'Lowest':
      return 'var(--color-priority-lowest)'
    default:
      return 'var(--color-text-quaternary)'
  }
}

/** 왼쪽 막대 색. Medium(P3)은 일부러 그리지 않는다 — 모든 행에 표시가 뜨면 신호가 죽는다. */
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
