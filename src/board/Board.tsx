import { useCallback, useMemo } from 'react'
import GridLayout, { type Layout, type LayoutItem, useContainerWidth } from 'react-grid-layout'
import { WidgetHost } from '#/board/WidgetHost'
import { GRID_COLUMNS, useBoardStore, useWidgets } from '#/store/board'
import { tryGetWidget } from '#/widgets/registry'

import 'react-grid-layout/css/styles.css'

const ROW_HEIGHT = 40
const MARGIN = [12, 12] as const

// RGL v2는 v1의 평면 prop 대신 설정 객체를 받는다.
const GRID_CONFIG = { cols: GRID_COLUMNS, rowHeight: ROW_HEIGHT, margin: MARGIN } as const
const DRAG_CONFIG = { handle: '[data-widget-drag-handle]' } as const
const RESIZE_CONFIG = { handles: ['se'] } as const

export function Board({ onOpenSettings }: { onOpenSettings: () => void }) {
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
              <WidgetHost widget={w} onOpenSettings={onOpenSettings} />
            </div>
          ))}
        </GridLayout>
      )}
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
