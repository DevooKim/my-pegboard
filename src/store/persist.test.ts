import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

const { boardLoad, boardSave, refresh } = vi.hoisted(() => ({
  boardLoad: vi.fn(),
  boardSave: vi.fn(),
  refresh: vi.fn(),
}))

vi.mock('#/ipc/bindings', () => ({
  commands: { boardLoad, boardSave },
}))

vi.mock('#/store/connection', () => ({
  useConnectionStore: { getState: () => ({ refresh }) },
}))

Object.defineProperty(window, '__TAURI_INTERNALS__', { value: {}, configurable: true })

const { useBoardStore } = await import('#/store/board')
const { bootstrap } = await import('#/store/persist')

const initialBoard = {
  version: 1,
  activeBoardId: 'default',
  boards: [{ id: 'default', name: 'Board', widgets: [] }],
}

describe('board persistence after import', () => {
  beforeAll(() => {
    vi.useFakeTimers()
  })

  beforeEach(() => {
    vi.clearAllMocks()
    boardLoad.mockResolvedValue({ status: 'ok', data: initialBoard })
    boardSave.mockResolvedValue({ status: 'ok', data: null })
    refresh.mockResolvedValue(undefined)
    useBoardStore.setState({
      version: 1,
      activeBoardId: 'default',
      boards: [{ id: 'default', name: 'Board', widgets: [] }],
      hydrated: false,
      skipNextSave: false,
    })
  })

  it('does not re-save the imported board, but saves the next user change', async () => {
    await bootstrap()
    const imported = {
      version: 1,
      activeBoardId: 'imported',
      boards: [{ id: 'imported', name: 'Imported', widgets: [] }],
    }

    useBoardStore.getState().replaceFromImport(imported)
    expect(useBoardStore.getState().skipNextSave).toBe(false)

    await vi.advanceTimersByTimeAsync(500)
    expect(boardSave).not.toHaveBeenCalled()

    useBoardStore.getState().addBoard()
    await vi.advanceTimersByTimeAsync(500)
    expect(boardSave).toHaveBeenCalledTimes(1)
    expect(boardSave.mock.calls[0]?.[0].activeBoardId).not.toBe('default')
  })
})
