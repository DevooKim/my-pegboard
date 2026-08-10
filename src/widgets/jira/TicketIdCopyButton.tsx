import { Check, Copy } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'

type CopyStatus = 'idle' | 'copied' | 'error'

export function TicketIdCopyButton({ identifier }: { identifier: string }) {
  const [status, setStatus] = useState<CopyStatus>('idle')
  const resetTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(
    () => () => {
      if (resetTimer.current) clearTimeout(resetTimer.current)
    },
    [],
  )

  const copy = async () => {
    if (resetTimer.current) clearTimeout(resetTimer.current)

    try {
      await navigator.clipboard.writeText(identifier)
      setStatus('copied')
      resetTimer.current = setTimeout(() => {
        setStatus('idle')
        resetTimer.current = null
      }, 1_500)
    } catch {
      setStatus('error')
    }
  }

  return (
    <button
      type="button"
      onClick={() => void copy()}
      aria-label={`${identifier} ${status === 'copied' ? '복사됨' : '복사'}`}
      className="ticket-key flex items-center gap-1 rounded text-text-secondary hover:text-accent
                 focus-visible:outline-2 focus-visible:outline-accent"
    >
      {status === 'copied' ? (
        <Check size={11} aria-hidden="true" />
      ) : (
        <Copy size={11} aria-hidden="true" />
      )}
      <span>{identifier}</span>
      {status === 'copied' && <span className="text-caption">복사됨</span>}
      {status === 'error' && <span className="text-caption text-danger">복사하지 못했습니다</span>}
    </button>
  )
}
