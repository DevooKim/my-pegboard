import { openUrl } from '@tauri-apps/plugin-opener'
import { ArrowDownToLine, ExternalLink, SquarePen } from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import type {
  GithubWidgetConfig,
  JiraWidgetConfig,
  LinearIssue,
  LinearWidgetConfig,
  TodoItem,
} from '#/ipc/bindings'
import { useBoardStore } from '#/store/board'
import { useConnectionStore } from '#/store/connection'
import { dateKey, useTodoStore } from '#/store/todos'
import { ConfirmDialog } from '#/ui/ConfirmDialog'
import type { AlbumWidgetConfig } from '#/widgets/album'
import { useAlbumData } from '#/widgets/album/useAlbumData'
import { useGithubData } from '#/widgets/github/useGithubData'
import { CreateIssueModal } from '#/widgets/jira/CreateIssueModal'
import { IssueDetailModal } from '#/widgets/jira/IssueDetailModal'
import { useJiraData } from '#/widgets/jira/useJiraData'
import { LinearCreateIssueModal } from '#/widgets/linear/CreateIssueModal'
import { IssueDetailModal as LinearIssueDetailModal } from '#/widgets/linear/IssueDetailModal'
import { useLinearData } from '#/widgets/linear/useLinearData'
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
      ) : widget.type === 'github' ? (
        <GithubHost
          widget={widget}
          width={width}
          onRemove={() => setConfirmingRemove(true)}
          onConfigure={openConfig}
        />
      ) : widget.type === 'album' ? (
        <AlbumHost
          widget={widget}
          width={width}
          onRemove={() => setConfirmingRemove(true)}
          onConfigure={openConfig}
        />
      ) : widget.type === 'linear' ? (
        <LinearHost
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
  const url = String((widget.config as { url?: unknown }).url ?? '').trim()

  return (
    <WidgetShell
      title={url || definition.deriveTitle(widget.config)}
      status="ready"
      fetchedAt={null}
      pollable
      onRefresh={() => setReloadKey((n) => n + 1)}
      onConfigure={onConfigure}
      onRemove={onRemove}
      actions={
        url ? (
          <IconButton label="브라우저에서 열기" onClick={() => void openUrl(url)}>
            <ExternalLink size={13} />
          </IconButton>
        ) : undefined
      }
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
 * 앨범 위젯 호스트.
 *
 * `refreshMs`를 계산하지 않는다 — **주기 폴링이 없다.** 사진 폴더는 5분마다
 * 바뀌지 않으므로 `useAlbumData`에 `setInterval`이 없고, 설정의 `intervalSecs`는
 * 데이터 갱신이 아니라 **사진을 넘기는 주기**라서 View가 소유한다.
 *
 * `actions` 슬롯이 비어 있다. GitHub과 같은 이유로 읽기 전용이고, 유일한
 * 상호작용("다음 장")은 위젯 면적 전체에 걸려 있어서 헤더에 버튼이 필요 없다.
 */
function AlbumHost({
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
  const definition = tryGetWidget('album')
  const config = widget.config as unknown as AlbumWidgetConfig
  // 소스만 넘긴다 — 순환 주기를 바꿨다고 폴더를 다시 훑지 않는다.
  const { envelope, refresh } = useAlbumData(widget.id, config.source ?? null)

  if (!definition) return null
  const View = definition.View

  return (
    <WidgetShell
      title={definition.deriveTitle(config)}
      status={envelope.status}
      // 스캔 시각을 표시하지 않는다. Jira·GitHub에서 "N분 전"이 의미가 있는 것은
      // 원본이 남의 서버에 있어서 내 화면이 얼마나 뒤처졌는지가 정보이기 때문이다.
      // 로컬 폴더는 원본이 이 기기에 있고 사진은 저절로 바뀌지 않는다 —
      // 배경으로 쓰는 위젯에 시각을 띄우면 알 필요 없는 숫자만 늘어난다.
      fetchedAt={null}
      // 새로고침 = 폴더 재스캔. 사진을 추가한 뒤 누를 일이 있다.
      pollable
      onRefresh={refresh}
      onConfigure={onConfigure}
      onRemove={onRemove}
      headerMode={(config.headerMode ?? 'hover') === 'hover' ? 'hover-overlay' : 'static'}
    >
      <View widgetId={widget.id} config={config} envelope={envelope} width={width} />
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
  const items = useTodoStore((s) => s.items)
  const carryOverNow = useTodoStore((s) => s.carryOverNow)

  // 가져올 것이 몇 개인가 = 오늘보다 이전의 미완료 항목.
  // hover 툴팁에 실제 내용을 보여주므로 개수만이 아니라 목록도 만든다.
  const pending = pendingCarry(items)

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
      actions={
        // 가져올 게 없으면 버튼을 숨긴다 — 눌러도 아무 일이 없는 버튼은
        // 사용자가 "고장났나" 하고 다시 누르게 만든다.
        pending.length > 0 ? (
          <IconButton label={carryTooltip(pending)} onClick={() => void carryOverNow()}>
            <ArrowDownToLine size={13} />
          </IconButton>
        ) : undefined
      }
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

/** 오늘보다 이전에 남아 있는 미완료 항목. 이월 대상과 같은 조건이다. */
function pendingCarry(items: TodoItem[]): TodoItem[] {
  const today = dateKey()
  return items.filter((i) => !i.done && i.date < today)
}

/**
 * 버튼 툴팁. **무엇을 가져오는지 내용을 보여준다.**
 *
 * 개수만 적으면("3개 가져오기") 누르기 전에 무엇이 튀어나올지 모른다.
 * 항목이 많으면 앞의 몇 개만 보이고 나머지는 수로 줄인다 — 툴팁이
 * 화면을 덮으면 그것대로 쓸모없다.
 */
function carryTooltip(pending: TodoItem[]): string {
  const SHOWN = 5
  const head = pending.slice(0, SHOWN).map((i) => `· ${i.text}`)
  const rest = pending.length - SHOWN
  const lines = rest > 0 ? [...head, `… 외 ${rest}개`] : head
  return [`미완료 ${pending.length}개 가져오기`, ...lines].join('\n')
}

/**
 * GitHub 위젯 호스트.
 *
 * Jira와 달리 **actions 슬롯이 비어 있다.** 읽기 전용이라 만들 것이 없다
 * (DECISIONS 12 — 상세도 생성도 없고, 누르면 브라우저로 나간다).
 */
function GithubHost({
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
  const definition = tryGetWidget('github')
  const config = widget.config as unknown as GithubWidgetConfig
  const secs = config.refreshSecs ?? DEFAULT_REFRESH_SECS
  const refreshMs = secs <= 0 ? 0 : Math.max(MIN_REFRESH_SECS, secs) * 1000
  const { envelope, refresh } = useGithubData(widget.id, config, refreshMs)

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

/**
 * Linear 위젯 호스트.
 *
 * GitHub과 달리 **읽기 전용이 아니다** — 생성·상태 변경과 상세 모달이 있다
 * (DECISIONS 25.1). 생성은 연결된 Linear 위젯의 헤더에서만 시작한다.
 */
function LinearHost({
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
  const definition = tryGetWidget('linear')
  const config = widget.config as unknown as LinearWidgetConfig
  // 0이면 자동 갱신하지 않는다. 그 외에는 1분이 하한.
  const secs = config.refreshSecs ?? DEFAULT_REFRESH_SECS
  const refreshMs = secs <= 0 ? 0 : Math.max(MIN_REFRESH_SECS, secs) * 1000
  const { envelope, refresh } = useLinearData(widget.id, config, refreshMs)
  const linearConfigured = useConnectionStore((s) => s.linearConfigured)
  const [creating, setCreating] = useState(false)
  const [createdIssue, setCreatedIssue] = useState<LinearIssue | null>(null)

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
          linearConfigured ? (
            <IconButton label="Linear 티켓 생성" onClick={() => setCreating(true)}>
              <SquarePen size={13} />
            </IconButton>
          ) : undefined
        }
      >
        <View widgetId={widget.id} config={config} envelope={envelope} width={width} />
      </WidgetShell>

      <LinearCreateIssueModal
        open={creating}
        onClose={() => setCreating(false)}
        onCreated={(issue) => {
          setCreating(false)
          setCreatedIssue(issue)
          window.dispatchEvent(new CustomEvent('pegboard:linear-created'))
        }}
      />
      <LinearIssueDetailModal issue={createdIssue} onClose={() => setCreatedIssue(null)} />
    </>
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
