import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { JiraTransition } from '#/ipc/bindings'

/**
 * 전이 팝오버의 계약을 고정한다 (DECISIONS 11.5 개정).
 *
 * 여기서 지키는 것은 네 가지다:
 *   1. **배지 클릭이 상세 모달을 열지 않는다** — stopPropagation을 빠뜨리면
 *      팝오버와 모달이 동시에 열린다. 목록 행 전체가 이미 클릭 대상이다(D1).
 *   2. **30초 TTL 캐시가 재호출을 막는다** — 행마다 조회하면 rate limit에 닿는다.
 *   3. **2단 클릭** — 배지 한 번으로 상태가 바뀌면 안 된다. 되돌리기가 없다.
 *   4. **필수 필드가 걸린 전이는 실행하지 않는다** — 누르기 전에 알려준다.
 */

const jiraTransitions = vi.hoisted(() => vi.fn())
const jiraTransition = vi.hoisted(() => vi.fn())
const openUrl = vi.hoisted(() => vi.fn())

vi.mock('#/ipc/bindings', () => ({
  commands: { jiraTransitions, jiraTransition },
}))
vi.mock('@tauri-apps/plugin-opener', () => ({ openUrl }))
// 스토어를 통째로 목한다. 이 테스트의 관심사는 전역 인증 배너가 아니다.
vi.mock('#/store/connection', () => ({
  useConnectionStore: (selector: (s: unknown) => unknown) =>
    selector({ setJiraAuthFailed: () => {} }),
}))

const { __clearTransitionCache, StatusTransitionPopover } = await import(
  '#/widgets/jira/StatusTransitionPopover'
)

function transition(over: Partial<JiraTransition> = {}): JiraTransition {
  return {
    id: '21',
    name: '진행 중',
    toStatusName: '진행 중',
    toStatusCategory: 'indeterminate',
    hasRequiredFields: false,
    ...over,
  }
}

function ok(transitions: JiraTransition[]) {
  return { status: 'ok' as const, data: transitions }
}

/** 행 안에 놓인 배지. 행 클릭은 상세 모달을 연다 — 실제 배치와 같게 만든다. */
function renderInRow(
  transitions: JiraTransition[] = [transition()],
  onOpenDetail = vi.fn(),
  onTransitioned = vi.fn(),
) {
  jiraTransitions.mockResolvedValue(ok(transitions))
  render(
    // biome-ignore lint/a11y/useKeyWithClickEvents: 실제 행의 동작만 흉내내는 테스트용 껍데기다
    // biome-ignore lint/a11y/noStaticElementInteractions: 위와 같음
    <div onClick={() => onOpenDetail()}>
      <StatusTransitionPopover
        issueKey="EDU-299"
        browseUrl="https://team.atlassian.net/browse/EDU-299"
        onTransitioned={onTransitioned}
      >
        <span>할 일</span>
      </StatusTransitionPopover>
    </div>,
  )
  return { onOpenDetail, onTransitioned }
}

function badge() {
  return screen.getByRole('button', { name: /EDU-299 상태 변경/ })
}

