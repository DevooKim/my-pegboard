import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { LinearIssue, LinearWidgetConfig, LinearWorkflowState } from '#/ipc/bindings'

/** `openUrl`은 Tauri 런타임 함수다. jsdom에는 없어서 그냥 부르면 던진다. */
vi.mock('@tauri-apps/plugin-opener', () => ({ openUrl: vi.fn() }))

/**
 * IPC를 세운다. 실제 Tauri 없이 훅과 팝오버의 호출 횟수를 세는 것이 목적이다.
 *
 * `IN_TAURI`도 켠다 — 꺼져 있으면 훅이 "브라우저에서는 불러올 수 없습니다"로
 * 빠져서 캐시·폴링 경로를 전혀 지나지 않는다.
 */
vi.mock('#/ipc/env', () => ({ IN_TAURI: true }))

const linearFetch = vi.fn()
const linearCached = vi.fn()
const linearTeamStates = vi.fn()
const linearSetState = vi.fn()
const linearIssue = vi.fn()

vi.mock('#/ipc/bindings', () => ({
  commands: {
    linearFetch: (...args: unknown[]) => linearFetch(...args),
    linearCached: (...args: unknown[]) => linearCached(...args),
    linearTeamStates: (...args: unknown[]) => linearTeamStates(...args),
    linearSetState: (...args: unknown[]) => linearSetState(...args),
    linearIssue: (...args: unknown[]) => linearIssue(...args),
  },
}))

const { groupByTeam } = await import('./grouping')
const { parseDue } = await import('./IssueRow')
const { IssueDetailModal } = await import('./IssueDetailModal')
const { LinearView } = await import('./View')
const { StatePopover, __clearStateCache } = await import('./StatePopover')
const { useLinearData, __resetLinearEnvelopes } = await import('./useLinearData')

// ─────────────────────────── 픽스처 ───────────────────────────

function issue(over: Partial<LinearIssue> = {}): LinearIssue {
  return {
    id: 'uuid-1',
    identifier: 'ENG-142',
    title: '로그인 후 리다이렉트가 한 번 더 발생한다',
    url: 'https://linear.app/acme/issue/ENG-142/redirect',
    state: {
      id: 'state-todo',
      name: 'Todo',
      color: '#e2e2e2',
      typeName: 'unstarted',
    },
    priorityLabel: 'High',
    priority: 2,
    assignee: 'Sammy',
    assigneeAvatarUrl: null,
    teamName: 'Engineering',
    teamId: 'team-eng',
    projectName: null,
    dueDate: null,
    estimate: null,
    updatedAt: '2026-08-06T09:00:00Z',
    createdAt: '2026-08-01T00:00:00Z',
    labels: [],
    ...over,
  }
}

function config(over: Partial<LinearWidgetConfig> = {}): LinearWidgetConfig {
  return {
    title: null,
    query: { kind: 'preset', id: 'assigned-to-me' },
    maxResults: 30,
    teams: [],
    sort: 'updatedAt',
    groupByTeam: false,
    refreshSecs: 0,
    ...over,
  }
}

function state(over: Partial<LinearWorkflowState> = {}): LinearWorkflowState {
  return {
    id: 'state-inprogress',
    name: 'In Progress',
    color: '#f2c94c',
    typeName: 'started',
    position: 2,
    ...over,
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  __clearStateCache()
  __resetLinearEnvelopes()
  linearCached.mockResolvedValue({ status: 'ok', data: null })
  linearTeamStates.mockResolvedValue({ status: 'ok', data: [state()] })
  linearSetState.mockResolvedValue({ status: 'ok', data: null })
  linearIssue.mockResolvedValue({
    status: 'ok',
    data: { id: 'uuid-1', identifier: 'ENG-142', description: null, branchName: null },
  })
})

afterEach(() => {
  vi.useRealTimers()
})

// ─────────────────────────── 그룹핑 ───────────────────────────

