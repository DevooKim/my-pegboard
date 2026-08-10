import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { LinearIssue } from '#/ipc/bindings'
import type { WidgetInstance } from '#/widgets/types'

const useLinearData = vi.fn()
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
  tryGetWidget: () => ({
    label: 'Linear',
    deriveTitle: () => 'Linear',
    pollable: true,
    View: () => null,
  }),
}))
vi.mock('#/widgets/shell/WidgetShell', () => ({
  WidgetShell: ({
    actions,
    children,
  }: {
    actions?: React.ReactNode
    children: React.ReactNode
  }) => (
    <section>
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
