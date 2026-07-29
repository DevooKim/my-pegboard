import { useCallback, useRef } from 'react'
import {
  type ColumnWidths,
  clampColumn,
  gridTemplate,
  resizableColumns,
} from '#/widgets/jira/columns'

const LABELS: Record<keyof ColumnWidths, string> = {
  key: '키',
  status: '상태',
  assignee: '담당',
  updated: '수정',
}

/**
 * 열 머리글 + 리사이즈 핸들.
 *
 * 헤더가 있어야 하는 이유는 두 가지다. 열을 끌 지점이 필요하고,
 * 무엇보다 **각 열이 무엇인지 이름이 붙는다** — 시간 열이 무슨 시간인지
 * 물어보게 만들지 않으려면 이름이 있어야 한다.
 */
export function ColumnHeader({
  widths,
  density,
  onResize,
}: {
  widths: ColumnWidths
  density: 'compact' | 'normal' | 'wide'
  onResize: (col: keyof ColumnWidths, px: number) => void
}) {
  const dragging = useRef<{ col: keyof ColumnWidths; startX: number; startW: number } | null>(null)

  const onPointerDown = useCallback(
    (col: keyof ColumnWidths) => (e: React.PointerEvent) => {
      e.preventDefault()
      e.stopPropagation() // 위젯 드래그로 번지지 않게
      dragging.current = { col, startX: e.clientX, startW: widths[col] }
      const target = e.currentTarget as HTMLElement
      target.setPointerCapture(e.pointerId)
    },
    [widths],
  )

  const onPointerMove = useCallback(
    (e: React.PointerEvent) => {
      const d = dragging.current
      if (!d) return
      onResize(d.col, clampColumn(d.col, d.startW + (e.clientX - d.startX)))
    },
    [onResize],
  )

  const endDrag = useCallback((e: React.PointerEvent) => {
    dragging.current = null
    const target = e.currentTarget as HTMLElement
    if (target.hasPointerCapture(e.pointerId)) target.releasePointerCapture(e.pointerId)
  }, [])

  const cols = resizableColumns(density)

  return (
    <div
      className="grid shrink-0 items-center gap-2 border-border-subtle border-b px-2 py-1
                 text-caption text-text-quaternary"
      style={{ gridTemplateColumns: gridTemplate(widths, density) }}
    >
      <HeaderCell
        label={LABELS.key}
        resizable={cols.includes('key')}
        onPointerDown={onPointerDown('key')}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
      />
      <span className="truncate">제목</span>
      <HeaderCell
        label={density === 'compact' ? '' : LABELS.status}
        resizable={cols.includes('status')}
        onPointerDown={onPointerDown('status')}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
      />
      <HeaderCell
        label={LABELS.assignee}
        resizable={cols.includes('assignee')}
        onPointerDown={onPointerDown('assignee')}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
      />
      {density === 'wide' && (
        <HeaderCell
          label={LABELS.updated}
          resizable={false}
          onPointerDown={onPointerDown('updated')}
          onPointerMove={onPointerMove}
          onPointerUp={endDrag}
        />
      )}
    </div>
  )
}

function HeaderCell({
  label,
  resizable,
  onPointerDown,
  onPointerMove,
  onPointerUp,
}: {
  label: string
  resizable: boolean
  onPointerDown: (e: React.PointerEvent) => void
  onPointerMove: (e: React.PointerEvent) => void
  onPointerUp: (e: React.PointerEvent) => void
}) {
  return (
    <span className="relative min-w-0 truncate">
      {label}
      {resizable && (
        // 열 너비는 포인터 전용 조작이다. 키보드로는 조절할 수 없지만,
        // 기본값이 항상 읽히는 폭이므로 기능 접근성이 막히지는 않는다.
        <span
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerUp}
          className="absolute top-[-4px] right-[-9px] z-10 h-[calc(100%+8px)] w-[10px]
                     cursor-col-resize after:absolute after:top-0 after:left-1/2 after:h-full
                     after:w-px after:bg-border-subtle after:opacity-0 hover:after:opacity-100"
        />
      )}
    </span>
  )
}
