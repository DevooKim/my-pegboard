import { create } from 'zustand'
import { getWidget } from '#/widgets/registry'
import type { WidgetInstance, WidgetType } from '#/widgets/types'

/**
 * 보드 상태.
 *
 * 보드는 항상 하나뿐이지만(DECISIONS 14장), 저장 구조와 접근 경로는
 * 다중 보드를 전제로 만들어져 있다. 컴포넌트는 boards[0]을 직접 보지 않고
 * 반드시 useActiveBoard()를 통해 접근한다 — 나중에 탭 UI를 붙일 때
 * 컴포넌트를 하나도 고치지 않기 위해서다.
 */

export interface Board {
  id: string
  name: string
  widgets: WidgetInstance[]
}

export interface BoardFile {
  version: number
  activeBoardId: string
  boards: Board[]
}

export const BOARD_SCHEMA_VERSION = 1
export const DEFAULT_BOARD_ID = 'default'
export const GRID_COLUMNS = 12

interface BoardState {
  version: number
  activeBoardId: string
  boards: Board[]
  /** 디스크에서 불러오기 전인가 — 그리드를 그리기 전에 대기해야 한다 */
  hydrated: boolean

  hydrate: (file: BoardFile) => void
  addWidget: (type: WidgetType) => { ok: true; id: string } | { ok: false; reason: string }
  removeWidget: (id: string) => void
  updateWidgetConfig: (id: string, config: Record<string, unknown>) => void
  applyLayout: (layout: Array<{ i: string; x: number; y: number; w: number; h: number }>) => void
}

function emptyBoard(): Board {
  return { id: DEFAULT_BOARD_ID, name: 'Board', widgets: [] }
}

export const useBoardStore = create<BoardState>((set, get) => ({
  version: BOARD_SCHEMA_VERSION,
  activeBoardId: DEFAULT_BOARD_ID,
  boards: [emptyBoard()],
  hydrated: false,

  hydrate: (file) =>
    set({
      version: file.version,
      activeBoardId: file.activeBoardId,
      boards: file.boards.length > 0 ? file.boards : [emptyBoard()],
      hydrated: true,
    }),

  addWidget: (type) => {
    const definition = getWidget(type)
    const state = get()
    const board = state.boards.find((b) => b.id === state.activeBoardId)
    if (!board) return { ok: false, reason: '활성 보드를 찾을 수 없습니다' }

    const existing = board.widgets.filter((w) => w.type === type).length
    if (existing >= definition.maxInstances) {
      return {
        ok: false,
        reason: `${definition.label} 위젯은 최대 ${definition.maxInstances}개까지 추가할 수 있습니다`,
      }
    }

    const id = crypto.randomUUID()
    const widget: WidgetInstance = {
      id,
      type,
      // y를 크게 두면 react-grid-layout이 맨 아래 빈 자리로 끌어올린다.
      layout: { x: 0, y: Number.MAX_SAFE_INTEGER, ...definition.defaultLayout },
      config: structuredClone(definition.defaultConfig),
    }

    set({
      boards: state.boards.map((b) =>
        b.id === board.id ? { ...b, widgets: [...b.widgets, widget] } : b,
      ),
    })
    return { ok: true, id }
  },

  removeWidget: (id) =>
    set((state) => ({
      boards: state.boards.map((b) =>
        b.id === state.activeBoardId ? { ...b, widgets: b.widgets.filter((w) => w.id !== id) } : b,
      ),
    })),

  updateWidgetConfig: (id, config) =>
    set((state) => ({
      boards: state.boards.map((b) =>
        b.id === state.activeBoardId
          ? { ...b, widgets: b.widgets.map((w) => (w.id === id ? { ...w, config } : w)) }
          : b,
      ),
    })),

  applyLayout: (layout) =>
    set((state) => {
      const byId = new Map(layout.map((l) => [l.i, l]))
      return {
        boards: state.boards.map((b) =>
          b.id === state.activeBoardId
            ? {
                ...b,
                widgets: b.widgets.map((w) => {
                  const next = byId.get(w.id)
                  return next ? { ...w, layout: { x: next.x, y: next.y, w: next.w, h: next.h } } : w
                }),
              }
            : b,
        ),
      }
    }),
}))

/**
 * 활성 보드 접근의 유일한 경로.
 * 컴포넌트에서 boards 배열을 직접 인덱싱하지 말 것.
 */
export function useActiveBoard(): Board {
  return useBoardStore((s) => {
    const active = s.boards.find((b) => b.id === s.activeBoardId) ?? s.boards[0]
    if (!active) throw new Error('보드가 하나도 없습니다 — hydrate가 보정했어야 합니다')
    return active
  })
}

export function useWidgets(): WidgetInstance[] {
  return useActiveBoard().widgets
}

/** 저장용 직렬화 — 파생 상태(hydrated)는 제외한다 */
export function serializeBoard(state: BoardState): BoardFile {
  return {
    version: BOARD_SCHEMA_VERSION,
    activeBoardId: state.activeBoardId,
    boards: state.boards,
  }
}
