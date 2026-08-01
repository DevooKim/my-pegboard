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
}: {
  item: TodoItem
  /** 경과일 계산 기준. 위젯이 보고 있는 날짜가 아니라 **오늘**이다. */
  today: DateKey
  onToggle: (done: boolean) => void
  onEdit: (text: string) => void
  onRemove: () => void
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
    <li className="group flex items-center gap-2 rounded px-1.5 py-1 hover:bg-surface-inset">
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
