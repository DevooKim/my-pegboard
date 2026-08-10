import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { useState } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  LinearGlobalMetadata,
  LinearMetadataResponse,
  LinearTeamMetadata,
  LinearWidgetConfig,
} from '#/ipc/bindings'

const linearPresets = vi.fn()
const linearMetadata = vi.fn()

vi.mock('#/ipc/bindings', () => ({
  commands: {
    linearPresets: (...args: unknown[]) => linearPresets(...args),
    linearMetadata: (...args: unknown[]) => linearMetadata(...args),
  },
}))

const { LinearConfigForm } = await import('./ConfigForm')

function globalMetadata(over: Partial<LinearGlobalMetadata> = {}): LinearGlobalMetadata {
  return {
    teams: {
      items: [
        { id: 'team-eng', key: 'ENG', name: 'Engineering' },
        { id: 'team-design', key: 'DES', name: 'Design' },
      ],
      fetchedAt: '2026-08-10T00:00:00Z',
      truncated: false,
    },
    viewer: { id: 'viewer-1', name: 'Sammy', avatarUrl: null },
    labels: {
      items: [{ id: 'label-bug', name: 'Bug', color: '#ff0000' }],
      fetchedAt: '2026-08-10T00:00:00Z',
      truncated: false,
    },
    ...over,
  }
}

function teamMetadata(teamId: string): LinearTeamMetadata {
  return {
    teamId,
    states: {
      items: [
        {
          id: `state-${teamId}`,
          name: 'In progress',
          color: '#f2c94c',
          typeName: teamId === 'team-eng' ? 'started' : 'completed',
          position: 1,
        },
      ],
      fetchedAt: '2026-08-10T00:00:00Z',
      truncated: false,
    },
    members: {
      items: [{ id: 'member-1', name: 'Sammy', avatarUrl: null }],
      fetchedAt: '2026-08-10T00:00:00Z',
      truncated: false,
    },
    projects: {
      items: [{ id: `project-${teamId}`, name: 'Auth', teamId }],
      fetchedAt: '2026-08-10T00:00:00Z',
      truncated: false,
    },
  }
}

function response(
  global: LinearGlobalMetadata = globalMetadata(),
  team: LinearTeamMetadata | null = null,
  refreshError: LinearMetadataResponse['refreshError'] = null,
): { status: 'ok'; data: LinearMetadataResponse } {
  return { status: 'ok', data: { global, team, refreshError } }
}

function config(over: Partial<LinearWidgetConfig> = {}): LinearWidgetConfig {
  return {
    title: null,
    query: { kind: 'preset', id: 'assigned-to-me' },
    maxResults: 30,
    teams: ['team-eng'],
    sort: 'updatedAt',
    sortDirection: 'descending',
    groupByTeam: true,
    refreshSecs: 300,
    ...over,
  }
}

function ControlledForm({
  initial,
  onValidityChange,
}: {
  initial: LinearWidgetConfig
  onValidityChange?: (valid: boolean) => void
}) {
  const [current, setCurrent] = useState(initial)
  return (
    <LinearConfigForm
      config={current}
      onChange={setCurrent}
      {...(onValidityChange ? { onValidityChange } : {})}
    />
  )
}

beforeEach(() => {
  vi.clearAllMocks()
  linearPresets.mockResolvedValue([
    {
      id: 'assigned-to-me',
      name: '내게 할당된 이슈',
      description: '내게 할당된 이슈',
      scope: 'assignedToViewer',
      openOnly: true,
    },
  ])
  linearMetadata.mockImplementation((teamId: string | null) =>
    Promise.resolve(response(globalMetadata(), teamId ? teamMetadata(teamId) : null)),
  )
})

