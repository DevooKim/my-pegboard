import { beforeEach, describe, expect, it } from 'vitest'
import {
  BOARD_SCHEMA_VERSION,
  DEFAULT_BOARD_ID,
  serializeBoard,
  useBoardStore,
} from '#/store/board'
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

  it('replaceFromImport는 Rust가 저장한 보드 파일을 한 번에 hydrate한다', () => {
    const imported = {
      version: BOARD_SCHEMA_VERSION,
      activeBoardId: 'imported',
      boards: [{ id: 'imported', name: '가져온 보드', widgets: [] }],
    }

    useBoardStore.getState().replaceFromImport(imported)

    expect(useBoardStore.getState()).toMatchObject({
      version: imported.version,
      activeBoardId: imported.activeBoardId,
      boards: imported.boards,
      hydrated: true,
    })
  })

  it('등록되지 않은 타입 추가는 조용히 실패하지 않고 예외를 던진다', () => {
    expect(() => useBoardStore.getState().addWidget('github')).toThrow(/등록되지 않은/)
  })
})

/**
 * 다중 보드 (DECISIONS 14장 개정).
 *
 * 여기서 지키려는 것은 화면에 안 드러나는 두 가지다: 보드 0개 상태를 만들지
 * 않는 것과, activeBoardId가 없는 보드를 가리키지 않는 것. 둘 다 깨지면
 * useActiveBoard의 폴백이 조용히 다른 보드를 열어 원인을 감춘다.
 */
