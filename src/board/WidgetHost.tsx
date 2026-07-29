import { useEffect, useRef, useState } from 'react'
import type { JiraWidgetConfig } from '#/ipc/bindings'
import { useBoardStore } from '#/store/board'
import { useJiraData } from '#/widgets/jira/useJiraData'
import { tryGetWidget } from '#/widgets/registry'
import { WidgetShell } from '#/widgets/shell/WidgetShell'
import type { WidgetInstance } from '#/widgets/types'

const DEFAULT_REFRESH_MS = 5 * 60 * 1000

/**
 * 위젯 하나를 실제로 살아 있게 만드는 곳.
 *
 * 데이터 수명주기를 타입별로 갈아끼우되, 껍데기와 레이아웃은 공통이다.
 * 지금은 jira만 데이터 훅이 있고 나머지는 후속.
 */
export function WidgetHost({
  widget,
  onOpenSettings,
}: {
  widget: WidgetInstance
  onOpenSettings: () => void
}) {
  const definition = tryGetWidget(widget.type)
  const removeWidget = useBoardStore((s) => s.removeWidget)
  const [width, setWidth] = useState(0)
  const ref = useRef<HTMLDivElement | null>(null)

  // 본문 폭을 재서 View에 넘긴다 — 밀도 전환의 근거(DESIGN.md 4.7).
  useEffect(() => {
    const node = ref.current
    if (!node) return
    const ro = new ResizeObserver(([entry]) => {
      if (entry) setWidth(Math.floor(entry.contentRect.width))
    })
    ro.observe(node)
    setWidth(Math.floor(node.getBoundingClientRect().width))
    return () => ro.disconnect()
  }, [])

  if (!definition) {
    return (
      <div className="grid h-full place-items-center rounded-lg border border-border-subtle border-dashed p-4 text-center text-caption text-text-tertiary">
        알 수 없는 위젯 타입: {widget.type}
      </div>
    )
  }

  return (
    <div ref={ref} className="h-full">
      {widget.type === 'jira' ? (
        <JiraHost
          widget={widget}
          width={width}
          onRemove={() => removeWidget(widget.id)}
          onConfigure={onOpenSettings}
        />
      ) : (
        <WidgetShell
          title={definition.deriveTitle(widget.config)}
          status="idle"
          fetchedAt={null}
          pollable={definition.pollable}
          onRefresh={() => {}}
          onConfigure={onOpenSettings}
          onRemove={() => removeWidget(widget.id)}
        >
          <div className="grid h-full place-items-center text-caption text-text-tertiary">
            아직 구현되지 않았습니다
          </div>
        </WidgetShell>
      )}
    </div>
  )
}

function JiraHost({
  widget,
  width,
  onRemove,
  onConfigure,
}: {
  widget: WidgetInstance
  width: number
  onRemove: () => void
  onConfigure: () => void
}) {
  const definition = tryGetWidget('jira')
  const config = widget.config as unknown as JiraWidgetConfig
  const { envelope, refresh } = useJiraData(widget.id, config, DEFAULT_REFRESH_MS)

  if (!definition) return null
  const View = definition.View

  return (
    <WidgetShell
      title={definition.deriveTitle(config)}
      status={envelope.status}
      fetchedAt={envelope.fetchedAt}
      pollable
      onRefresh={refresh}
      onConfigure={onConfigure}
      onRemove={onRemove}
    >
      <View widgetId={widget.id} config={config} envelope={envelope} width={width} />
    </WidgetShell>
  )
}
