import { useEffect, useState } from 'react'
import { AddWidgetMenu } from '#/board/AddWidgetMenu'
import { Board } from '#/board/Board'
import { useConnectionStore } from '#/store/connection'
import { bootstrap } from '#/store/persist'

export function App() {
  const [ready, setReady] = useState(false)

  useEffect(() => {
    void bootstrap().finally(() => setReady(true))
  }, [])

  return (
    <div className="flex h-full flex-col bg-surface-base text-text-primary">
      <AuthBanner />
      {/* macOS 오버레이 타이틀바 — 창을 끌 수 있게 비워두되, 우측에 액션을 얹는다 */}
      <header
        data-tauri-drag-region
        className="flex h-9 shrink-0 items-center justify-end gap-1 pr-2 pl-20"
      >
        <AddWidgetMenu />
      </header>
      {ready && <Board />}
    </div>
  )
}

/**
 * 인증 실패는 위젯마다 반복하지 않고 여기서 한 번만 알린다 (DECISIONS 16장).
 * 위젯 4개에 같은 401이 4번 뜨면 그건 소음이다.
 */
function AuthBanner() {
  const failed = useConnectionStore((s) => s.jiraAuthFailed)
  if (!failed) return null
  return (
    <div className="shrink-0 bg-danger-muted px-3 py-1.5 text-caption text-danger">
      Jira 인증에 실패했습니다. 설정에서 API 토큰을 확인하세요.
    </div>
  )
}
