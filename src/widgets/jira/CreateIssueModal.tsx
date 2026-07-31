import { openUrl } from '@tauri-apps/plugin-opener'
import { Check, RefreshCw, TriangleAlert } from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import {
  type CreateMeta,
  type CreateMetaField,
  commands,
  type JiraCreateFailure,
  type JiraIssueTypeOption,
  type JiraProjectWithTypes,
} from '#/ipc/bindings'
import { useConnectionStore } from '#/store/connection'
import { Modal } from '#/ui/Modal'
import { relativeTime, useNow } from '#/ui/relativeTime'
import { plainTextToAdf } from '#/widgets/jira/plainTextToAdf'

/**
 * 티켓 생성 폼 (D6~D8).
 *
 * # 성공해도 모달을 닫지 않는다
 *
 * 이 앱은 토스트를 쓰지 않는다(DESIGN 5.3). 만들어진 키를 보여주고 다음
 * 행동(Jira에서 열기 / 상세 보기 / 하나 더)을 같은 자리에서 고르게 한다.
 *
 * # 실패해도 입력을 지우지 않는다
 *
 * 특히 `possiblyCreated`(네트워크·타임아웃·5xx)일 때는 **[생성] 버튼을 잠근다.**
 * 다시 누르면 티켓이 두 개가 되고 우리에겐 지우는 기능이 없다.
 */

/** 마지막에 쓴 프로젝트·유형. 보드 배치와 무관하므로 board.json에 넣지 않는다. */
const LAST_USED_KEY = 'pegboard.jira.lastCreate'

/** createmeta가 실패해도 폼은 쓸 수 있어야 한다. 실측 5단계(id 1~5). */
const FALLBACK_PRIORITIES = [
  { id: '1', label: 'Highest' },
  { id: '2', label: 'High' },
  { id: '3', label: 'Medium' },
  { id: '4', label: 'Low' },
  { id: '5', label: 'Lowest' },
]

interface LastUsed {
  projectKey?: string
  issueTypeId?: string
}

function readLastUsed(): LastUsed {
  try {
    return JSON.parse(localStorage.getItem(LAST_USED_KEY) ?? '{}')
  } catch {
    return {}
  }
}

