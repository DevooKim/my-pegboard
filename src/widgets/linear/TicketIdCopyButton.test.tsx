import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { TicketIdCopyButton } from './TicketIdCopyButton'

afterEach(() => {
  vi.clearAllTimers()
  vi.useRealTimers()
})

describe('Linear TicketIdCopyButton', () => {
  it('copies the visible Linear identifier and exposes success for 1.5 seconds', async () => {
    vi.useFakeTimers()
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.assign(navigator, { clipboard: { writeText } })
    render(<TicketIdCopyButton identifier="ENG-142" />)

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'ENG-142 복사' }))
      await Promise.resolve()
    })
    expect(writeText).toHaveBeenCalledWith('ENG-142')
    expect(screen.getByRole('button', { name: 'ENG-142 복사됨' })).toBeInTheDocument()

    await act(async () => vi.advanceTimersByTimeAsync(1_500))
    expect(screen.getByRole('button', { name: 'ENG-142 복사' })).toBeInTheDocument()
  })

  it('leaves clipboard failure visible in the header', async () => {
    Object.assign(navigator, {
      clipboard: { writeText: vi.fn().mockRejectedValue(new Error('denied')) },
    })
    render(<TicketIdCopyButton identifier="ENG-142" />)

    fireEvent.click(screen.getByRole('button', { name: 'ENG-142 복사' }))

    expect(await screen.findByText('복사하지 못했습니다')).toBeInTheDocument()
  })

  it('clears its success timer on unmount', async () => {
    vi.useFakeTimers()
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.assign(navigator, { clipboard: { writeText } })
    const view = render(<TicketIdCopyButton identifier="ENG-142" />)

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'ENG-142 복사' }))
      await Promise.resolve()
    })
    expect(writeText).toHaveBeenCalledWith('ENG-142')

    view.unmount()
    expect(vi.getTimerCount()).toBe(0)
    await act(async () => vi.advanceTimersByTimeAsync(1_500))
  })
})
