import { openUrl } from '@tauri-apps/plugin-opener'
import { ExternalLink } from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { commands, type JiraCallError, type JiraTransition } from '#/ipc/bindings'
import { useConnectionStore } from '#/store/connection'

/**
 * 상태 배지를 눌러 티켓 상태를 바꾸는 팝오버 (DECISIONS 11.5 개정).
 *
 * 목록 행(`IssueRow`)과 상세 모달(`IssueDetailModal`)이 **이 파일 하나를 같이 쓴다.**
 * 두 곳에 같은 UI를 두면 한쪽만 고치는 일이 반드시 생긴다.
 *
 * # 왜 2단 클릭인가
 *
 * 배지 → 팝오버 → 전이 항목. 배지 한 번으로 상태가 바뀌지 않는다.
 * **되돌리기가 없는 조작**이라 이 한 겹이 필요하다. 목록을 훑다 잘못 누르면
 * 티켓 상태가 팀 전체에 잘못 알려지고, 우리에겐 취소 버튼이 없다.
 *
 * # 왜 열 때 조회하는가 (lazy)
 *
 * 행마다 미리 전이를 조회하면 티켓 30개에 요청 30개다 — rate limit에 바로 닿고,
 * 그중 사용자가 실제로 여는 것은 하나다. 배지를 누른 그 순간에 한 번 조회한다.
 *
 * # 캐시는 메모리 30초뿐
 *
 * 디스크에 캐시하지 않는다. 전이 가능성은 **상태가 바뀌면 즉시 낡는다** —
 * 방금 완료로 옮긴 티켓에 "완료로 이동"을 다시 보여주는 것보다 조회 한 번이 싸다.
 * 30초 메모리 캐시는 팝오버를 연달아 여닫을 때의 중복 호출만 막는다.
 *
 * # 필수 필드가 걸린 전이는 실행하지 않는다
 *
 * 앱에서 못 하는 일을 **누르기 전에** 말한다. 버튼을 눌러 400을 맞게 두지 않고,
 * 숨겨서 "왜 완료 버튼이 없지"를 만들지도 않는다. 브라우저 링크로 바뀐다.
 */

/** 전이 목록 메모리 캐시 TTL. 디스크에는 절대 쓰지 않는다. */
const CACHE_TTL_MS = 30_000

/**
 * 전이 성공을 알리는 이벤트.
 *
 * `pegboard:jira-created`와 같은 방식이다. **전역인 이유:** 보드에 Jira 위젯이
 * 여러 개일 때 같은 티켓이 둘 이상에 보일 수 있고(프리셋이 겹친다), 한쪽만
 * 갱신하면 나머지는 옛 상태를 계속 보여준다.
 *
 * `refresh-all`을 쓰지 않는 이유: 그쪽은 GitHub·Web 위젯까지 전부 다시 부른다.
 * 티켓 하나의 상태가 바뀐 것으로 보드 전체를 두들길 이유가 없다.
 */
export const JIRA_TRANSITIONED_EVENT = 'pegboard:jira-transitioned'

/** 전이 성공을 위젯들에게 알린다. 듣는 쪽은 `useJiraData`다. */
export function notifyTransitioned() {
  window.dispatchEvent(new CustomEvent(JIRA_TRANSITIONED_EVENT))
}

type CacheEntry = { transitions: JiraTransition[]; at: number }

/**
 * 티켓 키 → 전이 목록. **모듈 스코프**에 둔다.
 *
 * 위젯·컴포넌트 상태에 두면 팝오버를 닫을 때(언마운트) 같이 사라져서 TTL이
 * 의미를 잃는다. 같은 티켓을 목록에서 열고 상세 모달에서 또 열 때도 살아 있어야 한다.
 */
const cache = new Map<string, CacheEntry>()

/** 테스트에서 캐시를 비운다. 프로덕션 코드에서는 부르지 않는다. */
export function __clearTransitionCache() {
  cache.clear()
}

