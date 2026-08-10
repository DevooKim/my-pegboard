import { openUrl } from '@tauri-apps/plugin-opener'
import { AlertCircle, Check, ExternalLink, Loader2, X } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
import appIcon from '#/assets/icon.png'
import { type BoardImportCandidate, type BoardImportMode, commands } from '#/ipc/bindings'
import { IN_TAURI } from '#/ipc/env'
import { useBoardStore } from '#/store/board'
import { useConnectionStore } from '#/store/connection'
import { flushPendingSaves } from '#/store/persist'
import { RELEASES_PAGE, type UpdatePhase, useUpdateStore } from '#/store/update'
import { Modal } from '#/ui/Modal'

const TOKEN_PAGE = 'https://id.atlassian.com/manage-profile/security/api-tokens'
/** Classic PAT 발급 페이지. 스코프를 미리 채워 보낸다. */
const GITHUB_TOKEN_PAGE =
  'https://github.com/settings/tokens/new?scopes=repo,read:org&description=my-pegboard'
/** Linear의 개인 API 키 발급 페이지. 워크스페이스와 무관한 계정 설정이다. */
const LINEAR_TOKEN_PAGE = 'https://linear.app/settings/account/security'

type TestState =
  | { kind: 'idle' }
  | { kind: 'testing' }
  | { kind: 'ok'; displayName: string }
  | { kind: 'failed'; message: string }

export type SettingsTab = 'connections' | 'board' | 'about'

/**
 * 통합 설정창 (DECISIONS 15장).
 *
 * 별도 Tauri 창이 아니라 전체 모달인 이유: 별도 창은 위치 기억·중복 방지·
 * 포커스 관리라는 상태가 늘지만 얻는 게 없다. 잠깐 열었다 닫는 화면이다.
 *
 * 연결·보드·정보를 별도 탭으로 나눈다. 연결은 자격증명, 보드는 배치 전송,
 * 정보는 버전/업데이트라는 서로 다른 책임이라 한 스크롤에 섞지 않는다.
 *
 * 토큰은 이 폼을 떠나 키체인으로 바로 간다. 어떤 상태에도 보관하지 않고,
 * 저장 직후 입력을 비운다.
 */
export function SettingsModal({
  open,
  onClose,
  onSaved,
  initialTab = 'connections',
}: {
  open: boolean
  onClose: () => void
  onSaved: () => void
  /** 열 때 보여줄 탭. 업데이트 배지로 들어오면 'about'이다. */
  initialTab?: SettingsTab
}) {
  const [tab, setTab] = useState<SettingsTab>(initialTab)

  // 열 때마다 요청된 탭으로 되돌린다. 마지막 탭을 기억하지 않는다 —
  // 어제 정보 탭을 봤다고 오늘 설정을 열었을 때 정보가 뜨면 당황스럽다.
  useEffect(() => {
    if (open) setTab(initialTab)
  }, [open, initialTab])

  return (
    <Modal open={open} onClose={onClose} labelledBy="settings-title">
      <header className="flex shrink-0 items-center justify-between border-border-subtle border-b px-4 pt-3">
        <div className="flex flex-col gap-3">
          <h2 id="settings-title" className="text-body text-text-primary">
            설정
          </h2>
          {/* 탭. 밑줄 하나로만 현재 위치를 말한다 — 알약 배경이나 채움은
              이 앱의 "크롬은 얇을수록 좋다"와 어긋난다. */}
          <div role="tablist" aria-label="설정 구획" className="-mb-px flex gap-1">
            <TabButton id="connections" current={tab} onSelect={setTab}>
              연결
            </TabButton>
            <TabButton id="board" current={tab} onSelect={setTab}>
              보드
            </TabButton>
            <TabButton id="about" current={tab} onSelect={setTab}>
              정보
            </TabButton>
          </div>
        </div>
        <button
          type="button"
          onClick={onClose}
          aria-label="닫기"
          className="-mt-0.5 grid size-7 place-items-center self-start rounded text-text-tertiary
                       hover:bg-surface-inset hover:text-text-primary"
        >
          <X size={15} />
        </button>
      </header>

      <div
        role="tabpanel"
        id={`settings-panel-${tab}`}
        aria-labelledby={`settings-tab-${tab}`}
        className="min-h-0 flex-1 overflow-y-auto px-4 py-4"
      >
        {tab === 'connections' ? (
          <>
            <JiraSection onSaved={onSaved} onClose={onClose} />
            <hr className="my-5 border-border-subtle" />
            <GithubSection onSaved={onSaved} />
            <hr className="my-5 border-border-subtle" />
            <LinearSection onSaved={onSaved} />
          </>
        ) : tab === 'board' ? (
          <BoardSection />
        ) : (
          <AboutSection />
        )}
      </div>
    </Modal>
  )
}

