import { render } from '@testing-library/react'
import { beforeEach, expect, it, vi } from 'vitest'
import { BOARD_SCHEMA_VERSION, DEFAULT_BOARD_ID, useBoardStore } from '#/store/board'
import { __resetRegistry, registerWidget } from '#/widgets/registry'

const gridProps = vi.fn()

vi.mock('react-grid-layout', () => ({
  default: (props: Record<string, unknown> & { children: React.ReactNode }) => {
    gridProps(props)
    return <div>{props.children}</div>
  },
  useContainerWidth: () => ({ width: 1200, containerRef: { current: null } }),
}))
vi.mock('#/board/WidgetHost', () => ({ WidgetHost: () => <div>widget</div> }))

const { Board } = await import('./Board')

beforeEach(() => {
  gridProps.mockClear()
  __resetRegistry()
  registerWidget({
    type: 'web',
    label: '웹',
    description: 'test',
    icon: () => null,
    maxInstances: 4,
    defaultConfig: {},
    defaultLayout: { w: 4, h: 8 },
    minLayout: { w: 3, h: 5 },
    pollable: true,
    View: () => null,
    ConfigForm: () => null,
    deriveTitle: () => '웹',
  })
})

function renderBoard(locked: boolean) {
  useBoardStore.setState({
    version: BOARD_SCHEMA_VERSION,
    activeBoardId: DEFAULT_BOARD_ID,
    boards: [
      {
        id: DEFAULT_BOARD_ID,
        name: 'Board',
        locked,
        widgets: [
          {
            id: 'web-1',
            type: 'web',
            layout: { x: 0, y: 0, w: 4, h: 8 },
            config: {},
          },
        ],
      },
    ],
    hydrated: true,
    skipNextSave: false,
  })
  render(<Board />)
  return gridProps.mock.lastCall?.[0] as {
    dragConfig: { enabled?: boolean }
    resizeConfig: { enabled?: boolean }
  }
}

it('잠긴 보드는 위젯 이동과 크기 변경을 막는다', () => {
  const props = renderBoard(true)
  expect(props.dragConfig.enabled).toBe(false)
  expect(props.resizeConfig.enabled).toBe(false)
})

it('잠금 해제 보드는 위젯 이동과 크기 변경을 허용한다', () => {
  const props = renderBoard(false)
  expect(props.dragConfig.enabled).toBe(true)
  expect(props.resizeConfig.enabled).toBe(true)
})
