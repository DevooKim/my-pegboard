import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { WidgetInstance } from '#/widgets/types'

const updateWidgetConfig = vi.fn()

vi.mock('#/store/board', () => ({
  useBoardStore: (
    selector: (state: { updateWidgetConfig: typeof updateWidgetConfig }) => unknown,
  ) => selector({ updateWidgetConfig }),
}))

vi.mock('#/widgets/registry', () => ({
  getWidget: () => ({
    label: 'Linear',
    ConfigForm: ({ onValidityChange }: { onValidityChange?: (valid: boolean) => void }) => (
      <button type="button" onClick={() => onValidityChange?.(false)}>
        make invalid
      </button>
    ),
  }),
}))

const { WidgetConfigModal } = await import('./WidgetConfigModal')

const widget: WidgetInstance = {
  id: 'linear-1',
  type: 'linear',
  layout: { x: 0, y: 0, w: 4, h: 10 },
  config: { query: { kind: 'custom', filter: {} } },
}

beforeEach(() => vi.clearAllMocks())

describe('WidgetConfigModal validity', () => {
  it('disables apply when the config form reports invalid', async () => {
    render(<WidgetConfigModal widget={widget} onClose={vi.fn()} />)
    fireEvent.click(screen.getByRole('button', { name: 'make invalid' }))
    await waitFor(() => expect(screen.getByRole('button', { name: '적용' })).toBeDisabled())
    expect(updateWidgetConfig).not.toHaveBeenCalled()
  })
})
