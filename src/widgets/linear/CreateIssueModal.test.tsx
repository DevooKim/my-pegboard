import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  LinearGlobalMetadata,
  LinearIssue,
  LinearMetadataResponse,
  LinearTeamMetadata,
} from '#/ipc/bindings'

const linearMetadata = vi.fn()
const linearCreateIssue = vi.fn()
const setLinearAuthFailed = vi.fn()
const openUrl = vi.fn()

vi.mock('#/ipc/bindings', () => ({
  commands: {
    linearMetadata: (...args: unknown[]) => linearMetadata(...args),
    linearCreateIssue: (...args: unknown[]) => linearCreateIssue(...args),
  },
}))

vi.mock('#/store/connection', () => ({
  useConnectionStore: (
    selector: (state: { setLinearAuthFailed: typeof setLinearAuthFailed }) => unknown,
  ) => selector({ setLinearAuthFailed }),
}))

vi.mock('@tauri-apps/plugin-opener', () => ({ openUrl }))

const { LinearCreateIssueModal } = await import('./CreateIssueModal')

function globalMetadata(): LinearGlobalMetadata {
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
    labels: { items: [], fetchedAt: null, truncated: false },
  }
}

function teamMetadata(teamId: string): LinearTeamMetadata {
  const suffix = teamId === 'team-eng' ? 'eng' : 'design'
  return {
    teamId,
    states: {
      items: [
        {
          id: `state-${suffix}`,
          name: `${suffix} Todo`,
          color: '#8a8f98',
          typeName: 'unstarted',
          position: 0,
        },
      ],
      fetchedAt: '2026-08-10T00:00:00Z',
      truncated: false,
    },
    members: {
      items: [{ id: `member-${suffix}`, name: `${suffix} member`, avatarUrl: null }],
      fetchedAt: '2026-08-10T00:00:00Z',
      truncated: false,
    },
    projects: {
      items: [{ id: `project-${suffix}`, name: `${suffix} project`, teamId }],
      fetchedAt: '2026-08-10T00:00:00Z',
      truncated: false,
    },
  }
}

function metadataResponse(teamId: string | null, over: Partial<LinearMetadataResponse> = {}) {
  return {
    status: 'ok' as const,
    data: {
      global: globalMetadata(),
      team: teamId ? teamMetadata(teamId) : null,
      refreshError: null,
      ...over,
    },
  }
}

function issue(): LinearIssue {
  return {
    id: 'issue-1',
    identifier: 'ENG-143',
    title: '새 Linear 이슈',
    url: 'https://linear.app/acme/issue/ENG-143/new-linear-issue',
    state: { id: 'state-eng', name: 'eng Todo', color: '#8a8f98', typeName: 'unstarted' },
    priorityLabel: 'High',
    priority: 2,
    assignee: 'eng member',
    assigneeAvatarUrl: null,
    teamName: 'Engineering',
    teamId: 'team-eng',
    projectName: 'eng project',
    dueDate: null,
    estimate: null,
    updatedAt: '2026-08-10T00:00:00Z',
    createdAt: '2026-08-10T00:00:00Z',
    labels: [],
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  linearMetadata.mockImplementation((teamId: string | null) =>
    Promise.resolve(metadataResponse(teamId)),
  )
  linearCreateIssue.mockResolvedValue({ status: 'ok', data: issue() })
})

