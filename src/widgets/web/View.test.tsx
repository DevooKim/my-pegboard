import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { WebView } from './View'

vi.mock('@tauri-apps/plugin-opener', () => ({ openUrl: vi.fn() }))

describe('WebView', () => {
  it('주소 행을 본문에 중복해서 그리지 않는다', () => {
    render(
      <WebView
        widgetId="web-1"
        config={{
          title: null,
          url: 'https://example.com/dashboard',
          zoom: 100,
          refreshSecs: 0,
          allowSession: true,
          allowScroll: true,
        }}
        envelope={{ status: 'ready', data: null, fetchedAt: null, error: null }}
        width={600}
      />,
    )

    expect(screen.queryByText('https://example.com/dashboard')).toBeNull()
    expect(screen.queryByRole('button', { name: '브라우저에서 열기' })).toBeNull()
    expect(screen.getByTitle('https://example.com/dashboard')).toBeInTheDocument()
  })
})
