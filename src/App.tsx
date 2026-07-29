import { Board } from '#/board/Board'

export function App() {
  return (
    <div className="h-full bg-[--color-surface-base] text-[--color-text-primary]">
      {/* macOS 오버레이 타이틀바 영역 — 창을 끌 수 있게 비워둔다 */}
      <div data-tauri-drag-region className="h-9 w-full shrink-0" />
      <Board />
    </div>
  )
}
