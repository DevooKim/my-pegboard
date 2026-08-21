import type { JiraIssue, JiraParent } from '#/ipc/bindings'

export interface ParentGroup {
  parent: JiraParent | null
  label: string
  title: string
  issues: JiraIssue[]
}

/**
 * Jira의 결과 순서를 기준으로 상위 항목별로 묶는다.
 *
 * 그룹과 그룹 안의 순서 모두 첫 등장 순서를 따른다. 사용자가 고른 정렬(JQL의
 * ORDER BY 포함)을 이름순이나 최근순으로 덮어쓰지 않기 위해서다. 상위가 없는
 * 티켓도 숨기지 않고 명시적인 마지막이 아닌, 처음 등장한 자리에 그룹으로 둔다.
 */
export function groupByParent(issues: JiraIssue[]): ParentGroup[] {
  const groups = new Map<string, ParentGroup>()

  for (const issue of issues) {
    const key = issue.parent?.key ?? '__no_parent__'
    const existing = groups.get(key)
    if (existing) {
      existing.issues.push(issue)
      // 같은 상위를 가리키는 후속 티켓에만 제목이 채워진 경우 보강한다.
      if (existing.parent && !existing.parent.summary && issue.parent?.summary) {
        existing.parent = issue.parent
        existing.label = issue.parent.summary
        existing.title = `${issue.parent.key} ${issue.parent.summary}`
      }
      continue
    }

    const parent = issue.parent
    groups.set(key, {
      parent,
      label: parent?.summary ?? (parent ? '' : '상위 항목 없음'),
      title: parent ? `${parent.key} ${parent.summary ?? ''}`.trim() : '상위 항목 없음',
      issues: [issue],
    })
  }

  return [...groups.values()]
}
