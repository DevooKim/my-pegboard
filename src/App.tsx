import { Settings } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
import { AddWidgetMenu } from '#/board/AddWidgetMenu'
import { Board } from '#/board/Board'
import { SettingsModal, type SettingsTab } from '#/settings/SettingsModal'
import { useConnectionStore } from '#/store/connection'
import { bootstrap } from '#/store/persist'
import { startUpdateChecks, useUpdateStore } from '#/store/update'

export function App() {
  const [ready, setReady] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [settingsTab, setSettingsTab] = useState<SettingsTab>('connections')
  const hasUpdate = useUpdateStore((s) => s.hasUpdate)

  // 알려야 할 게 있으면 그것부터 보여준다 — 배지를 보고 열었다면 답은 정보 탭에 있다.
  const openSettings = useCallback(() => {
    setSettingsTab(hasUpdate ? 'about' : 'connections')
    setSettingsOpen(true)
  }, [hasUpdate])

  useEffect(() => {
    void bootstrap().finally(() => setReady(true))
  }, [])

  // 업데이트 확인은 보드가 그려진 뒤에 조용히 시작한다 (DECISIONS 23장).
  useEffect(() => startUpdateChecks(), [])

  // ⌘, 설정 / ⌘R 전체 새로고침 / ⌘⇧N 티켓 생성
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey && e.key === ',') {
        e.preventDefault()
        setSettingsOpen((v) => {
          // 열 때만 탭을 정한다. 닫는 길에 정하면 닫히는 화면이 한 번 깜빡인다.
          if (!v) setSettingsTab(useUpdateStore.getState().hasUpdate ? 'about' : 'connections')
          return !v
        })
      }
      if (e.metaKey && e.key === 'r') {
        e.preventDefault()
        window.dispatchEvent(new CustomEvent('pegboard:refresh-all'))
      }
      // ⇧를 먼저 본다 — ⌘N(위젯 추가)과 갈라져야 한다.
      //
      // 생성 폼은 Jira 위젯이 소유하므로(위젯 하나 = 폴더 하나) 여기서 직접 열지
      // 않고 알린다. 보드 위의 첫 Jira 위젯이 받아서 연다.
      if (e.metaKey && e.shiftKey && e.key.toLowerCase() === 'n') {
        e.preventDefault()
        window.dispatchEvent(new CustomEvent('pegboard:jira-create'))
      }
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [])

  return (
    <div className="flex h-full flex-col bg-surface-base text-text-primary">
      <AuthBanner onOpenSettings={openSettings} />
      {/* macOS 오버레이 타이틀바 — 창을 끌 수 있게 비워두되, 우측에 액션을 얹는다 */}
      <header
        data-tauri-drag-region
        className="flex h-9 shrink-0 items-center justify-end gap-1 pr-2 pl-20"
      >
        <AddWidgetMenu />
        <button
          type="button"
          onClick={openSettings}
          title={hasUpdate ? '설정 (⌘,) — 새 버전이 있습니다' : '설정 (⌘,)'}
          aria-label={hasUpdate ? '설정 — 새 버전이 있습니다' : '설정'}
          className="relative grid size-7 place-items-center rounded text-text-tertiary
                     transition-colors duration-fast hover:bg-surface-inset hover:text-text-primary"
        >
          <Settings size={14} />
          {/* 새 버전 알림. 업데이트는 에러가 아니므로 배너를 쓰지 않는다 —
              점 하나가 급수에 맞고, AuthBanner의 danger 채널과 섞이지 않는다.
              dismiss는 없다. 업데이트하면 사라진다. */}
          {hasUpdate && (
            <span
              aria-hidden="true"
              className="absolute top-1 right-1 size-1.5 rounded-full bg-accent
                         ring-2 ring-surface-base"
            />
          )}
        </button>
      </header>
      {ready && <Board />}
      <SettingsModal
        open={settingsOpen}
        initialTab={settingsTab}
        onClose={() => setSettingsOpen(false)}
        // 저장 직후 모든 위젯을 즉시 갱신한다. 저장의 결과가 화면 변화로 보여야 한다.
        onSaved={() => window.dispatchEvent(new CustomEvent('pegboard:refresh-all'))}
      />
    </div>
  )
}

/**
 * 인증 실패는 위젯마다 반복하지 않고 여기서 한 번만 알린다 (DECISIONS 16장).
 * 위젯 4개에 같은 401이 4번 뜨면 그건 소음이다.
 */
function AuthBanner({ onOpenSettings }: { onOpenSettings: () => void }) {
  const failed = useConnectionStore((s) => s.jiraAuthFailed)
  if (!failed) return null
  return (
    <div className="flex shrink-0 items-center gap-2 bg-danger-muted px-3 py-1.5">
      <span className="flex-1 text-caption text-danger">
        Jira 인증에 실패했습니다. API 토큰을 확인하세요.
      </span>
      <button
        type="button"
        onClick={onOpenSettings}
        className="shrink-0 rounded border border-danger/40 px-2 py-0.5 text-caption text-danger
                   hover:bg-danger/10"
      >
        설정 열기
      </button>
    </div>
  )
}
