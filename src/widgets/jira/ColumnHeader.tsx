import { useCallback, useRef } from 'react'
import {
  type ColumnWidths,
  gridTemplate,
  nextWidth,
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
 *
 * 모든 경계는 끌 수 있고 세로선으로 보인다 — 끌 수 없는 경계를 남겨두면
 * "왜 여기만 안 되지"가 된다. 어느 열이 움직이는지는 본문 주석 참조.
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
  const drag = useRef<{
    col: keyof ColumnWidths
    startX: number
    startW: number
    invert: boolean
  } | null>(null)

  const beginDrag = useCallback(
    (col: keyof ColumnWidths, invert: boolean) => (e: React.PointerEvent) => {
      e.preventDefault()
      e.stopPropagation() // 위젯 드래그로 번지지 않게
      drag.current = { col, startX: e.clientX, startW: widths[col], invert }
      ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
    },
    [widths],
  )

  const onPointerMove = useCallback(
    (e: React.PointerEvent) => {
      const d = drag.current
      if (!d) return
      onResize(d.col, nextWidth(d.col, d.startW, e.clientX - d.startX, d.invert))
    },
    [onResize],
  )

  const endDrag = useCallback((e: React.PointerEvent) => {
    drag.current = null
    const el = e.currentTarget as HTMLElement
    if (el.hasPointerCapture(e.pointerId)) el.releasePointerCapture(e.pointerId)
  }, [])

  const active = resizableColumns(density)
  const handleProps = (col: keyof ColumnWidths, invert = false) => ({
    onPointerDown: beginDrag(col, invert),
    onPointerMove,
    onPointerUp: endDrag,
    onPointerCancel: endDrag,
  })

  return (
    <div
      className="grid shrink-0 items-center gap-2 border-border-subtle border-b px-2 py-1
                 text-caption text-text-quaternary"
      style={{ gridTemplateColumns: gridTemplate(widths, density) }}
    >
      {/*
        **경계선은 자기 오른쪽 열을 조절한다.**

        선을 왼쪽으로 끌면 오른쪽 열이 넓어지고, 오른쪽으로 끌면 좁아진다.
        경계 왼쪽에 있는 열을 키우는 것이 더 직관적으로 들리지만, 이 그리드에서는
        제목이 1fr이라 벌어진 자리를 전부 흡수해버린다 — 그래서 왼쪽 열을 키워도
        화면에서는 "제목이 줄었다"로만 보인다. 오른쪽 열을 움직여야 사용자가
        잡은 선과 커지는 칸이 일치한다.

        예외는 키 열뿐이다. 그 오른쪽이 제목(1fr)이라 조절할 px가 없으므로
        역방향으로 키 자신을 키운다.

          키|제목    → 키 +        (역방향. 오른쪽으로 끌면 키가 넓어짐)
          제목|상태  → 상태 −
          상태|담당  → 담당 −
          담당|수정  → 수정 −
      */}
      <HeaderCell
        label={LABELS.key}
        handle={active.includes('key')}
        {...handleProps('key', true)}
      />

      <HeaderCell label="제목" handle={active.includes('status')} {...handleProps('status')} />

      <HeaderCell
        label={density === 'compact' ? '' : LABELS.status}
        handle={active.includes('assignee')}
        {...handleProps('assignee')}
      />

      <HeaderCell label={LABELS.assignee} handle={density === 'wide'} {...handleProps('updated')} />

      {/* 마지막 열은 오른쪽에 경계가 없으므로 핸들도 없다. */}
      {density === 'wide' && <HeaderCell label={LABELS.updated} handle={false} />}
    </div>
  )
}

function HeaderCell({
  label,
  handle,
  onPointerDown,
  onPointerMove,
  onPointerUp,
  onPointerCancel,
}: {
  label: string
  handle: boolean
  onPointerDown?: (e: React.PointerEvent) => void
  onPointerMove?: (e: React.PointerEvent) => void
  onPointerUp?: (e: React.PointerEvent) => void
  onPointerCancel?: (e: React.PointerEvent) => void
}) {
  return (
    <span className="relative min-w-0 truncate">
      {label}
      {handle && (
        // 열 너비는 포인터 전용 조작이다. 키보드로는 조절할 수 없지만
        // 기본값이 항상 읽히는 폭이므로 기능 접근성이 막히지는 않는다.
        <span
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerCancel}
          title="드래그해서 열 너비 조절"
          className="group absolute top-[-4px] right-[-9px] z-10 flex h-[calc(100%+8px)] w-[14px]
                     cursor-col-resize justify-center"
        >
          {/* 항상 보이는 세로선. 끌 수 있다는 것이 보여야 시도하게 된다. */}
          <span className="h-full w-px bg-border-subtle transition-colors duration-fast group-hover:bg-accent" />
        </span>
      )}
    </span>
  )
}
