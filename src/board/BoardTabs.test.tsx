import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { Board } from '#/board/Board'
import { BoardTabs } from '#/board/BoardTabs'
import { BOARD_SCHEMA_VERSION, DEFAULT_BOARD_ID, useBoardStore } from '#/store/board'
import { __resetRegistry, registerWidget } from '#/widgets/registry'
import type { WidgetDefinition, WidgetInstance } from '#/widgets/types'

/**
 * WidgetHost를 가짜로 바꾼다.
 *
 * 진짜 WidgetHost는 타입별로 데이터 훅(IPC·setInterval)을 물고 있다. 여기서
 * 확인하려는 것은 "**Board가 어떤 위젯을 렌더하는가**"이므로, 무엇이 마운트됐는지
 * 이름으로 말해주는 껍데기로 충분하다.
 */
vi.mock('#/board/WidgetHost', () => ({
  WidgetHost: ({ widget }: { widget: WidgetInstance }) => (
    <div data-testid={`host-${widget.id}`}>{widget.id}</div>
  ),
}))

// react-grid-layout은 jsdom에서 폭을 0으로 잡지만 자식은 그대로 그린다.
// 마운트 여부만 보므로 실제 라이브러리를 쓴다.

function stubWidget(overrides: Partial<WidgetDefinition> = {}): WidgetDefinition {
  return {
    type: 'jira',
    label: 'Jira',
    description: '테스트용',
    icon: () => null,
    maxInstances: 4,
    defaultConfig: {},
    defaultLayout: { w: 4, h: 8 },
    minLayout: { w: 3, h: 4 },
    pollable: true,
    View: () => null,
    ConfigForm: () => null,
    deriveTitle: () => 'Jira',
    ...overrides,
  } as WidgetDefinition
}

function reset() {
  useBoardStore.setState({
    version: BOARD_SCHEMA_VERSION,
    activeBoardId: DEFAULT_BOARD_ID,
    boards: [{ id: DEFAULT_BOARD_ID, name: '업무', locked: false, widgets: [] }],
    hydrated: true,
  })
}