function BoardSection() {
  const replaceFromImport = useBoardStore((state) => state.replaceFromImport)
  const restart = useUpdateStore((state) => state.restart)
  const [preview, setPreview] = useState<BoardImportCandidate | null>(null)
  const [mode, setMode] = useState<BoardImportMode>('replace')
  const [exportState, setExportState] = useState<
    { kind: 'idle' } | { kind: 'ok'; path: string } | { kind: 'error'; message: string }
  >({ kind: 'idle' })
  const [importError, setImportError] = useState<string | null>(null)
  const [importWarning, setImportWarning] = useState<string | null>(null)
  const [restartRequired, setRestartRequired] = useState(false)
  const [relaunching, setRelaunching] = useState(false)
  const [relaunchError, setRelaunchError] = useState<string | null>(null)
  const [busy, setBusy] = useState<'export' | 'preview' | 'apply' | null>(null)

  const exportBoard = useCallback(async () => {
    setBusy('export')
    setExportState({ kind: 'idle' })
    try {
      await flushPendingSaves()
      const result = await commands.boardExport()
      if (result.status === 'error') {
        setExportState({ kind: 'error', message: result.error })
      } else if (result.data) {
        setExportState({ kind: 'ok', path: result.data })
      }
    } catch (error) {
      setExportState({ kind: 'error', message: errorMessage(error) })
    } finally {
      setBusy(null)
    }
  }, [])

  const previewImport = useCallback(async () => {
    setBusy('preview')
    setPreview(null)
    setImportError(null)
    setRelaunchError(null)
    try {
      const result = await commands.boardImportPreview()
      if (result.status === 'error') {
        setImportError(result.error)
      } else if (result.data) {
        setMode('replace')
        setPreview(result.data)
      }
    } catch (error) {
      setImportError(errorMessage(error))
    } finally {
      setBusy(null)
    }
  }, [])

  const applyImport = useCallback(async () => {
    if (!preview) return
    const candidate = preview
    setBusy('apply')
    setPreview(null)
    setImportError(null)
    setRelaunchError(null)
    try {
      await flushPendingSaves()
      const result = await commands.boardImportApply(candidate.file, mode)
      if (result.status === 'error') {
        setImportError(result.error)
        return
      }
      // Rust and the existing frontend store share the same wire shape. The
      // generated JsonValue config is intentionally wider than the widget
      // registry's local config type, so this is the one IPC hydration seam.
      replaceFromImport(result.data.board as never)
      setImportWarning(result.data.orphanCacheCleanupWarning)
      setRestartRequired(result.data.signal === 'relaunchRequired')
      setPreview(null)
    } catch (error) {
      setImportError(errorMessage(error))
    } finally {
      setBusy(null)
    }
  }, [mode, preview, replaceFromImport])

  const relaunchApp = useCallback(async () => {
    setRelaunching(true)
    setRelaunchError(null)
    try {
      await restart()
    } catch (error) {
      setRelaunchError(`앱을 재시작하지 못했습니다: ${errorMessage(error)}`)
    } finally {
      setRelaunching(false)
    }
  }, [restart])

  return (
    <section className="flex flex-col gap-5">
      <div>
        <h3 className="text-caption text-text-secondary">보드 설정</h3>
        <p className="mt-0.5 text-caption text-text-tertiary leading-relaxed-ko">
          보드, 배치, 위젯 설정만 내보냅니다. 토큰·이메일·Todo 데이터·API 캐시는 포함하지 않습니다.
        </p>
      </div>

      <div className="flex flex-col gap-2">
        <h4 className="text-caption text-text-secondary">내보내기</h4>
        <button
          type="button"
          onClick={() => void exportBoard()}
          disabled={busy !== null}
          className={`${primaryPill} self-start disabled:cursor-not-allowed disabled:opacity-40`}
        >
          {busy === 'export' && <Loader2 size={13} className="mr-1.5 inline animate-spin" />}
          내보내기
        </button>
        {exportState.kind === 'ok' && (
          <p className="flex items-start gap-1.5 text-caption text-success">
            <Check size={13} className="mt-0.5 shrink-0" />
            내보냈습니다: <span className="break-all">{exportState.path}</span>
          </p>
        )}
        {exportState.kind === 'error' && (
          <p className="text-caption text-danger leading-relaxed-ko">{exportState.message}</p>
        )}
      </div>

      <div className="flex flex-col gap-2">
        <h4 className="text-caption text-text-secondary">가져오기</h4>
        <button
          type="button"
          onClick={() => void previewImport()}
          disabled={busy !== null}
          className={`${neutralPill} self-start disabled:cursor-not-allowed disabled:opacity-40`}
        >
          {busy === 'preview' && <Loader2 size={13} className="mr-1.5 inline animate-spin" />}
          가져오기
        </button>
        {importError && (
          <p className="text-caption text-danger leading-relaxed-ko">{importError}</p>
        )}
        {importWarning && (
          <p className="text-caption text-warning leading-relaxed-ko">{importWarning}</p>
        )}
        {restartRequired && (
          <div
            role="alert"
            className="flex flex-col gap-2 rounded bg-warning-muted p-2 text-caption text-warning"
          >
            <p>앨범 경로 권한 변경은 앱 재시작 후 반영됩니다.</p>
            <button
              type="button"
              onClick={() => void relaunchApp()}
              disabled={relaunching}
              className={`${neutralPill} self-start disabled:cursor-not-allowed disabled:opacity-40`}
            >
              {relaunching && <Loader2 size={13} className="mr-1.5 inline animate-spin" />}앱 재시작
            </button>
            {relaunchError && <p className="text-danger">{relaunchError}</p>}
          </div>
        )}
      </div>

      {preview && (
        <ImportPreview
          candidate={preview}
          mode={mode}
          busy={busy}
          onModeChange={setMode}
          onApply={() => void applyImport()}
          onCancel={() => {
            setPreview(null)
            setImportError(null)
          }}
        />
      )}
    </section>
  )
}