function readCache(issueKey: string, now: number): JiraTransition[] | null {
  const hit = cache.get(issueKey)
  if (!hit) return null
  if (now - hit.at > CACHE_TTL_MS) {
    cache.delete(issueKey)
    return null
  }
  return hit.transitions
}

/**
 * 배지 + 팝오버.
 *
 * 배지의 생김새는 호출하는 쪽이 정한다(`children`). 목록 행과 상세 모달의
 * 배지 크기가 다르고, 여기서 둘을 분기하면 이 파일이 두 화면의 사정을 알게 된다.
 */
export function StatusTransitionPopover({
  issueKey,
  browseUrl,
  disabled,
  children,
  onTransitioned,
}: {
  issueKey: string
  /** 이 티켓의 Jira 웹 URL. 연결이 없으면 null — 그때는 링크를 그리지 않는다. */
  browseUrl: string | null
  /** 연결이 없으면 배지가 평범한 배지로 남는다. 누를 것이 없다. */
  disabled?: boolean
  children: React.ReactNode
  /** 전이 성공. 호출하는 쪽이 목록을 다시 불러온다. */
  onTransitioned?: (() => void) | undefined
}) {
  const [open, setOpen] = useState(false)
  const anchorRef = useRef<HTMLButtonElement | null>(null)

  if (disabled) {
    // 배지를 버튼으로 만들지 않는다 — 눌러도 아무 일이 없는 버튼은
    // 사용자가 "고장났나" 하고 다시 누르게 만든다.
    return <>{children}</>
  }

  return (
    <>
      <button
        ref={anchorRef}
        type="button"
        // 행 전체 클릭은 이미 상세 모달을 연다(D1). 이게 없으면 배지를 누를 때
        // 팝오버와 모달이 동시에 열린다.
        onClick={(e) => {
          e.stopPropagation()
          setOpen((v) => !v)
        }}
        onKeyDown={(e) => {
          // Enter·Space가 행까지 번지면 상세 모달이 함께 열린다.
          if (e.key === 'Enter' || e.key === ' ') e.stopPropagation()
        }}
        aria-haspopup="menu"
        aria-expanded={open}
        // `title`은 마우스용, `aria-label`은 스크린 리더용이다. 배지 내용만으로는
        // ("할 일") 이것이 상태를 바꾸는 버튼이라는 사실이 읽히지 않는다.
        aria-label={`${issueKey} 상태 변경`}
        title={`${issueKey} 상태 변경`}
        className="max-w-full cursor-pointer rounded focus-visible:outline-2 focus-visible:outline-accent"
      >
        {children}
      </button>

      {open && (
        <TransitionMenu
          issueKey={issueKey}
          anchor={anchorRef.current}
          browseUrl={browseUrl}
          onClose={() => setOpen(false)}
          onTransitioned={onTransitioned}
        />
      )}
    </>
  )
}

/**
 * 팝오버 본체.
 *
 * **포털로 body에 붙인다.** 위젯 안에서 렌더하면 위젯의 `overflow-hidden`과
 * 목록의 스크롤 컨테이너에 잘려서 팝오버가 행 안에 갇힌다. `position: fixed`로도
 * 안 되는데, react-grid-layout이 조상에 `transform`을 걸어두면 fixed의 기준이
 * 뷰포트가 아니게 되기 때문이다 (`ui/Modal.tsx`에 같은 이유가 적혀 있다).
 *
 * 그래서 위치는 앵커의 화면 좌표를 **재서** 준다.
 */
