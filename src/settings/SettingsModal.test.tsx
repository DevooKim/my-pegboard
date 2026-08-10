import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { type BoardImportCandidate, commands } from '#/ipc/bindings'
import { SettingsModal } from '#/settings/SettingsModal'
import { type BoardFile, useBoardStore } from '#/store/board'
import { flushPendingSaves } from '#/store/persist'

const { relaunchMock } = vi.hoisted(() => ({ relaunchMock: vi.fn() }))

vi.mock('#/ipc/bindings', () => ({
  commands: {
    boardExport: vi.fn(),
    boardImportPreview: vi.fn(),
    boardImportApply: vi.fn(),
    linearSaveToken: vi.fn(),
    linearVerify: vi.fn(),
  },
}))

vi.mock('#/store/persist', () => ({
  flushPendingSaves: vi.fn(),
}))

vi.mock('#/store/update', () => ({
  RELEASES_PAGE: 'https://example.com/releases',
  useUpdateStore: (selector: (state: { restart: typeof relaunchMock }) => unknown) =>
    selector({ restart: relaunchMock }),
}))

vi.mock('#/ipc/env', () => ({ IN_TAURI: true }))

const refreshConnection = vi.fn()
vi.mock('#/store/connection', () => ({
  useConnectionStore: (
    selector: (state: { linearConfigured: boolean; refresh: typeof refreshConnection }) => unknown,
  ) => selector({ linearConfigured: false, refresh: refreshConnection }),
}))

const boardFile: BoardFile = {
  version: 1,
  activeBoardId: 'imported',
  boards: [{ id: 'imported', name: '업무', widgets: [] }],
}

const candidate = {
  file: {
    formatVersion: 1,
    exportedAt: '2026-08-10T00:00:00Z',
    board: boardFile,
  },
  preview: {
    boardCount: 1,
    widgetCount: 0,
    widgetCounts: [],
    formatVersion: 1,
    boardSchemaVersion: 1,
    albumPathWarnings: [{ path: '/Volumes/사진/여행' }],
  },
} as unknown as BoardImportCandidate

function resetStore() {
  useBoardStore.setState({
    version: 1,
    activeBoardId: 'default',
    boards: [{ id: 'default', name: 'Board', widgets: [] }],
    hydrated: false,
    skipNextSave: false,
  })
}

function renderBoardTab() {
  return render(<SettingsModal open onClose={vi.fn()} onSaved={vi.fn()} initialTab="board" />)
}

