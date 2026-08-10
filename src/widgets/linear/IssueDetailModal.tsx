import { openUrl } from '@tauri-apps/plugin-opener'
import { Check, Copy, ExternalLink, X } from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import {
  commands,
  type LinearCallError,
  type LinearIssue,
  type LinearIssueDetail,
} from '#/ipc/bindings'
import { useConnectionStore } from '#/store/connection'
import { Modal } from '#/ui/Modal'
import { absoluteDate, absoluteTime, relativeTime, useNow } from '#/ui/relativeTime'
import { MarkdownDoc } from './markdown/MarkdownDoc'
import { StatePopover } from './StatePopover'

/**
 * 이슈 상세 모달 (DECISIONS 25.6).
 *
 * # 왜 GitHub과 달리 상세가 있나
 *
 * GitHub 위젯은 상세를 만들지 않았다(12.5) — 목록이 리뷰 상태·CI·변경 규모를
 * 이미 보여줘서 "열어볼지 말지"를 판단하기에 충분하고, GitHub 웹이 느리지 않기
 * 때문이다. Linear에 상세를 넣은 것은 **사용자의 결정**이다: 조작 범위를
 * Jira와 같은 수준(읽기 + 상태 변경 + 상세)으로 하자고 정했다.
 *
 * # 0ms에 골격을 그린다
 *
 * 목록이 이미 가진 값(`issue`)으로 제목·상태·담당자·팀·날짜를 **즉시** 그리고,
 * **본문만** 나중에 채운다. 모달 전체를 스피너로 시작하면 "빠르게 보는 것"이라는
 * 이 앱의 존재 이유가 무너진다 (Jira 상세와 같은 구조, 11.4 D2).
 *
 * 상세 결과는 디스크에 캐시하지 않는다 — 낡은 본문을 보여줄 바에는 잠깐 비는
 * 편이 정직하다.
 *
 * # Jira 상세에 있고 여기 없는 것
 *
 * - **코멘트**: 조회가 하나 더 늘고, Linear 웹에서 스레드로 읽는 편이 낫다.
 *   필요해지면 추가한다
 * - **모달 안 티켓 전환**: markdown에 이슈 참조 문법(`ENG-123`)이 링크로
 *   오지 않는다. 링크는 URL이므로 브라우저로 나간다
 * - **하위 이슈 생성**: 조작 범위에 생성이 없다 (25.1)
 */
