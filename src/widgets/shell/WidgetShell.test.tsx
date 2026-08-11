import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { WidgetShell } from './WidgetShell'

function renderShell(headerMode?: 'static' | 'hover-overlay') {
  render(
    <WidgetShell
      title="사진"
      status="ready"
      fetchedAt={null}
      pollable
      onRefresh={vi.fn()}
      onConfigure={vi.fn()}
      onRemove={vi.fn()}
      {...(headerMode ? { headerMode } : {})}
    >
      <div>본문</div>
    </WidgetShell>,
  )
  return screen.getByRole('banner')
}

describe('WidgetShell header mode', () => {
  it('기본 헤더는 본문 위에서 높이를 차지한다', () => {
    const header = renderShell()
    expect(header.className).toContain('shrink-0')
    expect(header.className).not.toContain('absolute')
  })

  it('호버 헤더는 본문 위에 겹치고 hover와 focus-within에서 나타난다', () => {
    const header = renderShell('hover-overlay')
    expect(header.className).toContain('absolute')
    expect(header.className).toContain('opacity-0')
    expect(header.className).toContain('group-hover:opacity-100')
    expect(header.className).toContain('group-focus-within:opacity-100')
  })
})
