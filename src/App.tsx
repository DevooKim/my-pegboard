import { Settings, SquarePen } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
import { AddWidgetMenu } from '#/board/AddWidgetMenu'
import { Board } from '#/board/Board'
import { SettingsModal } from '#/settings/SettingsModal'
import { useConnectionStore } from '#/store/connection'
import { bootstrap } from '#/store/persist'
import { CreateIssueModal } from '#/widgets/jira/CreateIssueModal'
import { IssueDetailModal } from '#/widgets/jira/IssueDetailModal'

export function App() {
  const [ready, setReady] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [createOpen, setCreateOpen] = useState(false)
  /** 생성 직후 "상세 보기"로 연 티켓. 목록을 거치지 않으므로 seed가 없다. */
  const [createdDetail, setCreatedDetail] = useState<string | null>(null)
  const openSettings = useCallback(() => setSettingsOpen(true), [])
  const jiraConfigured = useConnectionStore((s) => s.jiraConfigured)

  useEffect(() => {
    void bootstrap().finally(() => setReady(true))
  }, [])

  // ⌘, 설정 / ⌘R 전체 새로고침 / ⌘⇧N 티켓 생성
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey && e.key === ',') {
        e.preventDefault()
        setSettingsOpen((v) => !v)
      }
      if (e.metaKey && e.key === 'r') {
        e.preventDefault()
        window.dispatchEvent(new CustomEvent('pegboard:refresh-all'))
      }
      // ⇧를 먼저 본다 — ⌘N(위젯 추가)과 갈라져야 한다.
      if (e.metaKey && e.shiftKey && e.key.toLowerCase() === 'n') {
        e.preventDefault()
        setCreateOpen(true)
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
        {/* Jira 연결이 없으면 만들 곳이 없다 — 버튼을 숨긴다. */}
        {jiraConfigured && (
          <button
            type="button"
            onClick={() => setCreateOpen(true)}
            title="티켓 생성 (⌘⇧N)"
            aria-label="티켓 생성"
            className="grid size-7 place-items-center rounded text-text-tertiary
                       transition-colors duration-fast hover:bg-surface-inset hover:text-text-primary"
          >
            <SquarePen size={14} />
          </button>
        )}
        <AddWidgetMenu />
        <button
          type="button"
          onClick={openSettings}
          title="설정 (⌘,)"
          aria-label="설정"
          className="grid size-7 place-items-center rounded text-text-tertiary
                     transition-colors duration-fast hover:bg-surface-inset hover:text-text-primary"
        >
          <Settings size={14} />
        </button>
      </header>
      {ready && <Board />}
      <SettingsModal
        open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        // 저장 직후 모든 위젯을 즉시 갱신한다. 저장의 결과가 화면 변화로 보여야 한다.
        onSaved={() => window.dispatchEvent(new CustomEvent('pegboard:refresh-all'))}
      />
      <CreateIssueModal
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        onCreated={(key) => {
          setCreateOpen(false)
          setCreatedDetail(key)
        }}
      />
      {/* 생성 → "상세 보기". 목록을 거치지 않아 골격(seed)이 없다. */}
      <IssueDetailModal
        issueKey={createdDetail}
        seed={null}
        onClose={() => setCreatedDetail(null)}
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
