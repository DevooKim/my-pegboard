import { openUrl } from '@tauri-apps/plugin-opener'
import { ExternalLink } from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { commands, type LinearCallError, type LinearWorkflowState } from '#/ipc/bindings'
import { useConnectionStore } from '#/store/connection'

/**
 * 상태 배지를 눌러 이슈 상태를 바꾸는 팝오버 (DECISIONS 25.5).
 *
 * 목록 행(`IssueRow`)과 상세 모달(`IssueDetailModal`)이 **이 파일 하나를 같이 쓴다.**
 * 두 곳에 같은 UI를 두면 한쪽만 고치는 일이 반드시 생긴다.
 *
 * # ★ Jira와 모델이 다르다
 *
 * | | Jira | Linear |
 * |---|---|---|
 * | 무엇을 받나 | **그 티켓에서 지금 갈 수 있는 전이** | **그 팀의 상태 목록 전부** |
 * | 조회 단위 | 이슈 | **팀** |
 * | 실행 | `transition(id)` | `issueUpdate(id, { stateId })` |
 * | 필수 필드 | 걸릴 수 있다 → 브라우저로 | **없다** |
 *
 * 마지막 줄이 중요하다. Jira 11.5가 크게 다룬 "필수 필드가 걸린 전이"
 * 문제가 **여기서는 발생하지 않는다** — `stateId` 하나만 보내면 되기 때문이다.
 * 그래서 "입력 필요 → 브라우저" 경로가 이 파일에 없다.
 *
 * 조회가 **팀 단위**라는 것도 다르다. 목록 30건이 같은 팀이면 상태 목록은
 * 하나이므로 캐시를 팀 id로 나눈다 — 이슈별로 나누면 같은 것을 30번 받는다.
 *
 * # 왜 2단 클릭인가
 *
 * 배지 → 팝오버 → 상태 항목. 배지 한 번으로 상태가 바뀌지 않는다.
 * **되돌리기가 없는 조작**이라 이 한 겹이 필요하다. 목록을 훑다 잘못 누르면
 * 이슈 상태가 팀 전체에 잘못 알려지고, 우리에겐 취소 버튼이 없다.
 *
 * # 왜 열 때 조회하는가 (lazy)
 *
 * 행마다 미리 조회하면 이슈 30건에 요청이 붙는다 — 그중 사용자가 실제로 여는
 * 것은 하나다. 배지를 누른 그 순간에 (팀별로) 한 번 조회한다.
 *
 * # 캐시는 메모리 30초뿐
 *
 * 디스크에 캐시하지 않는다. 팀의 상태 목록은 거의 안 바뀌지만, 바뀌었을 때
 * 없는 상태를 보여주면 `issueUpdate`가 실패한다. 30초 캐시는 팝오버를 연달아
 * 여닫을 때와 **같은 팀의 이슈 여럿을 옮길 때**의 중복 호출을 막는다.
 */

/** 상태 목록 메모리 캐시 TTL. 디스크에는 절대 쓰지 않는다. */
const CACHE_TTL_MS = 30_000

/**
 * 상태 변경 성공을 알리는 이벤트.
 *
 * `pegboard:jira-transitioned`와 같은 방식이다. **전역인 이유:** 보드에 Linear
 * 위젯이 여러 개일 때 같은 이슈가 둘 이상에 보일 수 있고(프리셋이 겹친다),
 * 한쪽만 갱신하면 나머지는 옛 상태를 계속 보여준다.
 *
 * `refresh-all`을 쓰지 않는 이유: 그쪽은 Jira·GitHub·Web 위젯까지 전부 다시
 * 부른다. 이슈 하나의 상태가 바뀐 것으로 보드 전체를 두들길 이유가 없다.
 */
export const LINEAR_STATE_CHANGED_EVENT = 'pegboard:linear-state-changed'

/** 상태 변경 성공을 위젯들에게 알린다. 듣는 쪽은 `useLinearData`다. */
export function notifyStateChanged() {
  window.dispatchEvent(new CustomEvent(LINEAR_STATE_CHANGED_EVENT))
}

type CacheEntry = { states: LinearWorkflowState[]; at: number }

