import { useCallback, useMemo } from 'react'
import GridLayout, { type Layout, type LayoutItem, useContainerWidth } from 'react-grid-layout'
import { GRID_COLUMNS, useBoardStore, useWidgets } from '#/store/board'
import { tryGetWidget } from '#/widgets/registry'

import 'react-grid-layout/css/styles.css'

const ROW_HEIGHT = 40
const MARGIN = [12, 12] as const

// RGL v2는 v1의 평면 prop 대신 설정 객체를 받는다.
const GRID_CONFIG = { cols: GRID_COLUMNS, rowHeight: ROW_HEIGHT, margin: MARGIN } as const
const DRAG_CONFIG = { handle: '[data-widget-drag-handle]' } as const
const RESIZE_CONFIG = { handles: ['se'] } as const

export function Board() {
  const widgets = useWidgets()
  const hydrated = useBoardStore((s) => s.hydrated)
  const applyLayout = useBoardStore((s) => s.applyLayout)
  const { width, containerRef } = useContainerWidth()

  const layout = useMemo<Layout>(
    () =>
      widgets.map<LayoutItem>((w) => {
        const definition = tryGetWidget(w.type)
        return {
          i: w.id,
          x: w.layout.x,
          y: w.layout.y,
          w: w.layout.w,
          h: w.layout.h,
          minW: definition?.minLayout.w ?? 2,
          minH: definition?.minLayout.h ?? 3,
        }
      }),
    [widgets],
  )

  // 드래그/리사이즈가 끝났을 때만 반영한다. 진행 중에는 초당 수십 번 발생하므로
  // 여기서 저장까지 하면 디스크를 두들기게 된다 (DECISIONS 10장).
  const handleLayoutCommit = useCallback(
    (next: Layout) => {
      applyLayout(next.map((l) => ({ i: l.i, x: l.x, y: l.y, w: l.w, h: l.h })))
    },
    [applyLayout],
  )

  if (!hydrated) {
    // 저장된 배치를 읽기 전에 그리면 위젯이 기본 위치에서 제자리로 튄다.
    return <div className="h-full" aria-busy="true" />
  }

  return (
    <div
      ref={containerRef}
      className="h-[calc(100%-2.25rem)] overflow-y-auto overflow-x-hidden px-3 pb-3"
    >
      {widgets.length === 0 ? (
        <EmptyBoard />
      ) : (
        <GridLayout
          layout={layout}
          width={width}
          gridConfig={GRID_CONFIG}
          dragConfig={DRAG_CONFIG}
          resizeConfig={RESIZE_CONFIG}
          onDragStop={handleLayoutCommit}
          onResizeStop={handleLayoutCommit}
        >
          {widgets.map((w) => (
            <div key={w.id}>
              <WidgetSlot type={w.type} id={w.id} />
            </div>
          ))}
        </GridLayout>
      )}
    </div>
  )
}

/**
 * 레지스트리에서 위젯 정의를 찾아 렌더한다.
 * 등록되지 않은 타입은 조용히 사라지게 두지 않는다 — 사용자가 코드를 읽지 않으므로
 * 안 보이는 것보다 "왜 안 보이는지"가 보여야 한다.
 */
function WidgetSlot({ type, id }: { type: string; id: string }) {
  const definition = tryGetWidget(type as never)
  if (!definition) {
    return (
      <div className="flex h-full items-center justify-center rounded-lg border border-dashed border-[--color-border-subtle] p-4 text-center text-sm text-[--color-text-muted]">
        알 수 없는 위젯 타입: {type}
      </div>
    )
  }
  // WidgetShell은 후속 단계에서 붙는다.
  return (
    <div className="h-full rounded-lg border border-[--color-border-subtle] bg-[--color-surface-raised] p-3">
      <div data-widget-drag-handle className="cursor-move text-sm text-[--color-text-muted]">
        {definition.label}
      </div>
      <div className="mt-2 text-xs text-[--color-text-muted]">{id.slice(0, 8)}</div>
    </div>
  )
}

function EmptyBoard() {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-2 text-[--color-text-muted]">
      <p className="text-sm">보드가 비어 있습니다</p>
      <p className="text-xs">⌘N 으로 위젯을 추가하세요</p>
    </div>
  )
}
