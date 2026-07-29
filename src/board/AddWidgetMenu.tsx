import { Plus } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { useActiveBoard, useBoardStore } from '#/store/board'
import { listWidgets } from '#/widgets/registry'

export function AddWidgetMenu() {
  const [open, setOpen] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const addWidget = useBoardStore((s) => s.addWidget)
  const board = useActiveBoard()
  const ref = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false)
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  // ⌘N
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey && e.key === 'n') {
        e.preventDefault()
        setOpen((v) => !v)
      }
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [])

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-1 rounded px-2 py-1 text-caption text-text-secondary
                   transition-colors duration-fast hover:bg-surface-inset hover:text-text-primary"
        title="위젯 추가 (⌘N)"
      >
        <Plus size={13} />
        위젯 추가
      </button>

      {open && (
        <div
          className="absolute right-0 z-50 mt-1 w-64 overflow-hidden rounded-lg border
                     border-border-subtle bg-surface-overlay shadow-lg"
        >
          {listWidgets().map((def) => {
            const used = board.widgets.filter((w) => w.type === def.type).length
            const full = used >= def.maxInstances
            const Icon = def.icon
            return (
              <button
                key={def.type}
                type="button"
                disabled={full}
                onClick={() => {
                  const r = addWidget(def.type)
                  if (r.ok) {
                    setOpen(false)
                    setError(null)
                  } else {
                    setError(r.reason)
                  }
                }}
                className="flex w-full items-start gap-2 px-3 py-2 text-left
                           transition-colors duration-fast hover:bg-surface-inset
                           disabled:cursor-not-allowed disabled:opacity-40"
              >
                <Icon size={15} className="mt-0.5 shrink-0 text-text-tertiary" />
                <span className="min-w-0 flex-1">
                  <span className="block text-body text-text-primary">{def.label}</span>
                  <span className="block text-caption text-text-tertiary">{def.description}</span>
                </span>
                <span className="shrink-0 text-caption text-text-quaternary tabular-nums">
                  {used}/{def.maxInstances}
                </span>
              </button>
            )
          })}
          {error && (
            <p className="border-border-subtle border-t px-3 py-2 text-caption text-danger">
              {error}
            </p>
          )}
        </div>
      )}
    </div>
  )
}
