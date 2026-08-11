import { RefreshCw, Settings2, X } from 'lucide-react'
import type { ReactNode } from 'react'
import { absoluteTime, relativeTime, useNow } from '#/ui/relativeTime'
import type { WidgetStatus } from '#/widgets/types'

/**
 * 모든 위젯이 공유하는 껍데기.
 *
 * 헤더·새로고침·상태 표시·삭제를 여기서 한 번만 구현하는 이유:
 * 위젯마다 만들면 "Jira는 에러가 보이는데 GitHub은 조용히 실패"하는
 * 불일치가 생긴다 (DECISIONS 4장).
 *
 * 갱신 중에도 본문을 스켈레톤으로 갈아끼우지 않는다. 헤더에 2px 스윕 바만
 * 지나간다 — 목록이 사라지지 않는 것이 이 앱의 핵심 약속이다.
 */
export function WidgetShell({
  title,
  status,
  fetchedAt,
  pollable,
  onRefresh,
  onConfigure,
  onRemove,
  actions,
  headerMode = 'static',
  children,
}: {
  title: string
  status: WidgetStatus
  fetchedAt: string | null
  pollable: boolean
  onRefresh: () => void
  onConfigure: () => void
  onRemove: () => void
  /** 사진처럼 본문이 주인공인 위젯은 헤더를 본문 위에 겹쳐 필요할 때만 보인다. */
  headerMode?: 'static' | 'hover-overlay'
  /**
   * 위젯 고유 동작. 공통 버튼(새로고침·설정·삭제) **왼쪽**에 놓인다.
   *
   * 셸이 위젯 종류를 알면 안 되므로(위젯 하나 = 폴더 하나) 여기서는 자리만
   * 내주고 내용은 각 위젯이 채운다. Jira의 "티켓 생성"이 그 첫 사례다.
   *
   * `IconButton`을 export해 두었으니 그것을 쓰면 생김새가 공통 버튼과 같아진다.
   */
  actions?: ReactNode
  children: ReactNode
}) {
  // 데이터가 안 바뀌어도 시간은 흐른다. 자동 새로고침을 꺼두면 리렌더가
  // 없어 "방금"이 그대로 남으므로, 1분마다 스스로 다시 그린다.
  const now = useNow()
  const refreshing = status === 'loading'
  const isStale = status === 'stale' || status === 'error-transient'

  return (
    <section
      className="group relative flex h-full flex-col overflow-hidden rounded-lg border bg-surface-raised"
      style={{
        borderColor: isStale ? 'var(--color-stale-border)' : 'var(--color-border-subtle)',
      }}
    >
      <header
        data-widget-drag-handle
        className={
          headerMode === 'hover-overlay'
            ? `absolute inset-x-0 top-0 z-10 flex cursor-move items-center gap-2
               border-border-subtle border-b bg-surface-raised/95 px-2 py-1.5 opacity-0
               transition-opacity duration-fast group-hover:opacity-100
               group-focus-within:opacity-100`
            : `relative flex shrink-0 cursor-move items-center gap-2 border-border-subtle
               border-b px-2 py-1.5`
        }
      >
        <h2 className="min-w-0 flex-1 truncate text-caption text-text-secondary">{title}</h2>

        {/*
          마지막으로 데이터를 가져온 시각. 새로고침 버튼 바로 왼쪽에 상시 표시한다 —
          위치가 곧 의미다(이 버튼을 마지막으로 누른 것과 같은 효과가 일어난 시점).
          stale일 때만 색이 앰버로 바뀐다.
        */}
        {fetchedAt && (
          // 헤더 전체가 드래그 핸들이라 여기서 포인터를 막지 않으면
          // 툴팁을 보려고 올린 커서가 위젯을 끌어버린다.
          <span
            onPointerDown={(e) => e.stopPropagation()}
            className={`shrink-0 cursor-default text-caption tabular-nums ${
              isStale ? 'text-stale' : 'text-text-quaternary'
            }`}
            title={`마지막 갱신: ${absoluteTime(fetchedAt)}`}
          >
            {relativeTime(fetchedAt, new Date(now))}
          </span>
        )}

        {/* 드래그 핸들 위의 버튼들 — 클릭이 드래그로 먹히지 않게 stopPropagation */}
        <div
          className="flex shrink-0 items-center gap-0.5"
          onPointerDown={(e) => e.stopPropagation()}
        >
          {/* 위젯 고유 동작이 먼저. 공통 버튼(새로고침·설정·삭제)의 자리가
              위젯마다 달라지면 근육기억이 깨진다. */}
          {actions}
          {pollable && (
            <IconButton label="새로고침" onClick={onRefresh} disabled={refreshing}>
              <RefreshCw size={13} className={refreshing ? 'animate-spin' : undefined} />
            </IconButton>
          )}
          <IconButton label="위젯 설정" onClick={onConfigure}>
            <Settings2 size={13} />
          </IconButton>
          <IconButton label="위젯 삭제" onClick={onRemove}>
            <X size={13} />
          </IconButton>
        </div>

        {refreshing && (
          <span
            aria-hidden
            className="absolute inset-x-0 bottom-0 h-0.5 overflow-hidden bg-transparent"
          >
            <span className="block h-full w-1/3 animate-[refresh-sweep_1.1s_ease-in-out_infinite] bg-accent" />
          </span>
        )}
      </header>

      <div className="min-h-0 flex-1">{children}</div>
    </section>
  )
}

export function IconButton({
  label,
  onClick,
  disabled,
  children,
}: {
  label: string
  onClick: () => void
  disabled?: boolean
  children: ReactNode
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={label}
      aria-label={label}
      className="grid size-6 place-items-center rounded text-text-tertiary
                 transition-colors duration-fast hover:bg-surface-inset hover:text-text-primary
                 disabled:opacity-40 focus-visible:outline-2 focus-visible:outline-accent"
    >
      {children}
    </button>
  )
}
