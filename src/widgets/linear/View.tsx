import { useMemo, useState } from 'react'
import type { LinearIssue, LinearWidgetConfig } from '#/ipc/bindings'
import { useNow } from '#/ui/relativeTime'
import type { WidgetViewProps } from '#/widgets/types'
import { groupByTeam } from './grouping'
import { IssueDetailModal } from './IssueDetailModal'
import { IssueRow } from './IssueRow'
import { notifyStateChanged } from './StatePopover'

/**
 * 폭이 이보다 좁으면 부가 정보(우선순위·프로젝트·담당자)를 접는다.
 *
 * GitHub 위젯의 `COMPACT_WIDTH`와 같은 자리다. 3열(≈240px)이 최소 가독 폭이고
 * 거기에 상태 배지 + 우선순위 + 프로젝트를 다 넣으면 제목이 밀린다.
 */
const COMPACT_WIDTH = 340

/**
 * Linear 위젯 본문.
 *
 * **한 번 데이터가 그려진 뒤로는 본문을 비우지 않는다** (DESIGN.md).
 * 갱신 중이든 일시적 실패든 직전 목록을 계속 보여준다.
 *
 * 상세 모달이 있다 — GitHub 위젯과 다른 점이고, **사용자가 정한 것**이다
 * (DECISIONS 25.1). 목록 행 클릭이 모달을 열고 ⌘+클릭이 브라우저로 나간다.
 */
export function LinearView({
  config,
  envelope,
  width,
}: WidgetViewProps<LinearWidgetConfig, { issues: LinearIssue[]; hasMore: boolean }>) {
  const now = useNow()
  const issues = envelope.data?.issues ?? []
  const compact = width < COMPACT_WIDTH

  /** 열려 있는 상세 모달. seed는 목록이 이미 가진 값 — 0ms 골격의 재료다. */
  const [detail, setDetail] = useState<LinearIssue | null>(null)

  // `serde(default)`라 생성 타입에서 optional이다. 이 설정이 생기기 전에 만든
  // 위젯은 값이 없는데, 그대로 두면 그룹핑이 조용히 꺼진다 — 기본은 켬이다.
  const grouped = config.groupByTeam ?? true

  // **범위에서 고른 순서가 곧 그룹 순서다.** 별도 설정을 두지 않는다.
  const groups = useMemo(
    () => (grouped ? groupByTeam(issues, config.teams ?? []) : null),
    [issues, grouped, config.teams],
  )

  // 아직 한 번도 데이터를 못 받은 상태에서만 로딩/에러가 본문을 차지한다.
  if (issues.length === 0) {
    if (envelope.status === 'loading' || envelope.status === 'idle') {
      return <Centered>불러오는 중…</Centered>
    }
    if (envelope.error) {
      return <ErrorBody message={envelope.error.message} />
    }
    return <Centered>조건에 맞는 이슈가 없습니다</Centered>
  }

  return (
    <div className="flex h-full flex-col">
      <div className="min-h-0 flex-1 overflow-y-auto px-1.5 py-1">
        {groups ? (
          groups.map((group) => (
            <section key={group.teamId || group.teamName}>
              {/* 그룹 헤더. GitHub 위젯과 같은 판단으로 sticky를 쓰지 않는다 —
                  위젯 높이가 10행 남짓이라 고정 헤더가 보이는 행을 잡아먹는다. */}
              <h3
                className="truncate px-1.5 pt-2 pb-1 text-base text-text-secondary"
                title={group.teamName}
              >
                {group.teamName}
              </h3>
              <ul>
                {group.issues.map((issue) => (
                  <li key={issue.id}>
                    <IssueRow
                      issue={issue}
                      now={now}
                      compact={compact}
                      // 헤더가 이미 팀을 보여주므로 행에서는 뺀다.
                      showTeam={false}
                      onOpen={() => setDetail(issue)}
                      onStateChanged={notifyStateChanged}
                    />
                  </li>
                ))}
              </ul>
            </section>
          ))
        ) : (
          <ul>
            {issues.map((issue) => (
              <li key={issue.id}>
                <IssueRow
                  issue={issue}
                  now={now}
                  compact={compact}
                  showTeam={true}
                  onOpen={() => setDetail(issue)}
                  onStateChanged={notifyStateChanged}
                />
              </li>
            ))}
          </ul>
        )}
      </div>

      {/* Modal이 포털이라 위치는 무관하다. 목록 뒤에 두어 읽는 순서를 맞춘다. */}
      <IssueDetailModal
        issue={detail}
        onClose={() => setDetail(null)}
        onStateChanged={notifyStateChanged}
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

      {/* **"N건 중 M건"을 만들지 않는다.** Linear 커넥션은 총 건수를 주지 않는다
          (GitHub과 다르고 Jira 신규 검색과 같다 — DECISIONS 25.3). 잘렸다는
          사실만 말한다. 조용히 자르지 않는 것이 목적이다. */}
      {envelope.data?.hasMore && (
        <p className="shrink-0 px-2 py-1 text-caption text-text-quaternary">
          {config.maxResults}건까지 표시 — 더 있습니다
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
      {/* Linear 원문을 그대로 보여준다 — 우리가 고쳐 쓰면 더 나빠진다 */}
      <p className="text-center text-caption text-danger leading-relaxed-ko">{message}</p>
    </div>
  )
}
