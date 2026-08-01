import { SquarePen } from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import type { JiraWidgetConfig } from '#/ipc/bindings'
import { useBoardStore } from '#/store/board'
import { useConnectionStore } from '#/store/connection'
import { ConfirmDialog } from '#/ui/ConfirmDialog'
import { CreateIssueModal } from '#/widgets/jira/CreateIssueModal'
import { IssueDetailModal } from '#/widgets/jira/IssueDetailModal'
import { useJiraData } from '#/widgets/jira/useJiraData'
import { tryGetWidget } from '#/widgets/registry'
import { WidgetConfigModal } from '#/widgets/shell/WidgetConfigModal'
import { IconButton, WidgetShell } from '#/widgets/shell/WidgetShell'
import type { WidgetInstance } from '#/widgets/types'

const DEFAULT_REFRESH_SECS = 300
/** 자동 갱신을 켠 경우의 하한. 이보다 잦으면 rate limit에 가까워진다. */
const MIN_REFRESH_SECS = 60

/**
 * 위젯 하나를 실제로 살아 있게 만드는 곳.
 *
 * 데이터 수명주기를 타입별로 갈아끼우되, 껍데기와 레이아웃은 공통이다.
 * 지금은 jira만 데이터 훅이 있고 나머지는 후속.
 */
export function WidgetHost({ widget }: { widget: WidgetInstance }) {
  const definition = tryGetWidget(widget.type)
  const removeWidget = useBoardStore((s) => s.removeWidget)
  const [width, setWidth] = useState(0)
  const [configuring, setConfiguring] = useState(false)
  const [confirmingRemove, setConfirmingRemove] = useState(false)
  const openConfig = useCallback(() => setConfiguring(true), [])
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
          onRemove={() => setConfirmingRemove(true)}
          onConfigure={openConfig}
        />
      ) : widget.type === 'web' ? (
        <WebHost
          widget={widget}
          width={width}
          onRemove={() => setConfirmingRemove(true)}
          onConfigure={openConfig}
        />
      ) : widget.type === 'todo' ? (
        <TodoHost
          widget={widget}
          width={width}
          onRemove={() => setConfirmingRemove(true)}
          onConfigure={openConfig}
        />
      ) : (
        <WidgetShell
          title={definition.deriveTitle(widget.config)}
          status="idle"
          fetchedAt={null}
          pollable={definition.pollable}
          onRefresh={() => {}}
          onConfigure={openConfig}
          onRemove={() => setConfirmingRemove(true)}
        >
          <div className="grid h-full place-items-center text-caption text-text-tertiary">
            아직 구현되지 않았습니다
          </div>
        </WidgetShell>
      )}
      <WidgetConfigModal
        widget={configuring ? widget : null}
        onClose={() => setConfiguring(false)}
      />
      <ConfirmDialog
        open={confirmingRemove}
        title={`${definition.label} 위젯을 삭제할까요?`}
        // 되돌리기가 없으므로 무엇을 잃는지 분명히 말한다.
        message="이 위젯의 설정(쿼리·열 너비·표시 개수)이 함께 사라집니다."
        confirmLabel="삭제"
        onConfirm={() => {
          setConfirmingRemove(false)
          removeWidget(widget.id)
        }}
        onCancel={() => setConfirmingRemove(false)}
      />
    </div>
  )
}

/**
 * 웹 위젯 호스트 (spike).
 *
 * Rust 데이터 훅이 없다 — iframe이 스스로 로드하므로 envelope은 껍데기다.
 * 새로고침은 View 안의 iframe을 다시 만드는 것이라, 여기서는 remount용
 * key만 올려준다.
 */
