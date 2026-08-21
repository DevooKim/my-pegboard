import { describe, expect, it } from 'vitest'
import type { JiraIssue } from '#/ipc/bindings'
import { groupByParent } from './grouping'

function issue(key: string, parent: JiraIssue['parent'] = null): JiraIssue {
  return {
    key,
    summary: key,
    status: null,
    assignee: null,
    priority: null,
    issueType: null,
    updated: null,
    created: null,
    dueDate: null,
    parent,
    sprint: null,
  }
}

describe('groupByParent', () => {
  it('같은 상위 항목의 티켓을 한 그룹으로 묶는다', () => {
    const groups = groupByParent([
      issue('ABC-1', { key: 'ABC-100', summary: '로그인 개선' }),
      issue('ABC-2', { key: 'ABC-200', summary: '검색 개선' }),
      issue('ABC-3', { key: 'ABC-100', summary: '로그인 개선' }),
    ])

    expect(groups.map((group) => group.parent?.key)).toEqual(['ABC-100', 'ABC-200'])
    expect(groups[0]?.issues.map((item) => item.key)).toEqual(['ABC-1', 'ABC-3'])
  })

  it('상위가 없는 티켓을 숨기지 않고 별도 그룹으로 모은다', () => {
    const groups = groupByParent([issue('ABC-1'), issue('ABC-2')])

    expect(groups).toHaveLength(1)
    expect(groups[0]?.parent).toBeNull()
    expect(groups[0]?.label).toBe('상위 항목 없음')
    expect(groups[0]?.issues).toHaveLength(2)
  })

  it('사용자가 고른 정렬을 보존하도록 그룹과 항목의 첫 등장 순서를 지킨다', () => {
    const groups = groupByParent([
      issue('ABC-3', { key: 'ABC-200', summary: '두 번째 상위' }),
      issue('ABC-2', { key: 'ABC-100', summary: '첫 번째 상위' }),
      issue('ABC-1', { key: 'ABC-200', summary: '두 번째 상위' }),
    ])

    expect(groups.map((group) => group.parent?.key)).toEqual(['ABC-200', 'ABC-100'])
    expect(groups[0]?.issues.map((item) => item.key)).toEqual(['ABC-3', 'ABC-1'])
  })

  it('첫 티켓에 빠진 상위 제목을 후속 티켓에서 보강한다', () => {
    const groups = groupByParent([
      issue('ABC-1', { key: 'ABC-100', summary: null }),
      issue('ABC-2', { key: 'ABC-100', summary: '로그인 개선' }),
    ])

    expect(groups[0]?.label).toBe('로그인 개선')
    expect(groups[0]?.title).toBe('ABC-100 로그인 개선')
  })

  it('상위 제목이 끝까지 없으면 키를 중복 표시하지 않는다', () => {
    const groups = groupByParent([issue('ABC-1', { key: 'ABC-100', summary: null })])

    expect(groups[0]?.label).toBe('')
    expect(groups[0]?.title).toBe('ABC-100')
  })
})
