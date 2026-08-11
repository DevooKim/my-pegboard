import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { LinearIssue } from '#/ipc/bindings'
import type { WidgetInstance } from '#/widgets/types'

const useLinearData = vi.fn()
const openUrl = vi.fn()
let linearConfigured = true

vi.stubGlobal(
  'ResizeObserver',
  class {
    observe() {}
    disconnect() {}
  },
)

vi.mock('#/widgets/linear/useLinearData', () => ({
  useLinearData: (...args: unknown[]) => useLinearData(...args),
}))
vi.mock('#/store/connection', () => ({
  useConnectionStore: (selector: (state: { linearConfigured: boolean }) => unknown) =>
    selector({ linearConfigured }),
}))
vi.mock('#/store/board', () => ({
  useBoardStore: (selector: (state: unknown) => unknown) =>
    selector({ removeWidget: vi.fn(), boards: [], activeBoardId: null }),
}))
vi.mock('#/widgets/registry', () => ({
  tryGetWidget: (type: string) => ({
    label: type === 'linear' ? 'Linear' : type === 'web' ? '웹' : '앨범',
    deriveTitle: () => (type === 'linear' ? 'Linear' : type === 'web' ? 'example.com' : '사진'),
    pollable: true,
    View: () => null,
  }),
}))
vi.mock('@tauri-apps/plugin-opener', () => ({
  openUrl: (...args: unknown[]) => openUrl(...args),
}))
vi.mock('#/widgets/shell/WidgetShell', () => ({
  WidgetShell: ({
    title,
    actions,
    children,
    headerMode,
  }: {
    title: string
    actions?: React.ReactNode
    children: React.ReactNode
    headerMode?: string
  }) => (
    <section data-header-mode={headerMode ?? 'static'}>
      <h2>{title}</h2>
      {actions}
      {children}
    </section>
  ),
  IconButton: ({
    label,
    onClick,
    children,
  }: {
    label: string
    onClick: () => void
    children: React.ReactNode
  }) => (
    <button type="button" aria-label={label} onClick={onClick}>
      {children}
    </button>
  ),
}))
vi.mock('#/widgets/shell/WidgetConfigModal', () => ({ WidgetConfigModal: () => null }))
vi.mock('#/ui/ConfirmDialog', () => ({ ConfirmDialog: () => null }))
vi.mock('#/widgets/jira/CreateIssueModal', () => ({ CreateIssueModal: () => null }))
vi.mock('#/widgets/jira/IssueDetailModal', () => ({ IssueDetailModal: () => null }))
vi.mock('#/widgets/linear/CreateIssueModal', () => ({
  LinearCreateIssueModal: ({
    open,
    onCreated,
  }: {
    open: boolean
    onCreated: (issue: LinearIssue) => void
  }) =>
    open ? (
      <button type="button" onClick={() => onCreated(createdIssue())}>
        complete create
      </button>
    ) : null,
}))
vi.mock('#/widgets/linear/IssueDetailModal', () => ({
  IssueDetailModal: ({ issue }: { issue: LinearIssue | null }) =>
    issue ? (
      <div role="dialog">
        <span>{issue.identifier}</span>
        <span>{issue.title}</span>
      </div>
    ) : null,
}))
vi.mock('#/widgets/album/useAlbumData', () => ({
  useAlbumData: () => ({ envelope: { status: 'ready' }, refresh: vi.fn() }),
}))
vi.mock('#/widgets/github/useGithubData', () => ({
  useGithubData: () => ({ envelope: { status: 'ready' }, refresh: vi.fn() }),
}))
vi.mock('#/widgets/jira/useJiraData', () => ({
  useJiraData: () => ({ envelope: { status: 'ready' }, refresh: vi.fn() }),
}))

const { WidgetHost } = await import('./WidgetHost')

function widget(): WidgetInstance {
  return {
    id: 'linear-1',
    type: 'linear',
    layout: { x: 0, y: 0, w: 4, h: 10 },
    config: {
      query: { kind: 'preset', id: 'assigned-to-me' },
      maxResults: 30,
      teams: [],
      sort: 'updatedAt',
      sortDirection: 'descending',
      refreshSecs: 0,
    },
  }
}

function webWidget(): WidgetInstance {
  return {
    id: 'web-1',
    type: 'web',
    layout: { x: 0, y: 0, w: 6, h: 12 },
    config: {
      title: '운영 화면',
      url: 'https://example.com/dashboard',
      zoom: 100,
      refreshSecs: 0,
      allowSession: true,
      allowScroll: true,
    },
  }
}

function albumWidget(): WidgetInstance {
  return {
    id: 'album-1',
    type: 'album',
    layout: { x: 0, y: 0, w: 4, h: 8 },
    config: {
      title: null,
      source: null,
      intervalSecs: 10,
    },
  }
}

function createdIssue(): LinearIssue {
  return {
    id: 'issue-1',
    identifier: 'ENG-143',
    title: '방금 만든 이슈',
    url: 'https://linear.app/acme/issue/ENG-143/new',
    state: { id: 'state-1', name: 'Todo', color: '#8a8f98', typeName: 'unstarted' },
    priorityLabel: '',
    priority: 0,
    assignee: null,
    assigneeAvatarUrl: null,
    teamName: 'Engineering',
    teamId: 'team-eng',
    projectName: null,
    dueDate: null,
    estimate: null,
    updatedAt: '2026-08-10T00:00:00Z',
    createdAt: '2026-08-10T00:00:00Z',
    labels: [],
  }
}

beforeEach(() => {
  linearConfigured = true
  vi.clearAllMocks()
  useLinearData.mockReturnValue({
    envelope: { status: 'ready', data: null, fetchedAt: null, error: null },
    refresh: vi.fn(),
  })
})

describe('LinearHost creation entry', () => {
  it('shows the connected-only header action and immediate created detail skeleton', () => {
    render(<WidgetHost widget={widget()} />)
    fireEvent.click(screen.getByRole('button', { name: 'Linear 티켓 생성' }))
    fireEvent.click(screen.getByRole('button', { name: 'complete create' }))

    expect(screen.getByRole('dialog')).toHaveTextContent('ENG-143')
    expect(screen.getByRole('dialog')).toHaveTextContent('방금 만든 이슈')
  })

  it('hides the creation entry when Linear is not configured', () => {
    linearConfigured = false
    render(<WidgetHost widget={widget()} />)
    expect(screen.queryByRole('button', { name: 'Linear 티켓 생성' })).toBeNull()
  })
})

describe('specialized widget headers', () => {
  it('웹 주소와 외부 열기 동작을 공통 헤더에 합친다', () => {
    render(<WidgetHost widget={webWidget()} />)

    expect(
      screen.getByRole('heading', { name: 'https://example.com/dashboard' }),
    ).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '브라우저에서 열기' }))
    expect(openUrl).toHaveBeenCalledWith('https://example.com/dashboard')
  })

  it('기존 앨범 설정도 호버 오버레이 헤더를 사용한다', () => {
    const { container } = render(<WidgetHost widget={albumWidget()} />)
    expect(container.querySelector('[data-header-mode="hover-overlay"]')).toBeInTheDocument()
  })
})