describe('groupByTeam', () => {
  it('팀별로 묶는다', () => {
    const groups = groupByTeam(
      [
        issue({ id: 'a', teamId: 't1', teamName: 'A팀' }),
        issue({ id: 'b', teamId: 't2', teamName: 'B팀' }),
        issue({ id: 'c', teamId: 't1', teamName: 'A팀' }),
      ],
      [],
    )
    expect(groups).toHaveLength(2)
    expect(groups.find((g) => g.teamId === 't1')?.issues).toHaveLength(2)
  })

  /**
   * "지금 뭐가 움직였나"가 이 앱의 목적이다. 이름순이나 개수순으로 두면
   * 오래된 팀이 위에 눌러앉아 최신 항목이 아래로 밀린다.
   */
  it('지정이 없으면 최신 항목이 있는 팀이 위로', () => {
    const groups = groupByTeam(
      [
        issue({ id: 'old', teamId: 'old', updatedAt: '2026-07-01T00:00:00Z' }),
        issue({ id: 'new', teamId: 'new', updatedAt: '2026-08-06T00:00:00Z' }),
      ],
      [],
    )
    expect(groups.map((g) => g.teamId)).toEqual(['new', 'old'])
  })

  it('지정한 순서가 최신순을 이긴다', () => {
    const groups = groupByTeam(
      [
        issue({ id: 'new', teamId: 'new', updatedAt: '2026-08-06T00:00:00Z' }),
        issue({ id: 'pinned', teamId: 'pinned', updatedAt: '2026-01-01T00:00:00Z' }),
      ],
      ['pinned', 'new'],
    )
    expect(groups.map((g) => g.teamId)).toEqual(['pinned', 'new'])
  })

  /** 팀 이름이 비면 헤더가 빈 줄이 된다. 왜 비었는지 알 수 있게 적는다. */
  it('팀 이름이 없으면 대체 문구를 쓴다', () => {
    const groups = groupByTeam([issue({ teamName: '' })], [])
    expect(groups[0]?.teamName).toBe('팀 없음')
  })
})

// ─────────────────────────── 마감일 파싱 ───────────────────────────

describe('parseDue', () => {
  /**
   * `new Date("2026-08-20")`은 UTC 자정으로 파싱돼 한국에서 오전 9시가 된다.
   * 그대로 쓰면 마감 당일 오전에 "1일 지남"이 뜬다 (todos.ts의 같은 함정).
   */
  it('YYYY-MM-DD를 로컬 하루의 끝으로 본다', () => {
    const t = parseDue('2026-08-20')
    expect(t).not.toBeNull()
    const d = new Date(t ?? 0)
    expect(d.getFullYear()).toBe(2026)
    expect(d.getMonth()).toBe(7)
    expect(d.getDate()).toBe(20)
    expect(d.getHours()).toBe(23)
  })

  /** Linear가 무엇을 주는지 실측하지 못했다 — 둘 다 견뎌야 한다. */
  it('ISO 8601도 읽는다', () => {
    expect(parseDue('2026-08-20T12:00:00.000Z')).not.toBeNull()
  })

  /** 못 읽는 값에 틀린 날짜를 그리는 것보다 아무것도 안 그리는 편이 낫다. */
  it('읽을 수 없으면 null', () => {
    expect(parseDue('언젠가')).toBeNull()
    expect(parseDue('')).toBeNull()
  })
})

// ─────────────────────────── View ───────────────────────────

function ready(issues: LinearIssue[], hasMore = false) {
  return {
    status: (issues.length === 0 ? 'empty' : 'ready') as 'empty' | 'ready',
    data: { issues, hasMore },
    fetchedAt: '2026-08-06T09:00:00Z',
    error: null,
  }
}