/**
 * **팀 id** → 상태 목록. 모듈 스코프에 둔다.
 *
 * 컴포넌트 상태에 두면 팝오버를 닫을 때(언마운트) 같이 사라져서 TTL이 의미를
 * 잃는다. 같은 팀의 이슈를 목록에서 열고 상세 모달에서 또 열 때도 살아 있어야 한다.
 *
 * **키가 이슈가 아니라 팀이다.** Jira는 이슈별로 전이가 달라 이슈 키를 썼지만,
 * Linear는 팀이 상태를 소유한다 — 이슈별로 나누면 같은 목록을 30번 받는다.
 */
const cache = new Map<string, CacheEntry>()

/** 테스트에서 캐시를 비운다. 프로덕션 코드에서는 부르지 않는다. */
export function __clearStateCache() {
  cache.clear()
}

function readCache(teamId: string, now: number): LinearWorkflowState[] | null {
  const hit = cache.get(teamId)
  if (!hit) return null
  if (now - hit.at > CACHE_TTL_MS) {
    cache.delete(teamId)
    return null
  }
  return hit.states
}

/**
 * 배지 + 팝오버.
 *
 * 배지의 생김새는 호출하는 쪽이 정한다(`children`). 목록 행과 상세 모달의
 * 배지 크기가 다르고, 여기서 둘을 분기하면 이 파일이 두 화면의 사정을 알게 된다.
 */