describe('StatusTransitionPopover', () => {
  beforeEach(() => {
    __clearTransitionCache()
    jiraTransitions.mockReset()
    jiraTransition.mockReset()
    openUrl.mockClear()
    jiraTransition.mockResolvedValue({ status: 'ok', data: null })
  })

  // --- 1. 행 클릭과의 분리 --------------------------------------------------

  it('배지를 클릭해도 상세 모달이 열리지 않는다 (stopPropagation)', async () => {
    const { onOpenDetail } = renderInRow()
    fireEvent.click(badge())

    await waitFor(() => expect(screen.getByRole('menu')).toBeInTheDocument())
    expect(onOpenDetail).not.toHaveBeenCalled()
  })

  it('팝오버 안의 전이를 클릭해도 상세 모달이 열리지 않는다', async () => {
    const { onOpenDetail } = renderInRow()
    fireEvent.click(badge())

    const item = await screen.findByRole('button', { name: /진행 중/ })
    fireEvent.click(item)

    await waitFor(() => expect(jiraTransition).toHaveBeenCalled())
    expect(onOpenDetail).not.toHaveBeenCalled()
  })

  // --- 2. 30초 TTL 캐시 -----------------------------------------------------

  it('열 때 한 번만 조회한다 (미리 조회하지 않는다)', async () => {
    renderInRow()
    // 아직 안 눌렀다 — 행이 30개면 요청도 30개가 되므로 여기서 0이어야 한다.
    expect(jiraTransitions).not.toHaveBeenCalled()

    fireEvent.click(badge())
    await waitFor(() => expect(jiraTransitions).toHaveBeenCalledTimes(1))
  })

  it('30초 안에 다시 열면 재호출하지 않는다', async () => {
    renderInRow()

    fireEvent.click(badge())
    await waitFor(() => expect(jiraTransitions).toHaveBeenCalledTimes(1))
    // 닫고 다시 연다. 캐시가 없으면 여기서 2가 된다.
    fireEvent.click(badge())
    fireEvent.click(badge())

    await waitFor(() => expect(screen.getByRole('menu')).toBeInTheDocument())
    expect(jiraTransitions).toHaveBeenCalledTimes(1)
  })

  it('캐시가 살아 있으면 스켈레톤 없이 목록이 바로 그려진다', async () => {
    renderInRow()
    fireEvent.click(badge())
    await screen.findByRole('button', { name: /진행 중/ })
    fireEvent.click(badge()) // 닫기

    fireEvent.click(badge()) // 다시 열기 — 캐시 히트
    // 첫 렌더부터 목록이 있어야 한다. await 없이 잡히는 것이 그 증거다.
    expect(screen.getByRole('button', { name: /진행 중/ })).toBeInTheDocument()
  })

  it('30초가 지나면 다시 조회한다', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    try {
      renderInRow()
      fireEvent.click(badge())
      await waitFor(() => expect(jiraTransitions).toHaveBeenCalledTimes(1))
      fireEvent.click(badge()) // 닫기

      // TTL 경계를 넘긴다.
      vi.advanceTimersByTime(30_001)

      fireEvent.click(badge())
      await waitFor(() => expect(jiraTransitions).toHaveBeenCalledTimes(2))
    } finally {
      vi.useRealTimers()
    }
  })

  it('전이에 성공하면 캐시를 버린다 — 목록이 즉시 낡기 때문', async () => {
    renderInRow()
    fireEvent.click(badge())
    fireEvent.click(await screen.findByRole('button', { name: /진행 중/ }))
    await waitFor(() => expect(jiraTransition).toHaveBeenCalled())

    // 다시 열면 새로 조회해야 한다 (30초 안이지만 상태가 바뀌었다).
    fireEvent.click(badge())
    await waitFor(() => expect(jiraTransitions).toHaveBeenCalledTimes(2))
  })

  // --- 3. 2단 클릭 ----------------------------------------------------------

  it('배지 클릭만으로는 상태가 바뀌지 않는다', async () => {
    renderInRow()
    fireEvent.click(badge())
    await waitFor(() => expect(screen.getByRole('menu')).toBeInTheDocument())

    // 되돌리기가 없는 조작이므로 이 한 겹이 필요하다.
    expect(jiraTransition).not.toHaveBeenCalled()
  })

  it('전이 항목을 클릭해야 실행된다', async () => {
    const { onTransitioned } = renderInRow()
    fireEvent.click(badge())
    fireEvent.click(await screen.findByRole('button', { name: /진행 중/ }))

    await waitFor(() => expect(jiraTransition).toHaveBeenCalledWith('EDU-299', '21'))
    // 낙관적 업데이트가 아니라 재조회를 요청한다.
    await waitFor(() => expect(onTransitioned).toHaveBeenCalled())
  })

  // --- 4. 필수 필드가 걸린 전이 ---------------------------------------------

  it('필수 필드가 걸린 전이는 실행하지 않고 브라우저로 보낸다', async () => {
    renderInRow([
      transition({
        id: '41',
        name: '완료 처리',
        toStatusName: '완료',
        toStatusCategory: 'done',
        hasRequiredFields: true,
      }),
    ])
    fireEvent.click(badge())

    const item = await screen.findByRole('button', { name: /완료/ })
    fireEvent.click(item)

    expect(openUrl).toHaveBeenCalledWith('https://team.atlassian.net/browse/EDU-299')
    // 눌러서 400을 맞게 두지 않는다.
    expect(jiraTransition).not.toHaveBeenCalled()
  })

  it('필수 필드가 걸린 전이는 누르기 전에 그 사실을 말한다', async () => {
    renderInRow([transition({ hasRequiredFields: true })])
    fireEvent.click(badge())

    // 숨기면 "왜 완료 버튼이 없지"라는 조용한 실패가 된다.
    expect(await screen.findByText('입력 필요')).toBeInTheDocument()
  })

  // --- 그 외 상태 -----------------------------------------------------------

  it('전이 목록이 비면 에러가 아니라 사실을 말한다', async () => {
    renderInRow([])
    fireEvent.click(badge())

    expect(await screen.findByText('가능한 전이가 없습니다.')).toBeInTheDocument()
  })

  it('로딩 중에도 빈 팝오버를 그리지 않는다', async () => {
    // 응답을 붙잡아 로딩 상태를 관찰한다.
    let release: (v: unknown) => void = () => {}
    jiraTransitions.mockReturnValue(
      new Promise((resolve) => {
        release = resolve
      }),
    )
    render(
      <StatusTransitionPopover issueKey="EDU-299" browseUrl={null}>
        <span>할 일</span>
      </StatusTransitionPopover>,
    )
    fireEvent.click(badge())

    const menu = await screen.findByRole('menu')
    // 스켈레톤 3줄이 자리를 잡고 있어야 한다.
    expect(menu.querySelectorAll('li')).toHaveLength(3)

    release(ok([transition()]))
    expect(await screen.findByRole('button', { name: /진행 중/ })).toBeInTheDocument()
  })

  it('조회 실패는 팝오버 안에 인라인으로 남는다', async () => {
    jiraTransitions.mockResolvedValue({
      status: 'error',
      error: {
        kind: 'permanent',
        message: '권한이 없습니다.',
        isAuthFailure: false,
        retryAfterSecs: null,
      },
    })
    render(
      <StatusTransitionPopover issueKey="EDU-299" browseUrl={null}>
        <span>할 일</span>
      </StatusTransitionPopover>,
    )
    fireEvent.click(badge())

    // Jira 원문 그대로 (DECISIONS 16장).
    expect(await screen.findByText('권한이 없습니다.')).toBeInTheDocument()
    // 영구 실패에는 재시도를 주지 않는다 — 몇 번을 눌러도 같은 결과다.
    expect(screen.queryByRole('button', { name: '다시 시도' })).not.toBeInTheDocument()
  })

  it('전이 실패는 팝오버를 닫지 않고 그 안에 에러를 남긴다', async () => {
    const { onTransitioned } = renderInRow()
    jiraTransition.mockResolvedValue({
      status: 'error',
      error: {
        kind: 'permanent',
        message: '해결책을 지정해야 합니다.',
        isAuthFailure: false,
        retryAfterSecs: null,
      },
    })

    fireEvent.click(badge())
    fireEvent.click(await screen.findByRole('button', { name: /진행 중/ }))

    // 어느 티켓이 실패했는지가 정보다 — 전역 배너로 보내지 않는다.
    expect(await screen.findByText('해결책을 지정해야 합니다.')).toBeInTheDocument()
    expect(screen.getByRole('menu')).toBeInTheDocument()
    expect(onTransitioned).not.toHaveBeenCalled()
  })

  it('연결이 없으면 배지가 버튼이 되지 않는다', () => {
    render(
      <StatusTransitionPopover issueKey="EDU-299" browseUrl={null} disabled>
        <span>할 일</span>
      </StatusTransitionPopover>,
    )
    // 눌러도 아무 일이 없는 버튼은 "고장났나"를 만든다.
    expect(screen.queryByRole('button')).not.toBeInTheDocument()
    expect(screen.getByText('할 일')).toBeInTheDocument()
  })
})
