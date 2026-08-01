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
import { projectKeyOf } from '#/widgets/jira/childTypes'
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
  parent,
}: {
  open: boolean
  onClose: () => void
  /** 만들어진 티켓의 상세를 열어달라는 요청. */
  onCreated: (key: string) => void
  /**
   * 하위 티켓을 만드는 경우의 **고정된 상위**.
   *
   * 상세 모달에서 "하위 만들기"로 열면 채워진다. 이때 프로젝트는 상위를
   * 따라가고(바꿀 수 없다), 유형 목록도 상위보다 한 단계 아래로 좁혀진다.
   *
   * 위젯 헤더에서 열면 `undefined`다 — 그때는 평범한 생성 폼이고
   * 하위 작업 유형은 목록에서 빠진다. 상위를 고를 방법이 없기 때문이다
   * (Jira가 parent에 allowedValues도 autoCompleteUrl도 주지 않는다 — 실측).
   */
  parent?: { key: string; summary: string | null; childTypes: JiraIssueTypeOption[] }
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

  // 닫히면 **1회성 상태를 지운다.**
  //
  // 안 하면 성공 화면(`created`)이 남아서, 다음에 열었을 때 폼 대신 지난번
  // "만들어졌습니다"가 다시 뜬다. 모달은 언마운트되지 않고 `open`으로만
  // 숨겨지므로 state가 그대로 살아 있다.
  //
  // 프로젝트·유형도 비운다. 다음에 열 때 **저장값**(마지막으로 만든 곳)에서
  // 다시 채운다 — 남겨두면 "만들지 않고 눌러보기만 한 선택"이 따라다닌다.
  useEffect(() => {
    if (open) return
    setCreated(null)
    setFailure(null)
    setSummary('')
    setDescription('')
    setDueDate('')
    setSubmitting(false)
    setProjectKey('')
    setIssueTypeId('')
  }, [open])

  // 열 때마다 **마지막으로 만든** 프로젝트로 되돌린다 (D6).
  //
  // 저장값이 곧 기본값이다. 남아 있던 선택을 우선하면, 폼에서 프로젝트만
  // 바꿔보고 만들지 않은 채 닫았을 때 그 선택이 계속 따라다닌다 —
  // "마지막에 만든 곳"이 아니라 "마지막에 눌러본 곳"이 되어버린다.
  //
  // 저장된 프로젝트가 목록에서 사라졌으면(권한 변경 등) 첫 번째로 떨어진다.
  useEffect(() => {
    if (!open) return

    // 상위가 있으면 프로젝트는 상위를 따라간다 — 저장값보다 우선한다.
    // 하위 티켓은 상위와 같은 프로젝트에만 만들 수 있다.
    if (parent) {
      setProjectKey(projectKeyOf(parent.key) ?? '')
      return
    }

    if (projects.length === 0) return
    const last = readLastUsed()
    const found = projects.find((p) => p.key === last.projectKey)
    setProjectKey(found?.key ?? projects[0]?.key ?? '')
  }, [open, projects, parent])

  const project = projects.find((p) => p.key === projectKey) ?? null

  // 유형 목록은 상위가 있느냐로 갈린다.
  //
  //   상위 있음 → 상위보다 한 단계 아래 유형만 (호출부가 계산해서 넘긴다)
  //   상위 없음 → 하위 작업을 **뺀** 전부
  //
  // 하위 작업을 빼는 이유: 상위를 고를 방법이 없다. Jira가 parent에
  // allowedValues도 autoCompleteUrl도 주지 않아(실측) 드롭다운도 자동완성도
  // 만들 수 없다. 하위 작업은 상세 화면의 "하위 만들기"로만 만든다.
  const selectableTypes = parent
    ? parent.childTypes
    : (project?.issueTypes ?? []).filter((t) => !t.subtask)

  // 유형도 같은 규칙 — 열 때는 저장값, 그 뒤 프로젝트를 바꾸면 그 프로젝트의 값.
  //
  // `open`을 의존성에 넣어야 같은 프로젝트로 다시 열었을 때도 저장값으로
  // 돌아온다. 안 그러면 selectableTypes가 그대로라 effect가 안 돌고,
  // 직전에 눌러본 유형이 남는다.
  // setIssueTypeId의 함수형 갱신을 쓰므로 issueTypeId를 의존성에 넣지 않아도 된다 —
  // 넣으면 사용자가 드롭다운에서 고른 값을 즉시 되돌려버린다.
  useEffect(() => {
    if (!open || selectableTypes.length === 0) return
    const last = readLastUsed()
    const found = selectableTypes.find((t) => t.id === last.issueTypeId)
    setIssueTypeId((cur) => {
      // 현재 선택이 이 프로젝트에서 유효하면 존중한다 — 사용자가 방금 고른 값이다.
      if (selectableTypes.some((t) => t.id === cur)) return cur
      return found?.id ?? selectableTypes[0]?.id ?? ''
    })
  }, [open, selectableTypes])

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

  /** 폼이 직접 보내는 필드. 이것들은 "못 그리는 필수 필드"가 아니다. */
  const FORM_FIELDS = [
    'project',
    'issuetype',
    'summary',
    'description',
    'priority',
    'duedate',
    'assignee',
    // 하위 작업일 때 상위 칸이 나타난다.
    'parent',
  ]

  // 폼이 못 그리는 필수 필드. 실측상 지금은 0개지만 설정이 바뀌면 나타난다 (4.2).
  const unhandledRequired: CreateMetaField[] =
    meta?.fields.filter(
      (f) => f.required && !f.hasDefaultValue && !FORM_FIELDS.includes(f.fieldId),
    ) ?? []

  /**
   * "하나 더 만들기" — 성공 화면에서 폼으로 돌아간다.
   *
   * 프로젝트·유형은 **그대로 둔다.** 연달아 만들 때 같은 곳에 만드는 경우가
   * 대부분이고, 방금 만든 것이 곧 저장값이라 다시 고를 필요가 없다.
   * (닫았다 여는 경로는 위의 `open` effect가 따로 처리한다.)
   */
  const startAnother = () => {
    setSummary('')
    setDescription('')
    setDueDate('')
    setCreated(null)
    setFailure(null)
  }

  const submit = async () => {
    if (!summary.trim() || submitting) return
    setSubmitting(true)
    setFailure(null)

    const extra: Record<string, unknown> = {}
    if (priorityId) extra.priority = { id: priorityId }
    if (dueDate) extra.duedate = dueDate
    if (assignToMe && myAccountId) extra.assignee = { id: myAccountId }
    // 하위 작업은 parent가 필수다. 키를 그대로 보낸다 — Jira가 검증한다.
    // 상위는 화면에서 고정돼 있다. 사용자가 칠 일이 없으므로 검증도 필요 없다.
    if (parent) extra.parent = { key: parent.key }

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
      // 만든 티켓이 위젯에 보이게 한다. `refresh-all`이 아니라 전용 이벤트를
      // 쓰는 이유: Jira 검색 인덱스가 쓰기보다 늦어서 즉시 조회로는 방금 만든
      // 티켓이 안 잡힌다. 듣는 쪽이 잠시 뒤 한 번 더 조회한다.
      window.dispatchEvent(new CustomEvent('pegboard:jira-created'))
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
            <Button onClick={startAnother}>하나 더 만들기</Button>
            <Button onClick={onClose} className="ml-auto">
              닫기
            </Button>
          </div>
        </div>
      </Modal>
    )
  }

  // --- 입력 폼 --------------------------------------------------------------

  // 만들 수 있는 유형이 없으면(하위 작업 아래) 애초에 열리지 않지만, 방어한다.
  const canSubmit =
    summary.trim().length > 0 && issueTypeId.length > 0 && !submitting && !failure?.possiblyCreated

  return (
    <Modal open onClose={onClose} labelledBy="create-issue-title" className="max-w-xl">
      <header className="border-border-subtle border-b px-4 py-3">
        <h2 id="create-issue-title" className="text-base text-text-primary">
          {parent ? '하위 티켓 생성' : '티켓 생성'}
        </h2>
      </header>

      <div className="flex-1 space-y-3 overflow-y-auto px-4 py-4">
        {optionsError && (
          <p className="rounded bg-danger-muted px-2 py-1.5 text-caption text-danger">
            프로젝트 목록을 불러오지 못했습니다 — {optionsError}
          </p>
        )}

        <div className="grid grid-cols-[auto_1fr] items-center gap-x-3 gap-y-3">
          {/* 상위가 정해져 있으면 프로젝트는 따라간다 — 고를 것이 없다.
              대신 무엇 아래에 만드는지를 보여준다. */}
          {parent ? (
            <>
              <Label htmlFor="ci-parent-fixed">상위</Label>
              <div id="ci-parent-fixed" className="flex min-w-0 items-center gap-1.5">
                <span className="ticket-key shrink-0 text-accent">{parent.key}</span>
                {parent.summary && (
                  <span className="truncate text-body text-text-secondary">{parent.summary}</span>
                )}
              </div>
            </>
          ) : (
            <>
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
                  className="rounded p-1 text-text-tertiary hover:bg-surface-inset
                             hover:text-text-primary focus-visible:outline-2
                             focus-visible:outline-accent"
                >
                  <RefreshCw size={12} className={refreshing ? 'animate-spin' : ''} />
                </button>
                {fetchedAt && (
                  <span className="shrink-0 text-caption text-text-quaternary">
                    {relativeTime(fetchedAt, new Date(now))}
                  </span>
                )}
              </div>
            </>
          )}

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
                {t.subtask ? ' (하위 작업)' : ''}
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
