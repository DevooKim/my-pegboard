import { openUrl } from '@tauri-apps/plugin-opener'
import type { LinearIssue } from '#/ipc/bindings'
import { absoluteDate, relativeTime } from '#/ui/relativeTime'
import { StatePopover } from './StatePopover'

/**
 * 목록 한 줄. **2행 구성**이다.
 *
 * ```
 * ENG-142  로그인 후 리다이렉트가 한 번 더 발생한다
 *          [In Progress] · High · 인증 개편 · 3p · 2일 전
 * ```
 *
 * GitHub 위젯과 같은 2행이고 Jira의 10열 그리드가 아니다. **열 설정을 만들지
 * 않는다** — Jira에서는 필드 채움률을 실측해 열을 골랐는데(라벨 0/22 등),
 * Linear는 실측이 없으므로 무엇을 켤지 정할 근거가 없다. 고정 배치로 두고
 * 값이 없는 것은 그리지 않는다 (DECISIONS 25.3).
 *
 * 행 전체 클릭이 상세 모달을 연다. **⌘+클릭은 브라우저** — Jira와 같은 관례다.
 */
export function IssueRow({
  issue,
  now,
  compact,
  showTeam,
  onOpen,
  onStateChanged,
}: {
  issue: LinearIssue
  /** 상대 시간 갱신용. 1분마다 바뀐다. */
  now: number
  /** 폭이 좁은가. 우선순위·프로젝트 같은 부가 정보를 접는다. */
  compact: boolean
  /** 팀 이름을 2행에 그릴까. 그룹 헤더가 이미 보여주면 끈다. */
  showTeam: boolean
  /** 행 클릭 → 상세 모달. */
  onOpen: () => void
  /** 상태 변경 성공 → 목록 재조회. */
  onStateChanged?: (() => void) | undefined
}) {
  // ⌘+클릭은 브라우저로. "새 창에서 열기"라는 익숙한 관습을 그대로 쓴다.
  const handleClick = (e: React.MouseEvent) => {
    if (e.metaKey || e.ctrlKey) {
      if (issue.url) void openUrl(issue.url)
      return
    }
    onOpen()
  }

  return (
    // 행 전체가 상세 모달을 여는 버튼이다. 안에 배지 버튼(팝오버)이 있으므로
    // <button>으로 감쌀 수 없다 — 중첩이 HTML 위반이라 role로 대신한다.
    // biome-ignore lint/a11y/useSemanticElements: 내부에 button이 있어 중첩이 불가능하다
    <div
      role="button"
      tabIndex={0}
      onClick={handleClick}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          onOpen()
        }
      }}
      title={`${issue.identifier} — 클릭하면 상세, ⌘+클릭하면 Linear`}
      className="flex w-full cursor-pointer flex-col gap-0.5 rounded px-1.5 py-1 text-left
                 transition-colors duration-fast hover:bg-surface-inset
                 focus-visible:outline-2 focus-visible:outline-accent"
    >
      {/* 1행 — 식별자 + 제목. 제목이 가장 중요하므로 한 줄을 통째로 준다. */}
      <span className="flex min-w-0 items-baseline gap-1.5">
        <span className="ticket-key shrink-0 text-text-tertiary">{issue.identifier}</span>
        <span className="min-w-0 flex-1 truncate text-body text-text-primary">{issue.title}</span>
      </span>

      {/* 2행 — 상태 배지 + 메타데이터. */}
      <span className="flex min-w-0 items-center gap-1 text-caption text-text-quaternary">
        <StatePopover
          issueId={issue.id}
          identifier={issue.identifier}
          teamId={issue.teamId}
          currentStateId={issue.state.id}
          issueUrl={issue.url}
          onChanged={onStateChanged}
        >
          <StateBadge issue={issue} />
        </StatePopover>

        {/* **`priorityLabel`을 그대로 쓴다.** 정수를 우리 말로 바꾸지 않는다
            (DECISIONS 25.3 — 0~4의 의미를 실측하지 못했다). 빈 문자열이면
            그리지 않는다. */}
        {!compact && issue.priorityLabel !== '' && (
          <>
            <Dot />
            <span className="shrink-0" title="우선순위">
              {issue.priorityLabel}
            </span>
          </>
        )}

        {showTeam && issue.teamName !== '' && (
          <>
            <Dot />
            <span className="truncate text-text-secondary">{issue.teamName}</span>
          </>
        )}

        {!compact && issue.projectName && (
          <>
            <Dot />
            <span className="min-w-0 truncate" title={`프로젝트: ${issue.projectName}`}>
              {issue.projectName}
            </span>
          </>
        )}

        {issue.estimate !== null && (
          <>
            <Dot />
            <span className="shrink-0 tabular-nums" title="추정치">
              {issue.estimate}p
            </span>
          </>
        )}

        <DueDate value={issue.dueDate} now={now} />

        <Dot />
        <span className="shrink-0 tabular-nums" title="마지막 업데이트">
          {relativeTime(issue.updatedAt, new Date(now))}
        </span>

        {issue.assignee && !compact && (
          <>
            {/* 담당자는 오른쪽 끝으로 밀어 붙인다 — 눈이 훑는 축이 다르다. */}
            <span className="ml-auto flex min-w-0 shrink-0 items-center gap-1">
              {issue.assigneeAvatarUrl ? (
                <img
                  src={issue.assigneeAvatarUrl}
                  alt=""
                  className="size-4 rounded-full"
                  loading="lazy"
                  decoding="async"
                />
              ) : (
                <span className="grid size-4 place-items-center rounded-full bg-surface-inset text-text-tertiary">
                  {issue.assignee.slice(0, 1)}
                </span>
              )}
              <span className="truncate text-text-tertiary">{issue.assignee}</span>
            </span>
          </>
        )}
      </span>
    </div>
  )
}