describe('LinearConfigForm', () => {
  it('copies persisted team scope into custom filter once, then edits the filter', async () => {
    const onChange = vi.fn()
    function Harness() {
      const [current, setCurrent] = useState(config())
      return (
        <LinearConfigForm
          config={current}
          onChange={(next) => {
            setCurrent(next)
            onChange(next)
          }}
        />
      )
    }
    render(<Harness />)

    await waitFor(() =>
      expect(screen.getByRole('option', { name: '직접 구성' })).toBeInTheDocument(),
    )
    fireEvent.change(screen.getByLabelText('쿼리'), { target: { value: '__custom__' } })

    const customConfig = onChange.mock.calls.at(-1)?.[0] as LinearWidgetConfig
    expect(customConfig.query).toEqual({
      kind: 'custom',
      filter: expect.objectContaining({ teamIds: ['team-eng'] }),
    })
    expect(customConfig.teams).toEqual(['team-eng'])

    fireEvent.click(screen.getByLabelText('Design'))
    const editedConfig = onChange.mock.calls.at(-1)?.[0] as LinearWidgetConfig
    expect(editedConfig.teams).toEqual(['team-eng'])
    expect(editedConfig.query).toEqual({
      kind: 'custom',
      filter: expect.objectContaining({ teamIds: ['team-eng', 'team-design'] }),
    })
  })

  it('reports empty custom filters as invalid and explains the required condition', async () => {
    const onValidityChange = vi.fn()
    render(
      <LinearConfigForm
        config={config({ query: { kind: 'custom', filter: {} }, teams: [] })}
        onChange={vi.fn()}
        onValidityChange={onValidityChange}
      />,
    )

    expect(await screen.findByText('조건을 하나 이상 선택하세요')).toBeInTheDocument()
    expect(onValidityChange).toHaveBeenLastCalledWith(false)
  })

  it('writes typed conditions, local dates, and sort direction independently', async () => {
    const onChange = vi.fn()
    function Harness() {
      const [current, setCurrent] = useState(
        config({ query: { kind: 'custom', filter: { teamIds: ['team-eng'] } } }),
      )
      return (
        <LinearConfigForm
          config={current}
          onChange={(next) => {
            setCurrent(next)
            onChange(next)
          }}
        />
      )
    }
    render(<Harness />)

    await waitFor(() => expect(screen.getByLabelText('우선순위: High')).toBeInTheDocument())
    fireEvent.click(screen.getByLabelText('우선순위: High'))
    fireEvent.change(screen.getByLabelText('담당자 조건'), { target: { value: 'viewer' } })
    fireEvent.change(screen.getByLabelText('생성일 시작'), { target: { value: '2026-08-10' } })
    fireEvent.change(screen.getByLabelText('생성일 종료'), { target: { value: '2026-08-12' } })
    fireEvent.change(screen.getByLabelText('정렬 필드'), { target: { value: 'createdAt' } })
    fireEvent.change(screen.getByLabelText('정렬 방향'), { target: { value: 'ascending' } })

    const next = onChange.mock.calls.at(-1)?.[0] as LinearWidgetConfig
    expect(next.query).toEqual({
      kind: 'custom',
      filter: expect.objectContaining({
        teamIds: ['team-eng'],
        assignee: 'viewer',
        priorities: [2],
        createdFrom: expect.any(String),
        createdTo: expect.any(String),
      }),
    })
    expect(next.sort).toBe('createdAt')
    expect(next.sortDirection).toBe('ascending')
    expect(screen.getByText('모든 조건을 동시에 만족하는 이슈만 표시합니다')).toBeInTheDocument()
  })

  it('shows reversed local date ranges and reports them as invalid', async () => {
    const onValidityChange = vi.fn()
    render(
      <ControlledForm
        initial={config({
          query: {
            kind: 'custom',
            filter: {
              priorities: [2],
              createdFrom: '2026-08-12T00:00:00.000Z',
              createdTo: '2026-08-10T23:59:59.999Z',
            },
          },
        })}
        onValidityChange={onValidityChange}
      />,
    )

    expect(await screen.findByText('시작일이 종료일보다 늦습니다')).toBeInTheDocument()
    expect(onValidityChange).toHaveBeenLastCalledWith(false)
  })

  it('keeps cached metadata errors and truncation visible', async () => {
    linearMetadata.mockResolvedValue(
      response(
        globalMetadata({
          labels: { ...globalMetadata().labels, truncated: true },
        }),
        null,
        {
          kind: 'transient',
          message: '메타데이터 새로고침 실패',
          isAuthFailure: false,
          retryAfterSecs: null,
        },
      ),
    )
    render(
      <ControlledForm
        initial={config({ query: { kind: 'custom', filter: { teamIds: ['team-eng'] } } })}
      />,
    )

    expect(await screen.findByText('메타데이터 새로고침 실패')).toBeInTheDocument()
    expect(screen.getByText('API 상한으로 일부만 표시됩니다')).toBeInTheDocument()
    expect(
      within(screen.getByText('라벨').parentElement as HTMLElement).getByText('Bug'),
    ).toBeInTheDocument()
  })

  it('refreshes global and selected-team metadata explicitly for custom queries', async () => {
    render(
      <ControlledForm
        initial={config({ query: { kind: 'custom', filter: { teamIds: ['team-eng'] } } })}
      />,
    )

    expect(await screen.findByLabelText('Engineering 메타데이터 새로고침')).toBeInTheDocument()
    linearMetadata.mockClear()

    fireEvent.click(screen.getByRole('button', { name: '전역 메타데이터 새로고침' }))
    await waitFor(() => expect(linearMetadata).toHaveBeenCalledWith(null, true))

    fireEvent.click(screen.getByRole('button', { name: 'Engineering 메타데이터 새로고침' }))
    await waitFor(() => expect(linearMetadata).toHaveBeenCalledWith('team-eng', true))
  })

  it('shows a retryable inline error and clears refresh state when metadata IPC rejects', async () => {
    linearMetadata.mockRejectedValueOnce(new Error('IPC 중단'))
    render(<ControlledForm initial={config({ query: { kind: 'custom', filter: {} } })} />)

    expect(
      await screen.findByText(/Linear 메타데이터를 불러오지 못했습니다: IPC 중단/),
    ).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '전역 메타데이터 새로고침' })).not.toBeDisabled()
  })

  it('prunes project and state selections when a custom team is removed', async () => {
    const onChange = vi.fn()
    function Harness() {
      const [current, setCurrent] = useState(
        config({
          query: {
            kind: 'custom',
            filter: {
              teamIds: ['team-eng', 'team-design'],
              stateTypes: ['started', 'completed'],
              projectIds: ['project-team-eng', 'project-team-design'],
              priorities: [2],
            },
          },
        }),
      )
      return (
        <LinearConfigForm
          config={current}
          onChange={(next) => {
            setCurrent(next)
            onChange(next)
          }}
        />
      )
    }
    render(<Harness />)

    expect(await screen.findByLabelText('Design')).toBeChecked()
    fireEvent.click(screen.getByLabelText('Design'))

    const next = onChange.mock.calls.at(-1)?.[0] as LinearWidgetConfig
    expect(next.query).toEqual({
      kind: 'custom',
      filter: expect.objectContaining({
        teamIds: ['team-eng'],
        stateTypes: ['started'],
        projectIds: ['project-team-eng'],
        priorities: [2],
      }),
    })
  })
})
