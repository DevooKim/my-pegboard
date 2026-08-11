import { FolderOpen, Images } from 'lucide-react'
import { useEffect, useState } from 'react'
import { commands } from '#/ipc/bindings'
import { IN_TAURI } from '#/ipc/env'
import type { WidgetConfigFormProps } from '#/widgets/types'
import { DEFAULT_INTERVAL_SECS, MIN_INTERVAL_SECS } from './defaults'
import type { AlbumWidgetConfig } from './index'

/**
 * 앨범 위젯 설정.
 *
 * 설정할 것이 셋뿐이다: 이름, 소스, 순환 주기. 사진 위젯에서 더 만들 만한
 * 것들(정렬 순서·전환 효과·꽉 채우기 여부)을 일부러 안 만들었다 —
 * 기분 전환용 배경이므로 고를 것이 늘어나면 그 자체가 부담이다 (DECISIONS 24).
 *
 * 구획(Section)과 숫자 입력(NumberField)은 web 위젯 설정 폼과 같은 패턴이다.
 * `widgets/web/`을 import하지 않고 필요한 만큼만 복사했다 — 위젯끼리 서로의
 * 파일을 열지 않는다는 원칙(CLAUDE.md)을 지킨다.
 *
 * ## 다이얼로그를 여는 것도 여기서 된다
 *
 * 위젯 본문의 빈 상태에도 같은 버튼이 있다. 두 곳에 있는 이유: 처음 놓았을
 * 때는 본문에서 바로 고르는 것이 빠르고, **폴더를 바꿀 때**는 설정창을
 * 여는 것이 자연스럽다. 둘 다 같은 커맨드를 부르므로 결과가 갈라지지 않는다.
 */