describe('BoardTabs', () => {
  beforeEach(() => {
    __resetRegistry()
    reset()
  })

  it('보드가 하나면 탭 바를 아예 그리지 않는다', () => {
    render(<BoardTabs />)
    expect(screen.queryByRole('tablist')).not.toBeInTheDocument()
  })

  it('보드가 둘 이상이면 탭이 보인다', () => {
    useBoardStore.getState().addBoard()
    render(<BoardTabs />)

    expect(screen.getByRole('tablist')).toBeInTheDocument()
    expect(screen.getAllByRole('tab')).toHaveLength(2)
    expect(screen.getByRole('tab', { name: /업무/ })).toBeInTheDocument()
  })

  it('각 탭이 자기 위젯 수를 표시한다 — 비활성 탭도', () => {
    // 14장의 남은 경고("탭 뒤에 숨은 위젯은 잊힌다")를 완화하는 장치다.
    registerWidget(stubWidget())
    useBoardStore.getState().addWidget('jira')
    useBoardStore.getState().addWidget('jira')

    const { id } = useBoardStore.getState().addBoard() // 여기로 전환됨
    useBoardStore.getState().addWidget('jira')

    render(<BoardTabs />)

    // 활성 탭(새 보드) — 위젯 1개
    expect(screen.getByRole('tab', { selected: true })).toHaveTextContent('1')
    // 비활성 탭(업무) — 위젯 2개. 안 보고 있어도 무엇을 들고 있는지 말한다.
    const inactive = screen.getByRole('tab', { name: /업무/ })
    expect(inactive).toHaveAttribute('aria-selected', 'false')
    expect(inactive).toHaveTextContent('2')
    expect(inactive.querySelector('[data-widget-count="2"]')).not.toBeNull()
    // 스크린리더가 "업무 2"로 읽지 않게 단위를 붙인다.
    expect(inactive).toHaveTextContent('개 위젯')

    expect(useBoardStore.getState().activeBoardId).toBe(id)
  })

  it('탭을 누르면 활성 보드가 바뀐다', () => {
    useBoardStore.getState().addBoard()
    useBoardStore.getState().setActiveBoard(DEFAULT_BOARD_ID)
    render(<BoardTabs />)

    fireEvent.click(screen.getByRole('tab', { name: /보드 2/ }))
    expect(useBoardStore.getState().boards[1]?.id).toBe(useBoardStore.getState().activeBoardId)
  })

  it('← → 로 탭을 옮긴다', () => {
    useBoardStore.getState().addBoard()
    useBoardStore.getState().setActiveBoard(DEFAULT_BOARD_ID)
    render(<BoardTabs />)

    fireEvent.keyDown(screen.getByRole('tablist'), { key: 'ArrowRight' })
    expect(useBoardStore.getState().activeBoardId).not.toBe(DEFAULT_BOARD_ID)

    fireEvent.keyDown(screen.getByRole('tablist'), { key: 'ArrowLeft' })
    expect(useBoardStore.getState().activeBoardId).toBe(DEFAULT_BOARD_ID)
  })

  it('더블클릭하면 이름을 인라인으로 고친다', () => {
    useBoardStore.getState().addBoard()
    useBoardStore.getState().setActiveBoard(DEFAULT_BOARD_ID)
    render(<BoardTabs />)

    fireEvent.doubleClick(screen.getByRole('tab', { name: /업무/ }))
    const input = screen.getByLabelText('보드 이름')
    fireEvent.change(input, { target: { value: '개인' } })
    fireEvent.keyDown(input, { key: 'Enter' })

    expect(useBoardStore.getState().boards[0]?.name).toBe('개인')
  })

  it('빈 이름으로 고치면 이전 이름이 남는다', () => {
    useBoardStore.getState().addBoard()
    useBoardStore.getState().setActiveBoard(DEFAULT_BOARD_ID)
    render(<BoardTabs />)

    fireEvent.doubleClick(screen.getByRole('tab', { name: /업무/ }))
    const input = screen.getByLabelText('보드 이름')
    fireEvent.change(input, { target: { value: '   ' } })
    fireEvent.blur(input)

    expect(useBoardStore.getState().boards[0]?.name).toBe('업무')
  })

  it('삭제 확인창이 사라지는 위젯 수를 숫자로 말한다', () => {
    registerWidget(stubWidget())
    useBoardStore.getState().addBoard()
    useBoardStore.getState().addWidget('jira')
    useBoardStore.getState().addWidget('jira')
    useBoardStore.getState().addWidget('jira')

    render(<BoardTabs />)
    fireEvent.click(screen.getByRole('button', { name: /보드 2 보드 삭제/ }))

    expect(screen.getByText(/위젯 3개가 함께 삭제됩니다/)).toBeInTheDocument()
    expect(screen.getByText(/되돌릴 수 없습니다/)).toBeInTheDocument()
  })

  it('확인창에서 삭제를 누르면 실제로 지워진다', () => {
    useBoardStore.getState().addBoard()
    render(<BoardTabs />)

    fireEvent.click(screen.getByRole('button', { name: /보드 2 보드 삭제/ }))
    fireEvent.click(screen.getByRole('button', { name: '삭제' }))

    expect(useBoardStore.getState().boards).toHaveLength(1)
  })

  it('취소하면 아무것도 지워지지 않는다', () => {
    useBoardStore.getState().addBoard()
    render(<BoardTabs />)

    fireEvent.click(screen.getByRole('button', { name: /보드 2 보드 삭제/ }))
    fireEvent.click(screen.getByRole('button', { name: '취소' }))

    expect(useBoardStore.getState().boards).toHaveLength(2)
  })

  it('보드가 하나면 삭제 버튼이 없다 — 탭 바 자체가 없다', () => {
    render(<BoardTabs />)
    expect(screen.queryByRole('button', { name: /보드 삭제/ })).not.toBeInTheDocument()
  })

  /**
   * 탭에 들어가지 않고도 지울 수 있어야 한다.
   *
   * `invisible`은 DOM에서 사라지지 않으므로 존재 여부만 보면 **숨겨져 있어도
   * 테스트가 통과한다.** 클래스를 직접 확인해야 실제로 보이는지 알 수 있다.
   */
  it('비활성 탭의 ✕는 호버할 때만 보인다', () => {
    // 앞 테스트가 기본 보드 이름을 바꿔놨을 수 있어 직접 정한다.
    const base = useBoardStore.getState().boards[0]
    if (base) useBoardStore.getState().renameBoard(base.id, '왼쪽')
    useBoardStore.getState().addBoard() // 보드 2가 활성이 된다
    render(<BoardTabs />)

    // 비활성 탭(왼쪽) — 자리는 있지만 숨어 있고, 호버하면 드러난다.
    const inactive = screen.getByRole('button', { name: /왼쪽 보드 삭제/ })
    expect(inactive).toHaveClass('invisible')
    expect(inactive).toHaveClass('group-hover:visible')

    // 활성 탭(보드 2) — 늘 보인다.
    expect(screen.getByRole('button', { name: /보드 2 보드 삭제/ })).toHaveClass('visible')
  })

  /** 연필도 ✕와 같은 규칙이다. 두 버튼이 나란히 있어 규칙이 다르면 폭이 두 단계로 변한다. */
  it('비활성 탭의 연필도 호버할 때만 보인다', () => {
    const base = useBoardStore.getState().boards[0]
    if (base) useBoardStore.getState().renameBoard(base.id, '왼쪽')
    useBoardStore.getState().addBoard()
    render(<BoardTabs />)

    const inactive = screen.getByRole('button', { name: /왼쪽 보드 이름 변경/ })
    expect(inactive).toHaveClass('invisible')
    expect(inactive).toHaveClass('group-hover:visible')

    expect(screen.getByRole('button', { name: /보드 2 보드 이름 변경/ })).toHaveClass('visible')
  })

  /** 비활성 탭의 연필을 눌러도 그 탭으로 전환되지 않는다 — 이름만 고친다. */
  it('비활성 탭의 이름을 바꿔도 활성 보드가 바뀌지 않는다', () => {
    const base = useBoardStore.getState().boards[0]
    if (base) useBoardStore.getState().renameBoard(base.id, '왼쪽')
    useBoardStore.getState().addBoard()
    const activeBefore = useBoardStore.getState().activeBoardId
    render(<BoardTabs />)

    fireEvent.click(screen.getByRole('button', { name: /왼쪽 보드 이름 변경/ }))
    const input = screen.getByRole('textbox', { name: '보드 이름' })
    fireEvent.change(input, { target: { value: '정리됨' } })
    fireEvent.blur(input)

    expect(useBoardStore.getState().boards[0]?.name).toBe('정리됨')
    expect(useBoardStore.getState().activeBoardId).toBe(activeBefore)
  })

  /** 비활성 탭의 ✕를 눌러도 그 탭으로 전환되지 않는다 — 지우려던 것만 지운다. */
  it('비활성 탭을 지워도 활성 보드가 바뀌지 않는다', () => {
    const base = useBoardStore.getState().boards[0]
    if (base) useBoardStore.getState().renameBoard(base.id, '왼쪽')
    useBoardStore.getState().addBoard() // 보드 2 활성
    const activeBefore = useBoardStore.getState().activeBoardId
    render(<BoardTabs />)

    fireEvent.click(screen.getByRole('button', { name: /왼쪽 보드 삭제/ }))
    fireEvent.click(screen.getByRole('button', { name: '삭제' }))

    expect(useBoardStore.getState().boards).toHaveLength(1)
    expect(useBoardStore.getState().activeBoardId).toBe(activeBefore)
  })
})

