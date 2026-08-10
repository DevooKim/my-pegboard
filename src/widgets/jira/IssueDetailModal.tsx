import { openUrl } from '@tauri-apps/plugin-opener'
import { ChevronLeft, ExternalLink, Plus, X } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
import {
  commands,
  type JiraCallError,
  type JiraComment,
  type JiraCommentsView,
  type JiraIssue,
  type JiraIssueDetail,
  type JiraProjectWithTypes,
} from '#/ipc/bindings'
import { useConnectionStore } from '#/store/connection'
import { Modal } from '#/ui/Modal'
import { absoluteDate, absoluteTime, relativeTime, useNow } from '#/ui/relativeTime'
import { AdfDoc } from '#/widgets/jira/adf/AdfDoc'
import { CreateIssueModal } from '#/widgets/jira/CreateIssueModal'
import { childTypesFor, levelOf, projectKeyOf } from '#/widgets/jira/childTypes'
import { notifyTransitioned, StatusTransitionPopover } from '#/widgets/jira/StatusTransitionPopover'
import { TicketIdCopyButton } from '#/widgets/jira/TicketIdCopyButton'

/**
 * 티켓 상세 모달.
 *
 * # 0ms에 골격을 그린다 (D2)
 *
 * 목록이 이미 가진 값(`seed`)으로 제목·상태·담당자를 **즉시** 그리고,
 * 설명·코멘트·라벨·보고자만 나중에 채운다. 모달 전체를 스피너로 시작하면
 * "빠르게 보는 것"이라는 이 앱의 존재 이유를 정면으로 부순다.
 *
 * 상세 결과는 디스크에 캐시하지 않는다 — 낡은 상세를 보여줄 바에는
 * 잠깐 비어 있는 편이 정직하다.
 *
 * # 모달 안에서 티켓을 갈아탄다 (D4)
 *
 * 본문의 티켓 키·상위 항목을 누르면 창을 새로 열지 않고 그 티켓으로 전환한다.
 * `‹`로 돌아온다. ESC는 **모달 전체를 닫는다** — 한 키가 두 가지 뜻을 갖지 않게.
 */