describe('SettingsModal board transfer', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(flushPendingSaves).mockResolvedValue(undefined)
    relaunchMock.mockResolvedValue(undefined)
    resetStore()
  })

  it('shows the board tab and keeps export cancellation quiet', async () => {
    vi.mocked(commands.boardExport).mockResolvedValue({ status: 'ok', data: null })
    renderBoardTab()

    expect(screen.getByRole('tab', { name: '보드' })).toHaveAttribute('aria-selected', 'true')
    fireEvent.click(screen.getByRole('button', { name: '내보내기' }))

    await waitFor(() => expect(commands.boardExport).toHaveBeenCalledTimes(1))
    expect(screen.queryByText(/실패|오류/)).not.toBeInTheDocument()
  })

  it('shows an export error inline', async () => {
    vi.mocked(commands.boardExport).mockResolvedValue({
      status: 'error',
      error: '권한이 없습니다',
    })
    renderBoardTab()

    fireEvent.click(screen.getByRole('button', { name: '내보내기' }))

    expect(await screen.findByText('권한이 없습니다')).toBeInTheDocument()
  })

  it('does not apply when import is cancelled', async () => {
    vi.mocked(commands.boardImportPreview).mockResolvedValue({ status: 'ok', data: null })
    renderBoardTab()

    fireEvent.click(screen.getByRole('button', { name: '가져오기' }))

    await waitFor(() => expect(commands.boardImportPreview).toHaveBeenCalledTimes(1))
    expect(screen.queryByRole('button', { name: /적용/ })).not.toBeInTheDocument()
    expect(commands.boardImportApply).not.toHaveBeenCalled()
  })

  it('previews album warnings, exposes replace warning, and allows merge selection', async () => {
    vi.mocked(commands.boardImportPreview).mockResolvedValue({ status: 'ok', data: candidate })
    renderBoardTab()

    fireEvent.click(screen.getByRole('button', { name: '가져오기' }))

    expect(await screen.findByText('보드 1개 · 위젯 0개')).toBeInTheDocument()
    expect(screen.getByText('/Volumes/사진/여행')).toBeInTheDocument()
    expect(screen.getByText(/현재 보드 구성이 사라집니다/)).toBeInTheDocument()
    expect(screen.getByRole('radio', { name: '교체' })).toBeChecked()

    fireEvent.click(screen.getByRole('radio', { name: '병합' }))
    expect(screen.getByRole('radio', { name: '병합' })).toBeChecked()
  })

  it('confirms apply and hydrates the returned board exactly once', async () => {
    const replaceFromImport = vi.fn()
    useBoardStore.setState({ replaceFromImport })
    vi.mocked(commands.boardImportPreview).mockResolvedValue({ status: 'ok', data: candidate })
    vi.mocked(commands.boardImportApply).mockResolvedValue({
      status: 'ok',
      data: { board: boardFile, orphanCacheCleanupWarning: null } as never,
    })
    renderBoardTab()

    fireEvent.click(screen.getByRole('button', { name: '가져오기' }))
    fireEvent.click(await screen.findByRole('button', { name: '교체 적용' }))

    await waitFor(() => expect(commands.boardImportApply).toHaveBeenCalledTimes(1))
    expect(commands.boardImportApply).toHaveBeenCalledWith(candidate.file, 'replace')
    expect(replaceFromImport).toHaveBeenCalledTimes(1)
    expect(replaceFromImport).toHaveBeenCalledWith(boardFile)
    expect(screen.queryByText('보드 1개 · 위젯 0개')).not.toBeInTheDocument()
  })

  it('flushes a pending save before apply and shows restart requirement without auto-relaunch', async () => {
    const order: string[] = []
    vi.mocked(flushPendingSaves).mockImplementation(async () => {
      order.push('flush')
    })
    vi.mocked(commands.boardImportApply).mockImplementation(async () => {
      order.push('apply')
      return {
        status: 'ok',
        data: {
          board: boardFile,
          orphanCacheCleanupWarning: '고아 캐시 경고',
          signal: 'relaunchRequired',
        } as never,
      }
    })
    renderBoardTab()

    fireEvent.click(screen.getByRole('button', { name: '가져오기' }))
    fireEvent.click(await screen.findByRole('button', { name: '교체 적용' }))

    await waitFor(() => expect(commands.boardImportApply).toHaveBeenCalledTimes(1))
    expect(order).toEqual(['flush', 'apply'])
    expect(await screen.findByText(/앨범 경로 권한 변경.*재시작/)).toBeInTheDocument()
    expect(await screen.findByText('고아 캐시 경고')).toBeInTheDocument()
    expect(relaunchMock).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole('button', { name: '앱 재시작' }))
    await waitFor(() => expect(relaunchMock).toHaveBeenCalledTimes(1))
    expect(order).toEqual(['flush', 'apply'])
  })

  it('keeps a relaunch rejection visible after the explicit restart button is pressed', async () => {
    relaunchMock.mockRejectedValue(new Error('재시작이 거부됐습니다'))
    vi.mocked(commands.boardImportPreview).mockResolvedValue({ status: 'ok', data: candidate })
    vi.mocked(commands.boardImportApply).mockResolvedValue({
      status: 'ok',
      data: {
        board: boardFile,
        orphanCacheCleanupWarning: null,
        signal: 'relaunchRequired',
      } as never,
    })
    renderBoardTab()

    fireEvent.click(screen.getByRole('button', { name: '가져오기' }))
    fireEvent.click(await screen.findByRole('button', { name: '교체 적용' }))
    fireEvent.click(await screen.findByRole('button', { name: '앱 재시작' }))

    expect(
      await screen.findByText('앱을 재시작하지 못했습니다: 재시작이 거부됐습니다'),
    ).toBeInTheDocument()
  })

  it('keeps an apply error visible in the board tab', async () => {
    vi.mocked(commands.boardImportPreview).mockResolvedValue({ status: 'ok', data: candidate })
    vi.mocked(commands.boardImportApply).mockResolvedValue({
      status: 'error',
      error: '저장할 수 없습니다',
    })
    renderBoardTab()

    fireEvent.click(screen.getByRole('button', { name: '가져오기' }))
    fireEvent.click(await screen.findByRole('button', { name: '교체 적용' }))

    expect(await screen.findByText('저장할 수 없습니다')).toBeInTheDocument()
  })

  it('keeps a cache cleanup warning visible after the board was applied successfully', async () => {
    const replaceFromImport = vi.fn()
    useBoardStore.setState({ replaceFromImport })
    vi.mocked(commands.boardImportPreview).mockResolvedValue({ status: 'ok', data: candidate })
    vi.mocked(commands.boardImportApply).mockResolvedValue({
      status: 'ok',
      data: {
        board: boardFile,
        orphanCacheCleanupWarning: '보드는 저장됐지만 고아 캐시 정리에 실패했습니다',
      } as never,
    })

    renderBoardTab()
    fireEvent.click(screen.getByRole('button', { name: '가져오기' }))
    fireEvent.click(await screen.findByRole('button', { name: '교체 적용' }))

    await waitFor(() => expect(replaceFromImport).toHaveBeenCalledWith(boardFile))
    expect(
      await screen.findByText('보드는 저장됐지만 고아 캐시 정리에 실패했습니다'),
    ).toBeInTheDocument()
  })
})