function TransitionMenu({
  issueKey,
  anchor,
  browseUrl,
  onClose,
  onTransitioned,
}: {
  issueKey: string
  anchor: HTMLElement | null
  browseUrl: string | null
  onClose: () => void
  onTransitioned?: (() => void) | undefined
}) {
  const setJiraAuthFailed = useConnectionStore((s) => s.setJiraAuthFailed)

  // 캐시에 있으면 첫 렌더부터 목록이 그려진다 — 스켈레톤을 깜빡이지 않는다.
  const [transitions, setTransitions] = useState<JiraTransition[] | null>(() =>
    readCache(issueKey, Date.now()),
  )
  const [loadError, setLoadError] = useState<JiraCallError | null>(null)
  /** 실행 중인 전이 id. 그 줄만 잠그고 나머지는 살려둔다. */
  const [running, setRunning] = useState<string | null>(null)
  /** 전이 실패. **팝오버 안에 인라인으로** 남는다 — 어느 티켓이 실패했는지가 정보다. */
  const [runError, setRunError] = useState<JiraCallError | null>(null)

  const load = useCallback(async () => {
    setLoadError(null)
    const result = await commands.jiraTransitions(issueKey)
    if (result.status === 'ok') {
      cache.set(issueKey, { transitions: result.data, at: Date.now() })
      setTransitions(result.data)
    } else {
      setLoadError(result.error)
      if (result.error.isAuthFailure) setJiraAuthFailed(true)
    }
  }, [issueKey, setJiraAuthFailed])

  // 열린 그 순간 한 번. 캐시가 살아 있으면 네트워크를 건드리지 않는다.
  useEffect(() => {
    if (readCache(issueKey, Date.now())) return
    void load()
  }, [issueKey, load])

  const run = async (transition: JiraTransition) => {
    setRunning(transition.id)
    setRunError(null)
    const result = await commands.jiraTransition(issueKey, transition.id)
    setRunning(null)

    if (result.status === 'ok') {
      // 이 티켓의 전이 목록은 방금 낡았다. 지워서 다음에 열 때 다시 묻게 한다.
      cache.delete(issueKey)
      onClose()
      // **낙관적 업데이트를 하지 않는다.** 도달 상태는 알지만 워크플로우
      // 후처리(자동 담당자 변경 등)는 예측할 수 없다. 다시 조회하는 편이 정직하다.
      onTransitioned?.()
    } else {
      setRunError(result.error)
      if (result.error.isAuthFailure) setJiraAuthFailed(true)
    }
  }

  return (
    <PopoverSurface anchor={anchor} onClose={onClose} label={`${issueKey} 상태 변경`}>
      <p className="px-1 pb-1.5 text-caption text-text-quaternary">
        <span className="ticket-key text-text-tertiary">{issueKey}</span> 상태 변경
      </p>

      {loadError ? (
        <InlineError
          title="전이 목록을 불러오지 못했습니다."
          error={loadError}
          onRetry={loadError.kind === 'transient' ? () => void load() : undefined}
          browseUrl={browseUrl}
        />
      ) : transitions === null ? (
        <Skeleton />
      ) : transitions.length === 0 ? (
        // 빈 목록은 에러가 아니다. 권한이 없거나 워크플로우 끝단이다.
        <div className="space-y-2 px-1 py-1">
          <p className="text-body text-text-secondary">가능한 전이가 없습니다.</p>
          <p className="text-caption text-text-tertiary leading-relaxed-ko">
            이 티켓을 옮길 권한이 없거나, 워크플로우의 마지막 단계입니다.
          </p>
          <BrowseLink browseUrl={browseUrl} label="Jira에서 열기" />
        </div>
      ) : (
        <ul>
          {transitions.map((t) => (
            <li key={t.id}>
              <TransitionItem
                transition={t}
                busy={running === t.id}
                // 하나가 도는 중에는 나머지도 잠근다. 전이는 되돌릴 수 없으므로
                // 두 개가 겹쳐 나가는 경로를 아예 만들지 않는다.
                locked={running !== null && running !== t.id}
                browseUrl={browseUrl}
                onRun={() => void run(t)}
              />
            </li>
          ))}
        </ul>
      )}

      {/* 전이 실패는 전역 배너가 아니라 여기 남는다 (DESIGN.md 5.1 — 이 티켓만의 문제다) */}
      {runError && (
        <div className="pt-1">
          <InlineError title="상태를 바꾸지 못했습니다." error={runError} browseUrl={browseUrl} />
        </div>
      )}
    </PopoverSurface>
  )
}