export function IssueDetailModal({
  issueKey,
  seed,
  onClose,
}: {
  /** 열려 있는 티켓 키. null이면 닫힘. */
  issueKey: string | null
  /** 목록이 가진 데이터. 골격을 0ms에 그리는 재료 (D2). */
  seed: JiraIssue | null
  onClose: () => void
}) {
  const baseUrl = useConnectionStore((s) => s.jiraBaseUrl)
  const setJiraAuthFailed = useConnectionStore((s) => s.setJiraAuthFailed)
  const now = useNow()

  // 전환 스택. 현재 티켓은 항상 맨 위.
  const [stack, setStack] = useState<string[]>([])
  const current = stack.at(-1) ?? null

  const [detail, setDetail] = useState<JiraIssueDetail | null>(null)
  const [detailError, setDetailError] = useState<JiraCallError | null>(null)
  const [comments, setComments] = useState<JiraCommentsView | null>(null)
  const [commentsError, setCommentsError] = useState<JiraCallError | null>(null)
  const [loading, setLoading] = useState(false)
  /** 하위 유형 판정에 쓸 프로젝트 유형 목록. 캐시가 있으면 0ms. */
  const [projects, setProjects] = useState<JiraProjectWithTypes[]>([])
  const [creatingChild, setCreatingChild] = useState(false)

  // 바깥에서 연 티켓이 바뀌면 스택을 새로 시작한다.
  useEffect(() => {
    setStack(issueKey ? [issueKey] : [])
  }, [issueKey])

  const load = useCallback(
    async (key: string) => {
      setLoading(true)
      setDetail(null)
      setDetailError(null)
      setComments(null)
      setCommentsError(null)

      // 상세와 코멘트를 동시에 쏜다. 순차로 하면 체감이 두 배가 된다.
      const [detailResult, commentsResult] = await Promise.all([
        commands.jiraIssue(key),
        commands.jiraComments(key),
      ])

      if (detailResult.status === 'ok') {
        setDetail(detailResult.data)
      } else {
        setDetailError(detailResult.error)
        if (detailResult.error.isAuthFailure) setJiraAuthFailed(true)
      }

      // 코멘트만 실패해도 설명은 살린다 — 부분 실패를 뭉개지 않는다.
      if (commentsResult.status === 'ok') {
        setComments(commentsResult.data)
      } else {
        setCommentsError(commentsResult.error)
      }
      setLoading(false)
    },
    [setJiraAuthFailed],
  )

  useEffect(() => {
    if (!current) return
    void load(current)
  }, [current, load])

  // 유형 계층을 알려면 프로젝트의 유형 목록이 필요하다. 생성 폼과 같은
  // 디스크 캐시라 두 번째부터는 네트워크를 타지 않는다.
  useEffect(() => {
    if (!issueKey) return
    void commands.jiraCreateOptions(false).then((r) => {
      if (r.status === 'ok') setProjects(r.data.projects)
    })
  }, [issueKey])

  const openIssue = useCallback((key: string) => {
    // 직전과 같은 티켓이면 무시 — 스택에 같은 것이 쌓이면 ‹가 헛돈다.
    setStack((s) => (s.at(-1) === key ? s : [...s, key]))
  }, [])

  const goBack = () => setStack((s) => (s.length > 1 ? s.slice(0, -1) : s))

  if (!issueKey || !current) return null

  // 전환으로 들어온 티켓에는 seed가 없다. 처음 연 티켓일 때만 골격을 쓴다.
  const skeleton = current === issueKey ? seed : null
  const browse = baseUrl ? `${baseUrl.replace(/\/$/, '')}/browse/${current}` : null

  // 골격 → 상세 순으로 값을 고른다. 상세가 오면 그것이 이긴다.
  const summary = detail?.summary ?? skeleton?.summary ?? null
  const status = detail?.status ?? skeleton?.status ?? null
  const issueType = detail?.issueType ?? skeleton?.issueType ?? null
  const priority = detail?.priority ?? skeleton?.priority ?? null
  const assignee = detail?.assignee ?? skeleton?.assignee ?? null
  const created = detail?.created ?? skeleton?.created ?? null
  const updated = detail?.updated ?? skeleton?.updated ?? null
  const dueDate = detail?.dueDate ?? skeleton?.dueDate ?? null
  const parent = detail?.parent ?? skeleton?.parent ?? null
  const sprint = detail?.sprint ?? skeleton?.sprint ?? null

  // 아무것도 그릴 게 없는 상태 = 골격도 없고 상세도 실패했다.
  const bodyIsEmpty = !summary && !detail

  // 이 티켓 아래에 만들 수 있는 유형. 계층은 hierarchyLevel로 정해진다
  // (에픽 1 → 작업 0 → 하위 작업 -1). 한 단계씩만 내려간다.
  const projectTypes = projects.find((p) => p.key === projectKeyOf(current))?.issueTypes ?? []
  const childTypes = childTypesFor(
    levelOf(issueType?.name, issueType?.subtask, projectTypes),
    projectTypes,
  )
  // 버튼 문구에 만들 유형을 그대로 쓴다 — "하위 만들기"보다 무엇이 생기는지 분명하다.
  const childLabel = childTypes.length === 1 ? `${childTypes[0]?.name} 만들기` : '하위 만들기'

  return (
    <Modal open onClose={onClose} labelledBy="issue-detail-title" className="max-w-3xl">
      <header className="flex items-center gap-2 border-border-subtle border-b px-4 py-3">
        {stack.length > 1 && (
          <button
            type="button"
            onClick={goBack}
            title="이전 티켓으로"
            aria-label="이전 티켓으로"
            className="rounded p-1 text-text-tertiary hover:bg-surface-inset hover:text-text-primary
                       focus-visible:outline-2 focus-visible:outline-accent"
          >
            <ChevronLeft size={16} />
          </button>
        )}
        <TicketIdCopyButton identifier={current} />

        {browse && (
          <button
            type="button"
            onClick={() => void openUrl(browse)}
            className="flex items-center gap-1 rounded px-1.5 py-0.5 text-caption text-text-tertiary
                       hover:bg-surface-inset hover:text-accent
                       focus-visible:outline-2 focus-visible:outline-accent"
          >
            <ExternalLink size={11} aria-hidden="true" />
            Jira에서 열기
          </button>
        )}

        {/* 한 단계 아래를 만들 수 있을 때만 (에픽→작업, 작업→하위 작업).
            하위 작업 아래로는 만들 수 없으므로 버튼이 사라진다. */}
        {childTypes.length > 0 && (
          <button
            type="button"
            onClick={() => setCreatingChild(true)}
            className="flex items-center gap-1 rounded px-1.5 py-0.5 text-caption text-text-tertiary
                       hover:bg-surface-inset hover:text-accent
                       focus-visible:outline-2 focus-visible:outline-accent"
          >
            <Plus size={11} aria-hidden="true" />
            {childLabel}
          </button>
        )}

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
        {bodyIsEmpty ? (
          detailError ? (
            <ErrorBlock error={detailError} onRetry={() => void load(current)} browse={browse} />
          ) : (
            <p className="text-body text-text-tertiary">불러오는 중…</p>
          )
        ) : (
          <>
            <h2 id="issue-detail-title" className="text-lg text-text-primary leading-tight-ko">
              {summary ?? '제목을 불러오는 중…'}
            </h2>

            <div className="flex flex-wrap items-center gap-2 text-caption">
              {status && (
                // 목록 행과 **같은 컴포넌트**를 쓴다 (DECISIONS 11.5 개정).
                // 두 곳에 같은 팝오버를 따로 두면 한쪽만 고치는 일이 생긴다.
                <StatusTransitionPopover
                  issueKey={current}
                  browseUrl={browse}
                  disabled={!browse}
                  onTransitioned={() => {
                    // 열려 있는 이 모달을 먼저 갱신한다 — 배지가 그대로면
                    // 전이가 됐는지 알 수 없다. 목록 위젯은 이벤트로 따라온다.
                    void load(current)
                    notifyTransitioned()
                  }}
                >
                  <span
                    className="block rounded px-1.5 py-0.5"
                    style={{
                      color: statusColor(status.statusCategory?.key ?? 'new'),
                      backgroundColor: statusMuted(status.statusCategory?.key ?? 'new'),
                    }}
                  >
                    {status.name}
                  </span>
                </StatusTransitionPopover>
              )}
              {issueType?.name && <span className="text-text-tertiary">{issueType.name}</span>}
              {priority?.name && (
                <>
                  <span className="text-text-quaternary">·</span>
                  <span className="text-text-tertiary">{priority.name}</span>
                </>
              )}
            </div>

            <MetaGrid
              assignee={assignee}
              reporter={detail?.reporter ?? null}
              created={created}
              updated={updated}
              dueDate={dueDate}
              sprint={sprint?.name ?? null}
              parent={parent}
              labels={detail?.labels ?? []}
              detailPending={!detail && !detailError}
              now={now}
              onOpenIssue={openIssue}
            />

            <hr className="border-border-subtle" />

            <section className="space-y-2">
              <h3 className="text-caption text-text-tertiary">설명</h3>
              {detailError ? (
                <ErrorBlock
                  error={detailError}
                  onRetry={() => void load(current)}
                  browse={browse}
                />
              ) : detail ? (
                <AdfDoc
                  doc={detail.description}
                  onOpenIssue={openIssue}
                  baseUrl={baseUrl}
                  issueUrl={browse}
                />
              ) : (
                <p className="text-body text-text-tertiary">불러오는 중…</p>
              )}
            </section>

            <hr className="border-border-subtle" />

            <Comments
              view={comments}
              error={commentsError}
              loading={loading && !comments && !commentsError}
              browse={browse}
              baseUrl={baseUrl}
              now={now}
              onOpenIssue={openIssue}
              onRetry={() => void load(current)}
            />
          </>
        )}
      </div>

      {/* 하위 티켓 생성. 상위는 지금 보고 있는 티켓으로 고정된다 —
          사용자가 키를 칠 일이 없다. */}
      <CreateIssueModal
        open={creatingChild}
        onClose={() => setCreatingChild(false)}
        parent={{ key: current, summary, childTypes }}
        onCreated={(key) => {
          setCreatingChild(false)
          // 만든 하위 티켓으로 전환한다. ‹로 지금 티켓에 돌아온다.
          openIssue(key)
        }}
      />
    </Modal>
  )
}

