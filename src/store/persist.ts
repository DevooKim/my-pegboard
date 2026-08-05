import { commands } from '#/ipc/bindings'
import { IN_TAURI } from '#/ipc/env'
import { serializeBoard, useBoardStore } from '#/store/board'
import { useConnectionStore } from '#/store/connection'

const SAVE_DEBOUNCE_MS = 500

/**
 * 앱 시작 시 한 번 호출한다.
 *
 * 저장은 디바운스한다 — 드래그 중 레이아웃 이벤트가 초당 수십 번 오는데
 * 그때마다 파일을 쓰면 디스크를 두들긴다 (DECISIONS 10장).
 */
export async function bootstrap(): Promise<void> {
  if (!IN_TAURI) {
    // Tauri 밖에서는 저장소가 없다. 빈 보드로 시작해 UI만 볼 수 있게 한다.
    useBoardStore.getState().hydrate({
      version: 1,
      activeBoardId: 'default',
      boards: [{ id: 'default', name: 'Board', widgets: [] }],
    })
    return
  }

  const result = await commands.boardLoad()
  if (result.status === 'ok') {
    useBoardStore.getState().hydrate(result.data as never)
  } else {
    console.error('보드를 불러오지 못했습니다:', result.error)
    // 불러오기 실패해도 앱은 떠야 한다. 빈 보드로 진행.
    useBoardStore.getState().hydrate({
      version: 1,
      activeBoardId: 'default',
      boards: [{ id: 'default', name: 'Board', widgets: [] }],
    })
  }

  void useConnectionStore.getState().refresh()
  subscribeSave()
}

/**
 * 디바운스 대기 중인 저장을 즉시 확정한다. 대기 중인 게 없으면 아무 일도 없다.
 *
 * 앱을 스스로 재시작하기 전에 반드시 호출한다 (업데이트 설치 후 재시작).
 * 디바운스 타이머가 살아 있는 채로 프로세스가 죽으면 **직전 배치 변경이
 * 조용히 사라진다** — 드래그로 위젯을 옮긴 직후가 정확히 그 구간이다.
 *
 * Todo는 여기 해당하지 않는다. 모든 변경이 즉시 Rust로 가므로 대기분이 없다.
 */
export function flushPendingSaves(): Promise<void> {
  return flushImpl()
}

/** subscribeSave가 실제 구현을 여기에 꽂는다. bootstrap 전에는 대기분이 없다. */
let flushImpl: () => Promise<void> = async () => {}

function subscribeSave(): void {
  let timer: ReturnType<typeof setTimeout> | undefined
  let pending: (() => Promise<void>) | undefined

  const save = async () => {
    const state = useBoardStore.getState()
    const r = await commands.boardSave(serializeBoard(state) as never)
    if (r.status === 'error') console.error('보드 저장 실패:', r.error)
  }

  flushImpl = async () => {
    if (!pending) return
    clearTimeout(timer)
    pending = undefined
    await save()
  }

  useBoardStore.subscribe((state, prev) => {
    // hydrate 자체가 저장을 유발하면 안 된다.
    if (!state.hydrated) return
    // activeBoardId도 저장 대상이다 — 앱을 다시 켜면 마지막에 보던 보드가
    // 열려야 한다. 탭 전환은 boards 배열을 건드리지 않으므로 여기를 빼면
    // "탭을 옮겨두고 재시작했는데 첫 보드가 뜬다"는 조용한 실패가 된다.
    if (state.boards === prev.boards && state.activeBoardId === prev.activeBoardId) return

    clearTimeout(timer)
    pending = save
    timer = setTimeout(() => {
      pending = undefined
      void save()
    }, SAVE_DEBOUNCE_MS)
  })
}
