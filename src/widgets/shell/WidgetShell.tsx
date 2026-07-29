import { RefreshCw, Settings2, X } from 'lucide-react'
import type { ReactNode } from 'react'
import { relativeTime } from '#/ui/relativeTime'
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
  children,
}: {
  title: string
  status: WidgetStatus
  fetchedAt: string | null
  pollable: boolean
  onRefresh: () => void
  onConfigure: () => void
  onRemove: () => void
  children: ReactNode
}) {
  const refreshing = status === 'loading'
  const isStale = status === 'stale' || status === 'error-transient'

  return (
    <section
      className="flex h-full flex-col overflow-hidden rounded-lg border bg-surface-raised"
      style={{
        borderColor: isStale ? 'var(--color-stale-border)' : 'var(--color-border-subtle)',
      }}
    >
      <header
        data-widget-drag-handle
        className="relative flex shrink-0 cursor-move items-center gap-2 border-border-subtle border-b px-2 py-1.5"
      >
        <h2 className="min-w-0 flex-1 truncate text-caption text-text-secondary">{title}</h2>

        {isStale && fetchedAt && (
          <span className="shrink-0 text-caption text-stale tabular-nums">
            {relativeTime(fetchedAt)}
          </span>
        )}

        {/* 드래그 핸들 위의 버튼들 — 클릭이 드래그로 먹히지 않게 stopPropagation */}
        <div
          className="flex shrink-0 items-center gap-0.5"
          onPointerDown={(e) => e.stopPropagation()}
        >
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

function IconButton({
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
