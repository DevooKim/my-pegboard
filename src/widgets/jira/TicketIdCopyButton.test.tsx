import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { TicketIdCopyButton } from './TicketIdCopyButton'

afterEach(() => {
  vi.clearAllTimers()
  vi.useRealTimers()
})

describe('Jira TicketIdCopyButton', () => {
  it('copies the visible Jira key and exposes success for 1.5 seconds', async () => {
    vi.useFakeTimers()
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.assign(navigator, { clipboard: { writeText } })
    render(<TicketIdCopyButton identifier="EDU-60" />)

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'EDU-60 복사' }))
      await Promise.resolve()
    })
    expect(writeText).toHaveBeenCalledWith('EDU-60')
    expect(screen.getByRole('button', { name: 'EDU-60 복사됨' })).toBeInTheDocument()

    await act(async () => vi.advanceTimersByTimeAsync(1_500))
    expect(screen.getByRole('button', { name: 'EDU-60 복사' })).toBeInTheDocument()
  })

  it('leaves clipboard failure visible in the header', async () => {
    Object.assign(navigator, {
      clipboard: { writeText: vi.fn().mockRejectedValue(new Error('denied')) },
    })
    render(<TicketIdCopyButton identifier="EDU-60" />)

    fireEvent.click(screen.getByRole('button', { name: 'EDU-60 복사' }))

    expect(await screen.findByText('복사하지 못했습니다')).toBeInTheDocument()
  })
})