export function IssueDetailModal({
  issue,
  onClose,
  onStateChanged,
}: {
  /** 열려 있는 이슈. null이면 닫힘. 목록이 가진 값이 그대로 골격이 된다. */
  issue: LinearIssue | null
  onClose: () => void
  /** 상태 변경 성공 → 목록 재조회. */
  onStateChanged?: (() => void) | undefined
}) {
  const setLinearAuthFailed = useConnectionStore((s) => s.setLinearAuthFailed)
  const now = useNow()

  const [loaded, setLoaded] = useState<{
    issueId: string
    detail: LinearIssueDetail | null
    error: LinearCallError | null
  } | null>(null)
  // 요청 취소 API가 없는 IPC라 순번으로 늦게 끝난 이전 응답을 버린다.
  const requestSequence = useRef(0)
  /** 상태를 바꾼 뒤 배지를 갱신하기 위한 로컬 상태. */
  const [stateChanged, setStateChanged] = useState(false)

  const issueId = issue?.id ?? null
  // prop이 바뀐 직후 effect가 실행되기 전 한 프레임에도 이전 본문을 그리지 않는다.
  const visible = loaded?.issueId === issueId ? loaded : null
  const detail = visible?.detail ?? null
  const detailError = visible?.error ?? null

  const load = useCallback(
    async (id: string) => {
      const sequence = ++requestSequence.current
      setLoaded({ issueId: id, detail: null, error: null })
      const result = await commands.linearIssue(id)
      if (sequence !== requestSequence.current) return
      if (result.status === 'ok') {
        setLoaded({ issueId: id, detail: result.data, error: null })
      } else {
        setLoaded({ issueId: id, detail: null, error: result.error })
        if (result.error.isAuthFailure) setLinearAuthFailed(true)
      }
    },
    [setLinearAuthFailed],
  )

  useEffect(() => {
    if (!issueId) {
      requestSequence.current += 1
      setLoaded(null)
      return
    }
    setStateChanged(false)
    void load(issueId)
    return () => {
      requestSequence.current += 1
    }
  }, [issueId, load])

  if (!issue) return null

  return (
    <Modal open onClose={onClose} labelledBy="linear-detail-title" className="max-w-3xl">
      <header className="flex items-center gap-2 border-border-subtle border-b px-4 py-3">
        <span className="ticket-key text-text-secondary">{issue.identifier}</span>

        {issue.url && (
          <button
            type="button"
            onClick={() => void openUrl(issue.url)}
            className="flex items-center gap-1 rounded px-1.5 py-0.5 text-caption text-text-tertiary
                       hover:bg-surface-inset hover:text-accent
                       focus-visible:outline-2 focus-visible:outline-accent"
          >
            <ExternalLink size={11} aria-hidden="true" />
            Linear에서 열기
          </button>
        )}

        {/* 브랜치 이름 복사. Linear가 만들어 주는 값이고, 이슈를 열어보는
            흔한 이유 하나가 이것이다. 없으면 버튼도 없다. */}
        {detail?.branchName && <CopyBranch branchName={detail.branchName} />}

        <button
          type="button"
          onClick={onClose}
          title="닫기"
          aria-label="닫기"
          className="ml-auto rounded p-1 text-text-tertiary hover:bg-surface-inset hover:text-text-primary
                     focus-visible:outline-2 focus-visible:outline-accent"
        >
          <X size={16} />
        </button>
      </header>

      <div className="flex-1 space-y-4 overflow-y-auto px-4 py-4">
        <h2 id="linear-detail-title" className="text-lg text-text-primary leading-tight-ko">
          {issue.title}
        </h2>

        <div className="flex flex-wrap items-center gap-2 text-caption">
          {/* 목록 행과 **같은 컴포넌트**를 쓴다 (DECISIONS 25.5).
              두 곳에 같은 팝오버를 따로 두면 한쪽만 고치는 일이 생긴다. */}
          <StatePopover
            issueId={issue.id}
            identifier={issue.identifier}
            teamId={issue.teamId}
            currentStateId={issue.state.id}
            issueUrl={issue.url}
            onChanged={() => {
              // 열려 있는 이 모달의 배지가 그대로면 바뀌었는지 알 수 없다.
              // **낙관적 업데이트를 하지 않으므로** 여기서는 "갱신됨" 한 줄만
              // 띄우고, 목록 위젯이 재조회해 새 상태를 가져온다.
              setStateChanged(true)
              onStateChanged?.()
            }}
          >
            <span className="flex items-center gap-1.5 rounded px-1.5 py-0.5">
              <span
                aria-hidden="true"
                className="size-2 shrink-0 rounded-full"
                style={{ backgroundColor: issue.state.color }}
              />
              <span className="text-text-secondary">{issue.state.name}</span>
            </span>
          </StatePopover>

          {/* `priorityLabel`을 그대로 쓴다 (DECISIONS 25.3). */}
          {issue.priorityLabel !== '' && (
            <>
              <span className="text-text-quaternary">·</span>
              <span className="text-text-tertiary">{issue.priorityLabel}</span>
            </>
          )}
          {issue.teamName !== '' && (
            <>
              <span className="text-text-quaternary">·</span>
              <span className="text-text-tertiary">{issue.teamName}</span>
            </>
          )}
        </div>

        {/* 토스트를 쓰지 않는다 (DESIGN 5.3). 사라지는 알림은 놓친다 —
            인라인으로 남기고 자동으로 없애지 않는다. */}
        {stateChanged && (
          <p className="rounded border border-border-subtle bg-surface-inset px-3 py-1.5 text-caption text-text-secondary leading-relaxed-ko">
            상태를 변경했습니다. 위 배지는 목록이 갱신되면 새 상태로 바뀝니다.
          </p>
        )}

        <MetaGrid issue={issue} now={now} />

        <hr className="border-border-subtle" />

        <section className="space-y-2">
          <h3 className="text-caption text-text-tertiary">설명</h3>
          {detailError ? (
            <ErrorBlock
              error={detailError}
              onRetry={() => void load(issue.id)}
              issueUrl={issue.url}
            />
          ) : detail ? (
            // **markdown이다** — ADF가 아니다. 의존성 0으로 직접 그린다
            // (DECISIONS 25.6). 미지원 문법은 회색 박스로 드러난다.
            <MarkdownDoc source={detail.description} />
          ) : (
            <p className="text-body text-text-tertiary">불러오는 중…</p>
          )}
        </section>
      </div>
    </Modal>
  )
}

