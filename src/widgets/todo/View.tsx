import { ChevronLeft, ChevronRight, Plus } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { addDays, dateKey, itemsOn, parseDateKey, useTodoStore } from '#/store/todos'
import { useNow } from '#/ui/relativeTime'
import type { WidgetViewProps } from '#/widgets/types'
import type { TodoWidgetConfig } from './index'
import { TodoRow } from './TodoRow'

/**
 * Todo 위젯 본문.
 *
 * # 날짜 축
 *
 * `◀ 8월 1일 (오늘) ▶`. 과거·미래 모두 이동할 수 있고 편집도 된다.
 * 보고 있는 날짜는 **세션 상태**다 — 재시작하면 오늘로 돌아온다. board.json에
 * 저장하면 어제 만든 보드를 오늘 열었을 때 어제를 보고 있게 된다.
 *
 * # 이월은 이동이다
 *
 * 과거의 미완료 항목은 오늘로 **옮겨진다**(복사가 아니다). 그래서 과거 날짜를
 * 보면 대개 **그날 완료한 것만** 남아 있다 — 과거는 "그날의 계획"이 아니라
 * "그날 해낸 것"의 기록이다(DECISIONS 13이 받아들인 대가).
 */
export function TodoView({ config }: WidgetViewProps<TodoWidgetConfig, null>) {
  const items = useTodoStore((s) => s.items)
  const loaded = useTodoStore((s) => s.loaded)
  const error = useTodoStore((s) => s.error)
  const load = useTodoStore((s) => s.load)
  const checkCarryOver = useTodoStore((s) => s.checkCarryOver)

  // 1분마다 흐른다. 자정을 넘겼는지 판단하는 시계다 —
  // setTimeout은 macOS 잠자기에서 멈추므로 폴링으로 간다.
  const nowMs = useNow()
  const today = useMemo(() => dateKey(new Date(nowMs)), [nowMs])

  const [viewing, setViewing] = useState(() => dateKey())
  const [draft, setDraft] = useState('')
  /** 끌고 있는 항목 id와 지금 올라가 있는 대상 id. */
  const [dragId, setDragId] = useState<string | null>(null)
  const [overId, setOverId] = useState<string | null>(null)

  // 안전망: 드래그가 어떻게 끝나든 상태를 되돌린다.
  //
  // 끌리는 행은 h-0으로 접혀 화면에서 사라진다. onDragEnd가 오지 않는
  // 경우(창 밖에 놓기, 웹뷰가 이벤트를 삼키는 경우)에 dragId가 남으면
  // **그 항목이 영영 안 보인다.** 문서 수준에서 한 번 더 받아둔다.
  useEffect(() => {
    if (!dragId) return
    const reset = () => {
      setDragId(null)
      setOverId(null)
    }
    document.addEventListener('dragend', reset)
    document.addEventListener('drop', reset)
    return () => {
      document.removeEventListener('dragend', reset)
      document.removeEventListener('drop', reset)
    }
  }, [dragId])

  const isToday = viewing === today

  useEffect(() => {
    void load()
  }, [load])

  // 자정을 넘기면 보고 있던 날짜도 따라 넘긴다.
  //
  // **직전까지 오늘을 보고 있었을 때만** 옮긴다. 과거·미래를 들여다보는
  // 중이라면 사용자가 일부러 거기 있는 것이므로 화면을 빼앗지 않는다.
  //
  // 안 하면 어제 화면에 머문 채로 "(오늘)" 표시만 사라진다. 그 상태에서
  // 항목을 추가하면 **어제에 쌓이고**, isToday가 false라 이월도 계속 미뤄진다.
  const prevToday = useRef(today)
  useEffect(() => {
    const wasViewingToday = viewing === prevToday.current
    prevToday.current = today
    if (wasViewingToday && viewing !== today) setViewing(today)
  }, [today, viewing])

  // 이 설정이 생기기 전에 만든 위젯은 값이 없다(undefined). 그대로 두면
  // falsy라 이월이 조용히 꺼진다 — 기존 사용자가 "왜 안 넘어오지" 하게 된다.
  // 없으면 켬으로 본다.
  const autoCarry = config.autoCarryOver ?? true

  // 날짜가 바뀌면 이월. 과거를 보는 중이거나 자동 이월이 꺼져 있으면
  // 스토어가 알아서 건너뛴다.
  useEffect(() => {
    void checkCarryOver(isToday, autoCarry)
  }, [checkCarryOver, isToday, autoCarry])

  const dayItems = itemsOn(items, viewing)
  const undone = dayItems.filter((i) => !i.done)
  const done = dayItems.filter((i) => i.done)

  return (
    <div className="flex h-full flex-col">
      <DateHeader
        viewing={viewing}
        today={today}
        onMove={(delta) => setViewing((d) => addDays(d, delta))}
        onToday={() => setViewing(today)}
      />

      {error && (
        <p className="shrink-0 border-border-subtle border-b bg-danger-muted px-2 py-1 text-caption text-danger">
          {error}
        </p>
      )}

      <div className="min-h-0 flex-1 overflow-y-auto px-1.5 py-1">
        {!loaded ? (
          <Centered>불러오는 중…</Centered>
        ) : dayItems.length === 0 ? (
          <Centered>
            {isToday
              ? '할 일을 추가하세요'
              : viewing < today
                ? '이 날 완료한 항목이 없습니다'
                : '이 날 할 일이 없습니다'}
          </Centered>
        ) : (
          <>
            {/* 미완료만 끌 수 있다. 완료 항목은 구분선 아래에 있어서
                섞이면 "완료를 미완료 사이로" 같은 무의미한 이동이 된다. */}
            <ul>
              {undone.map((item) => (
                <TodoRowBound
                  key={item.id}
                  id={item.id}
                  today={today}
                  drag={{
                    onStart: () => setDragId(item.id),
                    onOver: () => setOverId(item.id),
                    onDrop: () => {
                      if (dragId && dragId !== item.id) {
                        // 대상 항목이 **그 날짜 목록 전체에서** 몇 번째인지.
                        // Rust가 기대하는 것은 날짜 안의 위치다.
                        const to = dayItems.findIndex((i) => i.id === item.id)
                        if (to >= 0) void useTodoStore.getState().reorder(dragId, to)
                      }
                      setDragId(null)
                      setOverId(null)
                    },
                    onEnd: () => {
                      setDragId(null)
                      setOverId(null)
                    },
                    dragging: dragId === item.id,
                    // 끌던 항목보다 아래에 있는 대상이면 선을 아래에 긋는다 —
                    // 놓았을 때 실제로 그 자리에 들어가기 때문이다.
                    //
                    // **원래 자리(자기 자신) 위에서도 선을 보여준다.** 안 그러면
                    // 제자리로 되돌리는 중에 표시가 사라져서 "여기 놓으면 어떻게
                    // 되는지" 알 수 없다. 그때는 위쪽에 긋는다 — 제자리 드롭은
                    // 아무 변화가 없으므로 방향을 따질 필요가 없다.
                    over:
                      overId === item.id && dragId !== null
                        ? dragId === item.id
                          ? 'above'
                          : undone.findIndex((i) => i.id === dragId) <
                              undone.findIndex((i) => i.id === item.id)
                            ? 'below'
                            : 'above'
                        : null,
                  }}
                />
              ))}
            </ul>

            {/* 완료 항목은 구분선 아래로 내린다 (DECISIONS 13 "목록 아래로").
                지우지 않는다 — 그날 해낸 것의 기록이다.
                개수 문구를 두지 않는 이유: 항목이 이미 보이므로 세어 말할 필요가 없다. */}
            {done.length > 0 && (
              <>
                {undone.length > 0 && <hr className="my-1.5 border-border-subtle" />}
                <ul>
                  {done.map((item) => (
                    <TodoRowBound key={item.id} id={item.id} today={today} />
                  ))}
                </ul>
              </>
            )}
          </>
        )}
      </div>

      <AddRow
        value={draft}
        onChange={setDraft}
        onSubmit={() => {
          const text = draft.trim()
          if (!text) return
          void useTodoStore.getState().add(text, viewing)
          setDraft('')
        }}
        placeholder={isToday ? '할 일 추가' : `${monthDay(viewing)}에 추가`}
      />
    </div>
  )
}