function Dot() {
  return (
    <span aria-hidden="true" className="shrink-0">
      ·
    </span>
  )
}

/**
 * 상태 배지.
 *
 * **색은 Linear가 준 `state.color`다.** Jira처럼 카테고리(`new`/`indeterminate`/
 * `done`)로 매핑하지 않는다 — `WorkflowState.type`의 값을 실측하지 못했기
 * 때문이고(DECISIONS 25.3), 덕분에 Linear 웹에서 보던 색과 같아진다.
 *
 * 배경은 색을 그대로 쓰지 않고 점 + 이름으로 그린다. 팀마다 상태가 5~6개인데
 * 전부 색 블록이면 DESIGN 원칙 1("색은 상태를 말할 때만")이 무의미해진다.
 */
function StateBadge({ issue }: { issue: LinearIssue }) {
  return (
    <span className="flex max-w-full items-center gap-1 rounded px-1 py-0.5">
      <span
        aria-hidden="true"
        className="size-1.5 shrink-0 rounded-full"
        style={{ backgroundColor: issue.state.color }}
      />
      <span className="truncate text-text-secondary">{issue.state.name}</span>
    </span>
  )
}

/**
 * 마감일. 지났으면 빨강, 오늘·내일이면 앰버.
 *
 * **`dueDate`의 모양을 실측하지 못했다** (DECISIONS 25.7). `YYYY-MM-DD`일 수도
 * ISO 8601일 수도 있어서 둘 다 견디게 파싱한다 — 못 읽으면 아무것도 그리지
 * 않는다(틀린 날짜를 그리는 것보다 낫다).
 */
function DueDate({ value, now }: { value: string | null; now: number }) {
  if (!value) return null

  const due = parseDue(value)
  if (due === null) return null

  const days = Math.ceil((due - now) / 86_400_000)
  const color = days < 0 ? 'text-danger' : days <= 1 ? 'text-stale' : 'text-text-quaternary'

  return (
    <>
      <Dot />
      <span className={`shrink-0 tabular-nums ${color}`} title={`마감: ${absoluteDate(value)}`}>
        {days < 0 ? `${-days}일 지남` : days === 0 ? '오늘' : `${days}일 남음`}
      </span>
    </>
  )
}

/**
 * 마감일을 밀리초로. 못 읽으면 `null`.
 *
 * `YYYY-MM-DD`는 **로컬 하루의 끝**으로 본다. `new Date("2026-08-20")`을 그대로
 * 쓰면 UTC 자정으로 파싱돼 한국에서 오전 9시가 되고, 마감 당일 오전에 "1일
 * 지남"이 뜬다 (`store/todos.ts`에 같은 함정이 적혀 있다).
 */
export function parseDue(value: string): number | null {
  const dateOnly = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value)
  if (dateOnly) {
    const t = new Date(`${value}T23:59:59`).getTime()
    return Number.isNaN(t) ? null : t
  }
  const t = new Date(value).getTime()
  return Number.isNaN(t) ? null : t
}