describe('보드 CRUD', () => {
  beforeEach(() => {
    __resetRegistry()
    resetStore()
  })

  it('보드를 추가하면 목록에 붙고 그쪽으로 전환된다', () => {
    const { id } = useBoardStore.getState().addBoard()
    const state = useBoardStore.getState()
    expect(state.boards).toHaveLength(2)
    expect(state.boards[1]?.id).toBe(id)
    expect(state.boards[1]?.widgets).toEqual([])
    expect(state.activeBoardId).toBe(id)
  })

  it('새 보드 이름은 겹치지 않는다 — 지웠다 다시 만들어도', () => {
    const a = useBoardStore.getState().addBoard()
    expect(useBoardStore.getState().boards[1]?.name).toBe('보드 2')

    useBoardStore.getState().addBoard()
    expect(useBoardStore.getState().boards[2]?.name).toBe('보드 3')

    // '보드 2'를 지우고 다시 추가한다. 개수+1로 이름을 짓는다면 '보드 3'이
    // 되어 이미 있는 탭과 이름이 같아진다.
    useBoardStore.getState().removeBoard(a.id)
    useBoardStore.getState().addBoard()
    const names = useBoardStore.getState().boards.map((b) => b.name)
    expect(new Set(names).size).toBe(names.length)
    expect(names).toContain('보드 2')
  })

  it('전환은 존재하는 보드만 받는다 — 고아 activeBoardId를 만들지 않는다', () => {
    const { id } = useBoardStore.getState().addBoard()
    useBoardStore.getState().setActiveBoard(DEFAULT_BOARD_ID)
    expect(useBoardStore.getState().activeBoardId).toBe(DEFAULT_BOARD_ID)

    useBoardStore.getState().setActiveBoard('없는-보드')
    expect(useBoardStore.getState().activeBoardId).toBe(DEFAULT_BOARD_ID)

    useBoardStore.getState().setActiveBoard(id)
    expect(useBoardStore.getState().activeBoardId).toBe(id)
  })

  it('이름을 바꾼다 — 앞뒤 공백은 떼고', () => {
    const r = useBoardStore.getState().renameBoard(DEFAULT_BOARD_ID, '  업무  ')
    expect(r.ok).toBe(true)
    expect(useBoardStore.getState().boards[0]?.name).toBe('업무')
  })

  it('빈 이름은 거부하고 이전 이름을 유지한다', () => {
    useBoardStore.getState().renameBoard(DEFAULT_BOARD_ID, '업무')

    expect(useBoardStore.getState().renameBoard(DEFAULT_BOARD_ID, '').ok).toBe(false)
    expect(useBoardStore.getState().renameBoard(DEFAULT_BOARD_ID, '   ').ok).toBe(false)
    expect(useBoardStore.getState().boards[0]?.name).toBe('업무')
  })

  it('마지막 보드는 삭제되지 않는다', () => {
    const r = useBoardStore.getState().removeBoard(DEFAULT_BOARD_ID)
    expect(r.ok).toBe(false)
    expect(useBoardStore.getState().boards).toHaveLength(1)
  })

  it('보드를 지우면 위젯도 함께 사라진다', () => {
    registerWidget(stubWidget())
    const { id } = useBoardStore.getState().addBoard()
    useBoardStore.getState().addWidget('jira')
    expect(useBoardStore.getState().boards[1]?.widgets).toHaveLength(1)

    useBoardStore.getState().removeBoard(id)
    expect(useBoardStore.getState().boards).toHaveLength(1)
    expect(useBoardStore.getState().boards[0]?.widgets).toHaveLength(0)
  })

  it('보고 있던 보드를 지우면 오른쪽 보드로 옮겨간다', () => {
    const b = useBoardStore.getState().addBoard() // [default, b]
    const c = useBoardStore.getState().addBoard() // [default, b, c]
    useBoardStore.getState().setActiveBoard(b.id)

    useBoardStore.getState().removeBoard(b.id)
    // b가 있던 자리(index 1)에 c가 들어온다.
    expect(useBoardStore.getState().activeBoardId).toBe(c.id)
  })

  it('마지막 위치의 보드를 지우면 왼쪽 보드로 옮겨간다', () => {
    const b = useBoardStore.getState().addBoard()
    useBoardStore.getState().setActiveBoard(b.id)

    useBoardStore.getState().removeBoard(b.id)
    expect(useBoardStore.getState().activeBoardId).toBe(DEFAULT_BOARD_ID)
  })

  it('보고 있지 않은 보드를 지워도 활성 보드는 그대로다', () => {
    const b = useBoardStore.getState().addBoard()
    useBoardStore.getState().setActiveBoard(DEFAULT_BOARD_ID)

    useBoardStore.getState().removeBoard(b.id)
    expect(useBoardStore.getState().activeBoardId).toBe(DEFAULT_BOARD_ID)
  })

  it('없는 보드 삭제는 아무것도 바꾸지 않는다', () => {
    useBoardStore.getState().addBoard()
    const before = useBoardStore.getState().boards

    expect(useBoardStore.getState().removeBoard('없는-보드').ok).toBe(false)
    expect(useBoardStore.getState().boards).toBe(before)
  })

  it('순서를 바꾼다', () => {
    const b = useBoardStore.getState().addBoard()
    const c = useBoardStore.getState().addBoard()

    useBoardStore.getState().moveBoard(2, 0)
    expect(useBoardStore.getState().boards.map((x) => x.id)).toEqual([c.id, DEFAULT_BOARD_ID, b.id])
    // 순서를 바꿔도 보고 있던 보드는 그대로다 (c를 만들 때 c로 전환됐다).
    expect(useBoardStore.getState().activeBoardId).toBe(c.id)
  })

  it('범위를 벗어난 순서 변경은 무시한다', () => {
    useBoardStore.getState().addBoard()
    const before = useBoardStore.getState().boards

    useBoardStore.getState().moveBoard(0, 5)
    useBoardStore.getState().moveBoard(-1, 0)
    useBoardStore.getState().moveBoard(1, 1)
    expect(useBoardStore.getState().boards).toBe(before)
  })

  it('maxInstances는 보드별로 센다 — 보드 A가 가득 차도 보드 B에는 넣을 수 있다', () => {
    registerWidget(stubWidget({ maxInstances: 2 }))
    const { addWidget } = useBoardStore.getState()

    // 보드 A를 채운다.
    expect(addWidget('jira').ok).toBe(true)
    expect(addWidget('jira').ok).toBe(true)
    expect(addWidget('jira').ok).toBe(false)

    // 보드를 늘려 위젯을 더 담으려는 것이 아니지만, 맥락이 다른 보드에 그
    // 맥락의 위젯을 두는 것은 막을 이유가 없다 (DECISIONS 14장 개정).
    useBoardStore.getState().addBoard()
    expect(useBoardStore.getState().addWidget('jira').ok).toBe(true)
    expect(useBoardStore.getState().boards[0]?.widgets).toHaveLength(2)
    expect(useBoardStore.getState().boards[1]?.widgets).toHaveLength(1)
  })

  it('보드 1개인 기존 board.json이 그대로 읽힌다 (하위 호환)', () => {
    // v0.4.0까지 저장된 파일의 모양. 스키마 버전을 올리지 않았으므로
    // 마이그레이션 없이 읽혀야 하고, 탭 1개로 보여야 한다.
    useBoardStore.getState().hydrate({
      version: 1,
      activeBoardId: 'default',
      boards: [
        {
          id: 'default',
          name: 'Board',
          widgets: [{ id: 'w1', type: 'jira', layout: { x: 0, y: 0, w: 4, h: 8 }, config: {} }],
        },
      ],
    })

    const state = useBoardStore.getState()
    expect(state.version).toBe(1)
    expect(state.boards).toHaveLength(1)
    expect(state.activeBoardId).toBe('default')
    expect(state.boards[0]?.widgets).toHaveLength(1)
  })

  it('직렬화에 activeBoardId가 담긴다 — 재시작 때 마지막 보드가 열려야 한다', () => {
    const { id } = useBoardStore.getState().addBoard()
    const file = serializeBoard(useBoardStore.getState())
    expect(file.activeBoardId).toBe(id)
    expect(file.boards).toHaveLength(2)
    expect(file.version).toBe(BOARD_SCHEMA_VERSION)
  })
})
