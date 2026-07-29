import { useEffect } from 'react'

/**
 * 되돌릴 수 없는 동작 앞에 두는 확인창.
 *
 * 무엇을 잃는지 문장으로 밝힌다 — "정말요?"만 묻는 창은 읽히지 않고
 * 반사적으로 눌리므로 아무것도 막지 못한다.
 */
export function ConfirmDialog({
  open,
  title,
  message,
  confirmLabel,
  onConfirm,
  onCancel,
}: {
  open: boolean
  title: string
  message?: string
  confirmLabel: string
  onConfirm: () => void
  onCancel: () => void
}) {
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onCancel()
      if (e.key === 'Enter') onConfirm()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [open, onCancel, onConfirm])

  if (!open) return null

  return (
    <div className="fixed inset-0 z-100 grid place-items-center bg-black/50 p-8">
      <button
        type="button"
        aria-label="취소"
        tabIndex={-1}
        onClick={onCancel}
        className="absolute inset-0 cursor-default"
      />
      <div
        role="alertdialog"
        aria-modal="true"
        aria-label={title}
        className="relative w-full max-w-sm overflow-hidden rounded-xl border border-border-subtle
                   bg-surface-overlay shadow-2xl"
      >
        <div className="px-4 py-4">
          <h2 className="text-body text-text-primary">{title}</h2>
          {message && (
            <p className="mt-1 text-caption text-text-tertiary leading-relaxed-ko">{message}</p>
          )}
        </div>
        <div className="flex justify-end gap-2 border-border-subtle border-t px-4 py-3">
          <button
            type="button"
            onClick={onCancel}
            className="rounded border border-border-subtle px-3 py-1.5 text-caption text-text-secondary
                       hover:bg-surface-inset"
          >
            취소
          </button>
          <button
            type="button"
            // biome-ignore lint/a11y/noAutofocus: 확인창은 열리자마자 Enter/ESC로 끝낼 수 있어야 한다
            autoFocus
            onClick={onConfirm}
            className="rounded bg-danger px-3 py-1.5 text-caption text-surface-base"
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  )
}
