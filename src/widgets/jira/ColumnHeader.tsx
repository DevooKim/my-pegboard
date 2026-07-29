import { useCallback, useRef } from 'react'
import {
  alignClass,
  COLUMN_LABELS,
  type ColumnWidths,
  DEFAULT_VISIBLE_COLUMNS,
  gridTemplate,
  nextWidth,
  renderedColumns,
  resizableColumns,
  type ToggleableColumn,
} from '#/widgets/jira/columns'

/**
 * 값 쪽 셀이 안쪽 여백을 갖는 열의 헤더 들여쓰기.
 *
 * 그리드 트랙은 이미 픽셀 단위로 일치한다(실측). 남는 차이는 셀 **내용**의
 * 여백이다 — 상태 배지는 배경을 그리려고 px-1.5(6px)를 갖고, 담당자는
 * 아바타(20px)와 gap이 이름을 밀어낸다. 헤더 라벨에 같은 만큼을 줘서
 * 글자 시작점을 맞춘다.
 */
const CELL_INDENT: Partial<Record<ToggleableColumn | 'summary', string>> = {
  status: 'pl-1.5',
  assignee: 'pl-1',
}

/**
 * 열 머리글 + 리사이즈 핸들.
 *
 * 헤더가 있어야 하는 이유는 두 가지다. 열을 끌 지점이 필요하고,
 * 무엇보다 **각 열이 무엇인지 이름이 붙는다** — 시간 열이 무슨 시간인지
 * 물어보게 만들지 않으려면 이름이 있어야 한다.
 *
 * **경계선은 자기 오른쪽 열을 조절한다.** 제목이 1fr이라 벌어진 자리를 전부
 * 흡수하므로, 왼쪽 열을 키우면 화면에서는 "제목이 줄었다"로만 보인다.
 * 오른쪽 열을 움직여야 잡은 선과 커지는 칸이 일치한다.
 * 예외는 키 열 — 오른쪽이 제목이라 조절할 px가 없어 자기 자신을 키운다.
 */
export function ColumnHeader({
  widths,
  density,
  visible = DEFAULT_VISIBLE_COLUMNS,
  onResize,
}: {
  widths: ColumnWidths
  density: 'compact' | 'normal' | 'wide'
  visible?: ToggleableColumn[]
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

  const rendered = renderedColumns(density, visible)
  const adjustable = resizableColumns(density, visible)

  // 화면 순서: [키] 제목 [상태] [담당] [수정]
  // 셀에 붙는 핸들은 그 셀의 오른쪽 경계이고, 조절 대상은 **다음** 열이다.
  const cells: Array<ToggleableColumn | 'summary'> = [
    ...(rendered.includes('key') ? ['key' as const] : []),
    'summary',
    ...rendered.filter((c) => c !== 'key'),
  ]

  return (
    <div
      // 오른쪽 패딩을 헤더 '안'에 주면 1fr(제목)이 그만큼 넓어져 뒤 트랙이 전부
      // 밀린다. 스크롤바 보정은 바깥 래퍼가 담당한다(View.tsx).
      className="grid shrink-0 items-center gap-2 border-border-subtle border-b py-1 pr-2 pl-3
                 text-caption text-text-quaternary"
      style={{ gridTemplateColumns: gridTemplate(widths, density, visible) }}
    >
      {cells.map((cell, i) => {
        const next = cells[i + 1]
        // 키|제목 경계만 역방향(제목이 1fr이라 조절할 px가 없다).
        const invert = next === 'summary'
        const target: keyof ColumnWidths | undefined =
          next === undefined ? undefined : next === 'summary' ? 'key' : next
        const canDrag = target !== undefined && adjustable.includes(target)

        return (
          <div key={cell} className="flex min-w-0 items-center">
            <HeaderCell
              align={alignClass(cell)}
              label={
                cell === 'summary'
                  ? '제목'
                  : density === 'compact' && cell === 'status'
                    ? ''
                    : COLUMN_LABELS[cell]
              }
              indent={CELL_INDENT[cell] ?? ''}
              handle={canDrag}
              {...(canDrag && target
                ? {
                    onPointerDown: beginDrag(target, invert),
                    onPointerMove,
                    onPointerUp: endDrag,
                    onPointerCancel: endDrag,
                  }
                : {})}
            />
          </div>
        )
      })}
    </div>
  )
}

function HeaderCell({
  label,
  align,
  indent = '',
  handle,
  onPointerDown,
  onPointerMove,
  onPointerUp,
  onPointerCancel,
}: {
  label: string
  align: string
  indent?: string
  handle: boolean
  onPointerDown?: (e: React.PointerEvent) => void
  onPointerMove?: (e: React.PointerEvent) => void
  onPointerUp?: (e: React.PointerEvent) => void
  onPointerCancel?: (e: React.PointerEvent) => void
}) {
  return (
    // `w-full`이 핵심이다. flex 래퍼 안의 span은 기본적으로 콘텐츠 폭으로
    // 줄어들어 트랙 가운데 놓인다 — 헤더 글자가 중앙에 보이던 원인이다.
    // 트랙을 꽉 채워야 text-left가 실제로 왼쪽 끝을 잡는다.
    <span className={`relative w-full min-w-0 truncate ${align} ${indent}`}>
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