export function CreateIssueModal({
  open,
  onClose,
  onCreated,
}: {
  open: boolean
  onClose: () => void
  /** 만들어진 티켓의 상세를 열어달라는 요청. */
  onCreated: (key: string) => void
}) {
  const baseUrl = useConnectionStore((s) => s.jiraBaseUrl)
  const setJiraAuthFailed = useConnectionStore((s) => s.setJiraAuthFailed)
  const now = useNow()

  const [projects, setProjects] = useState<JiraProjectWithTypes[]>([])
  const [fetchedAt, setFetchedAt] = useState<string | null>(null)
  const [optionsError, setOptionsError] = useState<string | null>(null)
  const [refreshing, setRefreshing] = useState(false)

  const [projectKey, setProjectKey] = useState('')
  const [issueTypeId, setIssueTypeId] = useState('')
  const [summary, setSummary] = useState('')
  const [description, setDescription] = useState('')
  const [priorityId, setPriorityId] = useState('')
  const [dueDate, setDueDate] = useState('')
  const [assignToMe, setAssignToMe] = useState(true)

  const [meta, setMeta] = useState<CreateMeta | null>(null)
  const [myName, setMyName] = useState<string | null>(null)
  const [myAccountId, setMyAccountId] = useState<string | null>(null)

  const [submitting, setSubmitting] = useState(false)
  const [created, setCreated] = useState<string | null>(null)
  const [failure, setFailure] = useState<JiraCreateFailure | null>(null)

  const summaryRef = useRef<HTMLInputElement | null>(null)

  // --- 프로젝트 목록 (D9) ---------------------------------------------------

  const loadOptions = useCallback(
    async (force: boolean) => {
      if (force) setRefreshing(true)
      const result = await commands.jiraCreateOptions(force)
      if (result.status === 'ok') {
        setProjects(result.data.projects)
        setFetchedAt(result.data.fetchedAt)
        setOptionsError(null)
      } else {
        setOptionsError(result.error.message)
        if (result.error.isAuthFailure) setJiraAuthFailed(true)
      }
      setRefreshing(false)
    },
    [setJiraAuthFailed],
  )

  useEffect(() => {
    if (!open) return
    void loadOptions(false)
    void commands.jiraMyself().then((r) => {
      if (r.status === 'ok') {
        setMyName(r.data.displayName ?? null)
        setMyAccountId(r.data.accountId)
      }
    })
  }, [open, loadOptions])

  // 목록이 오면 마지막에 쓴 값 또는 첫 번째를 고른다.
  useEffect(() => {
    if (projects.length === 0 || projectKey) return
    const last = readLastUsed()
    const found = projects.find((p) => p.key === last.projectKey)
    setProjectKey(found?.key ?? projects[0]?.key ?? '')
  }, [projects, projectKey])

  const project = projects.find((p) => p.key === projectKey) ?? null
  // 하위작업은 parent가 필수라 이 폼으로 만들 수 없다.
  const selectableTypes = (project?.issueTypes ?? []).filter((t) => !t.subtask)
  const hiddenSubtaskCount = (project?.issueTypes?.length ?? 0) - selectableTypes.length

  useEffect(() => {
    if (selectableTypes.length === 0) return
    // 현재 선택이 이 프로젝트에 없으면 다시 고른다.
    if (selectableTypes.some((t) => t.id === issueTypeId)) return
    const last = readLastUsed()
    const found = selectableTypes.find((t) => t.id === last.issueTypeId)
    setIssueTypeId(found?.id ?? selectableTypes[0]?.id ?? '')
  }, [selectableTypes, issueTypeId])

  // --- createmeta (D10) -----------------------------------------------------

  useEffect(() => {
    if (!open || !projectKey || !issueTypeId) return
    let cancelled = false

    void commands.jiraCreatemeta(projectKey, issueTypeId, false).then((r) => {
      if (cancelled) return
      if (r.status === 'ok') {
        setMeta(r.data)
        const priority = r.data.fields.find((f) => f.fieldId === 'priority')
        // 기본값이 Medium(id 3)으로 온다. 없으면 목록 가운데를 고르지 않고 비워둔다.
        const fallback = priority?.allowedValues.find((v) => v.label === 'Medium')
        setPriorityId((cur) => cur || fallback?.id || '')
      } else {
        // createmeta가 실패해도 폼은 계속 쓸 수 있어야 한다.
        setMeta(null)
        setPriorityId((cur) => cur || '3')
      }
    })

    return () => {
      cancelled = true
    }
  }, [open, projectKey, issueTypeId])

  // 열릴 때 요약에 포커스.
  useEffect(() => {
    if (open && !created) summaryRef.current?.focus()
  }, [open, created])

  const priorityOptions =
    meta?.fields
      .find((f) => f.fieldId === 'priority')
      ?.allowedValues.map((v) => ({ id: v.id ?? '', label: v.label ?? v.id ?? '' })) ?? null

  // 폼이 못 그리는 필수 필드. 실측상 지금은 0개지만 설정이 바뀌면 나타난다 (4.2).
  const unhandledRequired: CreateMetaField[] =
    meta?.fields.filter(
      (f) =>
        f.required &&
        !f.hasDefaultValue &&
        !['project', 'issuetype', 'summary', 'description', 'priority', 'duedate'].includes(
          f.fieldId,
        ),
    ) ?? []

  const reset = (keepTarget: boolean) => {
    setSummary('')
    setDescription('')
    setDueDate('')
    setCreated(null)
    setFailure(null)
    if (!keepTarget) {
      setProjectKey('')
      setIssueTypeId('')
    }
  }

  const submit = async () => {
    if (!summary.trim() || submitting) return
    setSubmitting(true)
    setFailure(null)

    const extra: Record<string, unknown> = {}
    if (priorityId) extra.priority = { id: priorityId }
    if (dueDate) extra.duedate = dueDate
    if (assignToMe && myAccountId) extra.assignee = { id: myAccountId }

    const result = await commands.jiraCreateIssue({
      projectKey,
      issueTypeId,
      summary: summary.trim(),
      description: plainTextToAdf(description) as never,
      extraFields: extra as never,
    })

    if (result.status === 'ok') {
      localStorage.setItem(LAST_USED_KEY, JSON.stringify({ projectKey, issueTypeId }))
      setCreated(result.data.key)
      // 만든 티켓이 위젯에 바로 보이게 한다.
      window.dispatchEvent(new CustomEvent('pegboard:refresh-all'))
    } else {
      setFailure(result.error)
      if (result.error.isAuthFailure) setJiraAuthFailed(true)
    }
    setSubmitting(false)
  }

  if (!open) return null

  const browse = (key: string) => (baseUrl ? `${baseUrl.replace(/\/$/, '')}/browse/${key}` : null)

  // --- 성공 화면 ------------------------------------------------------------

  if (created) {
    const url = browse(created)
    return (
      <Modal open onClose={onClose} labelledBy="create-issue-title" className="max-w-xl">
        <div className="space-y-4 px-5 py-6">
          <h2 id="create-issue-title" className="flex items-center gap-2 text-md text-text-primary">
            <Check size={16} className="text-success" aria-hidden="true" />
            <span>
              <span className="ticket-key text-accent">{created}</span> 이(가) 만들어졌습니다
            </span>
          </h2>
          <div className="flex flex-wrap gap-2">
            {url && <Button onClick={() => void openUrl(url)}>Jira에서 열기</Button>}
            <Button onClick={() => onCreated(created)}>상세 보기</Button>
            <Button onClick={() => reset(true)}>하나 더 만들기</Button>
            <Button onClick={onClose} className="ml-auto">
              닫기
            </Button>
          </div>
        </div>
      </Modal>
    )
  }

  // --- 입력 폼 --------------------------------------------------------------

  const canSubmit = summary.trim().length > 0 && !submitting && !failure?.possiblyCreated

  return (
    <Modal open onClose={onClose} labelledBy="create-issue-title" className="max-w-xl">
      <header className="border-border-subtle border-b px-4 py-3">
        <h2 id="create-issue-title" className="text-base text-text-primary">
          티켓 생성
        </h2>
      </header>

      <div className="flex-1 space-y-3 overflow-y-auto px-4 py-4">
        {optionsError && (
          <p className="rounded bg-danger-muted px-2 py-1.5 text-caption text-danger">
            프로젝트 목록을 불러오지 못했습니다 — {optionsError}
          </p>
        )}

        <div className="grid grid-cols-[auto_1fr] items-center gap-x-3 gap-y-3">
          <Label htmlFor="ci-project">프로젝트</Label>
          <div className="flex items-center gap-2">
            <select
              id="ci-project"
              value={projectKey}
              onChange={(e) => setProjectKey(e.target.value)}
              className={selectClass}
            >
              {projects.map((p) => (
                <option key={p.key} value={p.key}>
                  {p.key} — {p.name}
                </option>
              ))}
            </select>
            <button
              type="button"
              onClick={() => void loadOptions(true)}
              title="프로젝트 목록 새로고침"
              aria-label="프로젝트 목록 새로고침"
              className="rounded p-1 text-text-tertiary hover:bg-surface-inset hover:text-text-primary
                         focus-visible:outline-2 focus-visible:outline-accent"
            >
              <RefreshCw size={12} className={refreshing ? 'animate-spin' : ''} />
            </button>
            {fetchedAt && (
              <span className="shrink-0 text-caption text-text-quaternary">
                {relativeTime(fetchedAt, new Date(now))}
              </span>
            )}
          </div>

          <Label htmlFor="ci-type">유형</Label>
          <select
            id="ci-type"
            value={issueTypeId}
            onChange={(e) => setIssueTypeId(e.target.value)}
            className={selectClass}
          >
            {selectableTypes.map((t: JiraIssueTypeOption) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
          </select>

          <Label htmlFor="ci-summary">요약</Label>
          <input
            id="ci-summary"
            ref={summaryRef}
            value={summary}
            onChange={(e) => setSummary(e.target.value)}
            className={inputClass}
          />

          <Label htmlFor="ci-desc">설명</Label>
          <div className="space-y-1">
            <textarea
              id="ci-desc"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              rows={5}
              className={`${inputClass} resize-y leading-relaxed-ko`}
            />
            <p className="text-caption text-text-quaternary">
              서식·표·이미지는 생성 후 Jira에서 편집하세요
            </p>
          </div>

          <Label htmlFor="ci-priority">우선순위</Label>
          <div className="flex items-center gap-3">
            <select
              id="ci-priority"
              value={priorityId}
              onChange={(e) => setPriorityId(e.target.value)}
              className={selectClass}
            >
              {(priorityOptions ?? FALLBACK_PRIORITIES).map((p) => (
                <option key={p.id} value={p.id}>
                  {p.label}
                </option>
              ))}
            </select>
            <label htmlFor="ci-due" className="shrink-0 text-caption text-text-tertiary">
              마감
            </label>
            <input
              id="ci-due"
              type="date"
              value={dueDate}
              onChange={(e) => setDueDate(e.target.value)}
              className={inputClass}
            />
          </div>

          <span />
          <label className="flex items-center gap-2 text-body text-text-secondary">
            <input
              type="checkbox"
              checked={assignToMe}
              onChange={(e) => setAssignToMe(e.target.checked)}
              className="accent-accent"
            />
            나에게 할당{myName ? ` (${myName})` : ''}
          </label>
        </div>

        {hiddenSubtaskCount > 0 && (
          <p className="text-caption text-text-quaternary">
            하위 작업 유형 {hiddenSubtaskCount}개는 상위 티켓이 필요해 제외했습니다
          </p>
        )}

        {unhandledRequired.length > 0 && (
          <p className="rounded bg-warning-muted px-2 py-1.5 text-caption text-warning">
            이 프로젝트는 폼에 없는 필수 필드가 있습니다:{' '}
            {unhandledRequired.map((f) => f.name).join(', ')} — 생성이 거절되면 Jira에서 만드세요.
          </p>
        )}

        {failure && <Failure failure={failure} baseUrl={baseUrl} />}
      </div>

      <footer className="flex justify-end gap-2 border-border-subtle border-t px-4 py-3">
        <Button onClick={onClose}>취소</Button>
        <Button onClick={() => void submit()} disabled={!canSubmit} primary>
          {submitting ? '만드는 중…' : '생성'}
        </Button>
      </footer>
    </Modal>
  )
}

/** 생성 실패. possiblyCreated가 가장 강한 경고다. */
function Failure({ failure, baseUrl }: { failure: JiraCreateFailure; baseUrl: string | null }) {
  if (failure.possiblyCreated) {
    return (
      <div className="space-y-2 rounded border border-warning bg-warning-muted px-3 py-2">
        <p className="flex items-start gap-1.5 text-body text-text-primary">
          <TriangleAlert size={14} className="mt-0.5 shrink-0 text-warning" aria-hidden="true" />
          <span>
            응답을 받지 못했습니다. <strong>티켓이 만들어졌을 수 있습니다</strong> — Jira에서
            확인하세요. 다시 누르면 중복이 됩니다.
          </span>
        </p>
        <p className="text-caption text-text-secondary">{failure.message}</p>
        {baseUrl && <Button onClick={() => void openUrl(baseUrl)}>Jira 열기</Button>}
      </div>
    )
  }

  return (
    <div className="space-y-2 rounded border border-danger-muted bg-danger-muted px-3 py-2">
      <p className="text-body text-text-primary">티켓을 만들지 못했습니다.</p>
      <p className="text-caption text-text-secondary">{failure.message}</p>
      {failure.missingFields.length > 0 && (
        <p className="text-caption text-text-secondary">
          채워야 하는 필드: {failure.missingFields.map((f) => f.name).join(', ')}
        </p>
      )}
      {failure.retried && (
        <p className="text-caption text-text-quaternary">
          스키마를 다시 읽고 한 번 재시도했습니다.
        </p>
      )}
    </div>
  )
}

const inputClass = `w-full rounded border border-border-subtle bg-surface-inset px-2 py-1
                    text-body text-text-primary
                    focus-visible:outline-2 focus-visible:outline-accent`

const selectClass = `${inputClass} cursor-pointer`

function Label({ htmlFor, children }: { htmlFor: string; children: React.ReactNode }) {
  return (
    <label htmlFor={htmlFor} className="self-start pt-1 text-caption text-text-tertiary">
      {children}
    </label>
  )
}

function Button({
  onClick,
  children,
  disabled,
  primary,
  className = '',
}: {
  onClick: () => void
  children: React.ReactNode
  disabled?: boolean
  primary?: boolean
  className?: string
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={`rounded border px-3 py-1 text-caption transition-colors duration-fast
                  focus-visible:outline-2 focus-visible:outline-accent
                  disabled:cursor-not-allowed disabled:opacity-50
                  ${
                    primary
                      ? 'border-accent bg-accent text-white hover:bg-accent/90'
                      : 'border-border-subtle text-text-secondary hover:bg-surface-inset'
                  } ${className}`}
    >
      {children}
    </button>
  )
}