describe('LinearView', () => {
  it('이슈 한 줄을 그린다', () => {
    render(<LinearView widgetId="l1" config={config()} envelope={ready([issue()])} width={500} />)

    expect(screen.getByText('ENG-142')).toBeInTheDocument()
    expect(screen.getByText(/리다이렉트/)).toBeInTheDocument()
    // `priorityLabel`을 그대로 쓴다 — 숫자를 우리 말로 바꾸지 않는다.
    expect(screen.getByText('High')).toBeInTheDocument()
  })

  it('상태 이름을 배지로 보여준다', () => {
    render(<LinearView widgetId="l1" config={config()} envelope={ready([issue()])} width={500} />)
    expect(screen.getByText('Todo')).toBeInTheDocument()
  })

  it('0건이면 조건에 맞는 이슈가 없다고 말한다', () => {
    render(<LinearView widgetId="l1" config={config()} envelope={ready([])} width={500} />)
    expect(screen.getByText('조건에 맞는 이슈가 없습니다')).toBeInTheDocument()
  })

  it('영구 실패는 Rust가 준 메시지를 그대로 보여준다', () => {
    render(
      <LinearView
        widgetId="l1"
        config={config()}
        envelope={{
          status: 'error-permanent',
          data: null,
          fetchedAt: null,
          error: { status: 'error-permanent', message: 'Argument Validation Error' },
        }}
        width={500}
      />,
    )
    expect(screen.getByText('Argument Validation Error')).toBeInTheDocument()
  })

  /** 한 번 데이터가 그려진 뒤로는 본문을 비우지 않는다 (DESIGN.md). */
  it('실패해도 직전 목록을 유지한다', () => {
    render(
      <LinearView
        widgetId="l1"
        config={config()}
        envelope={{
          status: 'error-transient',
          data: { issues: [issue()], hasMore: false },
          fetchedAt: '2026-08-06T09:00:00Z',
          error: { status: 'error-transient', message: 'Rate limit exceeded' },
        }}
        width={500}
      />,
    )
    expect(screen.getByText('ENG-142')).toBeInTheDocument()
    expect(screen.getByText('갱신 실패 — 재시도 중')).toBeInTheDocument()
  })

  /**
   * **"N건 중 M건"을 만들지 않는다.** Linear 커넥션은 총 건수를 주지 않는다
   * (GitHub과 다르고 Jira 신규 검색과 같다). 잘렸다는 사실만 말한다.
   */
  it('더 있으면 잘렸다는 사실만 말한다', () => {
    render(
      <LinearView
        widgetId="l1"
        config={config({ maxResults: 30 })}
        envelope={ready([issue()], true)}
        width={500}
      />,
    )
    expect(screen.getByText('30건까지 표시 — 더 있습니다')).toBeInTheDocument()
  })

  it('팀별 묶기를 켜면 그룹 헤더가 나온다', () => {
    render(
      <LinearView
        widgetId="l1"
        config={config({ groupByTeam: true })}
        envelope={ready([issue()])}
        width={500}
      />,
    )
    expect(screen.getByRole('heading', { name: 'Engineering' })).toBeInTheDocument()
  })

  // ── 행 클릭 ──

  it('행을 누르면 상세 모달이 열린다', async () => {
    render(<LinearView widgetId="l1" config={config()} envelope={ready([issue()])} width={500} />)

    // 행의 접근성 이름은 내용에서 나온다(제목 + 메타데이터). `title`은
    // 내용이 없을 때의 폴백이므로 이름으로 찾히지 않는다.
    fireEvent.click(screen.getByRole('button', { name: /리다이렉트/ }))

    expect(await screen.findByRole('dialog')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Linear에서 열기' })).toBeInTheDocument()
  })

  /**
   * **이게 이 위젯에서 가장 밟기 쉬운 함정이다.** 행 전체가 상세를 여는데
   * 배지도 그 안에 있으므로, `stopPropagation`이 없으면 배지를 누를 때
   * 팝오버와 모달이 **동시에** 열린다. Jira에서 이미 한 번 밟았다.
   */
  it('배지 클릭이 상세 모달을 열지 않는다', async () => {
    render(<LinearView widgetId="l1" config={config()} envelope={ready([issue()])} width={500} />)

    fireEvent.click(screen.getByRole('button', { name: 'ENG-142 상태 변경' }))

    // 팝오버는 열린다.
    expect(await screen.findByRole('menu')).toBeInTheDocument()
    // 그런데 모달은 안 열린다.
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('목록을 다시 받은 뒤 열린 모달도 새 상태를 보여준다', async () => {
    const view = render(
      <LinearView widgetId="l1" config={config()} envelope={ready([issue()])} width={500} />,
    )
    fireEvent.click(screen.getByRole('button', { name: /리다이렉트/ }))

    const dialog = await screen.findByRole('dialog')
    expect(within(dialog).getByText('Todo')).toBeInTheDocument()

    view.rerender(
      <LinearView
        widgetId="l1"
        config={config()}
        envelope={ready([
          issue({
            state: {
              id: 'state-inprogress',
              name: 'In Progress',
              color: '#f2c94c',
              typeName: 'started',
            },
          }),
        ])}
        width={500}
      />,
    )

    expect(within(dialog).getByText('In Progress')).toBeInTheDocument()
    expect(within(dialog).queryByText('Todo')).toBeNull()
  })
})

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

describe('IssueDetailModal', () => {
  it('브랜치 복사 실패를 헤더에 남긴다', async () => {
    const writeText = vi.fn().mockRejectedValue(new Error('denied'))
    Object.assign(navigator, { clipboard: { writeText } })
    linearIssue.mockResolvedValue({
      status: 'ok',
      data: {
        id: 'uuid-1',
        identifier: 'ENG-142',
        description: null,
        branchName: 'feature/eng-142',
      },
    })

    render(<IssueDetailModal issue={issue()} onClose={vi.fn()} />)

    const branchButton = await screen.findByTitle('브랜치 이름 복사: feature/eng-142')
    fireEvent.click(branchButton)

    expect(await screen.findByText('복사하지 못했습니다')).toBeInTheDocument()
  })

  it('브랜치 복사 타이머를 언마운트 때 정리한다', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.assign(navigator, { clipboard: { writeText } })
    linearIssue.mockResolvedValue({
      status: 'ok',
      data: {
        id: 'uuid-1',
        identifier: 'ENG-142',
        description: null,
        branchName: 'feature/eng-142',
      },
    })

    const view = render(<IssueDetailModal issue={issue()} onClose={vi.fn()} />)
    const branchButton = await screen.findByTitle('브랜치 이름 복사: feature/eng-142')
    vi.useFakeTimers()
    await act(async () => {
      fireEvent.click(branchButton)
      await Promise.resolve()
    })
    expect(writeText).toHaveBeenCalledWith('feature/eng-142')

    view.unmount()
    expect(vi.getTimerCount()).toBe(0)
    await act(async () => vi.advanceTimersByTimeAsync(1_500))
  })

  it('먼저 연 이슈의 늦은 응답을 다음 이슈에 붙이지 않는다', async () => {
    const first = deferred<Awaited<ReturnType<typeof linearIssue>>>()
    const second = deferred<Awaited<ReturnType<typeof linearIssue>>>()
    linearIssue.mockImplementation((id: string) =>
      id === 'uuid-1' ? first.promise : second.promise,
    )

    const modal = render(
      <IssueDetailModal issue={issue()} onClose={vi.fn()} onStateChanged={vi.fn()} />,
    )
    await waitFor(() => expect(linearIssue).toHaveBeenCalledWith('uuid-1'))

    modal.rerender(
      <IssueDetailModal
        issue={issue({ id: 'uuid-2', identifier: 'ENG-200', title: '두 번째 이슈' })}
        onClose={vi.fn()}
        onStateChanged={vi.fn()}
      />,
    )
    await waitFor(() => expect(linearIssue).toHaveBeenCalledWith('uuid-2'))

    await act(async () => {
      second.resolve({
        status: 'ok',
        data: {
          id: 'uuid-2',
          identifier: 'ENG-200',
          description: '두 번째 설명',
          branchName: 'feature/second',
        },
      })
    })
    expect(await screen.findByText('두 번째 설명')).toBeInTheDocument()

    await act(async () => {
      first.resolve({
        status: 'ok',
        data: {
          id: 'uuid-1',
          identifier: 'ENG-142',
          description: '첫 번째 설명',
          branchName: 'feature/first',
        },
      })
    })

    expect(screen.queryByText('첫 번째 설명')).toBeNull()
    expect(screen.getByText('두 번째 설명')).toBeInTheDocument()
  })
})

// ─────────────────────────── 상태 팝오버 ───────────────────────────

function renderPopover(over: Partial<Parameters<typeof StatePopover>[0]> = {}) {
  const props = {
    issueId: 'uuid-1',
    identifier: 'ENG-142',
    teamId: 'team-eng',
    currentStateId: 'state-todo',
    issueUrl: 'https://linear.app/acme/issue/ENG-142',
    ...over,
  }
  return render(
    <StatePopover {...props}>
      <span>Todo</span>
    </StatePopover>,
  )
}

describe('StatePopover', () => {
  it('배지를 누르면 그 팀의 상태 목록을 조회한다', async () => {
    renderPopover()
    fireEvent.click(screen.getByRole('button', { name: 'ENG-142 상태 변경' }))

    await waitFor(() => expect(linearTeamStates).toHaveBeenCalledWith('team-eng'))
    expect(await screen.findByRole('button', { name: /In Progress/ })).toBeInTheDocument()
  })

  /**
   * **30초 메모리 캐시가 재호출을 막는다.**
   *
   * 캐시 키가 **팀**이라는 것이 Jira와의 차이다 — 같은 팀 이슈 30건이 상태
   * 목록을 공유하므로, 이슈별로 나누면 같은 것을 30번 받는다.
   */
  it('30초 안에는 같은 팀을 다시 조회하지 않는다', async () => {
    const first = renderPopover()
    fireEvent.click(screen.getByRole('button', { name: 'ENG-142 상태 변경' }))
    await waitFor(() => expect(linearTeamStates).toHaveBeenCalledTimes(1))
    first.unmount()

    // 같은 팀의 **다른 이슈**를 연다. 캐시가 팀 단위이므로 조회가 없어야 한다.
    renderPopover({ issueId: 'uuid-2', identifier: 'ENG-999' })
    fireEvent.click(screen.getByRole('button', { name: 'ENG-999 상태 변경' }))

    expect(await screen.findByRole('button', { name: /In Progress/ })).toBeInTheDocument()
    expect(linearTeamStates).toHaveBeenCalledTimes(1)
  })

  it('다른 팀이면 새로 조회한다', async () => {
    const first = renderPopover()
    fireEvent.click(screen.getByRole('button', { name: 'ENG-142 상태 변경' }))
    await waitFor(() => expect(linearTeamStates).toHaveBeenCalledTimes(1))
    first.unmount()

    renderPopover({ teamId: 'team-des', identifier: 'DES-1' })
    fireEvent.click(screen.getByRole('button', { name: 'DES-1 상태 변경' }))

    await waitFor(() => expect(linearTeamStates).toHaveBeenCalledTimes(2))
    expect(linearTeamStates).toHaveBeenLastCalledWith('team-des')
  })

  it('TTL이 지나면 다시 조회한다', async () => {
    const first = renderPopover()
    fireEvent.click(screen.getByRole('button', { name: 'ENG-142 상태 변경' }))
    await waitFor(() => expect(linearTeamStates).toHaveBeenCalledTimes(1))
    first.unmount()

    // 31초 뒤. `Date.now`를 밀어 TTL을 넘긴다.
    const realNow = Date.now
    Date.now = () => realNow() + 31_000
    try {
      renderPopover()
      fireEvent.click(screen.getByRole('button', { name: 'ENG-142 상태 변경' }))
      await waitFor(() => expect(linearTeamStates).toHaveBeenCalledTimes(2))
    } finally {
      Date.now = realNow
    }
  })

  /** 같은 상태로 옮기는 것은 아무 일도 아니다. 누를 수 없어야 한다. */
  it('현재 상태는 누를 수 없다', async () => {
    linearTeamStates.mockResolvedValue({
      status: 'ok',
      data: [state({ id: 'state-todo', name: 'Todo' }), state()],
    })
    renderPopover({ currentStateId: 'state-todo' })
    fireEvent.click(screen.getByRole('button', { name: 'ENG-142 상태 변경' }))

    await screen.findByText('현재')
    expect(screen.queryByRole('button', { name: /^Todo/ })).toBeNull()
  })

  it('상태를 고르면 issueUpdate를 보낸다', async () => {
    const onChanged = vi.fn()
    renderPopover({ onChanged })
    fireEvent.click(screen.getByRole('button', { name: 'ENG-142 상태 변경' }))

    fireEvent.click(await screen.findByRole('button', { name: /In Progress/ }))

    await waitFor(() => expect(linearSetState).toHaveBeenCalledWith('uuid-1', 'state-inprogress'))
    // 성공 후 재조회. **낙관적 업데이트를 하지 않는다.**
    await waitFor(() => expect(onChanged).toHaveBeenCalled())
  })

  /** 실패는 팝오버 안에 남는다 — 어느 이슈가 실패했는지가 정보다. */
  it('변경 실패를 팝오버 안에 인라인으로 남긴다', async () => {
    linearSetState.mockResolvedValue({
      status: 'error',
      error: {
        kind: 'permanent',
        message: 'Entity not found',
        isAuthFailure: false,
        retryAfterSecs: null,
      },
    })
    const onChanged = vi.fn()
    renderPopover({ onChanged })
    fireEvent.click(screen.getByRole('button', { name: 'ENG-142 상태 변경' }))
    fireEvent.click(await screen.findByRole('button', { name: /In Progress/ }))

    expect(await screen.findByText('Entity not found')).toBeInTheDocument()
    // 실패했으면 목록을 갱신하지 않는다 — 바뀐 것이 없다.
    expect(onChanged).not.toHaveBeenCalled()
  })

  /**
   * 영구 실패에 재시도 버튼을 주면 몇 번을 눌러도 같은 결과인 버튼을 주는 셈이다.
   */
  it('목록 조회가 영구 실패면 재시도를 주지 않는다', async () => {
    linearTeamStates.mockResolvedValue({
      status: 'error',
      error: {
        kind: 'permanent',
        message: 'Team not found',
        isAuthFailure: false,
        retryAfterSecs: null,
      },
    })
    renderPopover()
    fireEvent.click(screen.getByRole('button', { name: 'ENG-142 상태 변경' }))

    expect(await screen.findByText('Team not found')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '다시 시도' })).toBeNull()
  })

  it('일시적 실패에는 재시도를 준다', async () => {
    linearTeamStates.mockResolvedValue({
      status: 'error',
      error: {
        kind: 'transient',
        message: 'Rate limit exceeded',
        isAuthFailure: false,
        retryAfterSecs: 60,
      },
    })
    renderPopover()
    fireEvent.click(screen.getByRole('button', { name: 'ENG-142 상태 변경' }))

    expect(await screen.findByRole('button', { name: '다시 시도' })).toBeInTheDocument()
  })

  /**
   * 팀을 모르면 상태 목록을 조회할 수 없다. **눌러도 아무 일이 없는 버튼을
   * 주지 않는다** — 사용자가 "고장났나" 하고 다시 누르게 만든다.
   */
  it('팀 id가 없으면 배지가 평범한 배지로 남는다', () => {
    renderPopover({ teamId: '' })
    expect(screen.queryByRole('button', { name: 'ENG-142 상태 변경' })).toBeNull()
    expect(screen.getByText('Todo')).toBeInTheDocument()
  })
})

