import { X } from 'lucide-react'
import { useEffect, useState } from 'react'
import { useBoardStore } from '#/store/board'
import { getWidget } from '#/widgets/registry'
import type { WidgetInstance } from '#/widgets/types'

/**
 * 위젯별 설정 모달.
 *
 * 앱 전역 설정(계정·테마)과 분리된다 — DECISIONS 15장의 경계.
 * 여기는 "이 위젯이 무엇을 보여줄 것인가"만 다룬다.
 *
 * 편집은 로컬 상태에서 하고 저장할 때 반영한다. 타이핑 한 글자마다
 * config가 바뀌면 JQL을 쓰는 도중 매번 API를 때린다.
 */
export function WidgetConfigModal({
  widget,
  onClose,
}: {
  widget: WidgetInstance | null
  onClose: () => void
}) {
  const updateConfig = useBoardStore((s) => s.updateWidgetConfig)
  const [draft, setDraft] = useState<Record<string, unknown> | null>(null)

  // 모달이 열릴 때마다 현재 설정을 복사해 온다.
  useEffect(() => {
    setDraft(widget ? structuredClone(widget.config) : null)
  }, [widget])

  useEffect(() => {
    if (!widget) return
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [widget, onClose])

  if (!widget || !draft) return null

  const definition = getWidget(widget.type)
  const ConfigForm = definition.ConfigForm

  const apply = () => {
    updateConfig(widget.id, draft)
    onClose()
  }

  return (
    <div className="fixed inset-0 z-100 grid place-items-center bg-black/50 p-8">
      <button
        type="button"
        aria-label="설정 닫기"
        tabIndex={-1}
        onClick={onClose}
        className="absolute inset-0 cursor-default"
      />
      <div
        role="dialog"
        aria-modal="true"
        aria-label={`${definition.label} 위젯 설정`}
        className="relative flex max-h-full w-full max-w-md flex-col overflow-hidden rounded-xl
                   border border-border-subtle bg-surface-overlay shadow-2xl"
      >
        <header className="flex shrink-0 items-center justify-between border-border-subtle border-b px-4 py-3">
          <h2 className="text-body text-text-primary">{definition.label} 위젯 설정</h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="닫기"
            className="grid size-7 place-items-center rounded text-text-tertiary
                       hover:bg-surface-inset hover:text-text-primary"
          >
            <X size={15} />
          </button>
        </header>

        <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4">
          <ConfigForm config={draft} onChange={setDraft} />
        </div>

        <footer className="flex shrink-0 justify-end gap-2 border-border-subtle border-t px-4 py-3">
          <button
            type="button"
            onClick={onClose}
            className="rounded border border-border-subtle px-3 py-1.5 text-caption text-text-secondary
                       hover:bg-surface-inset"
          >
            취소
          </button>
          <button
            type="button"
            onClick={apply}
            className="rounded bg-accent px-3 py-1.5 text-caption text-surface-base"
          >
            적용
          </button>
        </footer>
      </div>
    </div>
  )
}
