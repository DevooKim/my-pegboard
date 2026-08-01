import { RotateCw, X } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import type { TodoItem } from '#/ipc/bindings'
import { type DateKey, daysSinceOrigin } from '#/store/todos'

/** DECISIONS 13 — `carriedCount >= 7`이면 "이거 정말 할 건가요?" 힌트. */
const ZOMBIE_THRESHOLD = 7

/**
 * 할 일 한 줄.
 *
 * 체크·삭제는 즉시 저장되고(스토어 경유), 텍스트만 Enter/blur에서 저장한다 —
 * 글자마다 디스크를 때리지 않기 위해서다.
 */
export function TodoRow({
  item,
  today,
  onToggle,
  onEdit,
  onRemove,
  drag,
}: {
  item: TodoItem
  /** 경과일 계산 기준. 위젯이 보고 있는 날짜가 아니라 **오늘**이다. */
  today: DateKey
  onToggle: (done: boolean) => void
  onEdit: (text: string) => void
  onRemove: () => void
  /** 순서 변경. 없으면 이 행은 끌 수 없다. */
  drag?: {
    onStart: () => void
    onOver: () => void
    onDrop: () => void
    onEnd: () => void
    /** 지금 끌려가는 중인가 — 흐리게 그린다. */
    dragging: boolean
    /**
     * 이 행이 지금 드롭 대상인가. `'above'`면 위에, `'below'`면 아래에 선을 긋는다.
     *
     * 방향을 나누는 이유: 위로 끌 때와 아래로 끌 때 놓이는 자리가 다른데
     * 선이 늘 위에만 뜨면 아래로 끌 때 한 칸 어긋나 보인다.
     */
    over: 'above' | 'below' | null
  }
}) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(item.text)
  const inputRef = useRef<HTMLInputElement | null>(null)

  useEffect(() => {
    if (editing) inputRef.current?.select()
  }, [editing])

  // 바깥에서 값이 바뀌면(되돌리기 등) 편집 중이 아닐 때만 따라간다.
  useEffect(() => {
    if (!editing) setDraft(item.text)
  }, [item.text, editing])

  const commit = () => {
    setEditing(false)
    const next = draft.trim()
    if (next && next !== item.text) onEdit(next)
    else setDraft(item.text)
  }

  return (
    // 행 전체를 draggable로 둔다. 전용 손잡이(⠿)를 두지 않는 이유: 폭이
    // 2열까지 좁아질 수 있어(minLayout) 손잡이가 텍스트를 밀어낸다.
    //
    // 편집 중에는 끌 수 없게 한다 — 텍스트를 드래그로 선택하려는 동작과
    // 행 이동이 충돌한다.
    //
    // `relative`는 드롭 표시선을 행 **경계에 띄우기** 위한 기준이다.
    // 선을 행의 border로 그리면 py-1 안쪽에 붙어 텍스트에 바짝 닿고,
    // 완료 구분선과 위치가 겹쳐 어느 것이 드롭 표시인지 알 수 없다.
    <li
      draggable={!!drag && !editing}
      onDragStart={(e) => {
        // Firefox는 dataTransfer가 비면 드래그를 시작하지 않는다.
        e.dataTransfer.setData('text/plain', item.id)
        e.dataTransfer.effectAllowed = 'move'
        drag?.onStart()
      }}
      onDragOver={(e) => {
        if (!drag) return
        // preventDefault를 해야 drop이 허용된다.
        e.preventDefault()
        e.dataTransfer.dropEffect = 'move'
        drag.onOver()
      }}
      onDrop={(e) => {
        e.preventDefault()
        drag?.onDrop()
      }}
      onDragEnd={() => drag?.onEnd()}
      className={`group relative flex items-center gap-2 rounded px-1.5
                  transition-[opacity,height,padding] duration-fast
                  ${drag ? 'cursor-grab active:cursor-grabbing' : ''}
                  ${
                    drag?.dragging
                      ? // 끌리는 동안 **자리를 비운다.** 흐리게만 하면 원본이 그대로
                        // 남아 있어, 커서를 따라다니는 OS 드래그 이미지와 겹쳐
                        // 같은 항목이 둘로 보인다.
                        'pointer-events-none h-0 overflow-hidden py-0 opacity-0'
                      : 'py-1 hover:bg-surface-inset'
                  }`}
    >
      {/* 드롭 표시선. 행 경계에 걸쳐 띄운다 — 좌우를 조금 들여 목록의
          구분선(완료 항목 위)과 성격이 다르다는 것이 보이게 한다. */}
      {drag?.over && (
        <span
          aria-hidden="true"
          className={`pointer-events-none absolute inset-x-1 h-0.5 rounded-full bg-accent
                      ${drag.over === 'above' ? '-top-px' : '-bottom-px'}`}
        />
      )}

      <input
        type="checkbox"
        checked={item.done}
        onChange={(e) => onToggle(e.target.checked)}
        aria-label={item.text}
        className="shrink-0 accent-accent"
      />

      <CarriedBadge item={item} today={today} />

      {editing ? (
        <input
          ref={inputRef}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === 'Enter') commit()
            if (e.key === 'Escape') {
              setDraft(item.text)
              setEditing(false)
            }
          }}
          className="min-w-0 flex-1 rounded border border-border-subtle bg-surface-inset px-1
                     text-body text-text-primary focus-visible:outline-2 focus-visible:outline-accent"
        />
      ) : (
        // 완료 항목은 취소선 + 흐리게 (DECISIONS 13).
        <button
          type="button"
          // 버튼은 WebKit에서 기본적으로 draggable이라 행의 드래그를 가로챈다.
          // 이 버튼이 flex-1로 행의 대부분을 덮고 있어서, 끄지 않으면 사실상
          // 드래그가 아예 시작되지 않는다.
          draggable={false}
          onClick={() => setEditing(true)}
          title="클릭해서 수정"
          className={`min-w-0 flex-1 truncate rounded text-left text-body
                      focus-visible:outline-2 focus-visible:outline-accent
                      ${item.done ? 'text-text-quaternary line-through' : 'text-text-primary'}`}
        >
          {item.text}
        </button>
      )}

      <button
        type="button"
        draggable={false}
        onClick={onRemove}
        title="삭제"
        aria-label={`${item.text} 삭제`}
        className="shrink-0 rounded p-0.5 text-text-quaternary opacity-0 transition-opacity
                   duration-fast hover:text-danger focus-visible:opacity-100
                   focus-visible:outline-2 focus-visible:outline-accent group-hover:opacity-100"
      >
        <X size={12} />
      </button>
    </li>
  )
}

