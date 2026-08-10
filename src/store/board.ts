import { create } from 'zustand'
import { getWidget } from '#/widgets/registry'
import type { WidgetInstance, WidgetType } from '#/widgets/types'

/**
 * 보드 상태.
 *
 * 보드는 여러 개일 수 있다 (DECISIONS 14장 개정 — 근거는 위젯 수가 아니라
 * **맥락 전환**이다: 업무 볼 때와 개인 볼 때 봐야 할 것이 다르다).
 *
 * 컴포넌트는 boards 배열을 직접 인덱싱하지 않고 useActiveBoard()로 접근한다.
 * 14장이 단일 보드 시절에 미리 깔아둔 경로이고, 그래서 탭 UI를 붙이면서
 * 위젯 쪽 코드를 한 줄도 고치지 않았다.
 *
 * **보드당 위젯은 적게 유지하는 것이 여전히 맞다.** 14장의 전제("위젯 5~7개면
 * 한 화면에 다 들어간다")는 뒤집히지 않았다. 보드를 늘려 위젯을 더 담으려는
 * 것이 아니므로 maxInstances는 보드별로 센다.
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
  /** import apply가 이미 Rust에 저장한 정확한 파일임을 persist에 알린다 */
  skipNextSave: boolean

  hydrate: (file: BoardFile) => void
  /** Rust has already persisted and validated this exact file. */
  replaceFromImport: (file: BoardFile) => void
  addWidget: (type: WidgetType) => { ok: true; id: string } | { ok: false; reason: string }
  removeWidget: (id: string) => void
  updateWidgetConfig: (id: string, config: Record<string, unknown>) => void
  applyLayout: (layout: Array<{ i: string; x: number; y: number; w: number; h: number }>) => void

  // --- 보드 CRUD (DECISIONS 14장 개정) ---
  /** 새 보드를 만들고 그쪽으로 전환한다. 만든 직후 비어 있는 보드를 봐야 자연스럽다 */
  addBoard: () => { id: string }
  /** 활성 보드를 바꾼다. 없는 id는 무시한다 — 고아 activeBoardId를 만들지 않는다 */
  setActiveBoard: (id: string) => void
  /** 이름 변경. 빈 이름(공백만)은 거부한다 — 이름 없는 탭은 누를 수 없는 탭이다 */
  renameBoard: (id: string, name: string) => { ok: boolean }
  /** 삭제. 마지막 보드는 지울 수 없다 (보드 0개 상태를 만들지 않는다) */
  removeBoard: (id: string) => { ok: boolean }
  /** 탭 순서 변경. from 위치의 보드를 to 위치로 옮긴다 */
  moveBoard: (from: number, to: number) => void
}

function emptyBoard(): Board {
  return { id: DEFAULT_BOARD_ID, name: 'Board', widgets: [] }
}

/**
 * `보드 2`, `보드 3` … 중 비어 있는 첫 번호.
 *
 * 개수 + 1로 계산하지 않는 이유: `보드 2`를 지우고 다시 추가하면 이름이 겹친다.
 * 탭 이름이 같으면 어느 쪽을 눌러야 하는지 알 수 없다.
 */
function nextBoardName(boards: Board[]): string {
  const taken = new Set(boards.map((b) => b.name))
  for (let n = 2; ; n += 1) {
    const candidate = `보드 ${n}`
    if (!taken.has(candidate)) return candidate
  }
}

export const useBoardStore = create<BoardState>((set, get) => ({
  version: BOARD_SCHEMA_VERSION,
  activeBoardId: DEFAULT_BOARD_ID,
  boards: [emptyBoard()],
  hydrated: false,
  skipNextSave: false,

  hydrate: (file) =>
    set({
      version: file.version,
      activeBoardId: file.activeBoardId,
      boards: file.boards.length > 0 ? file.boards : [emptyBoard()],
      hydrated: true,
      skipNextSave: false,
    }),

  replaceFromImport: (file) =>
    set({
      version: file.version,
      activeBoardId: file.activeBoardId,
      boards: file.boards,
      hydrated: true,
      skipNextSave: true,
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

  addBoard: () => {
    const state = get()
    const id = crypto.randomUUID()
    set({
      boards: [...state.boards, { id, name: nextBoardName(state.boards), widgets: [] }],
      // 만든 보드로 바로 옮긴다. 추가해두고 안 보여주면 만들어진 줄 모른다.
      activeBoardId: id,
    })
    return { id }
  },

  setActiveBoard: (id) =>
    set((state) => (state.boards.some((b) => b.id === id) ? { activeBoardId: id } : {})),

  renameBoard: (id, name) => {
    const trimmed = name.trim()
    if (trimmed === '') return { ok: false }
    set((state) => ({
      boards: state.boards.map((b) => (b.id === id ? { ...b, name: trimmed } : b)),
    }))
    return { ok: true }
  },

  removeBoard: (id) => {
    const state = get()
    // 마지막 보드는 지킨다. Rust도 빈 배열을 기본 보드로 복구하지만 그건
    // 손으로 파일을 고친 경우를 위한 방어선이고, UI가 먼저 막아야 한다.
    if (state.boards.length <= 1) return { ok: false }
    if (!state.boards.some((b) => b.id === id)) return { ok: false }

    const index = state.boards.findIndex((b) => b.id === id)
    const remaining = state.boards.filter((b) => b.id !== id)
    // 지운 보드를 보고 있었으면 옆으로 옮긴다. 오른쪽이 없으면 왼쪽.
    // activeBoardId가 없는 보드를 가리키게 두면 useActiveBoard가 조용히
    // 첫 보드로 폴백해서 "왜 이 보드가 열렸지"가 된다.
    const nextActive =
      state.activeBoardId === id
        ? (remaining[index] ?? remaining[remaining.length - 1])
        : state.boards.find((b) => b.id === state.activeBoardId)

    set({
      boards: remaining,
      activeBoardId: nextActive?.id ?? remaining[0]?.id ?? DEFAULT_BOARD_ID,
    })
    return { ok: true }
  },

  moveBoard: (from, to) =>
    set((state) => {
      if (from === to) return {}
      if (from < 0 || from >= state.boards.length) return {}
      if (to < 0 || to >= state.boards.length) return {}
      const boards = [...state.boards]
      const [moved] = boards.splice(from, 1)
      if (!moved) return {}
      boards.splice(to, 0, moved)
      return { boards }
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
