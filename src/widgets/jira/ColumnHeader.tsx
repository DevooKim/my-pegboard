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
 *
 * 모든 경계는 끌 수 있고 세로선으로 보인다. 제목 열은 `1fr`이라 자기
 * 너비가 없으므로, 제목 오른쪽 경계는 **다음 열을 반대로 줄인다** —
 * 결과적으로 제목이 넓어진다. 끌 수 없는 경계를 남겨두면
 * "왜 여기만 안 되지"가 되므로 예외를 만들지 않는다.
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
      const delta = e.clientX - d.startX
      // invert: 오른쪽으로 끌면 그 열이 줄어들고 왼쪽(제목)이 넓어진다.
      onResize(d.col, clampColumn(d.col, d.startW + (d.invert ? -delta : delta)))
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
        핸들은 셀의 오른쪽 경계에 놓인다. 어느 열을 바꾸는지는 경계마다 다르다:

          키|제목    → 키를 늘린다        (오른쪽으로 끌면 넓어짐)
          제목|상태  → 상태를 줄인다      (제목이 1fr이라 결과적으로 제목이 넓어짐)
          상태|담당  → 상태를 늘린다
          담당|수정  → 담당을 늘린다

        남는 공간은 항상 1fr인 제목이 흡수한다. 그래서 어떤 고정 열을 줄여도
        넓어지는 것은 제목이지 옆 열이 아니다.
      */}
      <HeaderCell label={LABELS.key} handle={active.includes('key')} {...handleProps('key')} />

      <HeaderCell
        label="제목"
        handle={active.includes('status')}
        {...handleProps('status', true)}
      />

      <HeaderCell
        label={density === 'compact' ? '' : LABELS.status}
        handle={active.includes('status')}
        {...handleProps('status')}
      />

      <HeaderCell
        label={LABELS.assignee}
        handle={active.includes('assignee')}
        {...handleProps('assignee')}
      />

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