function WebHost({
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
  const definition = tryGetWidget('web')
  const [reloadKey, setReloadKey] = useState(0)
  if (!definition) return null
  const View = definition.View

  return (
    <WidgetShell
      title={definition.deriveTitle(widget.config)}
      status="ready"
      fetchedAt={null}
      pollable
      onRefresh={() => setReloadKey((n) => n + 1)}
      onConfigure={onConfigure}
      onRemove={onRemove}
    >
      <View
        key={reloadKey}
        widgetId={widget.id}
        config={widget.config}
        envelope={{ status: 'ready', data: null, fetchedAt: null, error: null }}
        width={width}
      />
    </WidgetShell>
  )
}

/**
 * Todo 위젯 호스트.
 *
 * 데이터 훅이 없다 — 상태는 `store/todos.ts`가 소유하고 View가 직접 구독한다.
 * 위젯이 하나뿐이라 envelope으로 감쌀 이유가 없고, 자정 이월이 위젯 수명과
 * 무관해야 해서 스토어에 두었다.
 *
 * `pollable: false`라 WidgetShell이 새로고침 버튼을 숨긴다. 우리가 호출할
 * 외부 API가 없으므로 누를 것이 없다.
 */
function TodoHost({
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
  const definition = tryGetWidget('todo')
  if (!definition) return null
  const View = definition.View

  return (
    <WidgetShell
      title={definition.deriveTitle(widget.config)}
      status="ready"
      fetchedAt={null}
      pollable={false}
      onRefresh={() => {}}
      onConfigure={onConfigure}
      onRemove={onRemove}
    >
      <View
        widgetId={widget.id}
        config={widget.config}
        envelope={{ status: 'ready', data: null, fetchedAt: null, error: null }}
        width={width}
      />
    </WidgetShell>
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
  // 0이면 자동 갱신하지 않는다. 그 외에는 1분이 하한.
  const secs = config.refreshSecs ?? DEFAULT_REFRESH_SECS
  const refreshMs = secs <= 0 ? 0 : Math.max(MIN_REFRESH_SECS, secs) * 1000
  const { envelope, refresh } = useJiraData(widget.id, config, refreshMs)
  const jiraConfigured = useConnectionStore((s) => s.jiraConfigured)
  const [creating, setCreating] = useState(false)
  const [createdKey, setCreatedKey] = useState<string | null>(null)

  // ⌘⇧N. 보드에 Jira 위젯이 여러 개면 **첫 번째만** 연다 — 안 그러면 모달이
  // 위젯 수만큼 겹쳐 뜬다. 판정은 DOM 순서가 아니라 보드의 위젯 순서로 한다.
  const isPrimaryJira = useBoardStore(
    (s) =>
      s.boards.find((b) => b.id === s.activeBoardId)?.widgets.find((w) => w.type === 'jira')?.id ===
      widget.id,
  )
  useEffect(() => {
    if (!isPrimaryJira || !jiraConfigured) return
    const open = () => setCreating(true)
    window.addEventListener('pegboard:jira-create', open)
    return () => window.removeEventListener('pegboard:jira-create', open)
  }, [isPrimaryJira, jiraConfigured])

  if (!definition) return null
  const View = definition.View

  return (
    <>
      <WidgetShell
        title={definition.deriveTitle(config)}
        status={envelope.status}
        fetchedAt={envelope.fetchedAt}
        pollable
        onRefresh={refresh}
        onConfigure={onConfigure}
        onRemove={onRemove}
        actions={
          // 연결이 없으면 만들 곳이 없다.
          jiraConfigured ? (
            <IconButton label="티켓 생성 (⌘⇧N)" onClick={() => setCreating(true)}>
              <SquarePen size={13} />
            </IconButton>
          ) : undefined
        }
      >
        <View widgetId={widget.id} config={config} envelope={envelope} width={width} />
      </WidgetShell>

      <CreateIssueModal
        open={creating}
        onClose={() => setCreating(false)}
        onCreated={(key) => {
          setCreating(false)
          setCreatedKey(key)
        }}
      />
      {/* 생성 → "상세 보기". 목록을 거치지 않아 골격(seed)이 없다. */}
      <IssueDetailModal issueKey={createdKey} seed={null} onClose={() => setCreatedKey(null)} />
    </>
  )
}
