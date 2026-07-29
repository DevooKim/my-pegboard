import { openUrl } from '@tauri-apps/plugin-opener'
import { Check, ExternalLink, Loader2, X } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
import { commands } from '#/ipc/bindings'
import { IN_TAURI } from '#/ipc/env'
import { useConnectionStore } from '#/store/connection'

const TOKEN_PAGE = 'https://id.atlassian.com/manage-profile/security/api-tokens'

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
export function SettingsModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const refreshConnection = useConnectionStore((s) => s.refresh)
  const [baseUrl, setBaseUrl] = useState('https://your-team.atlassian.net')
  // 이 앱은 단일 사용자용이다. 매번 타이핑할 이유가 없으므로 미리 채운다.
  const [email, setEmail] = useState('you@example.com')
  const [token, setToken] = useState('')
  const [test, setTest] = useState<TestState>({ kind: 'idle' })
  const [saved, setSaved] = useState(false)

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [open, onClose])

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
    const r = await commands.jiraSaveCredentials(baseUrl.trim(), email.trim(), token.trim())
    if (r.status === 'ok') {
      setToken('') // 저장 후 폼에 남기지 않는다
      setSaved(true)
      void refreshConnection()
      setTimeout(() => setSaved(false), 2000)
    } else {
      setTest({ kind: 'failed', message: r.error })
    }
  }, [baseUrl, email, token, canSubmit, refreshConnection])

  if (!open) return null

  return (
    <div className="fixed inset-0 z-100 grid place-items-center bg-black/50 p-8">
      {/* 백드롭 클릭으로 닫기. ESC도 동작하므로 키보드 접근성은 확보돼 있다. */}
      <button
        type="button"
        aria-label="설정 닫기"
        tabIndex={-1}
        onClick={onClose}
        className="absolute inset-0 cursor-default"
      />
      <div
        role="dialog"
        aria-modal="true"
        aria-label="설정"
        className="relative flex max-h-full w-full max-w-lg flex-col overflow-hidden rounded-xl
                   border border-border-subtle bg-surface-overlay shadow-2xl"
      >
        <header className="flex shrink-0 items-center justify-between border-border-subtle border-b px-4 py-3">
          <h2 className="text-body text-text-primary">설정</h2>
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
                disabled={!canSubmit}
                className="rounded bg-accent px-3 py-1.5 text-caption text-surface-base
                           disabled:cursor-not-allowed disabled:opacity-40"
              >
                {saved ? '저장됨' : '저장'}
              </button>
            </div>
          </section>
        </div>
      </div>
    </div>
  )
}

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
