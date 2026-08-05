import { Plus, X } from 'lucide-react'
import { useRef, useState } from 'react'
import { useBoardStore } from '#/store/board'
import { ConfirmDialog } from '#/ui/ConfirmDialog'

/**
 * 보드 탭 바 (DECISIONS 14장 개정).
 *
 * **타이틀바 안에 산다.** 보드 영역을 한 픽셀도 쓰지 않는다 — 대시보드의
 * 가치는 화면 면적이고, 탭 바를 위젯 위에 한 줄 얹으면 매일 그만큼을 낸다.
 * 타이틀바(h-9)는 창을 끌기 위해 어차피 비어 있던 공간이다.
 *
 * **탭이 1개면 아무것도 그리지 않는다.** 14장이 탭을 거부한 이유가
 * "쓰지 않는 것이 화면을 차지한다"였는데, 보드가 하나인 사람에게 탭 바를
 * 보여주면 그 우려가 그대로 실현된다. 보드를 만들면 나타난다.
 *
 * 그러면 첫 보드를 만들 길이 사라지므로, 탭이 1개일 때는 App.tsx의
 * `AddBoardButton`이 그 역할을 한다. 여기 ✚는 2개 이상일 때만 보인다.
 *
 * 각 탭은 **자기 위젯 수를 말한다.** 14장의 남은 경고("탭 뒤에 숨은 위젯은
 * 잊힌다")를 완화하는 유일한 장치다. 에러/갱신 상태 배지는 만들지 않았다 —
 * 비활성 보드는 렌더되지 않아 폴링하지 않으므로 에러 상태를 알 수 없고,
 * 모르는 것을 표시하면 거짓말이 된다. 위젯 수는 보드 데이터만으로 정확히
 * 아는 유일한 정보다.
 */
