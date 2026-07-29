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

function subscribeSave(): void {
  let timer: ReturnType<typeof setTimeout> | undefined

  useBoardStore.subscribe((state, prev) => {
    // hydrate 자체가 저장을 유발하면 안 된다.
    if (!state.hydrated || state.boards === prev.boards) return

    clearTimeout(timer)
    timer = setTimeout(() => {
      void commands.boardSave(serializeBoard(state) as never).then((r) => {
        if (r.status === 'error') console.error('보드 저장 실패:', r.error)
      })
    }, SAVE_DEBOUNCE_MS)
  })
}