describe('SettingsModal Linear connection', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    refreshConnection.mockResolvedValue(undefined)
  })

  it('shows a save IPC rejection and clears the working state', async () => {
    vi.mocked(commands.linearSaveToken).mockRejectedValueOnce(new Error('저장 IPC 중단'))
    render(<SettingsModal open onClose={vi.fn()} onSaved={vi.fn()} initialTab="connections" />)

    fireEvent.change(screen.getByPlaceholderText('lin_api_...'), {
      target: { value: 'lin_api_test' },
    })
    fireEvent.click(screen.getAllByRole('button', { name: '저장' }).at(-1) as HTMLElement)

    expect(await screen.findByText('저장 IPC 중단')).toBeInTheDocument()
    expect(screen.getAllByRole('button', { name: '저장' }).at(-1)).not.toBeDisabled()
  })

  it('shows a verify IPC rejection and clears the working state', async () => {
    vi.mocked(commands.linearSaveToken).mockResolvedValue({ status: 'ok', data: null })
    vi.mocked(commands.linearVerify).mockRejectedValueOnce(new Error('검증 IPC 중단'))
    render(<SettingsModal open onClose={vi.fn()} onSaved={vi.fn()} initialTab="connections" />)

    fireEvent.change(screen.getByPlaceholderText('lin_api_...'), {
      target: { value: 'lin_api_test' },
    })
    fireEvent.click(screen.getAllByRole('button', { name: '저장' }).at(-1) as HTMLElement)

    expect(await screen.findByText('검증 IPC 중단')).toBeInTheDocument()
    fireEvent.change(screen.getByPlaceholderText('lin_api_...'), {
      target: { value: 'lin_api_retry' },
    })
    expect(screen.getAllByRole('button', { name: '저장' }).at(-1)).not.toBeDisabled()
  })
})