/**
 * 비활성 보드는 렌더되지 않는다.
 *
 * **이게 폴링 중단의 근거다.** 폴링은 데이터 훅 안의 `setInterval`이고 언마운트에서
 * `clearInterval`한다. 비활성 보드를 숨긴 채 마운트해두면(display:none 같은 것)
 * 안 보는 보드가 계속 API를 때린다 — 화면에 드러나지 않는 실패라 테스트로 고정한다.
 */
describe('비활성 보드는 마운트되지 않는다', () => {
  beforeEach(() => {
    __resetRegistry()
    reset()
    registerWidget(stubWidget())
  })

  it('활성 보드의 위젯만 마운트된다', () => {
    const a = useBoardStore.getState().addWidget('jira')
    if (!a.ok) throw new Error('setup 실패')

    const { id: boardB } = useBoardStore.getState().addBoard()
    const b = useBoardStore.getState().addWidget('jira')
    if (!b.ok) throw new Error('setup 실패')

    // 지금 활성 보드는 B다.
    const { rerender } = render(<Board />)
    expect(screen.getByTestId(`host-${b.id}`)).toBeInTheDocument()
    expect(screen.queryByTestId(`host-${a.id}`)).not.toBeInTheDocument()

    // A로 전환하면 정확히 반대가 된다 — B의 위젯이 **언마운트**된다.
    useBoardStore.getState().setActiveBoard(DEFAULT_BOARD_ID)
    rerender(<Board />)
    expect(screen.getByTestId(`host-${a.id}`)).toBeInTheDocument()
    expect(screen.queryByTestId(`host-${b.id}`)).not.toBeInTheDocument()

    expect(boardB).not.toBe(DEFAULT_BOARD_ID)
  })
})
