import { ChevronLeft, ChevronRight, Plus } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
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

  const isToday = viewing === today

  useEffect(() => {
    void load()
  }, [load])

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
            <ul>
              {undone.map((item) => (
                <TodoRowBound key={item.id} id={item.id} today={today} />
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
function TodoRowBound({ id, today }: { id: string; today: string }) {
  const item = useTodoStore((s) => s.items.find((i) => i.id === id))
  if (!item) return null

  return (
    <TodoRow
      item={item}
      today={today}
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