/** 2열 메타 그리드. 값이 없는 항목은 행 자체를 빼서 빈 칸을 만들지 않는다. */
function MetaGrid({
  assignee,
  reporter,
  created,
  updated,
  dueDate,
  sprint,
  parent,
  labels,
  detailPending,
  now,
  onOpenIssue,
}: {
  assignee: JiraIssue['assignee']
  reporter: JiraIssueDetail['reporter']
  created: string | null
  updated: string | null
  dueDate: string | null
  sprint: string | null
  parent: JiraIssue['parent']
  labels: string[]
  /** 상세가 아직 안 왔다. 보고자·라벨 자리를 밝혀둔다. */
  detailPending: boolean
  now: number
  onOpenIssue: (key: string) => void
}) {
  return (
    <dl className="grid grid-cols-[auto_1fr_auto_1fr] items-center gap-x-3 gap-y-2 text-caption">
      {assignee && <Row label="담당자">{<User user={assignee} />}</Row>}
      {reporter ? (
        <Row label="보고자">{<User user={reporter} />}</Row>
      ) : detailPending ? (
        <Row label="보고자">
          <span className="text-text-quaternary">불러오는 중…</span>
        </Row>
      ) : null}

      {created && (
        <Row label="생성">
          <time title={absoluteTime(created)} className="text-text-secondary">
            {relativeTime(created, new Date(now))}
          </time>
        </Row>
      )}
      {updated && (
        <Row label="수정">
          <time title={absoluteTime(updated)} className="text-text-secondary">
            {relativeTime(updated, new Date(now))}
          </time>
        </Row>
      )}

      {dueDate && (
        <Row label="마감">
          <span className="text-text-secondary tabular-nums">{absoluteDate(dueDate)}</span>
        </Row>
      )}
      {sprint && (
        <Row label="스프린트">
          <span className="text-text-secondary">{sprint}</span>
        </Row>
      )}

      {parent && (
        <Row label="상위" wide>
          <button
            type="button"
            onClick={() => onOpenIssue(parent.key)}
            className="flex min-w-0 items-center gap-1.5 rounded text-left text-accent
                       hover:underline focus-visible:outline-2 focus-visible:outline-accent"
          >
            <span className="ticket-key">{parent.key}</span>
            {parent.summary && (
              <span className="truncate text-text-secondary">{parent.summary}</span>
            )}
          </button>
        </Row>
      )}

      {labels.length > 0 && (
        <Row label="라벨" wide>
          <span className="flex flex-wrap gap-1">
            {labels.map((l) => (
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
  /** 한 줄을 통째로 쓴다(상위·라벨처럼 긴 값). */
  wide?: boolean
  children: React.ReactNode
}) {
  // `wide`는 반드시 **새 줄에서 시작**해야 한다(`col-start-1`).
  //
  // 앞의 반쪽 행이 홀수 개면(마감 없이 스프린트만 있는 티켓 등) 오른쪽 두 칸이
  // 비어 있는데, 거기에 3칸짜리 dd가 안 들어가서 값만 다음 줄로 밀린다.
  // 그러면 라벨과 값이 서로 다른 줄에 놓여 배치가 깨져 보인다 (EDU-60에서 실측).
  return (
    <>
      <dt className={`text-text-quaternary ${wide ? 'col-start-1' : ''}`}>{label}</dt>
      <dd className={`min-w-0 ${wide ? 'col-span-3' : ''}`}>{children}</dd>
    </>
  )
}

function User({ user }: { user: NonNullable<JiraIssue['assignee']> }) {
  return (
    <span className="flex min-w-0 items-center gap-1.5">
      {user.avatarUrl ? (
        <img src={user.avatarUrl} alt="" className="size-5 rounded-full" loading="lazy" />
      ) : (
        <span className="grid size-5 place-items-center rounded-full bg-surface-inset text-text-tertiary">
          {(user.displayName || '?').slice(0, 1)}
        </span>
      )}
      <span className="truncate text-text-secondary">{user.displayName || '이름 없음'}</span>
    </span>
  )
}

function Comments({
  view,
  error,
  loading,
  browse,
  baseUrl,
  now,
  onOpenIssue,
  onRetry,
}: {
  view: JiraCommentsView | null
  error: JiraCallError | null
  loading: boolean
  browse: string | null
  baseUrl: string | null
  now: number
  onOpenIssue: (key: string) => void
  onRetry: () => void
}) {
  return (
    <section className="space-y-3">
      <h3 className="text-caption text-text-tertiary">코멘트{view ? ` ${view.total}` : ''}</h3>

      {error ? (
        // 코멘트만 실패한 경우. 설명은 위에 그대로 남아 있다.
        <div className="space-y-2 rounded border border-border-subtle bg-surface-inset px-3 py-2">
          <p className="text-body text-text-secondary">코멘트를 불러오지 못했습니다.</p>
          <p className="text-caption text-text-tertiary">{error.message}</p>
          <button
            type="button"
            onClick={onRetry}
            className="rounded border border-border-subtle px-2 py-1 text-caption text-text-secondary
                       hover:bg-surface-raised focus-visible:outline-2 focus-visible:outline-accent"
          >
            다시 시도
          </button>
        </div>
      ) : loading ? (
        <p className="text-body text-text-tertiary">불러오는 중…</p>
      ) : !view || view.comments.length === 0 ? (
        <p className="text-body text-text-tertiary">코멘트가 없습니다</p>
      ) : (
        <>
          {view.hasOlder && browse && (
            <button
              type="button"
              onClick={() => void openUrl(browse)}
              className="text-caption text-text-tertiary hover:text-accent hover:underline
                         focus-visible:outline-2 focus-visible:outline-accent"
            >
              … 이전 {view.total - view.comments.length}개는 Jira에서 보기
            </button>
          )}
          <ul className="space-y-3">
            {view.comments.map((c) => (
              <CommentItem
                key={c.id}
                comment={c}
                baseUrl={baseUrl}
                browse={browse}
                now={now}
                onOpenIssue={onOpenIssue}
              />
            ))}
          </ul>
        </>
      )}
    </section>
  )
}

function CommentItem({
  comment,
  baseUrl,
  browse,
  now,
  onOpenIssue,
}: {
  comment: JiraComment
  baseUrl: string | null
  browse: string | null
  now: number
  onOpenIssue: (key: string) => void
}) {
  return (
    <li className="space-y-1">
      <div className="flex items-center gap-2 text-caption">
        {comment.author && <User user={comment.author} />}
        {comment.created && (
          <time title={absoluteTime(comment.created)} className="text-text-quaternary">
            {relativeTime(comment.created, new Date(now))}
          </time>
        )}
      </div>
      <div className="pl-6.5">
        <AdfDoc doc={comment.body} onOpenIssue={onOpenIssue} baseUrl={baseUrl} issueUrl={browse} />
      </div>
    </li>
  )
}

/** 상세 조회 실패. 일시적이면 재시도를, 아니면 Jira로 나갈 길을 준다. */
function ErrorBlock({
  error,
  onRetry,
  browse,
}: {
  error: JiraCallError
  onRetry: () => void
  browse: string | null
}) {
  return (
    <div className="space-y-2 rounded border border-danger-muted bg-danger-muted px-3 py-2">
      <p className="text-body text-text-primary">
        {error.isAuthFailure
          ? '인증에 실패했습니다. 설정에서 토큰을 다시 입력하세요.'
          : '티켓을 불러오지 못했습니다.'}
      </p>
      <p className="text-caption text-text-secondary">{error.message}</p>
      <div className="flex gap-2 pt-1">
        <button
          type="button"
          onClick={onRetry}
          className="rounded border border-border-subtle bg-surface-raised px-2 py-1 text-caption
                     text-text-primary hover:bg-surface-overlay
                     focus-visible:outline-2 focus-visible:outline-accent"
        >
          다시 시도
        </button>
        {browse && (
          <button
            type="button"
            onClick={() => void openUrl(browse)}
            className="rounded border border-border-subtle px-2 py-1 text-caption text-text-secondary
                       hover:bg-surface-raised focus-visible:outline-2 focus-visible:outline-accent"
          >
            Jira에서 열기
          </button>
        )}
      </div>
    </div>
  )
}

function statusColor(key: string): string {
  if (key === 'done') return 'var(--color-status-done)'
  if (key === 'indeterminate') return 'var(--color-status-progress)'
  return 'var(--color-status-todo)'
}

function statusMuted(key: string): string {
  if (key === 'done') return 'var(--color-status-done-muted)'
  if (key === 'indeterminate') return 'var(--color-status-progress-muted)'
  return 'var(--color-status-todo-muted)'
}