/** 2열 메타 그리드. 값이 없는 항목은 행 자체를 빼서 빈 칸을 만들지 않는다. */
function MetaGrid({ issue, now }: { issue: LinearIssue; now: number }) {
  return (
    <dl className="grid grid-cols-[auto_1fr_auto_1fr] items-center gap-x-3 gap-y-2 text-caption">
      {issue.assignee && (
        <Row label="담당자">
          <span className="flex min-w-0 items-center gap-1.5">
            {issue.assigneeAvatarUrl ? (
              <img
                src={issue.assigneeAvatarUrl}
                alt=""
                className="size-5 rounded-full"
                loading="lazy"
              />
            ) : (
              <span className="grid size-5 place-items-center rounded-full bg-surface-inset text-text-tertiary">
                {issue.assignee.slice(0, 1)}
              </span>
            )}
            <span className="truncate text-text-secondary">{issue.assignee}</span>
          </span>
        </Row>
      )}

      {issue.projectName && (
        <Row label="프로젝트">
          <span className="truncate text-text-secondary">{issue.projectName}</span>
        </Row>
      )}

      {issue.createdAt !== '' && (
        <Row label="생성">
          <time title={absoluteTime(issue.createdAt)} className="text-text-secondary">
            {relativeTime(issue.createdAt, new Date(now))}
          </time>
        </Row>
      )}
      {issue.updatedAt !== '' && (
        <Row label="수정">
          <time title={absoluteTime(issue.updatedAt)} className="text-text-secondary">
            {relativeTime(issue.updatedAt, new Date(now))}
          </time>
        </Row>
      )}

      {issue.dueDate && (
        <Row label="마감">
          <span className="text-text-secondary tabular-nums">{absoluteDate(issue.dueDate)}</span>
        </Row>
      )}
      {issue.estimate !== null && (
        <Row label="추정">
          <span className="text-text-secondary tabular-nums">{issue.estimate}p</span>
        </Row>
      )}

      {issue.labels.length > 0 && (
        <Row label="라벨" wide>
          <span className="flex flex-wrap gap-1">
            {issue.labels.map((l) => (
              <span
                key={l}
                className="rounded-xs bg-surface-inset px-1.5 py-0.5 text-text-secondary"
              >
                {l}
              </span>
            ))}
          </span>
        </Row>
      )}
    </dl>
  )
}

function Row({
  label,
  wide,
  children,
}: {
  label: string
  /** 한 줄을 통째로 쓴다(라벨처럼 긴 값). */
  wide?: boolean
  children: React.ReactNode
}) {
  // `wide`는 반드시 **새 줄에서 시작**해야 한다(`col-start-1`).
  // 앞의 반쪽 행이 홀수 개면 오른쪽 두 칸이 비어 있는데, 거기에 3칸짜리 dd가
  // 안 들어가서 값만 다음 줄로 밀린다 (Jira 상세에서 실측한 함정이다).
  return (
    <>
      <dt className={`text-text-quaternary ${wide ? 'col-start-1' : ''}`}>{label}</dt>
      <dd className={`min-w-0 ${wide ? 'col-span-3' : ''}`}>{children}</dd>
    </>
  )
}

/** 브랜치 이름 복사 버튼. Linear가 규칙대로 만들어 주는 값이다. */
function CopyBranch({ branchName }: { branchName: string }) {
  const [copied, setCopied] = useState(false)

  return (
    <button
      type="button"
      onClick={() => {
        void navigator.clipboard.writeText(branchName).then(() => {
          setCopied(true)
          setTimeout(() => setCopied(false), 1500)
        })
      }}
      title={`브랜치 이름 복사: ${branchName}`}
      className="flex items-center gap-1 rounded px-1.5 py-0.5 text-caption text-text-tertiary
                 hover:bg-surface-inset hover:text-accent
                 focus-visible:outline-2 focus-visible:outline-accent"
    >
      {copied ? <Check size={11} aria-hidden="true" /> : <Copy size={11} aria-hidden="true" />}
      브랜치 이름
    </button>
  )
}

/** 상세 조회 실패. 일시적이면 재시도를, 아니면 Linear로 나갈 길을 준다. */
function ErrorBlock({
  error,
  onRetry,
  issueUrl,
}: {
  error: LinearCallError
  onRetry: () => void
  issueUrl: string
}) {
  return (
    <div className="space-y-2 rounded border border-danger-muted bg-danger-muted px-3 py-2">
      <p className="text-body text-text-primary">
        {error.isAuthFailure
          ? '인증에 실패했습니다. 설정에서 API 키를 다시 입력하세요.'
          : '설명을 불러오지 못했습니다.'}
      </p>
      {/* Linear 원문 그대로 (DECISIONS 16장). */}
      <p className="text-caption text-text-secondary">{error.message}</p>
      <div className="flex gap-2 pt-1">
        {/* 영구적 실패에 재시도 버튼을 주면 몇 번을 눌러도 같은 결과인 버튼이다. */}
        {error.kind === 'transient' && (
          <button
            type="button"
            onClick={onRetry}
            className="rounded border border-border-subtle bg-surface-raised px-2 py-1 text-caption
                       text-text-primary hover:bg-surface-overlay
                       focus-visible:outline-2 focus-visible:outline-accent"
          >
            다시 시도
          </button>
        )}
        {issueUrl && (
          <button
            type="button"
            onClick={() => void openUrl(issueUrl)}
            className="rounded border border-border-subtle px-2 py-1 text-caption text-text-secondary
                       hover:bg-surface-raised focus-visible:outline-2 focus-visible:outline-accent"
          >
            Linear에서 열기
          </button>
        )}
      </div>
    </div>
  )
}
