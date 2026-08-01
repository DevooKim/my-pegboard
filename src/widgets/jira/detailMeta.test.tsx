import { render } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { IssueDetailModal } from '#/widgets/jira/IssueDetailModal'

vi.mock('@tauri-apps/plugin-opener', () => ({ openUrl: vi.fn() }))
vi.mock('#/ipc/bindings', () => ({
  commands: {
    // 상세·코멘트가 안 와도 seed로 골격을 그린다 (D2). 이 테스트는 그 골격만 본다.
    jiraIssue: vi.fn(() => new Promise(() => {})),
    jiraComments: vi.fn(() => new Promise(() => {})),
    // 하위 유형 판정용 프로젝트 목록. 여기서는 비워도 된다 —
    // 목록이 없으면 "만들기" 버튼이 안 뜰 뿐, 메타 그리드 배치와는 무관하다.
    jiraCreateOptions: vi.fn(async () => ({ status: 'ok', data: { projects: [] } })),
    jiraMyself: vi.fn(() => new Promise(() => {})),
    jiraCreatemeta: vi.fn(() => new Promise(() => {})),
  },
}))

/**
 * 메타 그리드 배치 회귀 테스트.
 *
 * 4열 그리드 `[auto 1fr auto 1fr]`에 반쪽 행(라벨+값)을 흘려 넣는 구조라,
 * 반쪽 행이 **홀수 개**면 오른쪽 두 칸이 빈 채로 남는다. 그 상태에서 `상위`처럼
 * 한 줄을 다 쓰는 항목이 오면 3칸짜리 dd가 남은 2칸에 안 들어가 **값만 다음 줄로
 * 밀리고 라벨만 홀로 남는다.** EDU-60에서 실제로 그렇게 보였다.
 *
 * `col-start-1`이 그것을 막는다.
 */

const seed = {
  key: 'EDU-60',
  summary: '서버 구조 재배치',
  status: { name: '완료', statusCategory: { key: 'done', colorName: null, name: null } },
  assignee: { accountId: 'a', displayName: '김현우', avatarUrl: null },
  priority: { name: 'Medium', iconUrl: null },
  issueType: { name: '하위 작업', iconUrl: null, subtask: true },
  updated: '2026-07-29T14:00:00.000+0900',
  created: '2026-07-15T09:00:00.000+0900',
  // 마감이 없고 스프린트만 있다 → 반쪽 행이 홀수가 되는 실제 조합
  dueDate: null,
  parent: { key: 'EDU-10', summary: '/admin 페이지의 서버 분리' },
  sprint: { name: '2026 3Q2', state: 'active' },
}

function renderModal() {
  return render(<IssueDetailModal issueKey="EDU-60" seed={seed as never} onClose={vi.fn()} />)
}

describe('상세 모달 메타 그리드', () => {
  it('상위 라벨이 새 줄에서 시작한다 (값과 갈라지지 않게)', () => {
    renderModal()
    const dt = [...document.querySelectorAll('dt')].find((el) => el.textContent === '상위')

    expect(dt, '상위 행이 있어야 한다').toBeTruthy()
    expect(dt?.className).toContain('col-start-1')
  })

  it('상위 값은 한 줄을 통째로 쓴다', () => {
    renderModal()
    const dt = [...document.querySelectorAll('dt')].find((el) => el.textContent === '상위')
    const dd = dt?.nextElementSibling

    expect(dd?.className).toContain('col-span-3')
  })

  /** 반쪽 행은 col-start를 갖지 않는다 — 가지면 2열로 안 붙고 한 줄에 하나씩 쌓인다. */
  it('반쪽 행은 흐름대로 배치된다', () => {
    renderModal()
    for (const label of ['담당자', '생성', '수정', '스프린트']) {
      const dt = [...document.querySelectorAll('dt')].find((el) => el.textContent === label)
      expect(dt?.className, `${label}이 새 줄을 강제하면 안 된다`).not.toContain('col-start-1')
    }
  })

  it('마감이 없으면 그 행 자체를 그리지 않는다', () => {
    renderModal()
    const dt = [...document.querySelectorAll('dt')].find((el) => el.textContent === '마감')
    expect(dt, '값 없는 항목은 빈 칸을 만들지 않는다').toBeFalsy()
  })
})