describe('LinearCreateIssueModal', () => {
  it('does not let a late initial metadata response clear an explicit refresh', async () => {
    let resolveInitial!: (value: ReturnType<typeof metadataResponse>) => void
    let resolveRefresh!: (value: ReturnType<typeof metadataResponse>) => void
    const initial = new Promise<ReturnType<typeof metadataResponse>>((resolve) => {
      resolveInitial = resolve
    })
    const refresh = new Promise<ReturnType<typeof metadataResponse>>((resolve) => {
      resolveRefresh = resolve
    })
    linearMetadata.mockImplementation((_teamId: string | null, force: boolean) =>
      force ? refresh : initial,
    )

    render(<LinearCreateIssueModal open onClose={vi.fn()} onCreated={vi.fn()} />)
    const refreshButton = await screen.findByRole('button', { name: '전역 메타데이터 새로고침' })
    fireEvent.click(refreshButton)
    resolveInitial(metadataResponse(null))
    await waitFor(() => expect(refreshButton).toBeDisabled())
    resolveRefresh(metadataResponse(null))
    await waitFor(() => expect(refreshButton).not.toBeDisabled())
  })

  it('keeps explicit metadata after an initial cache response arrives late', async () => {
    let resolveInitial!: (value: ReturnType<typeof metadataResponse>) => void
    let resolveRefresh!: (value: ReturnType<typeof metadataResponse>) => void
    const initial = new Promise<ReturnType<typeof metadataResponse>>((resolve) => {
      resolveInitial = resolve
    })
    const refresh = new Promise<ReturnType<typeof metadataResponse>>((resolve) => {
      resolveRefresh = resolve
    })
    linearMetadata.mockImplementation((_teamId: string | null, force: boolean) =>
      force ? refresh : initial,
    )

    render(<LinearCreateIssueModal open onClose={vi.fn()} onCreated={vi.fn()} />)
    const refreshButton = await screen.findByRole('button', { name: '전역 메타데이터 새로고침' })
    fireEvent.click(refreshButton)
    resolveRefresh(
      metadataResponse(null, {
        global: {
          ...globalMetadata(),
          teams: {
            ...globalMetadata().teams,
            items: [{ id: 'team-design', key: 'DES', name: 'Design' }],
          },
        },
      }),
    )
    await waitFor(() => expect(screen.getByRole('option', { name: 'Design' })).toBeInTheDocument())
    resolveInitial(metadataResponse(null))
    await waitFor(() =>
      expect(screen.queryByRole('option', { name: 'Engineering' })).not.toBeInTheDocument(),
    )
  })

  it('requires a team and a trimmed title before submitting', async () => {
    render(<LinearCreateIssueModal open onClose={vi.fn()} onCreated={vi.fn()} />)

    expect(await screen.findByRole('option', { name: 'Engineering' })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '생성' }))
    expect(linearCreateIssue).not.toHaveBeenCalled()

    fireEvent.change(screen.getByLabelText('팀'), { target: { value: 'team-eng' } })
    fireEvent.click(screen.getByRole('button', { name: '생성' }))
    expect(linearCreateIssue).not.toHaveBeenCalled()

    fireEvent.change(screen.getByLabelText('제목'), { target: { value: '  로그인 수정  ' } })
    fireEvent.click(screen.getByRole('button', { name: '생성' }))
    await waitFor(() => expect(linearCreateIssue).toHaveBeenCalledTimes(1))
    expect(linearCreateIssue.mock.calls[0]?.[0]).toMatchObject({
      teamId: 'team-eng',
      title: '로그인 수정',
    })
  })

  it('sends selected optional fields and clears team-dependent values when team changes', async () => {
    render(<LinearCreateIssueModal open onClose={vi.fn()} onCreated={vi.fn()} />)

    fireEvent.change(await screen.findByLabelText('팀'), { target: { value: 'team-eng' } })
    await waitFor(() =>
      expect(screen.getByRole('option', { name: 'eng Todo' })).toBeInTheDocument(),
    )
    fireEvent.change(screen.getByLabelText('제목'), { target: { value: '제목' } })
    fireEvent.change(screen.getByLabelText('설명'), { target: { value: '설명' } })
    fireEvent.change(screen.getByLabelText('상태'), { target: { value: 'state-eng' } })
    fireEvent.change(screen.getByLabelText('담당자'), { target: { value: 'member-eng' } })
    fireEvent.change(screen.getByLabelText('우선순위'), { target: { value: '2' } })
    fireEvent.change(screen.getByLabelText('프로젝트'), { target: { value: 'project-eng' } })

    fireEvent.change(screen.getByLabelText('팀'), { target: { value: 'team-design' } })
    await waitFor(() =>
      expect(screen.getByRole('option', { name: 'design Todo' })).toBeInTheDocument(),
    )
    expect(screen.getByLabelText('상태')).toHaveValue('')
    expect(screen.getByLabelText('담당자')).toHaveValue('')
    expect(screen.getByLabelText('프로젝트')).toHaveValue('')

    fireEvent.change(screen.getByLabelText('상태'), { target: { value: 'state-design' } })
    fireEvent.change(screen.getByLabelText('담당자'), { target: { value: 'member-design' } })
    fireEvent.change(screen.getByLabelText('프로젝트'), { target: { value: 'project-design' } })
    fireEvent.click(screen.getByRole('button', { name: '생성' }))
    await waitFor(() => expect(linearCreateIssue).toHaveBeenCalledTimes(1))
    expect(linearCreateIssue).toHaveBeenCalledWith({
      teamId: 'team-design',
      title: '제목',
      description: '설명',
      stateId: 'state-design',
      assigneeId: 'member-design',
      priority: 2,
      projectId: 'project-design',
    })
  })

  it('shows metadata refresh errors and truncation without hiding cached choices', async () => {
    linearMetadata.mockResolvedValue(
      metadataResponse(null, {
        global: { ...globalMetadata(), labels: { items: [], fetchedAt: null, truncated: true } },
        refreshError: {
          kind: 'transient',
          message: '메타데이터 오류',
          isAuthFailure: false,
          retryAfterSecs: null,
        },
      }),
    )
    render(<LinearCreateIssueModal open onClose={vi.fn()} onCreated={vi.fn()} />)

    expect(await screen.findByText('메타데이터 오류')).toBeInTheDocument()
    expect(screen.getByText('API 상한으로 일부만 표시됩니다')).toBeInTheDocument()
    expect(screen.getByRole('option', { name: 'Engineering' })).toBeInTheDocument()
  })

  it('offers explicit global and selected-team metadata refresh actions', async () => {
    render(<LinearCreateIssueModal open onClose={vi.fn()} onCreated={vi.fn()} />)
    fireEvent.change(await screen.findByLabelText('팀'), { target: { value: 'team-eng' } })
    expect(
      await screen.findByRole('button', { name: '현재 선택 메타데이터 새로고침' }),
    ).toBeInTheDocument()

    linearMetadata.mockClear()
    fireEvent.click(screen.getByRole('button', { name: '전역 메타데이터 새로고침' }))
    await waitFor(() => expect(linearMetadata).toHaveBeenCalledWith(null, true))

    fireEvent.click(screen.getByRole('button', { name: '현재 선택 메타데이터 새로고침' }))
    await waitFor(() => expect(linearMetadata).toHaveBeenCalledWith('team-eng', true))
  })

  it('shows a retryable error and clears refreshing when metadata IPC rejects', async () => {
    linearMetadata.mockRejectedValueOnce(new Error('IPC 중단'))
    render(<LinearCreateIssueModal open onClose={vi.fn()} onCreated={vi.fn()} />)

    expect(
      await screen.findByText(/Linear 메타데이터를 불러오지 못했습니다: IPC 중단/),
    ).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '전역 메타데이터 새로고침' })).not.toBeDisabled()
  })

  it('passes the created issue through immediately', async () => {
    const onCreated = vi.fn()
    render(<LinearCreateIssueModal open onClose={vi.fn()} onCreated={onCreated} />)
    fireEvent.change(await screen.findByLabelText('팀'), { target: { value: 'team-eng' } })
    fireEvent.change(screen.getByLabelText('제목'), { target: { value: '제목' } })
    fireEvent.click(screen.getByRole('button', { name: '생성' }))
    await waitFor(() => expect(onCreated).toHaveBeenCalledWith(issue()))
  })

  it('retains values and blocks duplicate creation when the result may already exist', async () => {
    linearCreateIssue.mockResolvedValue({
      status: 'error',
      error: {
        kind: 'transient',
        message: '네트워크 오류',
        isAuthFailure: false,
        possiblyCreated: true,
        checkUrl: 'https://linear.app',
      },
    })
    render(<LinearCreateIssueModal open onClose={vi.fn()} onCreated={vi.fn()} />)
    fireEvent.change(await screen.findByLabelText('팀'), { target: { value: 'team-eng' } })
    fireEvent.change(screen.getByLabelText('제목'), { target: { value: '입력 유지' } })
    fireEvent.click(screen.getByRole('button', { name: '생성' }))
    expect(
      await screen.findByText('이미 생성됐을 수 있어 중복 생성을 막았습니다'),
    ).toBeInTheDocument()
    expect(screen.getByLabelText('제목')).toHaveValue('입력 유지')
    expect(screen.getByRole('button', { name: '생성' })).toBeDisabled()
    fireEvent.click(screen.getByRole('button', { name: 'Linear에서 확인' }))
    expect(openUrl).toHaveBeenCalledWith('https://linear.app')
  })

  it('allows a deliberate retry for a permanent rejection and reports auth failure', async () => {
    linearCreateIssue
      .mockResolvedValueOnce({
        status: 'error',
        error: {
          kind: 'permanent',
          message: '거부됨',
          isAuthFailure: true,
          possiblyCreated: false,
          checkUrl: 'https://linear.app',
        },
      })
      .mockResolvedValueOnce({ status: 'ok', data: issue() })
    render(<LinearCreateIssueModal open onClose={vi.fn()} onCreated={vi.fn()} />)
    fireEvent.change(await screen.findByLabelText('팀'), { target: { value: 'team-eng' } })
    fireEvent.change(screen.getByLabelText('제목'), { target: { value: '재시도 제목' } })
    fireEvent.click(screen.getByRole('button', { name: '생성' }))
    expect(await screen.findByText('거부됨')).toBeInTheDocument()
    expect(setLinearAuthFailed).toHaveBeenCalledWith(true)
    expect(screen.getByLabelText('제목')).toHaveValue('재시도 제목')
    fireEvent.click(screen.getByRole('button', { name: '생성' }))
    await waitFor(() => expect(linearCreateIssue).toHaveBeenCalledTimes(2))
  })

  it('locks duplicate submission when the create IPC transport rejects', async () => {
    linearCreateIssue.mockRejectedValueOnce(new Error('IPC 중단'))
    render(<LinearCreateIssueModal open onClose={vi.fn()} onCreated={vi.fn()} />)
    fireEvent.change(await screen.findByLabelText('팀'), { target: { value: 'team-eng' } })
    fireEvent.change(screen.getByLabelText('제목'), { target: { value: '입력 유지' } })
    fireEvent.click(screen.getByRole('button', { name: '생성' }))

    expect(
      await screen.findByText(/생성 요청 결과를 확인하지 못했습니다: IPC 중단/),
    ).toBeInTheDocument()
    expect(screen.getByLabelText('제목')).toHaveValue('입력 유지')
    expect(screen.getByRole('button', { name: '생성' })).toBeDisabled()
    fireEvent.click(screen.getByRole('button', { name: '생성' }))
    expect(linearCreateIssue).toHaveBeenCalledTimes(1)
  })
})