/** 전이 한 줄. 필수 필드가 걸렸으면 실행 버튼이 아니라 브라우저 링크가 된다. */
function TransitionItem({
  transition,
  busy,
  locked,
  browseUrl,
  onRun,
}: {
  transition: JiraTransition
  busy: boolean
  locked: boolean
  browseUrl: string | null
  onRun: () => void
}) {
  // 도달 상태 이름을 우선한다. 사용자가 알고 싶은 것은 "누르면 무엇이 되는가"다.
  const label = transition.toStatusName ?? transition.name
  const category = transition.toStatusCategory ?? 'new'

  // 필수 필드가 걸린 전이 — 앱에서 실행할 수 없다.
  //
  // 폼을 만들지 않는 이유: 필드 타입별 렌더러(사용자 검색·날짜·다중 선택…)가
  // 다시 필요해져 생성 폼의 범위가 그대로 반복된다. 숨기지도 않는다 —
  // "왜 완료 버튼이 없지"는 조용한 실패다.
  if (transition.hasRequiredFields) {
    if (!browseUrl) {
      // 링크를 줄 수 없으면 사실만 말한다. 눌러도 안 되는 버튼을 주지 않는다.
      return (
        <p className="flex items-center gap-2 rounded px-1 py-1.5 text-body text-text-quaternary">
          <StatusDot category={category} />
          <span className="min-w-0 flex-1 truncate">{label}</span>
          <span className="shrink-0 text-caption">입력 필요</span>
        </p>
      )
    }
    return (
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation()
          void openUrl(browseUrl)
        }}
        title={`${label} — 입력해야 하는 항목이 있어 Jira에서 처리합니다`}
        className="flex w-full items-center gap-2 rounded px-1 py-1.5 text-left
                   transition-colors duration-fast hover:bg-surface-inset
                   focus-visible:outline-2 focus-visible:outline-accent"
      >
        <StatusDot category={category} />
        <span className="min-w-0 flex-1 truncate text-body text-text-secondary">{label}</span>
        {/* 무엇이 다른지 말한다. 아이콘만으로는 "왜 이 줄만 다르지"에 답이 안 된다. */}
        <span className="flex shrink-0 items-center gap-1 text-caption text-text-quaternary">
          입력 필요
          <ExternalLink size={11} aria-hidden="true" />
        </span>
      </button>
    )
  }

  return (
    <button
      type="button"
      disabled={busy || locked}
      onClick={(e) => {
        e.stopPropagation()
        onRun()
      }}
      title={transition.name === label ? `${label}으로 이동` : `${transition.name} → ${label}`}
      className="flex w-full items-center gap-2 rounded px-1 py-1.5 text-left
                 transition-colors duration-fast hover:bg-surface-inset
                 focus-visible:outline-2 focus-visible:outline-accent
                 disabled:cursor-default disabled:opacity-50 disabled:hover:bg-transparent"
    >
      <StatusDot category={category} />
      <span className="min-w-0 flex-1 truncate text-body text-text-primary">{label}</span>
      {busy && <span className="shrink-0 text-caption text-text-tertiary">이동 중…</span>}
    </button>
  )
}

/**
 * 도달 상태의 카테고리 점.
 *
 * 배지처럼 색 배경을 깔지 않는다 — 목록 여섯 줄이 전부 색 블록이면 원칙 1의
 * "색은 상태를 말할 때만"이 무의미해진다. 6px 점이면 카테고리는 충분히 읽힌다.
 */
function StatusDot({ category }: { category: string }) {
  return (
    <span
      aria-hidden="true"
      className="size-1.5 shrink-0 rounded-full"
      style={{ backgroundColor: statusColor(category) }}
    />
  )
}

/**
 * 로딩 자리. **빈 팝오버를 그리지 않는다** — 아무것도 없는 상자가 떴다가
 * 내용이 채워지면 위치가 튀고, 그 사이에 사용자는 "고장났나"를 겪는다.
 *
 * 펄스 애니메이션을 넣지 않는다 (DESIGN.md 9장). 목록은 200ms 안에 오고,
 * 그 사이 깜빡이는 것은 빠름을 알리는 게 아니라 요동으로 읽힌다.
 * 세 줄인 이유는 실측 전이 개수(5~7개)보다 적게 잡아 채워질 때 커지게
 * 하는 편이 줄어드는 것보다 덜 튀기 때문이다.
 */
