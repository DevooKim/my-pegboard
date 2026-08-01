import { create } from 'zustand'
import { type CarryOverReport, commands, type TodoItem } from '#/ipc/bindings'

/**
 * Todo 상태.
 *
 * # 왜 위젯 안이 아니라 스토어인가
 *
 * 자정 이월은 **위젯 바깥의 관심사**다. 위젯이 화면에 있든 없든 자정은
 * 지나가고, 이월은 앱 전체에 한 번만 일어나야 한다. 위젯 컴포넌트의
 * `useState`에 두면 언마운트될 때 타이머가 같이 죽는다.
 *
 * # 낙관적 업데이트를 하지 않는다
 *
 * 저장이 성공해야 화면이 바뀐다. Jira였다면 반대로 했겠지만 Todo는 로컬
 * 파일이라 왕복이 수 ms다 — 숨길 느림이 없다. 그리고 이 데이터는 원본이
 * 딴 데 없어서(DECISIONS 13), 저장 실패를 얼버무리는 것이 가장 위험하다.
 *
 * 모든 커맨드가 전체 목록을 돌려주므로 부분 갱신 로직 자체가 없다.
 */

/** `YYYY-MM-DD` — Rust의 `NaiveDate`와 짝을 이룬다. */
export type DateKey = string

/**
 * 로컬 시각 기준 날짜 키.
 *
 * `toISOString()`을 쓰지 않는 이유: 그건 UTC라 한국 시간 오전 9시 이전이면
 * **어제 날짜**가 나온다. 자정 직후에 이월이 하루 밀리는 버그가 된다.
 */
export function dateKey(d: Date = new Date()): DateKey {
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

/**
 * `YYYY-MM-DD` → 로컬 `Date`(자정).
 *
 * `new Date("2026-08-01")`을 쓰지 않는 이유: 그건 UTC 자정으로 해석돼서
 * 한국에서는 오전 9시가 된다. 날짜만 다루는 값에 시간대가 끼면 하루가 밀린다.
 */
export function parseDateKey(key: DateKey): Date {
  const parts = key.split('-').map(Number)
  const [y, m, d] = [parts[0] ?? 1970, parts[1] ?? 1, parts[2] ?? 1]
  return new Date(y, m - 1, d)
}

/** `YYYY-MM-DD`에 일수를 더한다. 월·연 경계를 Date에 맡긴다. */
export function addDays(key: DateKey, delta: number): DateKey {
  const base = parseDateKey(key)
  base.setDate(base.getDate() + delta)
  return dateKey(base)
}

interface TodoState {
  items: TodoItem[]
  loaded: boolean
  /** 마지막 작업이 실패했으면 그 메시지. 화면에 드러낸다 — 조용한 실패 금지. */
  error: string | null
  /** 되돌릴 수 있는 직전 이월. 배너가 이걸 보고 뜬다. */
  lastCarry: CarryOverReport | null
  /** 이월 판정에 쓴 마지막 날짜. 이 값이 바뀌면 자정을 넘긴 것이다. */
  lastCheckedDate: DateKey | null

  load: () => Promise<void>
  add: (text: string, date: DateKey) => Promise<void>
  setDone: (id: string, done: boolean) => Promise<void>
  setText: (id: string, text: string) => Promise<void>
  remove: (id: string) => Promise<void>
  /**
   * 날짜가 바뀌었으면 이월한다.
   *
   * `viewingToday`가 false면 **아무것도 하지 않는다** — 과거를 편집하는 중에
   * 눈앞에서 항목이 튀어나가면 혼란스럽다(DECISIONS 13). 오늘로 돌아오면
   * 그때 실행된다.
   */
  checkCarryOver: (viewingToday: boolean) => Promise<void>
  undoCarry: () => Promise<void>
  dismissCarry: () => void
  clearError: () => void
}

export const useTodoStore = create<TodoState>((set, get) => ({
  items: [],
  loaded: false,
  error: null,
  lastCarry: null,
  lastCheckedDate: null,

  load: async () => {
    const r = await commands.todoList()
    if (r.status === 'ok') {
      set({ items: r.data, loaded: true, error: null })
    } else {
      set({ error: r.error, loaded: true })
    }
  },

  add: async (text, date) => {
    const trimmed = text.trim()
    if (!trimmed) return
    const r = await commands.todoAdd(trimmed, date)
    if (r.status === 'ok') set({ items: r.data, error: null })
    else set({ error: r.error })
  },

  setDone: async (id, done) => {
    const r = await commands.todoSetDone(id, done)
    if (r.status === 'ok') set({ items: r.data, error: null })
    else set({ error: r.error })
  },

  setText: async (id, text) => {
    const trimmed = text.trim()
    // 빈 텍스트로 지우는 경로를 만들지 않는다. 삭제는 명시적으로만.
    if (!trimmed) return
    const r = await commands.todoSetText(id, trimmed)
    if (r.status === 'ok') set({ items: r.data, error: null })
    else set({ error: r.error })
  },

  remove: async (id) => {
    const r = await commands.todoRemove(id)
    if (r.status === 'ok') set({ items: r.data, error: null })
    else set({ error: r.error })
  },

  checkCarryOver: async (viewingToday) => {
    const today = dateKey()
    const { lastCheckedDate } = get()

    // 같은 날 안에서 여러 번 불려도(1분마다 온다) 한 번만 일한다.
    if (lastCheckedDate === today) return
    // 과거·미래를 보는 중이면 판정 자체를 미룬다. lastCheckedDate를 갱신하지
    // 않으므로 오늘로 돌아오는 순간 다시 시도한다.
    if (!viewingToday) return

    const r = await commands.todoCarryOver(today)
    if (r.status === 'ok') {
      set({
        items: r.data.items,
        lastCheckedDate: today,
        // 옮긴 게 없으면 배너를 띄우지 않는다.
        lastCarry: r.data.report.carried.length > 0 ? r.data.report : null,
        error: null,
      })
    } else {
      set({ error: r.error })
    }
  },

  undoCarry: async () => {
    const report = get().lastCarry
    if (!report) return
    const r = await commands.todoUndoCarryOver(report)
    if (r.status === 'ok') {
      set({ items: r.data.items, lastCarry: null, error: null })
    } else {
      set({ error: r.error })
    }
  },

  dismissCarry: () => set({ lastCarry: null }),
  clearError: () => set({ error: null }),
}))

/** 특정 날짜의 항목. 배열 순서(= 추가된 순서)를 그대로 지킨다. */
export function itemsOn(items: TodoItem[], date: DateKey): TodoItem[] {
  return items.filter((i) => i.date === date)
}

/**
 * 이 항목을 며칠째 들고 있나. `originDate` 기준 **경과일**이다.
 *
 * `carriedCount`(이월 **횟수**)와 다르다. 금요일에 만들어 월요일에 이월되면
 * 이월은 1회지만 3일이 지났다. 배지에 "1일째"라고 쓰면 거짓말이므로
 * 표시는 이 값을 쓴다. 좀비 판정(7회)은 여전히 carriedCount 기준이다 —
 * 둘은 다른 것을 잰다("얼마나 오래됐나" vs "몇 번이나 미뤘나").
 */
export function daysSinceOrigin(item: TodoItem, today: DateKey = dateKey()): number {
  const origin = parseDateKey(item.originDate).getTime()
  const now = parseDateKey(today).getTime()
  // 자정 기준끼리 빼므로 DST가 껴도 반올림이 흡수한다.
  return Math.max(0, Math.round((now - origin) / 86_400_000))
}