export function BoardTabs() {
  const boards = useBoardStore((s) => s.boards)
  const activeBoardId = useBoardStore((s) => s.activeBoardId)
  const setActiveBoard = useBoardStore((s) => s.setActiveBoard)
  const renameBoard = useBoardStore((s) => s.renameBoard)
  const removeBoard = useBoardStore((s) => s.removeBoard)
  const moveBoard = useBoardStore((s) => s.moveBoard)
  const addBoard = useBoardStore((s) => s.addBoard)

  const [editingId, setEditingId] = useState<string | null>(null)
  const [pendingDeleteId, setPendingDeleteId] = useState<string | null>(null)
  const tablistRef = useRef<HTMLDivElement | null>(null)

  // 탭이 하나면 탭 바 자체가 없다. 위 주석 참조.
  if (boards.length <= 1) return null

  const pendingDelete = boards.find((b) => b.id === pendingDeleteId) ?? null

  // ← → 로 탭 이동. tablist 관례이고, 화살표는 앱의 다른 곳에서 쓰지 않는다.
  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return
    e.preventDefault()
    const index = boards.findIndex((b) => b.id === activeBoardId)
    if (index < 0) return
    const step = e.key === 'ArrowLeft' ? -1 : 1
    const next = boards[(index + step + boards.length) % boards.length]
    if (!next) return
    setActiveBoard(next.id)
    // 포커스도 따라가야 한다 — 안 그러면 다음 화살표가 옛 탭에서 출발한다.
    requestAnimationFrame(() => {
      tablistRef.current?.querySelector<HTMLElement>(`[data-board-id="${next.id}"]`)?.focus()
    })
  }

  return (
    <>
      <div
        ref={tablistRef}
        role="tablist"
        aria-label="보드"
        aria-orientation="horizontal"
        onKeyDown={onKeyDown}
        className="flex min-w-0 items-center gap-0.5"
      >
        {boards.map((board, index) => {
          const active = board.id === activeBoardId
          const editing = board.id === editingId
          return (
            <div key={board.id} className="flex min-w-0 shrink items-center">
              {editing ? (
                <input
                  // biome-ignore lint/a11y/noAutofocus: 더블클릭으로 편집을 시작했으니 바로 타이핑할 수 있어야 한다
                  autoFocus
                  aria-label="보드 이름"
                  defaultValue={board.name}
                  onBlur={(e) => {
                    // 빈 이름은 거부하고 이전 이름을 그대로 둔다. renameBoard가
                    // ok:false를 주면 상태를 안 건드리므로 여기서 되돌릴 것이 없다.
                    renameBoard(board.id, e.currentTarget.value)
                    setEditingId(null)
                  }}
                  onKeyDown={(e) => {
                    e.stopPropagation() // 화살표가 탭 이동으로 새지 않게
                    if (e.key === 'Enter') e.currentTarget.blur()
                    if (e.key === 'Escape') {
                      e.currentTarget.value = board.name // 되돌린 뒤 blur
                      e.currentTarget.blur()
                    }
                  }}
                  className="w-24 rounded-sm border border-border-strong bg-surface-inset px-1.5
                             py-0.5 text-caption text-text-primary outline-none"
                />
              ) : (
                <button
                  type="button"
                  role="tab"
                  data-board-id={board.id}
                  aria-selected={active}
                  tabIndex={active ? 0 : -1}
                  draggable
                  onDragStart={(e) => e.dataTransfer.setData('text/plain', String(index))}
                  onDragOver={(e) => e.preventDefault()}
                  onDrop={(e) => {
                    e.preventDefault()
                    const from = Number(e.dataTransfer.getData('text/plain'))
                    if (Number.isInteger(from)) moveBoard(from, index)
                  }}
                  onClick={() => setActiveBoard(board.id)}
                  onDoubleClick={() => setEditingId(board.id)}
                  title={`${board.name} — 위젯 ${board.widgets.length}개 (⌘${index + 1}, 더블클릭으로 이름 변경)`}
                  className={`flex min-w-0 items-center gap-1.5 rounded-sm px-2 py-1 text-caption
                              transition-colors duration-fast ${
                                active
                                  ? 'bg-surface-inset text-text-primary'
                                  : 'text-text-tertiary hover:bg-surface-hover hover:text-text-secondary'
                              }`}
                >
                  <span className="truncate">{board.name}</span>
                  {/* 비활성 탭도 자기가 무엇을 들고 있는지 말해야 한다.
                      눈으로는 숫자만 본다 — 괄호나 "개"를 붙이면 탭이 길어진다.
                      단위는 sr-only로 따로 준다. 숫자만 읽히면 스크린리더에서
                      "업무 2"가 되어 무엇의 2인지 알 수 없다. */}
                  <span
                    data-widget-count={board.widgets.length}
                    className="shrink-0 text-2xs text-text-quaternary tabular-nums"
                  >
                    {board.widgets.length}
                    <span className="sr-only">개 위젯</span>
                  </span>
                </button>
              )}
              {/* 삭제는 활성 탭에만 둔다. 모든 탭에 ✕가 상시로 보이면 누르려던
                  탭 옆의 ✕를 누르게 된다 — 되돌릴 수 없는 동작이다. */}
              {active && !editing && (
                <button
                  type="button"
                  onClick={() => setPendingDeleteId(board.id)}
                  aria-label={`${board.name} 보드 삭제`}
                  title="보드 삭제"
                  className="ml-0.5 grid size-5 shrink-0 place-items-center rounded-sm
                             text-text-quaternary transition-colors duration-fast
                             hover:bg-surface-hover hover:text-danger"
                >
                  <X size={11} />
                </button>
              )}
            </div>
          )
        })}

        <button
          type="button"
          onClick={() => addBoard()}
          aria-label="보드 추가"
          title="보드 추가"
          className="ml-0.5 grid size-6 shrink-0 place-items-center rounded-sm text-text-tertiary
                     transition-colors duration-fast hover:bg-surface-inset hover:text-text-primary"
        >
          <Plus size={13} />
        </button>
      </div>

      <ConfirmDialog
        open={pendingDelete !== null}
        title={`'${pendingDelete?.name ?? ''}' 보드를 삭제할까요?`}
        // 무엇을 잃는지 숫자로 밝힌다. 보드 삭제는 되돌릴 수 없고, 사라지는
        // 것은 탭 하나가 아니라 그 안의 위젯 설정 전부다.
        message={
          pendingDelete && pendingDelete.widgets.length > 0
            ? `위젯 ${pendingDelete.widgets.length}개가 함께 삭제됩니다. 되돌릴 수 없습니다.`
            : '되돌릴 수 없습니다.'
        }
        confirmLabel="삭제"
        onConfirm={() => {
          if (pendingDeleteId) removeBoard(pendingDeleteId)
          setPendingDeleteId(null)
        }}
        onCancel={() => setPendingDeleteId(null)}
      />
    </>
  )
}