function Skeleton() {
  return (
    <ul aria-hidden="true" className="space-y-0.5">
      {[52, 40, 46].map((w) => (
        <li key={w} className="flex items-center gap-2 px-1 py-1.5">
          <span className="size-1.5 shrink-0 rounded-full bg-border-default" />
          <span className="h-2.5 rounded-xs bg-border-subtle" style={{ width: `${w}%` }} />
        </li>
      ))}
    </ul>
  )
}

/**
 * 팝오버 안의 실패 표시.
 *
 * 일시적 실패에만 [다시 시도]를 준다. 영구적 실패(403 권한·404 없음)에
 * 재시도 버튼을 주면 몇 번을 눌러도 같은 결과인 버튼을 주는 셈이다.
 *
 * 전이 실패에는 재시도를 아예 주지 않는다 — 요청이 닿았는지 모르는 상태에서
 * 다시 보내면 워크플로우가 두 칸 움직일 수 있다. 팝오버를 닫고 새로고침해
 * 지금 상태를 확인하는 것이 옳은 다음 행동이다.
 */
function InlineError({
  title,
  error,
  onRetry,
  browseUrl,
}: {
  title: string
  error: JiraCallError
  onRetry?: (() => void) | undefined
  browseUrl: string | null
}) {
  return (
    <div className="space-y-1.5 rounded border border-danger-muted bg-danger-muted px-2 py-1.5">
      <p className="text-body text-text-primary">
        {error.isAuthFailure ? '인증에 실패했습니다. 설정에서 토큰을 다시 입력하세요.' : title}
      </p>
      {/* Jira 원문 그대로. 우리가 고쳐 쓰면 더 나빠진다 (DECISIONS 16장). */}
      <p className="text-caption text-text-secondary leading-relaxed-ko">{error.message}</p>
      <div className="flex flex-wrap items-center gap-2 pt-0.5">
        {onRetry && (
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation()
              onRetry()
            }}
            className="rounded border border-border-subtle bg-surface-raised px-1.5 py-0.5
                       text-caption text-text-primary hover:bg-surface-overlay
                       focus-visible:outline-2 focus-visible:outline-accent"
          >
            다시 시도
          </button>
        )}
        <BrowseLink browseUrl={browseUrl} label="Jira에서 처리" />
      </div>
    </div>
  )
}

function BrowseLink({ browseUrl, label }: { browseUrl: string | null; label: string }) {
  if (!browseUrl) return null
  return (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation()
        void openUrl(browseUrl)
      }}
      className="flex items-center gap-1 rounded text-caption text-text-tertiary
                 hover:text-accent hover:underline
                 focus-visible:outline-2 focus-visible:outline-accent"
    >
      <ExternalLink size={11} aria-hidden="true" />
      {label}
    </button>
  )
}

/**
 * 팝오버 표면 — 포털 + 위치 계산 + 바깥 클릭·ESC 닫기.
 *
 * 위치를 좌표로 계산하는 이유는 이 파일 위쪽 주석에 있다(포털이 필수다).
 * 화면 밖으로 나가면 접는다 — 목록의 마지막 행에서 아래로 열면 팝오버가
 * 창 밖으로 잘린다.
 */
