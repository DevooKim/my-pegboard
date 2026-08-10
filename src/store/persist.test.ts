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
const { bootstrap, flushPendingSaves } = await import('#/store/persist')

const initialBoard = {
  version: 1,
  activeBoardId: 'default',
  boards: [{ id: 'default', name: 'Board', widgets: [] }],
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise
  })
  return { promise, resolve }
}

let subscribed = false

describe('board persistence after import', () => {
  beforeAll(() => {
    vi.useFakeTimers()
  })

  beforeEach(async () => {
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
    if (!subscribed) {
      await bootstrap()
      subscribed = true
    } else {
      useBoardStore.setState({ hydrated: true })
    }
  })

  it('does not re-save the imported board, but saves the next user change', async () => {
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

  it('waits for an in-flight save before saving the latest pending board', async () => {
    const oldSave = deferred<{ status: 'ok'; data: null }>()
    const latestSave = deferred<{ status: 'ok'; data: null }>()
    let persisted = initialBoard
    boardSave.mockImplementation((file) => {
      const gate = boardSave.mock.calls.length === 1 ? oldSave : latestSave
      return gate.promise.then((result) => {
        persisted = file
        return result
      })
    })

    useBoardStore.getState().addBoard()
    await vi.advanceTimersByTimeAsync(500)
    expect(boardSave).toHaveBeenCalledTimes(1)

    const latestBoard = useBoardStore.getState().addBoard()
    let flushSettled = false
    const flush = flushPendingSaves().finally(() => {
      flushSettled = true
    })

    await Promise.resolve()
    expect(flushSettled).toBe(false)
    expect(boardSave).toHaveBeenCalledTimes(1)

    oldSave.resolve({ status: 'ok', data: null })
    for (let i = 0; i < 10; i += 1) await Promise.resolve()
    expect(boardSave).toHaveBeenCalledTimes(2)

    latestSave.resolve({ status: 'ok', data: null })
    await flush
    expect(persisted.activeBoardId).toBe(latestBoard.id)
  })

  it('does not let a save started before flush overwrite an imported board', async () => {
    const oldSave = deferred<{ status: 'ok'; data: null }>()
    let persisted = initialBoard
    boardSave.mockImplementation((file) =>
      oldSave.promise.then((result) => {
        persisted = file
        return result
      }),
    )

    useBoardStore.getState().addBoard()
    await vi.advanceTimersByTimeAsync(500)

    const imported = {
      version: 1,
      activeBoardId: 'imported',
      boards: [{ id: 'imported', name: 'Imported', widgets: [] }],
    }
    const importAfterFlush = flushPendingSaves().then(() => {
      useBoardStore.getState().replaceFromImport(imported)
      // This represents Rust's successful atomic import write.
      persisted = imported
    })

    oldSave.resolve({ status: 'ok', data: null })
    await importAfterFlush
    expect(persisted).toEqual(imported)
  })

  it('rejects flush when boardSave returns an error result', async () => {
    boardSave.mockResolvedValue({ status: 'error', error: '디스크가 가득 찼습니다' })
    useBoardStore.getState().addBoard()

    await expect(flushPendingSaves()).rejects.toThrow('디스크가 가득 찼습니다')
  })
})
