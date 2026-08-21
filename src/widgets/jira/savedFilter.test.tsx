import { render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { JiraWidgetConfig } from '#/ipc/bindings'

/**
 * 저장된 필터 불러오기 (DECISIONS 11.1).
 *
 * 이 파일이 지키는 것은 하나다: **필터 목록 조회가 실패해도 프리셋을 고를 수 있다.**
 *
 * 새 기능이 원래 되던 일을 막는 것이 최악의 회귀다. 필터는 서버에 물어봐야
 * 하므로 실패할 수 있고(오프라인·권한·SSO), 그때 위젯 설정 자체가 잠기면
 * 사용자는 "왜 위젯을 못 만들지?"만 겪는다. 실패는 화면에 드러나되
 * 선택을 막지 않아야 한다 (CLAUDE.md 대전제 2).
 */

const PRESETS = [
  {
    id: 'assigned-to-me',
    name: '내게 할당된 티켓',
    description: '내가 담당자이고 아직 해결되지 않은 티켓',
    jql: 'assignee = currentUser() ORDER BY updated DESC',
  },
  {
    id: 'watched-by-me',
    name: '내가 지켜보는 티켓',
    description: 'watch 중인 티켓',
    jql: 'watcher = currentUser() ORDER BY updated DESC',
  },
]

const jiraFilters = vi.fn()

vi.mock('#/ipc/bindings', () => ({
  commands: {
    jiraPresets: vi.fn(async () => PRESETS),
    // 프로젝트 목록은 이 테스트의 관심사가 아니다. 비워도 칩만 안 그려진다.
    jiraCreateOptions: vi.fn(async () => ({
      status: 'ok',
      data: { projects: [], fetchedAt: null, fromCache: false },
    })),
    jiraFilters: (...args: unknown[]) => jiraFilters(...args),
  },
}))

// mock 이후에 import해야 컴포넌트가 mock된 bindings를 집는다.
const { JiraConfigForm } = await import('#/widgets/jira/ConfigForm')

const baseConfig: JiraWidgetConfig = {
  title: null,
  query: { kind: 'preset', id: 'assigned-to-me' },
  maxResults: 15,
  projects: [],
  refreshSecs: 300,
  columns: null,
  sortField: null,
  sortDirection: null,
  groupByParent: false,
}

function renderForm(config: JiraWidgetConfig = baseConfig) {
  const onChange = vi.fn()
  const view = render(<JiraConfigForm config={config} onChange={onChange} />)
  return { onChange, ...view }
}

/** 쿼리 셀렉트 = 프리셋 옵션을 담고 있는 select. */
function querySelect(): HTMLSelectElement {
  const selects = screen.getAllByRole('combobox') as HTMLSelectElement[]
  const found = selects.find((s) => s.querySelector('option[value="assigned-to-me"]'))
  if (!found) throw new Error('쿼리 셀렉트를 찾지 못했다')
  return found
}

beforeEach(() => {
  jiraFilters.mockReset()
})

describe('상위 항목 그룹 설정', () => {
  it('기본은 기존과 같은 평면 목록이고 체크하면 그룹 설정을 저장한다', async () => {
    jiraFilters.mockResolvedValue({ status: 'ok', data: [] })
    const { onChange } = renderForm()

    const checkbox = await screen.findByRole('checkbox', { name: '상위 항목별로 묶어서 보기' })
    expect(checkbox).not.toBeChecked()

    checkbox.click()
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ groupByParent: true }))
  })
})

describe('필터 목록 조회가 실패했을 때', () => {
  const failure = {
    status: 'error',
    error: {
      kind: 'permanent',
      message: '권한이 없습니다',
      isAuthFailure: false,
      retryAfterSecs: null,
    },
  }

  it('실패를 화면에 드러낸다 (조용한 실패 금지)', async () => {
    jiraFilters.mockResolvedValue(failure)
    renderForm()

    await waitFor(() => {
      expect(screen.getByText(/저장된 필터 목록을 불러오지 못했습니다/)).toBeTruthy()
    })
    // Jira 원문을 그대로 보여준다 — 우리가 고쳐 쓰지 않는다.
    expect(screen.getByText(/권한이 없습니다/)).toBeTruthy()
  })

  it('재시도 버튼을 준다', async () => {
    jiraFilters.mockResolvedValue(failure)
    renderForm()

    const retry = await screen.findByRole('button', { name: '다시 시도' })
    expect(retry).toBeTruthy()
  })

  it('**프리셋은 그대로 선택 가능하다** — 이 테스트가 이 파일의 존재 이유다', async () => {
    jiraFilters.mockResolvedValue(failure)
    const { onChange } = renderForm()

    await waitFor(() => {
      expect(screen.getByText(/저장된 필터 목록을 불러오지 못했습니다/)).toBeTruthy()
    })

    const select = querySelect()
    expect(select.disabled).toBe(false)

    // 프리셋 항목이 전부 살아 있다.
    for (const p of PRESETS) {
      expect(select.querySelector(`option[value="${p.id}"]`)).toBeTruthy()
    }

    // 실제로 고를 수 있다.
    select.value = 'watched-by-me'
    select.dispatchEvent(new Event('change', { bubbles: true }))
    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({ query: { kind: 'preset', id: 'watched-by-me' } }),
    )
  })

  it('JQL 직접 입력도 막히지 않는다', async () => {
    jiraFilters.mockResolvedValue(failure)
    renderForm()

    await waitFor(() => {
      expect(screen.getByText(/저장된 필터 목록을 불러오지 못했습니다/)).toBeTruthy()
    })
    expect(querySelect().querySelector('option[value="__raw__"]')).toBeTruthy()
  })
})

