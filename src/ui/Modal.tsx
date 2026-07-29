import { type ReactNode, useEffect } from 'react'
import { createPortal } from 'react-dom'

/**
 * 모달의 공통 껍데기.
 *
 * **반드시 포털로 body에 붙인다.** 위젯 안에서 렌더하면 위젯의
 * `overflow-hidden`과 그리드 셀 경계에 잘려서 위젯 안에만 갇힌다.
 * `position: fixed`도 소용없다 — 조상에 transform이 걸려 있으면
 * (react-grid-layout이 걸어둔다) fixed의 기준이 뷰포트가 아니게 된다.
 *
 * 열려 있는 동안 배경 스크롤을 막는다. 안 막으면 모달 위에서 굴린 휠이
 * 뒤 목록을 움직여서, 닫았을 때 엉뚱한 위치에 가 있다.
 */
export function Modal({
  open,
  onClose,
  labelledBy,
  role = 'dialog',
  children,
  className = 'max-w-lg',
}: {
  open: boolean
  onClose: () => void
  labelledBy: string
  role?: 'dialog' | 'alertdialog'
  children: ReactNode
  /** 너비 등 컨테이너 클래스 */
  className?: string
}) {
  useEffect(() => {
    if (!open) return

    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKey)

    // 스크롤바가 사라지며 레이아웃이 튀지 않도록 그 폭만큼 패딩으로 보상한다.
    const { body } = document
    const gap = window.innerWidth - document.documentElement.clientWidth
    const prevOverflow = body.style.overflow
    const prevPadding = body.style.paddingRight
    body.style.overflow = 'hidden'
    if (gap > 0) body.style.paddingRight = `${gap}px`

    return () => {
      document.removeEventListener('keydown', onKey)
      body.style.overflow = prevOverflow
      body.style.paddingRight = prevPadding
    }
  }, [open, onClose])

  if (!open) return null

  return createPortal(
    <div className="fixed inset-0 z-100 grid place-items-center p-8">
      {/* 바깥 클릭으로 닫기. ESC도 되므로 키보드 접근성은 확보돼 있다. */}
      <button
        type="button"
        aria-hidden="true"
        tabIndex={-1}
        onClick={onClose}
        className="absolute inset-0 cursor-default bg-black/50"
      />
      {/* biome-ignore lint/a11y/useAriaPropsSupportedByRole: role은 dialog|alertdialog로 제한돼 있고
          둘 다 aria-modal을 지원한다. 변수라서 정적 분석이 좁히지 못할 뿐이다. */}
      <div
        role={role}
        aria-modal="true"
        aria-labelledby={labelledBy}
        className={`relative flex max-h-full w-full flex-col overflow-hidden rounded-xl
                    border border-border-subtle bg-surface-overlay shadow-2xl ${className}`}
      >
        {children}
      </div>
    </div>,
    document.body,
  )
}
