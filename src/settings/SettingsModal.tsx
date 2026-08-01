import { openUrl } from '@tauri-apps/plugin-opener'
import { AlertCircle, Check, ExternalLink, Loader2, X } from 'lucide-react'
import { useCallback, useState } from 'react'
import { commands } from '#/ipc/bindings'
import { IN_TAURI } from '#/ipc/env'
import { useConnectionStore } from '#/store/connection'
import { Modal } from '#/ui/Modal'

const TOKEN_PAGE = 'https://id.atlassian.com/manage-profile/security/api-tokens'
/** Classic PAT 발급 페이지. 스코프를 미리 채워 보낸다. */
const GITHUB_TOKEN_PAGE =
  'https://github.com/settings/tokens/new?scopes=repo,read:org&description=my-pegboard'

type TestState =
  | { kind: 'idle' }
  | { kind: 'testing' }
  | { kind: 'ok'; displayName: string }
  | { kind: 'failed'; message: string }

/**
 * 통합 설정창 (DECISIONS 15장).
 *
 * 별도 Tauri 창이 아니라 전체 모달인 이유: 별도 창은 위치 기억·중복 방지·
 * 포커스 관리라는 상태가 늘지만 얻는 게 없다. 잠깐 열었다 닫는 화면이다.
 *
 * 토큰은 이 폼을 떠나 키체인으로 바로 간다. 어떤 상태에도 보관하지 않고,
 * 저장 직후 입력을 비운다.
 */
export function SettingsModal({
  open,
  onClose,
  onSaved,
}: {
  open: boolean
  onClose: () => void
  onSaved: () => void
}) {
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
    <Modal open={open} onClose={onClose} labelledBy="settings-title">
      <header className="flex shrink-0 items-center justify-between border-border-subtle border-b px-4 py-3">
        <h2 id="settings-title" className="text-body text-text-primary">
          설정
        </h2>
        <button
          type="button"
          onClick={onClose}
          aria-label="닫기"
          className="grid size-7 place-items-center rounded text-text-tertiary
                       hover:bg-surface-inset hover:text-text-primary"
        >
          <X size={15} />
        </button>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4">
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

        <hr className="my-5 border-border-subtle" />

        <GithubSection onSaved={onSaved} />
      </div>
    </Modal>
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
