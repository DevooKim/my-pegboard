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
      boards: [{ id: 'default', name: 'Board', locked: false, widgets: [] }],
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
      boards: [{ id: 'default', name: 'Board', locked: false, widgets: [] }],
    })
  }

  void useConnectionStore.getState().refresh()
  subscribeSave()
}

/**
 * 디바운스 대기 중인 저장을 즉시 확정하고, 이미 시작된 저장이 있으면
 * 끝날 때까지 기다린다. 저장 중 최신 변경도 같은 장벽 안에서 끝까지 저장하며,
 * 어느 저장이든 실패하면 호출자에게 reject한다.
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
  let pending: ReturnType<typeof serializeBoard> | undefined
  let drainPromise: Promise<void> | undefined

  const save = async (file: ReturnType<typeof serializeBoard>) => {
    const r = await commands.boardSave(file as never)
    if (r.status === 'error') throw new Error(r.error)
  }

  const drainPendingSaves = (): Promise<void> => {
    if (drainPromise) return drainPromise

    const run = (async () => {
      while (pending) {
        const file = pending
        pending = undefined
        await save(file)
      }
    })()
    drainPromise = run
    const clearDrain = () => {
      if (drainPromise === run) drainPromise = undefined
    }
    void run.then(clearDrain, clearDrain)
    return run
  }

  flushImpl = () => {
    clearTimeout(timer)
    timer = undefined
    return drainPendingSaves()
  }

  useBoardStore.subscribe((state, prev) => {
    if (state.skipNextSave) {
      // Rust board_import_apply가 이미 이 정확한 파일을 저장했다. 이 플래그를
      // 먼저 소비하지 않으면 hydrate가 다시 디바운스 저장되어 오래된 상태가
      // import 결과를 덮을 수 있다.
      useBoardStore.setState({ skipNextSave: false })
      return
    }
    // hydrate 자체가 저장을 유발하면 안 된다.
    if (!state.hydrated) return
    // activeBoardId도 저장 대상이다 — 앱을 다시 켜면 마지막에 보던 보드가
    // 열려야 한다. 탭 전환은 boards 배열을 건드리지 않으므로 여기를 빼면
    // "탭을 옮겨두고 재시작했는데 첫 보드가 뜬다"는 조용한 실패가 된다.
    if (state.boards === prev.boards && state.activeBoardId === prev.activeBoardId) return

    clearTimeout(timer)
    pending = serializeBoard(state)
    timer = setTimeout(() => {
      timer = undefined
      void drainPendingSaves().catch((error) => {
        console.error('보드 저장 실패:', error)
      })
    }, SAVE_DEBOUNCE_MS)
  })
}
