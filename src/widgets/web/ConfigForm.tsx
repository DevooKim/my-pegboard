import { useEffect, useState } from 'react'
import type { WidgetConfigFormProps } from '#/widgets/types'
import { isKnownBlocked } from './blocked'
import type { WebWidgetConfig } from './index'

/**
 * 웹 위젯 설정.
 *
 * 구획 나눔(Section)과 숫자 입력(NumberField)은 Jira 설정 폼과 같은 패턴이다.
 * jira 내부를 import하지 않고 필요한 만큼만 복사했다 — 위젯끼리 서로의
 * 파일을 열지 않는다는 원칙(CLAUDE.md)을 실험 코드에서도 지킨다.
 */
export function WebConfigForm({ config, onChange }: WidgetConfigFormProps<WebWidgetConfig>) {
  const blockedDomain = isKnownBlocked(config.url)
  return (
    <div className="flex flex-col">
      <Section>
        <label className="flex flex-col gap-1">
          <span className="text-caption text-text-secondary">위젯 이름</span>
          <input
            data-selectable
            value={config.title ?? ''}
            onChange={(e) => onChange({ ...config, title: e.target.value })}
            placeholder={hostOf(config.url) ?? '웹'}
            className="rounded border border-border-subtle bg-surface-inset px-2 py-1.5
                       text-body text-text-primary placeholder:text-text-quaternary"
          />
        </label>

        <label className="flex flex-col gap-1">
          <span className="text-caption text-text-secondary">주소</span>
          <input
            data-selectable
            value={config.url}
            onChange={(e) => onChange({ ...config, url: e.target.value })}
            spellCheck={false}
            placeholder="https://example.com"
            className="rounded border border-border-subtle bg-surface-inset px-2 py-1.5
                       font-mono text-caption text-text-primary placeholder:text-text-quaternary"
          />
          {/*
            차단 여부는 런타임에 감지할 수 없다(blocked.ts 참조). 대신 알려진
            도메인이면 **위젯을 배치하기 전에** 여기서 알려준다.
          */}
          {blockedDomain ? (
            <span className="text-caption text-stale leading-relaxed-ko">
              {blockedDomain}은 임베드를 거부합니다 — 빈 화면이 표시됩니다. 대신 브라우저에서 열어야
              합니다.
            </span>
          ) : (
            <span className="text-caption text-text-tertiary leading-relaxed-ko">
              https 주소와 로컬 서버(http://localhost, 127.0.0.1)를 넣을 수 있습니다. 일부 사이트는
              임베드를 거부해 빈 화면이 됩니다.
            </span>
          )}
        </label>
      </Section>

      <Section>
        <div className="flex flex-col gap-1">
          <span className="text-caption text-text-secondary">확대</span>
          <div className="flex items-center gap-2">
            <NumberField
              value={config.zoom}
              min={50}
              max={150}
              clamp={(n) => clamp(n, 50, 150)}
              onCommit={(n) => onChange({ ...config, zoom: n })}
            />
            <span className="text-caption text-text-tertiary">%</span>
          </div>
          <span className="text-caption text-text-tertiary">
            작게 하면 더 많은 내용이 들어오지만 글씨가 작아집니다
          </span>
        </div>

        <Toggle
          checked={config.allowScroll}
          onChange={(v) => onChange({ ...config, allowScroll: v })}
          label="스크롤 허용"
          hint={
            config.allowScroll
              ? '위젯 안에서 페이지를 스크롤할 수 있습니다'
              : '페이지 상단만 고정으로 보여줍니다'
          }
        />

        <Toggle
          checked={config.allowSession}
          onChange={(v) => onChange({ ...config, allowSession: v })}
          label="로그인 세션 사용"
          hint={
            config.allowSession
              ? // 앱을 끄면 실제로 풀린다. 조용히 겪게 두지 않는다 (index.ts 주석 참조).
                '이미 로그인한 사이트는 로그인된 상태로 보입니다. 다만 앱을 종료하면 로그인이 풀립니다 — macOS 웹뷰가 iframe의 쿠키를 지웁니다'
              : '샌드박스를 강하게 걸어 로그인 상태를 쓰지 않습니다 — 로그인이 필요한 페이지는 로그인 화면이 뜹니다'
          }
        />
      </Section>

      <Section last>
        <div className="flex flex-col gap-1">
          <span className="text-caption text-text-secondary">자동 새로고침</span>
          <div className="flex items-center gap-2">
            <NumberField
              value={Math.round(config.refreshSecs / 60)}
              min={0}
              max={120}
              // 0은 '자동 갱신 안 함'. 그 외에는 1분이 하한.
              clamp={(n) => (n <= 0 ? 0 : Math.min(120, Math.max(1, n)))}
              onCommit={(mins) => onChange({ ...config, refreshSecs: mins * 60 })}
            />
            <span className="text-caption text-text-tertiary">분마다</span>
          </div>
          <span className="text-caption text-text-tertiary">
            {config.refreshSecs === 0
              ? '자동 갱신하지 않습니다 — 새로고침 버튼으로만 다시 불러옵니다'
              : `${Math.round(config.refreshSecs / 60)}분마다 페이지를 다시 불러옵니다`}
          </span>
        </div>
      </Section>
    </div>
  )
}

/** 설정 폼의 구획. 제목 없이 구분선만 둔다. */
function Section({ last, children }: { last?: boolean; children: React.ReactNode }) {
  return (
    <section className={`flex flex-col gap-3 py-4 ${last ? '' : 'border-border-subtle border-b'}`}>
      {children}
    </section>
  )
}

function Toggle({
  checked,
  onChange,
  label,
  hint,
}: {
  checked: boolean
  onChange: (v: boolean) => void
  label: string
  hint: string
}) {
  return (
    <div className="flex flex-col gap-1">
      <label className="flex items-center gap-2">
        <input
          type="checkbox"
          checked={checked}
          onChange={(e) => onChange(e.target.checked)}
          className="size-3.5 accent-accent"
        />
        <span className="text-caption text-text-secondary">{label}</span>
      </label>
      <span className="text-caption text-text-tertiary">{hint}</span>
    </div>
  )
}

/**
 * 숫자 입력.
 *
 * 타이핑 중에는 문자열을 그대로 둔다. 매 키 입력마다 clamp를 걸면
 * 120을 치려고 '1'을 누른 순간 하한으로 튀어 사실상 입력이 안 된다.
 * 확정은 blur와 Enter에서 한 번만.
 */
function NumberField({
  value,
  min,
  max,
  clamp: clampFn,
  onCommit,
}: {
  value: number
  min: number
  max: number
  clamp: (n: number) => number
  onCommit: (n: number) => void
}) {
  const [text, setText] = useState(String(value))

  useEffect(() => {
    setText(String(value))
  }, [value])

  const commit = () => {
    const n = Number(text)
    const next = Number.isFinite(n) ? clampFn(Math.round(n)) : value
    setText(String(next))
    if (next !== value) onCommit(next)
  }

  return (
    <input
      data-selectable
      type="number"
      inputMode="numeric"
      min={min}
      max={max}
      value={text}
      onChange={(e) => setText(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          e.preventDefault()
          commit()
        }
      }}
      className="w-24 rounded border border-border-subtle bg-surface-inset px-2 py-1
                 text-body text-text-primary tabular-nums"
    />
  )
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, Math.round(n)))
}

function hostOf(url: string): string | null {
  try {
    return new URL(url).host
  } catch {
    return null
  }
}
