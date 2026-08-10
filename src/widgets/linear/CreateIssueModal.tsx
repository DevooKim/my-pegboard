import { openUrl } from '@tauri-apps/plugin-opener'
import { RefreshCw, TriangleAlert, X } from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import {
  commands,
  type LinearCreateFailure,
  type LinearGlobalMetadata,
  type LinearIssue,
  type LinearTeamMetadata,
} from '#/ipc/bindings'
import { useConnectionStore } from '#/store/connection'
import { Modal } from '#/ui/Modal'

function transportErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export function LinearCreateIssueModal({
  open,
  onClose,
  onCreated,
}: {
  open: boolean
  onClose: () => void
  onCreated: (issue: LinearIssue) => void
}) {
  const setLinearAuthFailed = useConnectionStore((s) => s.setLinearAuthFailed)
  const [metadata, setMetadata] = useState<LinearGlobalMetadata | null>(null)
  const [teamMetadata, setTeamMetadata] = useState<Record<string, LinearTeamMetadata>>({})
  const [metadataError, setMetadataError] = useState<string | null>(null)
  const [metadataErrorTeamId, setMetadataErrorTeamId] = useState<string | null>(null)
  const [refreshing, setRefreshing] = useState(false)
  const [teamId, setTeamId] = useState('')
  const [title, setTitle] = useState('')
  const [description, setDescription] = useState('')
  const [stateId, setStateId] = useState('')
  const [assigneeId, setAssigneeId] = useState('')
  const [priority, setPriority] = useState('')
  const [projectId, setProjectId] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [failure, setFailure] = useState<LinearCreateFailure | null>(null)
  const titleRef = useRef<HTMLInputElement | null>(null)
  const metadataRequestRef = useRef(new Map<string, number>())
  const activeRefreshRef = useRef<{ key: string; requestId: number } | null>(null)

  const loadMetadata = useCallback(async (selectedTeamId: string | null, refresh: boolean) => {
    const key = selectedTeamId ?? '__global__'
    const requestId = (metadataRequestRef.current.get(key) ?? 0) + 1
    metadataRequestRef.current.set(key, requestId)
    if (refresh) {
      activeRefreshRef.current = { key, requestId }
      setRefreshing(true)
    } else if (activeRefreshRef.current === null) {
      setRefreshing(false)
    }
    try {
      const result = await commands.linearMetadata(selectedTeamId, refresh)
      if (metadataRequestRef.current.get(key) !== requestId) return
      if (result.status !== 'ok') {
        setMetadataError(result.error)
        setMetadataErrorTeamId(selectedTeamId)
        return
      }
      const error = result.data.refreshError?.message ?? null
      if (selectedTeamId === null && (!refresh || !error)) setMetadata(result.data.global)
      const team = result.data.team
      if (team) {
        setTeamMetadata((current) => ({ ...current, [team.teamId]: team }))
      }
      setMetadataError(error)
      setMetadataErrorTeamId(error ? selectedTeamId : null)
    } catch (error) {
      if (metadataRequestRef.current.get(key) !== requestId) return
      setMetadataError(
        `Linear 메타데이터를 불러오지 못했습니다: ${transportErrorMessage(error)}. 새로고침하세요.`,
      )
      setMetadataErrorTeamId(selectedTeamId)
    } finally {
      if (metadataRequestRef.current.get(key) === requestId) {
        if (
          activeRefreshRef.current?.key === key &&
          activeRefreshRef.current.requestId === requestId
        ) {
          activeRefreshRef.current = null
          setRefreshing(false)
        } else if (activeRefreshRef.current === null) {
          setRefreshing(false)
        }
      }
    }
  }, [])

  useEffect(() => {
    if (!open) return
    void loadMetadata(null, false)
    titleRef.current?.focus()
  }, [loadMetadata, open])

  useEffect(() => {
    if (open) return
    setTeamId('')
    setTitle('')
    setDescription('')
    setStateId('')
    setAssigneeId('')
    setPriority('')
    setProjectId('')
    setFailure(null)
    setSubmitting(false)
  }, [open])

  if (!open) return null

  const currentTeam = teamId ? teamMetadata[teamId] : undefined
  const teams = metadata?.teams.items ?? []
  const canSubmit = !!teamId && title.trim().length > 0 && !submitting && !failure?.possiblyCreated

  const changeTeam = (nextTeamId: string) => {
    setTeamId(nextTeamId)
    setStateId('')
    setAssigneeId('')
    setProjectId('')
    setFailure(null)
    if (nextTeamId && !teamMetadata[nextTeamId]) void loadMetadata(nextTeamId, false)
  }

  const submit = async () => {
    if (!canSubmit) return
    setSubmitting(true)
    setFailure(null)
    try {
      const result = await commands.linearCreateIssue({
        teamId,
        title: title.trim(),
        description: description.trim() || null,
        stateId: stateId || null,
        assigneeId: assigneeId || null,
        priority: priority === '' ? null : Number(priority),
        projectId: projectId || null,
      })
      if (result.status === 'ok') {
        onCreated(result.data)
      } else {
        setFailure(result.error)
        if (result.error.isAuthFailure) setLinearAuthFailed(true)
      }
    } catch (error) {
      setFailure({
        kind: 'transient',
        message: `생성 요청 결과를 확인하지 못했습니다: ${transportErrorMessage(error)}`,
        isAuthFailure: false,
        possiblyCreated: true,
        checkUrl: 'https://linear.app',
      })
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <Modal open onClose={onClose} labelledBy="linear-create-title" className="max-w-xl">
      <header className="flex items-center justify-between border-border-subtle border-b px-4 py-3">
        <h2 id="linear-create-title" className="text-base text-text-primary">
          Linear 티켓 생성
        </h2>
        <button
          type="button"
          onClick={onClose}
          aria-label="닫기"
          className="rounded p-1 text-text-tertiary hover:text-text-primary"
        >
          <X size={15} />
        </button>
      </header>

      <div className="flex-1 space-y-3 overflow-y-auto px-4 py-4">
        {metadataError && (
          <div className="flex flex-wrap items-center gap-2 rounded bg-danger-muted px-2 py-1 text-caption text-danger">
            <span>{metadataError}</span>
            <button
              type="button"
              onClick={() => void loadMetadata(metadataErrorTeamId, true)}
              disabled={refreshing}
              className="rounded border border-danger-muted px-1.5 py-0.5 text-text-primary disabled:opacity-40"
            >
              다시 시도
            </button>
          </div>
        )}
        <div className="flex items-center gap-2 text-caption text-text-tertiary">
          <span>메타데이터</span>
          <button
            type="button"
            aria-label="전역 메타데이터 새로고침"
            title="전역 메타데이터 새로고침"
            onClick={() => void loadMetadata(null, true)}
            disabled={refreshing}
            className="rounded p-0.5 text-text-quaternary hover:text-text-secondary disabled:opacity-40"
          >
            <RefreshCw size={11} className={refreshing ? 'animate-spin' : ''} />
          </button>
        </div>
        {metadata?.teams.truncated && (
          <p className="text-caption text-stale">API 상한으로 일부만 표시됩니다</p>
        )}
        {metadata?.labels.truncated && (
          <p className="text-caption text-stale">API 상한으로 일부만 표시됩니다</p>
        )}

        <div className="flex flex-col gap-1">
          <span className="flex items-center gap-2 text-caption text-text-secondary">
            <span>팀</span>
            {teamId && (
              <button
                type="button"
                aria-label="현재 선택 메타데이터 새로고침"
                title="현재 선택 메타데이터 새로고침"
                onClick={() => void loadMetadata(teamId, true)}
                disabled={refreshing}
                className="rounded p-0.5 text-text-quaternary hover:text-text-secondary disabled:opacity-40"
              >
                <RefreshCw size={11} className={refreshing ? 'animate-spin' : ''} />
              </button>
            )}
          </span>
          <select
            aria-label="팀"
            value={teamId}
            onChange={(event) => changeTeam(event.target.value)}
            className="rounded border border-border-subtle bg-surface-inset px-2 py-2 text-body text-text-primary"
          >
            <option value="">팀을 선택하세요</option>
            {teams.map((team) => (
              <option key={team.id} value={team.id}>
                {team.name}
              </option>
            ))}
          </select>
        </div>

        <label className="flex flex-col gap-1">
          <span className="text-caption text-text-secondary">제목</span>
          <input
            ref={titleRef}
            aria-label="제목"
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            className="rounded border border-border-subtle bg-surface-inset px-2 py-1.5 text-body text-text-primary"
          />
        </label>

        <label className="flex flex-col gap-1">
          <span className="text-caption text-text-secondary">설명</span>
          <textarea
            aria-label="설명"
            value={description}
            onChange={(event) => setDescription(event.target.value)}
            rows={4}
            className="rounded border border-border-subtle bg-surface-inset px-2 py-1.5 text-body text-text-primary"
          />
        </label>

        <div className="grid grid-cols-2 gap-2">
          <SelectField
            ariaLabel="상태"
            label="상태"
            value={stateId}
            onChange={setStateId}
            options={
              currentTeam?.states.items.map((state) => ({ id: state.id, label: state.name })) ?? []
            }
          />
          <SelectField
            ariaLabel="담당자"
            label="담당자"
            value={assigneeId}
            onChange={setAssigneeId}
            options={
              currentTeam?.members.items.map((member) => ({ id: member.id, label: member.name })) ??
              []
            }
          />
          <SelectField
            ariaLabel="우선순위"
            label="우선순위"
            value={priority}
            onChange={setPriority}
            options={[
              { id: '0', label: 'No priority' },
              { id: '1', label: 'Urgent' },
              { id: '2', label: 'High' },
              { id: '3', label: 'Normal' },
              { id: '4', label: 'Low' },
            ]}
          />
          <SelectField
            ariaLabel="프로젝트"
            label="프로젝트"
            value={projectId}
            onChange={setProjectId}
            options={
              currentTeam?.projects.items.map((project) => ({
                id: project.id,
                label: project.name,
              })) ?? []
            }
          />
        </div>

        {currentTeam &&
          (currentTeam.states.truncated ||
            currentTeam.members.truncated ||
            currentTeam.projects.truncated) && (
            <p className="text-caption text-stale">API 상한으로 일부만 표시됩니다</p>
          )}

        {failure && (
          <div className="space-y-2 rounded border border-danger-muted bg-danger-muted px-3 py-2">
            <p className="flex items-center gap-1 text-body text-text-primary">
              <TriangleAlert size={14} aria-hidden="true" />
              {failure.message}
            </p>
            {failure.possiblyCreated && (
              <p className="text-caption text-danger">
                이미 생성됐을 수 있어 중복 생성을 막았습니다
              </p>
            )}
            {failure.possiblyCreated && (
              <button
                type="button"
                onClick={() => void openUrl(failure.checkUrl)}
                className="rounded border border-border-subtle px-2 py-1 text-caption text-text-primary"
              >
                Linear에서 확인
              </button>
            )}
          </div>
        )}
      </div>

      <footer className="flex justify-end gap-2 border-border-subtle border-t px-4 py-3">
        <button
          type="button"
          onClick={onClose}
          className="rounded border border-border-subtle px-3 py-1.5 text-caption text-text-secondary"
        >
          취소
        </button>
        <button
          type="button"
          onClick={() => void submit()}
          disabled={!canSubmit}
          className="rounded bg-accent px-3 py-1.5 text-caption text-surface-base disabled:opacity-40"
        >
          {submitting ? '생성 중…' : '생성'}
        </button>
        {refreshing && (
          <RefreshCw
            size={14}
            className="self-center animate-spin text-text-tertiary"
            aria-label="새로고침 중"
          />
        )}
      </footer>
    </Modal>
  )
}

function SelectField({
  ariaLabel,
  label,
  value,
  onChange,
  options,
}: {
  ariaLabel: string
  label: string
  value: string
  onChange: (value: string) => void
  options: { id: string; label: string }[]
}) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-caption text-text-secondary">{label}</span>
      <select
        aria-label={ariaLabel}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className="rounded border border-border-subtle bg-surface-inset px-2 py-2 text-body text-text-primary"
      >
        <option value="">선택 안 함</option>
        {options.map((option) => (
          <option key={option.id} value={option.id}>
            {option.label}
          </option>
        ))}
      </select>
    </label>
  )
}