/**
 * 스토어에서 항목을 직접 집어 그린다.
 *
 * 부모가 item 객체를 내려주지 않는 이유: 목록 배열이 매번 새로 만들어져서
 * 항목 하나가 바뀌어도 전부 리렌더된다. id로 구독하면 바뀐 행만 다시 그린다.
 */
function TodoRowBound({
  id,
  today,
  drag,
}: {
  id: string
  today: string
  drag?: React.ComponentProps<typeof TodoRow>['drag']
}) {
  const item = useTodoStore((s) => s.items.find((i) => i.id === id))
  if (!item) return null

  return (
    <TodoRow
      item={item}
      today={today}
      // exactOptionalPropertyTypes가 켜져 있어 undefined를 명시로 넘기면 안 된다.
      {...(drag ? { drag } : {})}
      onToggle={(done) => void useTodoStore.getState().setDone(id, done)}
      onEdit={(text) => void useTodoStore.getState().setText(id, text)}
      onRemove={() => void useTodoStore.getState().remove(id)}
    />
  )
}

function DateHeader({
  viewing,
  today,
  onMove,
  onToday,
}: {
  viewing: string
  today: string
  onMove: (delta: number) => void
  onToday: () => void
}) {
  const isToday = viewing === today
  return (
    <div className="flex shrink-0 items-center gap-1 border-border-subtle border-b px-1.5 py-1">
      <NavButton onClick={() => onMove(-1)} label="이전 날">
        <ChevronLeft size={13} />
      </NavButton>

      <button
        type="button"
        onClick={onToday}
        disabled={isToday}
        title={isToday ? undefined : '오늘로'}
        className="min-w-0 flex-1 truncate rounded px-1 text-caption text-text-secondary
                   enabled:hover:bg-surface-inset enabled:hover:text-text-primary
                   focus-visible:outline-2 focus-visible:outline-accent"
      >
        {monthDay(viewing)}
        {isToday && <span className="text-text-quaternary"> (오늘)</span>}
      </button>

      <NavButton onClick={() => onMove(1)} label="다음 날">
        <ChevronRight size={13} />
      </NavButton>
    </div>
  )
}