// ─────────────────────────── 데이터 훅 ───────────────────────────

/** 훅을 시험하기 위한 최소 컴포넌트. envelope의 상태와 건수만 찍는다. */
function HookProbe({ widgetId = 'l1', refreshMs = 0 }: { widgetId?: string; refreshMs?: number }) {
  const { envelope } = useLinearData(widgetId, config(), refreshMs)
  return (
    <div>
      <span data-testid="status">{envelope.status}</span>
      <span data-testid="count">{envelope.data?.issues.length ?? -1}</span>
    </div>
  )
}

describe('useLinearData', () => {
  /**
   * **★ 탭 복귀 깜빡임 방지 — 이 위젯에서 반드시 있어야 하는 것.**
   *
   * 비활성 보드는 언마운트되므로(그게 폴링을 멈추는 방식이다) 탭을 돌아오면
   * 훅이 새로 마운트된다. 모듈 스코프 맵이 없으면 `IDLE`부터 시작해
   * "불러오는 중…"이 한 프레임 스친다.
   *
   * 리마운트가 **데이터를 든 상태로** 시작하는지 본다.
   */
  it('탭을 오가도 데이터를 든 상태로 리마운트된다', async () => {
    linearFetch.mockResolvedValue({
      status: 'ok',
      data: {
        issues: [issue(), issue({ id: 'uuid-2', identifier: 'ENG-143' })],
        hasMore: false,
        fetchedAt: '2026-08-06T09:00:00Z',
        fromCache: false,
      },
    })

    const first = render(<HookProbe />)
    await waitFor(() => expect(screen.getByTestId('status')).toHaveTextContent('ready'))
    expect(screen.getByTestId('count')).toHaveTextContent('2')

    // 탭을 떠난다(언마운트).
    first.unmount()

    // 돌아온다. **첫 렌더부터** 데이터가 있어야 한다 — 비동기를 기다리지 않고 본다.
    render(<HookProbe />)
    expect(screen.getByTestId('count')).toHaveTextContent('2')
    expect(screen.getByTestId('status')).not.toHaveTextContent('loading')
  })

  /** 위젯이 다르면 서로의 데이터를 보지 않는다. */
  it('다른 위젯 id는 캐시를 공유하지 않는다', async () => {
    linearFetch.mockResolvedValue({
      status: 'ok',
      data: {
        issues: [issue()],
        hasMore: false,
        fetchedAt: '2026-08-06T09:00:00Z',
        fromCache: false,
      },
    })

    const first = render(<HookProbe widgetId="l1" />)
    await waitFor(() => expect(screen.getByTestId('count')).toHaveTextContent('1'))
    first.unmount()

    render(<HookProbe widgetId="l2" />)
    // l2는 처음이므로 데이터가 없다(-1).
    expect(screen.getByTestId('count')).toHaveTextContent('-1')
  })

  /** 캐시 먼저, 네트워크 나중 (DECISIONS 17장). */
  it('디스크 캐시를 먼저 그린다', async () => {
    linearCached.mockResolvedValue({
      status: 'ok',
      data: {
        issues: [issue()],
        hasMore: false,
        fetchedAt: '2026-08-05T00:00:00Z',
        fromCache: true,
      },
    })
    // 네트워크는 영원히 안 온다 — 캐시만으로 그려지는지 본다.
    linearFetch.mockReturnValue(new Promise(() => {}))

    render(<HookProbe />)

    await waitFor(() => expect(screen.getByTestId('count')).toHaveTextContent('1'))
    expect(screen.getByTestId('status')).toHaveTextContent('stale')
  })

  /**
   * **rate limit이 일시적으로 도착해야 한다.** Linear는 rate limit을 HTTP 400으로
   * 보내고 이 앱은 400을 영구로 분류한다 — Rust가 갈라낸 것이 여기까지 와야
   * `error-transient`가 된다.
   */
  it('rate limit은 error-transient가 된다', async () => {
    linearFetch.mockResolvedValue({
      status: 'error',
      error: {
        kind: 'transient',
        message: 'Rate limit exceeded',
        isAuthFailure: false,
        retryAfterSecs: 60,
        stale: null,
      },
    })

    render(<HookProbe />)
    await waitFor(() => expect(screen.getByTestId('status')).toHaveTextContent('error-transient'))
  })

  it('일시적 실패를 1초·2초·4초 뒤 세 번 재시도한다', async () => {
    vi.useFakeTimers()
    linearFetch.mockResolvedValue({
      status: 'error',
      error: {
        kind: 'transient',
        message: 'Network unavailable',
        isAuthFailure: false,
        retryAfterSecs: null,
        stale: null,
      },
    })

    render(<HookProbe />)
    await act(async () => {})
    expect(linearFetch).toHaveBeenCalledTimes(1)

    await act(async () => vi.advanceTimersByTimeAsync(999))
    expect(linearFetch).toHaveBeenCalledTimes(1)
    await act(async () => vi.advanceTimersByTimeAsync(1))
    expect(linearFetch).toHaveBeenCalledTimes(2)

    await act(async () => vi.advanceTimersByTimeAsync(2_000))
    expect(linearFetch).toHaveBeenCalledTimes(3)
    await act(async () => vi.advanceTimersByTimeAsync(4_000))
    expect(linearFetch).toHaveBeenCalledTimes(4)

    await act(async () => vi.advanceTimersByTimeAsync(8_000))
    expect(linearFetch).toHaveBeenCalledTimes(4)
  })

  it('rate limit 재시도는 서버가 준 대기 시간을 지킨다', async () => {
    vi.useFakeTimers()
    linearFetch.mockResolvedValue({
      status: 'error',
      error: {
        kind: 'transient',
        message: 'Rate limit exceeded',
        isAuthFailure: false,
        retryAfterSecs: 60,
        stale: null,
      },
    })

    render(<HookProbe />)
    await act(async () => {})
    expect(linearFetch).toHaveBeenCalledTimes(1)

    await act(async () => vi.advanceTimersByTimeAsync(59_999))
    expect(linearFetch).toHaveBeenCalledTimes(1)
    await act(async () => vi.advanceTimersByTimeAsync(1))
    expect(linearFetch).toHaveBeenCalledTimes(2)
  })

  it('정기 폴링도 rate limit 대기 시간을 앞당기지 않는다', async () => {
    vi.useFakeTimers()
    linearFetch.mockResolvedValue({
      status: 'error',
      error: {
        kind: 'transient',
        message: 'Rate limit exceeded',
        isAuthFailure: false,
        retryAfterSecs: 60,
        stale: null,
      },
    })

    render(<HookProbe refreshMs={10_000} />)
    await act(async () => {})
    expect(linearFetch).toHaveBeenCalledTimes(1)

    await act(async () => vi.advanceTimersByTimeAsync(59_999))
    expect(linearFetch).toHaveBeenCalledTimes(1)
    await act(async () => vi.advanceTimersByTimeAsync(1))
    expect(linearFetch).toHaveBeenCalledTimes(2)
  })

  it('언마운트 뒤 끝난 실패 응답은 재시도를 예약하지 않는다', async () => {
    vi.useFakeTimers()
    const pending = deferred<Awaited<ReturnType<typeof linearFetch>>>()
    linearFetch.mockReturnValue(pending.promise)

    const probe = render(<HookProbe />)
    await act(async () => {})
    expect(linearFetch).toHaveBeenCalledTimes(1)
    probe.unmount()

    await act(async () => {
      pending.resolve({
        status: 'error',
        error: {
          kind: 'transient',
          message: 'Network unavailable',
          isAuthFailure: false,
          retryAfterSecs: null,
          stale: null,
        },
      })
    })
    await act(async () => vi.advanceTimersByTimeAsync(10_000))

    expect(linearFetch).toHaveBeenCalledTimes(1)
  })

  /** 실패해도 Rust가 준 직전 데이터로 목록을 유지한다. */
  it('실패 시 stale 데이터를 받아 목록을 유지한다', async () => {
    linearFetch.mockResolvedValue({
      status: 'error',
      error: {
        kind: 'transient',
        message: 'Rate limit exceeded',
        isAuthFailure: false,
        retryAfterSecs: 60,
        stale: {
          issues: [issue()],
          hasMore: false,
          fetchedAt: '2026-08-05T00:00:00Z',
          fromCache: true,
        },
      },
    })

    render(<HookProbe />)
    await waitFor(() => expect(screen.getByTestId('count')).toHaveTextContent('1'))
  })

  /** 상태 변경 성공 → 목록 재조회. 낙관적 업데이트를 하지 않기 때문이다. */
  it('상태 변경 이벤트를 받으면 다시 조회한다', async () => {
    linearFetch.mockResolvedValue({
      status: 'ok',
      data: {
        issues: [issue()],
        hasMore: false,
        fetchedAt: '2026-08-06T09:00:00Z',
        fromCache: false,
      },
    })

    render(<HookProbe />)
    await waitFor(() => expect(linearFetch).toHaveBeenCalledTimes(1))

    window.dispatchEvent(new CustomEvent('pegboard:linear-state-changed'))
    await waitFor(() => expect(linearFetch).toHaveBeenCalledTimes(2))
  })

  it('생성 이벤트를 받으면 다시 조회한다', async () => {
    linearFetch.mockResolvedValue({
      status: 'ok',
      data: {
        issues: [issue()],
        hasMore: false,
        fetchedAt: '2026-08-06T09:00:00Z',
        fromCache: false,
      },
    })

    render(<HookProbe />)
    await waitFor(() => expect(linearFetch).toHaveBeenCalledTimes(1))
    window.dispatchEvent(new CustomEvent('pegboard:linear-created'))
    await waitFor(() => expect(linearFetch).toHaveBeenCalledTimes(2))
  })

  it('상태 변경 이벤트가 진행 중 조회와 겹치면 종료 직후 다시 조회한다', async () => {
    const pending = deferred<Awaited<ReturnType<typeof linearFetch>>>()
    linearFetch.mockReturnValueOnce(pending.promise).mockResolvedValueOnce({
      status: 'ok',
      data: {
        issues: [
          issue({
            state: {
              id: 'state-inprogress',
              name: 'In Progress',
              color: '#f2c94c',
              typeName: 'started',
            },
          }),
        ],
        hasMore: false,
        fetchedAt: '2026-08-06T09:01:00Z',
        fromCache: false,
      },
    })

    render(<HookProbe />)
    await waitFor(() => expect(linearFetch).toHaveBeenCalledTimes(1))
    window.dispatchEvent(new CustomEvent('pegboard:linear-state-changed'))

    await act(async () => {
      pending.resolve({
        status: 'ok',
        data: {
          issues: [issue()],
          hasMore: false,
          fetchedAt: '2026-08-06T09:00:00Z',
          fromCache: false,
        },
      })
    })

    await waitFor(() => expect(linearFetch).toHaveBeenCalledTimes(2))
    await waitFor(() => expect(screen.getByTestId('status')).toHaveTextContent('ready'))
  })
})