/**
 * `↻ N일째` 배지.
 *
 * 숫자는 **경과일**(`originDate` 기준)이고 색은 **이월 횟수**(`carriedCount`)로
 * 정한다. 둘은 다른 것을 잰다 — 주말을 건너뛰면 3일이 지나도 미룬 횟수는 1이다.
 * 미루는 것을 압박하는 게 목적이므로 색은 횟수를 따른다.
 */
function CarriedBadge({ item, today }: { item: TodoItem; today: DateKey }) {
  if (item.carriedCount === 0) return null

  const days = daysSinceOrigin(item, today)
  const zombie = item.carriedCount >= ZOMBIE_THRESHOLD

  // 횟수가 늘수록 진해진다 (DECISIONS 13).
  const tone = zombie
    ? 'text-danger'
    : item.carriedCount >= 3
      ? 'text-warning'
      : 'text-text-tertiary'

  return (
    <span
      className={`flex shrink-0 items-center gap-0.5 text-caption tabular-nums ${tone}`}
      title={
        zombie
          ? `${days}일째 미루고 있습니다 (${item.carriedCount}번 이월) — 이거 정말 할 건가요?`
          : `${days}일째 (${item.carriedCount}번 이월)`
      }
    >
      <RotateCw size={10} aria-hidden="true" />
      {days}일째
    </span>
  )
}
