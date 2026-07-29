import { beforeEach, describe, expect, it } from 'vitest'
import { BOARD_SCHEMA_VERSION, DEFAULT_BOARD_ID, useBoardStore } from '#/store/board'
import { __resetRegistry, registerWidget } from '#/widgets/registry'
import type { WidgetDefinition } from '#/widgets/types'

function stubWidget(overrides: Partial<WidgetDefinition> = {}): WidgetDefinition {
  return {
    type: 'jira',
    label: 'Jira',
    description: '테스트용',
    icon: () => null,
    maxInstances: 4,
    defaultConfig: { preset: 'assigned-to-me' },
    defaultLayout: { w: 4, h: 8 },
    minLayout: { w: 3, h: 4 },
    pollable: true,
    View: () => null,
    ConfigForm: () => null,
    deriveTitle: () => 'Jira',
    ...overrides,
  } as WidgetDefinition
}

function resetStore() {
  useBoardStore.setState({
    version: BOARD_SCHEMA_VERSION,
    activeBoardId: DEFAULT_BOARD_ID,
    boards: [{ id: DEFAULT_BOARD_ID, name: 'Board', widgets: [] }],
    hydrated: false,
  })
}

describe('board store', () => {
  beforeEach(() => {
    __resetRegistry()
    resetStore()
  })

  it('타입별 인스턴스 상한을 넘으면 추가를 거부한다', () => {
    registerWidget(stubWidget({ maxInstances: 2 }))
    const { addWidget } = useBoardStore.getState()

    expect(addWidget('jira').ok).toBe(true)
    expect(addWidget('jira').ok).toBe(true)

    const third = addWidget('jira')
    expect(third.ok).toBe(false)
    if (!third.ok) expect(third.reason).toContain('최대 2개')
    expect(useBoardStore.getState().boards[0]?.widgets).toHaveLength(2)
  })

  it('상한은 타입별로 독립적으로 적용된다', () => {
    registerWidget(stubWidget({ type: 'jira', maxInstances: 1 }))
    registerWidget(stubWidget({ type: 'todo', maxInstances: 3, label: 'Todo' }))
    const { addWidget } = useBoardStore.getState()

    addWidget('jira')
    expect(addWidget('jira').ok).toBe(false)
    // jira가 찼다고 todo까지 막히면 안 된다
    expect(addWidget('todo').ok).toBe(true)
  })

  it('추가한 위젯은 정의의 기본 설정을 복사해서 갖는다 (공유 참조 아님)', () => {
    const definition = stubWidget()
    registerWidget(definition)
    const result = useBoardStore.getState().addWidget('jira')
    expect(result.ok).toBe(true)

    const widget = useBoardStore.getState().boards[0]?.widgets[0]
    expect(widget?.config).toEqual({ preset: 'assigned-to-me' })
    // 인스턴스 설정을 바꿔도 정의의 기본값이 오염되면 안 된다
    expect(widget?.config).not.toBe(definition.defaultConfig)
  })

  it('applyLayout은 좌표만 갱신하고 설정은 보존한다', () => {
    registerWidget(stubWidget())
    const added = useBoardStore.getState().addWidget('jira')
    if (!added.ok) throw new Error('setup 실패')

    useBoardStore.getState().applyLayout([{ i: added.id, x: 3, y: 2, w: 6, h: 10 }])

    const widget = useBoardStore.getState().boards[0]?.widgets[0]
    expect(widget?.layout).toEqual({ x: 3, y: 2, w: 6, h: 10 })
    expect(widget?.config).toEqual({ preset: 'assigned-to-me' })
  })

  it('applyLayout에 없는 위젯은 건드리지 않는다', () => {
    registerWidget(stubWidget())
    const a = useBoardStore.getState().addWidget('jira')
    const b = useBoardStore.getState().addWidget('jira')
    if (!a.ok || !b.ok) throw new Error('setup 실패')

    useBoardStore.getState().applyLayout([{ i: a.id, x: 1, y: 1, w: 5, h: 5 }])

    const widgets = useBoardStore.getState().boards[0]?.widgets ?? []
    expect(widgets.find((w) => w.id === b.id)?.layout.w).toBe(4)
  })

  it('hydrate는 빈 boards 배열을 기본 보드로 보정한다', () => {
    useBoardStore.getState().hydrate({
      version: BOARD_SCHEMA_VERSION,
      activeBoardId: DEFAULT_BOARD_ID,
      boards: [],
    })
    const state = useBoardStore.getState()
    expect(state.boards).toHaveLength(1)
    expect(state.hydrated).toBe(true)
  })

  it('등록되지 않은 타입 추가는 조용히 실패하지 않고 예외를 던진다', () => {
    expect(() => useBoardStore.getState().addWidget('github')).toThrow(/등록되지 않은/)
  })
})
