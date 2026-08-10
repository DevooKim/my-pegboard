import type { LinearIssue } from '#/ipc/bindings'

export interface TeamGroup {
  teamId: string
  teamName: string
  issues: LinearIssue[]
}

/**
 * 팀별로 묶는다.
 *
 * GitHub 위젯의 `groupByRepo`와 같은 자리이고 같은 규칙이다:
 *
 * - **범위에서 고른 순서가 곧 그룹 순서다.** 별도 설정을 두지 않는다 —
 *   같은 목록을 두 군데서 고르게 만들지 않는다
 * - 범위를 안 골랐으면 **최근 업데이트된 이슈가 있는 팀이 위로.** 이름순이나
 *   개수순으로 두면 오래된 팀이 위에 눌러앉아 최신 항목이 아래로 밀린다
 * - 그룹 **안**의 순서는 건드리지 않는다. Rust가 `orderBy`로 정한 순서다
 *
 * 순수 함수로 뺀 이유는 "테스트하고 싶은가"다. 정렬이 틀리면 화면에서
 * 알아채기 어렵고, 렌더 트리를 거쳐 확인할 로직이 아니다.
 */
export function groupByTeam(issues: LinearIssue[], teamOrder: string[]): TeamGroup[] {
  const groups = new Map<string, TeamGroup>()

  for (const issue of issues) {
    const key = issue.teamId || issue.teamName
    const existing = groups.get(key)
    if (existing) {
      existing.issues.push(issue)
    } else {
      groups.set(key, {
        teamId: issue.teamId,
        // 팀 이름이 비면 그룹 헤더가 빈 줄이 된다. 그럴 때는 "팀 없음"을
        // 적어 헤더가 왜 비었는지 알 수 있게 한다.
        teamName: issue.teamName || '팀 없음',
        issues: [issue],
      })
    }
  }

  const list = [...groups.values()]

  // 지정한 순서가 있으면 그것이 이긴다. 목록에 없는 팀은 뒤로 밀린다.
  if (teamOrder.length > 0) {
    const rank = new Map(teamOrder.map((id, i) => [id, i]))
    return list.sort(
      (a, b) =>
        (rank.get(a.teamId) ?? Number.MAX_SAFE_INTEGER) -
        (rank.get(b.teamId) ?? Number.MAX_SAFE_INTEGER),
    )
  }

  // 지정이 없으면 최신 항목이 있는 팀이 위로.
  return list.sort((a, b) => newest(b.issues).localeCompare(newest(a.issues)))
}

/** 그룹 안에서 가장 최근 업데이트 시각. ISO 8601이라 문자열 비교로 충분하다. */
function newest(issues: LinearIssue[]): string {
  return issues.reduce((max, i) => (i.updatedAt > max ? i.updatedAt : max), '')
}