function PopoverSurface({
  anchor,
  onClose,
  label,
  children,
}: {
  anchor: HTMLElement | null
  onClose: () => void
  label: string
  children: React.ReactNode
}) {
  const surfaceRef = useRef<HTMLDivElement | null>(null)
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null)

  // 좌표를 다시 잡는다.
  //
  // 내용이 바뀌면(스켈레톤 → 목록, 에러 추가) 높이가 달라지므로 다시 재야 한다.
  // 위로 뒤집힌 팝오버는 높이가 곧 위치라서, 안 다시 재면 앵커에서 떨어진다.
  // `children`을 의존성에 넣는 대신 ResizeObserver로 실제 크기 변화를 듣는다 —
  // 매 렌더 새로 만들어지는 JSX를 의존성에 두면 값 비교가 늘 실패한다.
  useEffect(() => {
    if (!anchor) return

    const place = () => {
      const a = anchor.getBoundingClientRect()
      const surface = surfaceRef.current
      const h = surface?.offsetHeight ?? 0
      const w = surface?.offsetWidth ?? MIN_WIDTH

      const GAP = 4
      // 아래에 자리가 없으면 위로 뒤집는다.
      const below = window.innerHeight - a.bottom
      const top = below < h + GAP && a.top > h + GAP ? a.top - h - GAP : a.bottom + GAP

      // 오른쪽으로 넘치면 왼쪽으로 당긴다. 창 왼쪽 밖으로는 나가지 않는다.
      const left = Math.max(GAP, Math.min(a.left, window.innerWidth - w - GAP))
      setPos({ top, left })
    }

    place()
    // 목록 스크롤·창 리사이즈에 따라간다. 스크롤 중에 팝오버가 행에서
    // 떨어져 남아 있으면 어느 티켓의 것인지 알 수 없게 된다.
    window.addEventListener('resize', place)
    window.addEventListener('scroll', place, true)
    // 내용이 채워져 높이가 바뀌면 다시 잡는다.
    //
    // 존재를 확인하고 쓴다 — jsdom(테스트 환경)에는 ResizeObserver가 없다.
    // 없으면 위치 보정만 한 번 덜 하는 것이고, 팝오버가 안 뜨는 것보다 낫다.
    const ro =
      typeof ResizeObserver === 'function' && surfaceRef.current ? new ResizeObserver(place) : null
    if (ro && surfaceRef.current) ro.observe(surfaceRef.current)
    return () => {
      window.removeEventListener('resize', place)
      window.removeEventListener('scroll', place, true)
      ro?.disconnect()
    }
  }, [anchor])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      // 상세 모달 위에서 열렸을 때 ESC가 모달까지 닫지 않게 막는다.
      // 한 번에 한 겹씩 닫히는 것이 예상대로다.
      e.stopPropagation()
      onClose()
    }
    const onDown = (e: MouseEvent) => {
      if (surfaceRef.current?.contains(e.target as Node)) return
      onClose()
    }
    // capture로 듣는다. 행의 onClick(상세 모달)보다 먼저 닫아야 한다.
    document.addEventListener('keydown', onKey, true)
    document.addEventListener('mousedown', onDown, true)
    return () => {
      document.removeEventListener('keydown', onKey, true)
      document.removeEventListener('mousedown', onDown, true)
    }
  }, [onClose])

  return createPortal(
    // 클릭이 행까지 번지지 않게 따로 막을 필요가 없다. 이 표면은 포털로
    // body에 붙어 있어서 React 이벤트가 목록 행을 조상으로 갖지 않는다.
    // (안에서 openUrl을 부르는 버튼들이 stopPropagation을 하는 것은 상세 모달
    //  위에서 열렸을 때를 위한 것이다.)
    <div
      ref={surfaceRef}
      role="menu"
      aria-label={label}
      className="fixed z-110 rounded-lg border border-border-subtle bg-surface-overlay
                 p-1.5 shadow-popover"
      style={{
        top: pos?.top ?? 0,
        left: pos?.left ?? 0,
        minWidth: MIN_WIDTH,
        maxWidth: 280,
        // 좌표를 재기 전에는 그리지 않는다. 안 그러면 (0,0)에 한 번 보인다.
        visibility: pos ? 'visible' : 'hidden',
      }}
    >
      {children}
    </div>,
    document.body,
  )
}

/** 3열 위젯(약 240px)보다 좁아지지 않게. 상태명이 잘리면 고를 수 없다. */
const MIN_WIDTH = 200

/** Jira가 보장하는 고정 키: `new` | `indeterminate` | `done` */
function statusColor(key: string): string {
  if (key === 'done') return 'var(--color-status-done)'
  if (key === 'indeterminate') return 'var(--color-status-progress)'
  return 'var(--color-status-todo)'
}