export function AlbumConfigForm({ config, onChange }: WidgetConfigFormProps<AlbumWidgetConfig>) {
  const [picking, setPicking] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // 손으로 편집한 board.json에서 빠졌을 수 있다 (defaults.ts의 주석 참조).
  const intervalSecs = config.intervalSecs ?? DEFAULT_INTERVAL_SECS

  const pick = async (kind: 'folder' | 'files') => {
    // `WidgetConfigFormProps`에는 위젯 id가 없다(모든 위젯이 공유하는 계약이라
    // 이것 하나 때문에 늘리지 않는다). id는 캐시 파일 이름에만 쓰이므로
    // 고정 키를 준다 — '적용'을 누르면 위젯 본문이 진짜 id로 다시 훑어
    // 제대로 캐시하고, 이 임시 파일은 다음 `board_save`의 orphan 정리가 지운다.
    setPicking(true)
    setError(null)
    try {
      const result =
        kind === 'folder'
          ? await commands.albumPickFolder('album-config-preview')
          : await commands.albumPickFiles('album-config-preview')

      if (result.status !== 'ok') {
        setError(result.error)
        return
      }
      if (!result.data) return // 취소
      onChange({ ...config, source: result.data.source })
    } finally {
      setPicking(false)
    }
  }

  return (
    <div className="flex flex-col">
      <Section>
        <label className="flex flex-col gap-1">
          <span className="text-caption text-text-secondary">위젯 이름</span>
          <input
            data-selectable
            value={config.title ?? ''}
            onChange={(e) => onChange({ ...config, title: e.target.value })}
            placeholder="앨범"
            className="rounded border border-border-subtle bg-surface-inset px-2 py-1.5
                       text-body text-text-primary placeholder:text-text-quaternary"
          />
        </label>

        <div className="flex flex-col gap-1">
          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={(config.headerMode ?? 'hover') === 'always'}
              onChange={(e) =>
                onChange({ ...config, headerMode: e.target.checked ? 'always' : 'hover' })
              }
              className="size-3.5 accent-accent"
            />
            <span className="text-caption text-text-secondary">헤더 항상 표시</span>
          </label>
          <span className="text-caption text-text-tertiary">
            끄면 사진을 가득 보여주고 마우스를 올릴 때만 헤더가 나타납니다
          </span>
        </div>
      </Section>

      <Section>
        <div className="flex flex-col gap-2">
          <span className="text-caption text-text-secondary">사진</span>

          {/* 지금 무엇을 보고 있는지. 경로를 통째로 적는다 —
              설정창은 폭이 있고, 외장 디스크인지 아닌지는 경로로만 안다. */}
          <p className="break-all font-mono text-caption text-text-tertiary leading-relaxed-ko">
            {describeSource(config)}
          </p>

          <div className="flex gap-2">
            <button
              type="button"
              disabled={picking || !IN_TAURI}
              onClick={() => void pick('folder')}
              className="flex items-center gap-1 rounded border border-border-subtle px-2 py-1
                         text-caption text-text-secondary hover:bg-surface-inset
                         disabled:opacity-50"
            >
              <FolderOpen size={12} />
              폴더 선택
            </button>
            <button
              type="button"
              disabled={picking || !IN_TAURI}
              onClick={() => void pick('files')}
              className="flex items-center gap-1 rounded border border-border-subtle px-2 py-1
                         text-caption text-text-secondary hover:bg-surface-inset
                         disabled:opacity-50"
            >
              <Images size={12} />
              사진 선택
            </button>
          </div>

          {error && <p className="text-caption text-danger leading-relaxed-ko">{error}</p>}
          {!IN_TAURI && (
            <p className="text-caption text-stale leading-relaxed-ko">
              브라우저에서는 파일 선택 창을 열 수 없습니다. 앱에서 설정하세요.
            </p>
          )}

          <span className="text-caption text-text-tertiary leading-relaxed-ko">
            폴더는 <strong>하위 폴더를 보지 않습니다</strong> — 사진 10만 장 폴더에서 시작이 멈추지
            않게 하려는 것입니다. 최대 1000장까지 표시하고, 넘치면 위젯에 몇 장이 빠졌는지 적습니다.
            jpg · jpeg · png · gif · webp · heic
          </span>
        </div>
      </Section>

      <Section last>
        <div className="flex flex-col gap-1">
          <span className="text-caption text-text-secondary">사진 넘기는 주기</span>
          <div className="flex items-center gap-2">
            <NumberField
              value={intervalSecs}
              min={0}
              max={3600}
              // 0은 '자동 순환 안 함'. 그 외에는 MIN_INTERVAL_SECS가 하한이다.
              clamp={(n) => (n <= 0 ? 0 : Math.min(3600, Math.max(MIN_INTERVAL_SECS, n)))}
              onCommit={(secs) => onChange({ ...config, intervalSecs: secs })}
            />
            <span className="text-caption text-text-tertiary">초마다</span>
          </div>
          <span className="text-caption text-text-tertiary leading-relaxed-ko">
            {intervalSecs === 0
              ? '자동으로 넘기지 않습니다 — 위젯을 누를 때만 다음 사진으로 갑니다'
              : `${intervalSecs}초마다 다음 사진으로 넘깁니다. 위젯을 누르면 바로 넘어갑니다.`}
          </span>
          <span className="text-caption text-text-quaternary leading-relaxed-ko">
            시스템의 '동작 줄이기'가 켜져 있으면 자동으로 넘기지 않습니다.
          </span>
        </div>
      </Section>
    </div>
  )
}

/** 지금 고른 소스를 사람이 읽을 문장으로. 아직 없으면 그 사실을 적는다. */
function describeSource(config: AlbumWidgetConfig): string {
  const source = config.source
  if (!source) return '아직 고르지 않았습니다'
  if (source.kind === 'folder') return source.path
  if (source.paths.length === 1) return source.paths[0] ?? ''
  return `사진 ${source.paths.length}장 (${source.paths[0] ?? ''} 외)`
}

/** 설정 폼의 구획. 제목 없이 구분선만 둔다. */
function Section({ last, children }: { last?: boolean; children: React.ReactNode }) {
  return (
    <section className={`flex flex-col gap-3 py-4 ${last ? '' : 'border-border-subtle border-b'}`}>
      {children}
    </section>
  )
}

/**
 * 숫자 입력.
 *
 * 타이핑 중에는 문자열을 그대로 둔다. 매 키 입력마다 clamp를 걸면 30을
 * 치려고 '3'을 누른 순간 하한으로 튀어 사실상 입력이 안 된다.
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