function ImportPreview({
  candidate,
  mode,
  busy,
  onModeChange,
  onApply,
  onCancel,
}: {
  candidate: BoardImportCandidate
  mode: BoardImportMode
  busy: 'export' | 'preview' | 'apply' | null
  onModeChange: (mode: BoardImportMode) => void
  onApply: () => void
  onCancel: () => void
}) {
  const { preview } = candidate
  return (
    <section className="flex flex-col gap-3 rounded border border-border-subtle bg-surface-inset p-3">
      <div>
        <h4 className="text-caption text-text-secondary">가져오기 미리보기</h4>
        <p className="mt-1 text-caption text-text-primary">
          보드 {preview.boardCount}개 · 위젯 {preview.widgetCount}개
        </p>
        <p className="text-caption text-text-tertiary">
          export v{preview.formatVersion} · board v{preview.boardSchemaVersion}
        </p>
      </div>

      {preview.widgetCounts.length > 0 && (
        <ul className="flex flex-col gap-1 text-caption text-text-secondary">
          {preview.widgetCounts.map((item) => (
            <li key={item.widgetType}>
              {item.widgetType}: {item.count}개
            </li>
          ))}
        </ul>
      )}

      {preview.albumPathWarnings.length > 0 && (
        <div className="flex flex-col gap-1 rounded bg-warning-muted p-2 text-caption text-warning">
          <p className="flex items-center gap-1.5">
            <AlertCircle size={13} />
            찾을 수 없는 앨범 경로
          </p>
          <ul className="flex flex-col gap-0.5 break-all pl-5">
            {preview.albumPathWarnings.map((warning) => (
              <li key={warning.path}>{warning.path}</li>
            ))}
          </ul>
        </div>
      )}

      <fieldset className="flex flex-col gap-1.5">
        <legend className="text-caption text-text-secondary">가져오기 방식</legend>
        <label className="flex items-start gap-2 text-caption text-text-primary">
          <input
            type="radio"
            name="board-import-mode"
            value="replace"
            aria-label="교체"
            checked={mode === 'replace'}
            onChange={() => onModeChange('replace')}
          />
          <span>
            <span className="block">교체</span>
            {mode === 'replace' && (
              <span className="block text-danger">현재 보드 구성이 사라집니다.</span>
            )}
          </span>
        </label>
        <label className="flex items-start gap-2 text-caption text-text-primary">
          <input
            type="radio"
            name="board-import-mode"
            value="merge"
            aria-label="병합"
            checked={mode === 'merge'}
            onChange={() => onModeChange('merge')}
          />
          <span>
            <span className="block">병합</span>
            <span className="block text-text-tertiary">가져온 보드와 위젯 ID를 새로 만듭니다.</span>
          </span>
        </label>
      </fieldset>

      <div className="flex items-center gap-2 pt-1">
        <button
          type="button"
          onClick={onApply}
          disabled={busy !== null}
          className={`${primaryPill} disabled:cursor-not-allowed disabled:opacity-40`}
        >
          {busy === 'apply' && <Loader2 size={13} className="mr-1.5 inline animate-spin" />}
          {mode === 'replace' ? '교체 적용' : '병합 적용'}
        </button>
        <button
          type="button"
          onClick={onCancel}
          disabled={busy !== null}
          className="rounded-md px-3 py-1.5 text-caption text-text-tertiary hover:text-text-primary disabled:opacity-40"
        >
          취소
        </button>
      </div>
    </section>
  )
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function TabButton({
  id,
  current,
  onSelect,
  children,
}: {
  id: SettingsTab
  current: SettingsTab
  onSelect: (t: SettingsTab) => void
  children: React.ReactNode
}) {
  const active = current === id
  return (
    <button
      type="button"
      role="tab"
      id={`settings-tab-${id}`}
      aria-selected={active}
      aria-controls={`settings-panel-${id}`}
      onClick={() => onSelect(id)}
      className={`border-b-2 px-2.5 py-1.5 text-caption transition-colors duration-fast ${
        active
          ? 'border-accent text-text-primary'
          : 'border-transparent text-text-tertiary hover:text-text-secondary'
      }`}
    >
      {children}
    </button>
  )
}

/**
 * Jira 연결.
 *
 * 입력이 셋이다 — 사이트 URL·이메일·토큰. GitHub과 달리 self-hosted가 아니어도
 * 사이트마다 도메인이 다르고, Basic 인증이 `email:token`을 요구한다.
 */
function JiraSection({ onSaved, onClose }: { onSaved: () => void; onClose: () => void }) {
  const refreshConnection = useConnectionStore((s) => s.refresh)
  const configured = useConnectionStore((s) => s.jiraConfigured)
  const [baseUrl, setBaseUrl] = useState('https://your-team.atlassian.net')
  // 이 앱은 단일 사용자용이다. 매번 타이핑할 이유가 없으므로 미리 채운다.
  const [email, setEmail] = useState('you@example.com')
  const [token, setToken] = useState('')
  const [test, setTest] = useState<TestState>({ kind: 'idle' })
  const [saving, setSaving] = useState(false)

  const canSubmit = baseUrl.trim() && email.trim() && token.trim()

  const runTest = useCallback(async () => {
    if (!canSubmit || !IN_TAURI) return
    setTest({ kind: 'testing' })
    const r = await commands.jiraVerify(baseUrl.trim(), email.trim(), token.trim())
    setTest(
      r.status === 'ok'
        ? { kind: 'ok', displayName: r.data }
        : { kind: 'failed', message: r.error },
    )
  }, [baseUrl, email, token, canSubmit])

  const save = useCallback(async () => {
    if (!canSubmit || !IN_TAURI) return
    setSaving(true)
    const r = await commands.jiraSaveCredentials(baseUrl.trim(), email.trim(), token.trim())
    setSaving(false)

    if (r.status !== 'ok') {
      setTest({ kind: 'failed', message: r.error })
      return
    }

    setToken('') // 저장 후 폼에 남기지 않는다
    await refreshConnection()

    // 성공을 버튼 글자 변화로만 알리면 안 된다 — 방금 누른 버튼은
    // 이미 시선이 떠난 곳이라 안 보인다. 모달을 닫아서 결과를 화면 변화로 만든다.
    onSaved()
    onClose()
  }, [baseUrl, email, token, canSubmit, refreshConnection, onSaved, onClose])

  return (
    <section className="flex flex-col gap-3">
      <div>
        <h3 className="text-caption text-text-secondary">Jira 연결</h3>
        <p className="mt-0.5 text-caption text-text-tertiary leading-relaxed-ko">
          토큰은 macOS 키체인에 저장되며 파일이나 로그에 남지 않습니다.
        </p>
      </div>

      {/* 지금 연결돼 있는가 — 저장 여부를 매번 의심하지 않게 상시 표시한다 */}
      <p
        className={`flex items-center gap-1.5 rounded px-2 py-1.5 text-caption ${
          configured ? 'bg-success-muted text-success' : 'bg-surface-inset text-text-tertiary'
        }`}
      >
        {configured ? <Check size={13} /> : <AlertCircle size={13} />}
        {configured ? '연결됨 — 토큰이 키체인에 저장돼 있습니다' : '아직 연결되지 않았습니다'}
      </p>

      <Field label="사이트 URL">
        <input
          data-selectable
          value={baseUrl}
          onChange={(e) => setBaseUrl(e.target.value)}
          spellCheck={false}
          placeholder="https://your-team.atlassian.net"
          className={inputClass}
        />
      </Field>

      <Field label="계정 이메일">
        <input
          data-selectable
          type="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          spellCheck={false}
          placeholder="you@company.com"
          className={inputClass}
        />
      </Field>

      <Field label="API 토큰">
        <input
          data-selectable
          type="password"
          value={token}
          onChange={(e) => setToken(e.target.value)}
          spellCheck={false}
          autoComplete="off"
          placeholder="ATATT3x..."
          className={`${inputClass} font-mono`}
        />
        <button
          type="button"
          onClick={() => void openUrl(TOKEN_PAGE)}
          className="mt-1 flex items-center gap-1 self-start text-caption text-accent hover:underline"
        >
          토큰 발급 페이지 열기
          <ExternalLink size={11} />
        </button>
      </Field>

      {test.kind === 'ok' && (
        <p className="flex items-center gap-1.5 text-caption text-success">
          <Check size={13} />
          연결됨 — {test.displayName}
        </p>
      )}
      {test.kind === 'failed' && (
        <p className="text-caption text-danger leading-relaxed-ko">{test.message}</p>
      )}

      <div className="flex items-center gap-2 pt-1">
        <button
          type="button"
          onClick={() => void runTest()}
          disabled={!canSubmit || test.kind === 'testing'}
          className="flex items-center gap-1.5 rounded border border-border-subtle px-3 py-1.5
                       text-caption text-text-secondary hover:bg-surface-inset
                       disabled:cursor-not-allowed disabled:opacity-40"
        >
          {test.kind === 'testing' && <Loader2 size={13} className="animate-spin" />}
          연결 테스트
        </button>
        <button
          type="button"
          onClick={() => void save()}
          disabled={!canSubmit || saving}
          className="flex items-center gap-1.5 rounded bg-accent px-3 py-1.5 text-caption
                       text-surface-base disabled:cursor-not-allowed disabled:opacity-40"
        >
          {saving && <Loader2 size={13} className="animate-spin" />}
          {configured ? '토큰 교체' : '저장'}
        </button>
      </div>
    </section>
  )
}

/**
 * GitHub 연결.
 *
 * Jira와 달리 입력이 **토큰 하나**다 — github.com 고정이라 URL이 없고,
 * 사용자 식별은 토큰이 한다(`@me`).
 */
function GithubSection({ onSaved }: { onSaved: () => void }) {
  const refreshConnection = useConnectionStore((s) => s.refresh)
  const configured = useConnectionStore((s) => s.githubConfigured)
  const [token, setToken] = useState('')
  const [state, setState] = useState<GithubState>({ kind: 'idle' })

  const importFromGh = useCallback(async () => {
    if (!IN_TAURI) return
    setState({ kind: 'working' })
    const r = await commands.githubImportGhToken()
    if (r.status === 'ok') {
      setState({ kind: 'ok', message: r.data })
      await refreshConnection()
      onSaved()
    } else {
      setState({ kind: 'failed', message: r.error })
    }
  }, [refreshConnection, onSaved])

  const save = useCallback(async () => {
    if (!token.trim() || !IN_TAURI) return
    setState({ kind: 'working' })
    const saved = await commands.githubSaveToken(token.trim())
    if (saved.status !== 'ok') {
      setState({ kind: 'failed', message: saved.error })
      return
    }
    setToken('') // 저장 후 폼에 남기지 않는다

    // 저장과 확인을 붙여둔다. 저장만 하고 끝내면 틀린 토큰을 넣어도
    // 위젯이 401을 낼 때까지 모른다.
    const verified = await commands.githubVerify()
    setState(
      verified.status === 'ok'
        ? { kind: 'ok', message: verified.data }
        : { kind: 'failed', message: verified.error },
    )
    await refreshConnection()
    onSaved()
  }, [token, refreshConnection, onSaved])

  return (
    <section className="flex flex-col gap-3">
      <div>
        <h3 className="text-caption text-text-secondary">GitHub 연결</h3>
        <p className="mt-0.5 text-caption text-text-tertiary leading-relaxed-ko">
          토큰은 macOS 키체인에 저장되며 파일이나 로그에 남지 않습니다. github.com 전용입니다.
        </p>
      </div>

      <p
        className={`flex items-center gap-1.5 rounded px-2 py-1.5 text-caption ${
          configured ? 'bg-success-muted text-success' : 'bg-surface-inset text-text-tertiary'
        }`}
      >
        {configured ? <Check size={13} /> : <AlertCircle size={13} />}
        {configured ? '연결됨 — 토큰이 키체인에 저장돼 있습니다' : '아직 연결되지 않았습니다'}
      </p>

      {/* gh CLI에서 가져오기 — 대개 이 버튼 하나로 끝난다.
          토큰을 **복사**하는 것이지 gh에 의존하는 것이 아니다 (DECISIONS 12). */}
      <div className="flex flex-col gap-1">
        <button
          type="button"
          onClick={() => void importFromGh()}
          disabled={state.kind === 'working'}
          className="flex items-center gap-1.5 self-start rounded border border-border-subtle
                     px-3 py-1.5 text-caption text-text-secondary hover:bg-surface-inset
                     disabled:cursor-not-allowed disabled:opacity-40"
        >
          {state.kind === 'working' && <Loader2 size={13} className="animate-spin" />}
          gh CLI에서 가져오기
        </button>
        <p className="text-caption text-text-tertiary leading-relaxed-ko">
          gh에 로그인돼 있으면 토큰을 복사해 옵니다. 복사한 뒤에는 gh 없이 동작합니다.
        </p>
      </div>

      <Field label="또는 직접 입력 (Personal Access Token)">
        <input
          data-selectable
          type="password"
          value={token}
          onChange={(e) => setToken(e.target.value)}
          spellCheck={false}
          autoComplete="off"
          placeholder="ghp_..."
          className={`${inputClass} font-mono`}
        />
        <button
          type="button"
          onClick={() => void openUrl(GITHUB_TOKEN_PAGE)}
          className="mt-1 flex items-center gap-1 self-start text-caption text-accent hover:underline"
        >
          토큰 발급 페이지 열기 (repo, read:org)
          <ExternalLink size={11} />
        </button>
      </Field>

      {state.kind === 'ok' && (
        <p className="flex items-center gap-1.5 text-caption text-success">
          <Check size={13} />
          {state.message}
        </p>
      )}
      {state.kind === 'failed' && (
        <p className="text-caption text-danger leading-relaxed-ko">{state.message}</p>
      )}

      {/* 조직 저장소가 안 보이는 가장 흔한 이유. 겪고 나서 찾게 하지 않는다. */}
      <p className="text-caption text-text-tertiary leading-relaxed-ko">
        조직 저장소가 보이지 않으면 토큰에 SSO 인증이 필요할 수 있습니다 — 토큰 목록에서 “Configure
        SSO”를 눌러 해당 조직을 승인하세요.
      </p>

      <div className="flex items-center gap-2 pt-1">
        <button
          type="button"
          onClick={() => void save()}
          disabled={!token.trim() || state.kind === 'working'}
          className="flex items-center gap-1.5 rounded bg-accent px-3 py-1.5 text-caption
                     text-surface-base disabled:cursor-not-allowed disabled:opacity-40"
        >
          {state.kind === 'working' && <Loader2 size={13} className="animate-spin" />}
          {configured ? '토큰 교체' : '저장'}
        </button>
      </div>
    </section>
  )
}

/**
 * Linear 연결.
 *
 * GitHub과 같은 모양이다 — 입력이 **API 키 하나**뿐이고 URL이 없다
 * (`api.linear.app` 고정), 사용자 식별은 키가 한다(`viewer`).
 *
 * gh CLI에 해당하는 것이 없어서 가져오기 버튼도 없다. 키는 Linear 설정에서
 * 직접 발급한다.
 */
function LinearSection({ onSaved }: { onSaved: () => void }) {
  const refreshConnection = useConnectionStore((s) => s.refresh)
  const configured = useConnectionStore((s) => s.linearConfigured)
  const setAuthFailed = useConnectionStore((s) => s.setLinearAuthFailed)
  const [token, setToken] = useState('')
  const [state, setState] = useState<GithubState>({ kind: 'idle' })

  const save = useCallback(async () => {
    if (!token.trim() || !IN_TAURI) return
    setState({ kind: 'working' })
    try {
      const saved = await commands.linearSaveToken(token.trim())
      if (saved.status !== 'ok') {
        setState({ kind: 'failed', message: saved.error })
        return
      }
      setToken('') // 저장 후 폼에 남기지 않는다

      // 저장과 확인을 붙여둔다. 저장만 하고 끝내면 틀린 키를 넣어도
      // 위젯이 401을 낼 때까지 모른다. 확인은 `viewer` 한 방이다.
      const verified = await commands.linearVerify()
      if (verified.status === 'ok') {
        setState({ kind: 'ok', message: verified.data })
        // 새 키로 성공했으므로 전역 배너를 내린다. 안 내리면 고친 뒤에도
        // "인증 실패"가 남아 있어 뭘 더 해야 하는지 모른다.
        setAuthFailed(false)
      } else {
        setState({ kind: 'failed', message: verified.error })
      }
      await refreshConnection()
      onSaved()
    } catch (error) {
      setState({ kind: 'failed', message: errorMessage(error) })
    } finally {
      setState((current) => (current.kind === 'working' ? { kind: 'idle' } : current))
    }
  }, [token, refreshConnection, onSaved, setAuthFailed])

  return (
    <section className="flex flex-col gap-3">
      <div>
        <h3 className="text-caption text-text-secondary">Linear 연결</h3>
        <p className="mt-0.5 text-caption text-text-tertiary leading-relaxed-ko">
          API 키는 macOS 키체인에 저장되며 파일이나 로그에 남지 않습니다.
        </p>
      </div>

      <p
        className={`flex items-center gap-1.5 rounded px-2 py-1.5 text-caption ${
          configured ? 'bg-success-muted text-success' : 'bg-surface-inset text-text-tertiary'
        }`}
      >
        {configured ? <Check size={13} /> : <AlertCircle size={13} />}
        {configured ? '연결됨 — API 키가 키체인에 저장돼 있습니다' : '아직 연결되지 않았습니다'}
      </p>

      <Field label="Personal API key">
        <input
          data-selectable
          type="password"
          value={token}
          onChange={(e) => setToken(e.target.value)}
          spellCheck={false}
          autoComplete="off"
          placeholder="lin_api_..."
          className={`${inputClass} font-mono`}
        />
        <button
          type="button"
          onClick={() => void openUrl(LINEAR_TOKEN_PAGE)}
          className="mt-1 flex items-center gap-1 self-start text-caption text-accent hover:underline"
        >
          API 키 발급 페이지 열기
          <ExternalLink size={11} />
        </button>
      </Field>

      {state.kind === 'ok' && (
        <p className="flex items-center gap-1.5 text-caption text-success">
          <Check size={13} />
          {state.message}
        </p>
      )}
      {state.kind === 'failed' && (
        <p className="text-caption text-danger leading-relaxed-ko">{state.message}</p>
      )}

      <div className="flex items-center gap-2 pt-1">
        <button
          type="button"
          onClick={() => void save()}
          disabled={!token.trim() || state.kind === 'working'}
          className="flex items-center gap-1.5 rounded bg-accent px-3 py-1.5 text-caption
                     text-surface-base disabled:cursor-not-allowed disabled:opacity-40"
        >
          {state.kind === 'working' && <Loader2 size={13} className="animate-spin" />}
          {configured ? 'API 키 교체' : '저장'}
        </button>
      </div>
    </section>
  )
}

const REPO_PAGE = 'https://github.com/DevooKim/my-pegboard'

/**
 * 정보 탭 — 이 앱에 대하여 + 업데이트.
 *
 * macOS의 "이 앱에 대하여"와 같은 세로 중앙 배치다. 여기가 **버전 정보의 집**이고,
 * 업데이트 확인·설치도 이 화면 하나에서 끝난다.
 *
 * 업데이트 결과는 버튼 자리에 그대로 나타난다. "최신 버전입니다"까지 반드시
 * 보여주는 이유: 눌렀는데 아무 일도 안 일어나면 버튼이 고장 난 것처럼 보인다.
 */
function AboutSection() {
  const version = useUpdateStore((s) => s.currentVersion)
  const phase = useUpdateStore((s) => s.phase)
  const check = useUpdateStore((s) => s.check)
  const downloadAndInstall = useUpdateStore((s) => s.downloadAndInstall)
  const restart = useUpdateStore((s) => s.restart)

  return (
    <section className="flex flex-col items-center gap-3 px-6 py-8 text-center">
      {/* 아이콘은 장식이 아니라 신원이다. "지금 보고 있는 게 이 앱"을 말한다. */}
      <img src={appIcon} alt="" width={112} height={112} className="size-28" />

      <div className="flex flex-col gap-0.5">
        <h3 className="font-semibold text-md text-text-primary">my-pegboard</h3>
        <p className="text-caption text-text-tertiary">
          {version ? `버전 ${version}` : '버전 확인 중'}
        </p>
      </div>

      <UpdateControl
        phase={phase}
        onCheck={() => void check({ manual: true })}
        onInstall={() => void downloadAndInstall()}
        onRestart={() => void restart()}
      />

      <button
        type="button"
        onClick={() => void openUrl(REPO_PAGE)}
        className="text-caption text-accent hover:underline"
      >
        GitHub
      </button>

      <p className="text-caption text-text-quaternary">© 2026 DevooKim. MIT License.</p>
    </section>
  )
}

/**
 * 업데이트 확인 버튼과 그 결과.
 *
 * 한 자리에서 상태가 바뀐다 — 버튼이 결과 표시로 변신하고, 새 버전이 있으면
 * 설치 버튼이 된다. 자리를 옮기지 않는 이유: 방금 누른 곳에 답이 나와야 읽는다.
 */
function UpdateControl({
  phase,
  onCheck,
  onInstall,
  onRestart,
}: {
  phase: UpdatePhase
  onCheck: () => void
  onInstall: () => void
  onRestart: () => void
}) {
  if (phase.kind === 'available') {
    return (
      <div className="flex flex-col items-center gap-1.5">
        <button type="button" onClick={onInstall} className={primaryPill}>
          {phase.version}(으)로 업데이트
        </button>
        <p className="text-caption text-text-tertiary">새 버전이 있습니다</p>
      </div>
    )
  }

  if (phase.kind === 'downloading') {
    // 진행률을 그리지 않는다 — 6MB라 정상이면 1~3초에 끝난다.
    return (
      <p className="flex h-7 items-center gap-1.5 text-caption text-text-secondary">
        <Loader2 size={13} className="animate-spin" />
        업데이트 중…
      </p>
    )
  }

  if (phase.kind === 'installed') {
    return (
      <div className="flex flex-col items-center gap-1.5">
        <button type="button" onClick={onRestart} className={primaryPill}>
          지금 재시작
        </button>
        <p className="max-w-64 text-caption text-text-tertiary leading-relaxed-ko">
          {phase.version} 설치가 끝났습니다. 다음에 앱을 열 때 적용해도 됩니다.
        </p>
      </div>
    )
  }

  if (phase.kind === 'failed') {
    return (
      <div className="flex flex-col items-center gap-1.5">
        {/* 서명 검증 실패는 앱 안에서 할 수 있는 게 없다. 유일한 출구를 준다. */}
        {phase.signature ? (
          <button
            type="button"
            onClick={() => void openUrl(RELEASES_PAGE)}
            className={`${primaryPill} flex items-center gap-1.5`}
          >
            릴리즈 페이지에서 직접 받기
            <ExternalLink size={11} />
          </button>
        ) : (
          <button type="button" onClick={onCheck} className={neutralPill}>
            다시 시도
          </button>
        )}
        <p className="max-w-72 text-caption text-danger leading-relaxed-ko">{phase.message}</p>
      </div>
    )
  }

  return (
    <div className="flex flex-col items-center gap-1.5">
      <button
        type="button"
        onClick={onCheck}
        disabled={phase.kind === 'checking'}
        className={`${neutralPill} flex items-center gap-1.5 disabled:cursor-not-allowed disabled:opacity-60`}
      >
        {phase.kind === 'checking' && <Loader2 size={13} className="animate-spin" />}
        업데이트 확인
      </button>
      {/* 수동 확인의 결과는 반드시 말한다. 조용하면 고장으로 보인다. */}
      {phase.kind === 'latest' && (
        <p className="text-caption text-text-tertiary">최신 버전입니다</p>
      )}
    </div>
  )
}

/** 정보 탭의 버튼 두 종. 작은 컨트롤이라 알약이 맞다. */
const neutralPill =
  'rounded-md bg-surface-inset px-3 py-1.5 text-caption text-text-secondary hover:text-text-primary'
const primaryPill = 'rounded-md bg-accent px-3 py-1.5 text-caption text-surface-base'

type GithubState =
  | { kind: 'idle' }
  | { kind: 'working' }
  | { kind: 'ok'; message: string }
  | { kind: 'failed'; message: string }

const inputClass =
  'w-full rounded border border-border-subtle bg-surface-inset px-2 py-1.5 text-body text-text-primary placeholder:text-text-quaternary'

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1">
      {/* biome-ignore lint/a11y/noLabelWithoutControl: 입력을 children으로 감싸므로 암묵적 연결이다 */}
      <label className="text-caption text-text-secondary">{label}</label>
      {children}
    </div>
  )
}
