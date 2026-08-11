import { act, fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, expect, it, vi } from 'vitest'
import { BOARD_SCHEMA_VERSION, DEFAULT_BOARD_ID, useBoardStore } from '#/store/board'

vi.mock('#/board/AddWidgetMenu', () => ({ AddWidgetMenu: () => null }))
vi.mock('#/board/Board', () => ({ Board: () => null }))
vi.mock('#/board/BoardTabs', () => ({ BoardTabs: () => null }))
vi.mock('#/settings/SettingsModal', () => ({ SettingsModal: () => null }))
vi.mock('#/store/connection', () => ({
  useConnectionStore: (selector: (state: object) => unknown) =>
    selector({ jiraAuthFailed: false, linearAuthFailed: false }),
}))
vi.mock('#/store/persist', () => ({ bootstrap: () => Promise.resolve() }))

const updateState = { hasUpdate: false }
const useUpdateStore = Object.assign(
  (selector: (state: typeof updateState) => unknown) => selector(updateState),
  { getState: () => updateState },
)
vi.mock('#/store/update', () => ({
  startUpdateChecks: () => () => {},
  useUpdateStore,
}))

const { App } = await import('./App')

beforeEach(() => {
  useBoardStore.setState({
    version: BOARD_SCHEMA_VERSION,
    activeBoardId: DEFAULT_BOARD_ID,
    boards: [{ id: DEFAULT_BOARD_ID, name: 'Board', locked: false, widgets: [] }],
    hydrated: true,
    skipNextSave: false,
  })
})

it('타이틀바에서 활성 보드 잠금을 토글한다', async () => {
  await act(async () => render(<App />))

  const lockButton = screen.getByRole('button', { name: '보드 잠금' })
  expect(lockButton).not.toHaveAttribute('aria-pressed')
  fireEvent.click(lockButton)

  expect(useBoardStore.getState().boards[0]?.locked).toBe(true)
  expect(screen.getByRole('button', { name: '보드 잠금 해제' })).toBeInTheDocument()
})
