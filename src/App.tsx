import { Columns, Settings } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
import { AddWidgetMenu } from '#/board/AddWidgetMenu'
import { Board } from '#/board/Board'
import { BoardTabs } from '#/board/BoardTabs'
import { SettingsModal, type SettingsTab } from '#/settings/SettingsModal'
import { useBoardStore } from '#/store/board'
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
      // ⌘1~⌘9 보드 전환. 브라우저·에디터의 탭 전환 관례를 그대로 따른다.
      // 기존 단축키(⌘, ⌘R ⌘N ⌘⇧N)와 겹치지 않는다. ⇧를 안 눌렀을 때만 —
      // ⌘⇧숫자는 macOS 입력기가 가져가는 경우가 있다.
      if (e.metaKey && !e.shiftKey && !e.altKey && e.key >= '1' && e.key <= '9') {
        const state = useBoardStore.getState()
        const target = state.boards[Number(e.key) - 1]
        // 보드가 그 자리에 없으면 아무것도 하지 않는다. preventDefault도 하지
        // 않아서 다른 핸들러가 있다면 그쪽이 받는다.
        if (target) {
          e.preventDefault()
          state.setActiveBoard(target.id)
        }
      }
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [])

  return (
    <div className="flex h-full flex-col bg-surface-base text-text-primary">
      <AuthBanner onOpenSettings={openSettings} />
      {/* macOS 오버레이 타이틀바 — 창을 끌 수 있게 비워두되, 좌측에 보드 탭,
          우측에 액션을 얹는다.

          보드 탭이 여기 있는 이유: 보드 영역을 쓰지 않으려면 이미 비어 있는
          줄에 넣어야 한다. pl-20은 신호등 버튼 자리다. */}
      <header data-tauri-drag-region className="flex h-9 shrink-0 items-center gap-1 pr-2 pl-20">
        <BoardTabs />
        <div data-tauri-drag-region className="flex-1" />
        <AddBoardButton />
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
 * 보드가 하나일 때만 보이는 "보드 추가".
 *
 * BoardTabs는 탭이 1개면 아무것도 그리지 않는다(DECISIONS 14장 개정 — 쓰지
 * 않는 기능이 화면을 차지하면 안 된다). 그러면 보드를 처음 만들 길이 없어지므로
 * 여기에 하나 둔다. 탭이 생기면 사라지고, 그 뒤로는 탭 바의 ✚가 받는다.
 *
 * ✚가 아니라 칸 아이콘을 쓴다 — 옆의 "위젯 추가"와 같은 모양이면 둘 중
 * 무엇이 무엇인지 아이콘만으로 구분되지 않는다.
 */
function AddBoardButton() {
  const boardCount = useBoardStore((s) => s.boards.length)
  const addBoard = useBoardStore((s) => s.addBoard)
  if (boardCount > 1) return null
  return (
    <button
      type="button"
      onClick={() => addBoard()}
      title="보드 추가 — 맥락이 다른 위젯 묶음을 따로 둡니다"
      aria-label="보드 추가"
      className="flex items-center gap-1 rounded px-2 py-1 text-caption text-text-tertiary
                 transition-colors duration-fast hover:bg-surface-inset hover:text-text-primary"
    >
      <Columns size={13} />
      보드 추가
    </button>
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