describe('필터 목록을 불러오는 중일 때', () => {
  it('프리셋은 기다리지 않고 바로 고를 수 있다', async () => {
    // 영원히 안 끝나는 조회. 로딩이 선택을 막지 않는지 본다.
    jiraFilters.mockReturnValue(new Promise(() => {}))
    const { onChange } = renderForm()

    // 프리셋이 도착하면 셀렉트가 채워진다 — 필터와 무관하게.
    await waitFor(() => {
      expect(querySelect().querySelector('option[value="watched-by-me"]')).toBeTruthy()
    })

    const select = querySelect()
    expect(select.disabled).toBe(false)
    select.value = 'watched-by-me'
    select.dispatchEvent(new Event('change', { bubbles: true }))
    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({ query: { kind: 'preset', id: 'watched-by-me' } }),
    )
  })
})

describe('필터 목록을 받았을 때', () => {
  const filters = [
    { id: '10001', name: '우리 팀 스프린트', jql: 'project = ABC', ownerIsMe: true },
    { id: '10002', name: '남의 필터', jql: 'project = XYZ', ownerIsMe: false },
  ]

  it('프리셋과 같은 셀렉트 안에 저장된 필터 그룹이 생긴다', async () => {
    jiraFilters.mockResolvedValue({ status: 'ok', data: filters })
    renderForm()

    await waitFor(() => {
      expect(querySelect().querySelector('optgroup[label="저장된 필터"]')).toBeTruthy()
    })
    const select = querySelect()
    // 프리셋과 필터가 한 목록에 공존한다.
    expect(select.querySelector('option[value="assigned-to-me"]')).toBeTruthy()
    expect(select.querySelector('option[value="filter:10001"]')).toBeTruthy()
  })

  it('필터를 고르면 id와 이름이 함께 저장된다', async () => {
    jiraFilters.mockResolvedValue({ status: 'ok', data: filters })
    const { onChange } = renderForm()

    await waitFor(() => {
      expect(querySelect().querySelector('option[value="filter:10001"]')).toBeTruthy()
    })

    const select = querySelect()
    select.value = 'filter:10001'
    select.dispatchEvent(new Event('change', { bubbles: true }))

    // name이 빠지면 앱 시작 0ms에 제목을 풀 방법이 없다 (깜빡임).
    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({
        query: { kind: 'savedFilter', id: '10001', name: '우리 팀 스프린트' },
      }),
    )
  })

  it('공유받은 필터임을 표시한다', async () => {
    jiraFilters.mockResolvedValue({ status: 'ok', data: filters })
    renderForm()

    await waitFor(() => {
      expect(querySelect().querySelector('option[value="filter:10002"]')).toBeTruthy()
    })
    const shared = querySelect().querySelector('option[value="filter:10002"]')
    expect(shared?.textContent).toContain('공유받음')
  })

  it('고른 필터가 목록에서 사라져도 선택이 엉뚱한 항목으로 튀지 않는다', async () => {
    // 필터를 Jira에서 지운 경우. 셀렉트가 매칭 option을 못 찾으면
    // 사용자가 건드리지도 않은 설정이 바뀐 듯 보인다.
    jiraFilters.mockResolvedValue({ status: 'ok', data: [] })
    renderForm({
      ...baseConfig,
      query: { kind: 'savedFilter', id: '99999', name: '지워진 필터' },
    })

    await waitFor(() => {
      expect(querySelect().querySelector('option[value="filter:99999"]')).toBeTruthy()
    })
    const select = querySelect()
    expect(select.value).toBe('filter:99999')
    // 저장해둔 이름으로 무엇이었는지 알려준다.
    expect(select.querySelector('option[value="filter:99999"]')?.textContent).toContain(
      '지워진 필터',
    )
  })
})