export function StatePopover({
  issueId,
  identifier,
  teamId,
  currentStateId,
  issueUrl,
  disabled,
  children,
  onChanged,
}: {
  /** Linear 내부 UUID. `issueUpdate(id:)`가 받는 값이다. */
  issueId: string
  /** `ENG-123`. 사람이 읽는 식별자 — 팝오버 제목과 접근성 이름에 쓴다. */
  identifier: string
  /** 이 이슈의 팀. **상태 목록의 조회 단위이자 캐시 키다.** */
  teamId: string
  /** 지금 상태. 목록에서 현재 항목을 표시하는 데 쓴다. */
  currentStateId: string
  /** Linear 웹 URL. 실패했을 때 나갈 길. */
  issueUrl: string
  /** 연결이 없으면 배지가 평범한 배지로 남는다. 누를 것이 없다. */
  disabled?: boolean
  children: React.ReactNode
  /** 상태 변경 성공. 호출하는 쪽이 목록을 다시 불러온다. */
  onChanged?: (() => void) | undefined
}) {
  const [open, setOpen] = useState(false)
  const anchorRef = useRef<HTMLButtonElement | null>(null)

  // 팀을 모르면 상태 목록을 조회할 수 없다. 응답이 이상해 team.id가 빈
  // 경우인데, **눌러도 아무 일이 없는 버튼을 주지 않는다.**
  if (disabled || teamId === '') {
    return <>{children}</>
  }

  return (
    <>
      <button
        ref={anchorRef}
        type="button"
        // 행 전체 클릭은 이미 상세 모달을 연다. 이게 없으면 배지를 누를 때
        // 팝오버와 모달이 동시에 열린다 (Jira에서 같은 함정을 밟았다).
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
        // ("Todo") 이것이 상태를 바꾸는 버튼이라는 사실이 읽히지 않는다.
        aria-label={`${identifier} 상태 변경`}
        title={`${identifier} 상태 변경`}
        className="max-w-full cursor-pointer rounded focus-visible:outline-2 focus-visible:outline-accent"
      >
        {children}
      </button>

      {open && (
        <StateMenu
          issueId={issueId}
          identifier={identifier}
          teamId={teamId}
          currentStateId={currentStateId}
          issueUrl={issueUrl}
          anchor={anchorRef.current}
          onClose={() => setOpen(false)}
          onChanged={onChanged}
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
function StateMenu({
  issueId,
  identifier,
  teamId,
  currentStateId,
  issueUrl,
  anchor,
  onClose,
  onChanged,
}: {
  issueId: string
  identifier: string
  teamId: string
  currentStateId: string
  issueUrl: string
  anchor: HTMLElement | null
  onClose: () => void
  onChanged?: (() => void) | undefined
}) {
  const setLinearAuthFailed = useConnectionStore((s) => s.setLinearAuthFailed)

  // 캐시에 있으면 첫 렌더부터 목록이 그려진다 — 스켈레톤을 깜빡이지 않는다.
  const [states, setStates] = useState<LinearWorkflowState[] | null>(() =>
    readCache(teamId, Date.now()),
  )
  const [loadError, setLoadError] = useState<LinearCallError | null>(null)
  /** 실행 중인 상태 id. 그 줄만 잠그고 나머지는 살려둔다. */
  const [running, setRunning] = useState<string | null>(null)
  /** 변경 실패. **팝오버 안에 인라인으로** 남는다 — 어느 이슈가 실패했는지가 정보다. */
  const [runError, setRunError] = useState<LinearCallError | null>(null)

  const load = useCallback(async () => {
    setLoadError(null)
    const result = await commands.linearTeamStates(teamId)
    if (result.status === 'ok') {
      cache.set(teamId, { states: result.data, at: Date.now() })
      setStates(result.data)
    } else {
      setLoadError(result.error)
      if (result.error.isAuthFailure) setLinearAuthFailed(true)
    }
  }, [teamId, setLinearAuthFailed])

  // 열린 그 순간 한 번. 캐시가 살아 있으면 네트워크를 건드리지 않는다.
  useEffect(() => {
    if (readCache(teamId, Date.now())) return
    void load()
  }, [teamId, load])

  const run = async (state: LinearWorkflowState) => {
    setRunning(state.id)
    setRunError(null)
    const result = await commands.linearSetState(issueId, state.id)
    setRunning(null)

    if (result.status === 'ok') {
      // 팀의 상태 목록은 방금 낡지 않았다 — 우리가 바꾼 것은 이슈다.
      // 그래서 캐시를 지우지 않는다 (Jira는 전이 가능성이 상태에 딸려 있어
      // 지웠지만, 여기서 캐시는 팀 소유다).
      onClose()
      // **낙관적 업데이트를 하지 않는다.** Linear의 자동화를 예측할 수 없다.
      onChanged?.()
    } else {
      setRunError(result.error)
      if (result.error.isAuthFailure) setLinearAuthFailed(true)
    }
  }

  return (
    <PopoverSurface anchor={anchor} onClose={onClose} label={`${identifier} 상태 변경`}>
      <p className="px-1 pb-1.5 text-caption text-text-quaternary">
        <span className="ticket-key text-text-tertiary">{identifier}</span> 상태 변경
      </p>

      {loadError ? (
        <InlineError
          title="상태 목록을 불러오지 못했습니다."
          error={loadError}
          onRetry={loadError.kind === 'transient' ? () => void load() : undefined}
          issueUrl={issueUrl}
        />
      ) : states === null ? (
        <Skeleton />
      ) : states.length === 0 ? (
        // 빈 목록은 에러가 아니다. 팀에 상태가 없는 구성은 없지만,
        // 볼 권한이 없으면 그렇게 보일 수 있다.
        <div className="space-y-2 px-1 py-1">
          <p className="text-body text-text-secondary">고를 수 있는 상태가 없습니다.</p>
          <p className="text-caption text-text-tertiary leading-relaxed-ko">
            이 팀의 워크플로우를 볼 권한이 없을 수 있습니다.
          </p>
          <BrowseLink issueUrl={issueUrl} label="Linear에서 열기" />
        </div>
      ) : (
        <ul>
          {states.map((s) => (
            <li key={s.id}>
              <StateItem
                state={s}
                current={s.id === currentStateId}
                busy={running === s.id}
                // 하나가 도는 중에는 나머지도 잠근다. 되돌릴 수 없는 조작이므로
                // 두 개가 겹쳐 나가는 경로를 아예 만들지 않는다.
                locked={running !== null && running !== s.id}
                onRun={() => void run(s)}
              />
            </li>
          ))}
        </ul>
      )}

      {/* 변경 실패는 전역 배너가 아니라 여기 남는다 (DESIGN.md 5.1 — 이 이슈만의 문제다) */}
      {runError && (
        <div className="pt-1">
          <InlineError title="상태를 바꾸지 못했습니다." error={runError} issueUrl={issueUrl} />
        </div>
      )}
    </PopoverSurface>
  )
}

/**
 * 상태 한 줄.
 *
 * Jira와 달리 **"입력 필요 → 브라우저" 갈래가 없다.** `stateId`만 보내면 되므로
 * 앱에서 못 하는 상태 변경이 존재하지 않는다 (DECISIONS 25.5).
 *
 * 지금 상태에는 체크 표시를 두고 누를 수 없게 한다. 같은 상태로 옮기는 것은
 * 아무 일도 아닌데 성공으로 보고되면 "뭐가 바뀐 거지"가 된다.
 */
function StateItem({
  state,
  current,
  busy,
  locked,
  onRun,
}: {
  state: LinearWorkflowState
  current: boolean
  busy: boolean
  locked: boolean
  onRun: () => void
}) {
  if (current) {
    return (
      <p className="flex items-center gap-2 rounded px-1 py-1.5 text-body text-text-quaternary">
        <StateDot color={state.color} />
        <span className="min-w-0 flex-1 truncate">{state.name}</span>
        <span className="shrink-0 text-caption">현재</span>
      </p>
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
      title={`${state.name}으로 이동`}
      className="flex w-full items-center gap-2 rounded px-1 py-1.5 text-left
                 transition-colors duration-fast hover:bg-surface-inset
                 focus-visible:outline-2 focus-visible:outline-accent
                 disabled:cursor-default disabled:opacity-50 disabled:hover:bg-transparent"
    >
      <StateDot color={state.color} />
      <span className="min-w-0 flex-1 truncate text-body text-text-primary">{state.name}</span>
      {busy && <span className="shrink-0 text-caption text-text-tertiary">이동 중…</span>}
    </button>
  )
}

/**
 * 상태 색 점.
 *
 * 배지처럼 색 배경을 깔지 않는다 — 목록 여섯 줄이 전부 색 블록이면 DESIGN
 * 원칙 1의 "색은 상태를 말할 때만"이 무의미해진다. 6px 점이면 충분히 읽힌다.
 *
 * 색은 **Linear가 준 값**이다. Jira처럼 카테고리로 매핑하지 않는 이유는
 * `WorkflowState.type`의 값을 실측하지 못했기 때문이다 (DECISIONS 25.3).
 * 덕분에 Linear 웹에서 보던 색과 같아진다는 이점도 있다.
 */
function StateDot({ color }: { color: string }) {
  return (
    <span
      aria-hidden="true"
      className="size-1.5 shrink-0 rounded-full"
      style={{ backgroundColor: color }}
    />
  )
}

/**
 * 로딩 자리. **빈 팝오버를 그리지 않는다** — 아무것도 없는 상자가 떴다가
 * 내용이 채워지면 위치가 튀고, 그 사이에 사용자는 "고장났나"를 겪는다.
 *
 * 펄스 애니메이션을 넣지 않는다 (DESIGN.md 9장).
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
 * **상태 변경 실패에는 재시도를 주지 않는다** — 요청이 닿았는지 모르는 상태에서
 * 다시 보내면 그 사이 사람이 바꾼 값을 덮을 수 있다. 팝오버를 닫고 새로고침해
 * 지금 상태를 확인하는 것이 옳은 다음 행동이다.
 */
function InlineError({
  title,
  error,
  onRetry,
  issueUrl,
}: {
  title: string
  error: LinearCallError
  onRetry?: (() => void) | undefined
  issueUrl: string
}) {
  return (
    <div className="space-y-1.5 rounded border border-danger-muted bg-danger-muted px-2 py-1.5">
      <p className="text-body text-text-primary">
        {error.isAuthFailure ? '인증에 실패했습니다. 설정에서 API 키를 다시 입력하세요.' : title}
      </p>
      {/* Linear 원문 그대로. 우리가 고쳐 쓰면 더 나빠진다 (DECISIONS 16장). */}
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
        <BrowseLink issueUrl={issueUrl} label="Linear에서 처리" />
      </div>
    </div>
  )
}

function BrowseLink({ issueUrl, label }: { issueUrl: string; label: string }) {
  if (!issueUrl) return null
  return (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation()
        void openUrl(issueUrl)
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
    // 떨어져 남아 있으면 어느 이슈의 것인지 알 수 없게 된다.
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
