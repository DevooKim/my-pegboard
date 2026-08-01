import { RotateCw, X } from 'lucide-react'
import type { CarryOverReport } from '#/ipc/bindings'

/**
 * 이월 알림.
 *
 * 이월은 **사용자가 요청하지 않았는데 데이터가 움직이는 유일한 동작**이다.
 * 그게 일어났다는 사실은 드러나야 한다(CLAUDE.md 대전제 2).
 *
 * 토스트를 쓰지 않는다(DESIGN 5.3). 스스로 사라지지도 않는다 — 사라지는
 * 알림을 거부한 것과 같은 이유다. 사용자가 닫거나, 되돌리거나, 날짜를
 * 옮기면 사라진다.
 */
export function CarryBanner({
  report,
  onUndo,
  onDismiss,
}: {
  report: CarryOverReport
  onUndo: () => void
  onDismiss: () => void
}) {
  const count = report.carried.length
  if (count === 0) return null

  return (
    <div className="flex shrink-0 items-center gap-1.5 border-border-subtle border-b bg-surface-inset px-2 py-1">
      <RotateCw size={11} className="shrink-0 text-text-tertiary" aria-hidden="true" />
      <span className="min-w-0 flex-1 truncate text-caption text-text-secondary">
        {describe(report.sourceDates.length, count)}
      </span>
      <button
        type="button"
        onClick={onUndo}
        className="shrink-0 rounded px-1.5 py-0.5 text-caption text-accent hover:bg-surface-raised
                   focus-visible:outline-2 focus-visible:outline-accent"
      >
        되돌리기
      </button>
      <button
        type="button"
        onClick={onDismiss}
        title="닫기"
        aria-label="이월 알림 닫기"
        className="shrink-0 rounded p-0.5 text-text-quaternary hover:text-text-primary
                   focus-visible:outline-2 focus-visible:outline-accent"
      >
        <X size={11} />
      </button>
    </div>
  )
}

/**
 * 며칠치에서 왔는지 말해준다.
 *
 * 주말을 건너뛰면 여러 날에서 한꺼번에 온다 — "어제에서"라고 하면 거짓말이다.
 */
function describe(sourceDays: number, count: number): string {
  if (sourceDays <= 1) return `어제에서 ${count}개를 가져왔습니다`
  return `${sourceDays}일치에서 ${count}개를 가져왔습니다`
}