function NavButton({
  onClick,
  label,
  children,
}: {
  onClick: () => void
  label: string
  children: React.ReactNode
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={label}
      aria-label={label}
      className="shrink-0 rounded p-0.5 text-text-tertiary hover:bg-surface-inset
                 hover:text-text-primary focus-visible:outline-2 focus-visible:outline-accent"
    >
      {children}
    </button>
  )
}

function AddRow({
  value,
  onChange,
  onSubmit,
  placeholder,
}: {
  value: string
  onChange: (v: string) => void
  onSubmit: () => void
  placeholder: string
}) {
  return (
    <div className="flex shrink-0 items-center gap-1.5 border-border-subtle border-t px-2 py-1.5">
      <Plus size={12} className="shrink-0 text-text-quaternary" aria-hidden="true" />
      <input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') onSubmit()
        }}
        placeholder={placeholder}
        aria-label={placeholder}
        className="min-w-0 flex-1 bg-transparent text-body text-text-primary
                   placeholder:text-text-quaternary focus-visible:outline-none"
      />
    </div>
  )
}

function Centered({ children }: { children: React.ReactNode }) {
  return (
    <div className="grid h-full place-items-center px-3 text-center text-caption text-text-tertiary">
      {children}
    </div>
  )
}

/** `8월 1일 (금)` */
function monthDay(key: string): string {
  return parseDateKey(key).toLocaleDateString('ko-KR', {
    month: 'long',
    day: 'numeric',
    weekday: 'short',
  })
}
