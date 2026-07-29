import { useEffect, useState } from 'react'
import { commands, type JiraWidgetConfig, type Preset } from '#/ipc/bindings'
import type { WidgetConfigFormProps } from '#/widgets/types'

const RAW = '__raw__'

/**
 * DECISIONS 11.1 — 프리셋 + JQL 탈출구.
 *
 * 폼 빌더를 만들지 않는 이유: "우리 팀 티켓"의 정의가 조직마다 달라서
 * 결국 JQL의 표현력이 필요해진다. 프리셋으로 흔한 경우를 덮고,
 * 나머지는 JQL을 그대로 열어준다.
 */
export function JiraConfigForm({ config, onChange }: WidgetConfigFormProps<JiraWidgetConfig>) {
  const [presets, setPresets] = useState<Preset[]>([])

  useEffect(() => {
    void commands.jiraPresets().then(setPresets)
  }, [])

  const selected = config.query.kind === 'preset' ? config.query.id : RAW

  return (
    <div className="flex flex-col gap-3">
      <label className="flex flex-col gap-1">
        <span className="text-caption text-text-secondary">쿼리</span>
        <select
          value={selected}
          onChange={(e) => {
            const v = e.target.value
            onChange({
              ...config,
              query:
                v === RAW
                  ? { kind: 'raw', jql: currentJql(config, presets) }
                  : { kind: 'preset', id: v },
            })
          }}
          className="rounded border border-border-subtle bg-surface-inset px-2 py-1.5
                     text-body text-text-primary"
        >
          {presets.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
          <option value={RAW}>직접 입력 (JQL)</option>
        </select>
        {config.query.kind === 'preset' && (
          <span className="text-caption text-text-tertiary">
            {presets.find((p) => p.id === presetId(config))?.description}
          </span>
        )}
      </label>

      {config.query.kind === 'raw' && (
        <label className="flex flex-col gap-1">
          <span className="text-caption text-text-secondary">JQL</span>
          <textarea
            data-selectable
            value={config.query.jql}
            onChange={(e) => onChange({ ...config, query: { kind: 'raw', jql: e.target.value } })}
            rows={3}
            spellCheck={false}
            placeholder="project = ABC AND status != Done ORDER BY updated DESC"
            className="resize-none rounded border border-border-subtle bg-surface-inset px-2 py-1.5
                       font-mono text-caption text-text-primary"
          />
          {/* 검증하지 않는다 — 틀리면 Jira가 훨씬 나은 메시지를 준다 */}
          <span className="text-caption text-text-tertiary">
            문법 오류는 저장 후 위젯에 Jira의 메시지가 그대로 표시됩니다
          </span>
        </label>
      )}

      <label className="flex flex-col gap-1">
        <span className="text-caption text-text-secondary">표시 개수</span>
        <input
          data-selectable
          type="number"
          min={5}
          max={100}
          step={5}
          value={config.maxResults}
          onChange={(e) => {
            const n = Number(e.target.value)
            if (Number.isFinite(n)) onChange({ ...config, maxResults: clamp(n, 5, 100) })
          }}
          className="w-24 rounded border border-border-subtle bg-surface-inset px-2 py-1.5
                     text-body text-text-primary tabular-nums"
        />
        <span className="text-caption text-text-tertiary">
          많을수록 응답이 커집니다. 기본 30건.
        </span>
      </label>
    </div>
  )
}

function presetId(config: JiraWidgetConfig): string | null {
  return config.query.kind === 'preset' ? config.query.id : null
}

/** 프리셋 → 직접 입력으로 전환할 때, 그 프리셋의 JQL을 시작점으로 준다. */
function currentJql(config: JiraWidgetConfig, presets: Preset[]): string {
  const q = config.query
  if (q.kind === 'raw') return q.jql
  return presets.find((p) => p.id === q.id)?.jql ?? ''
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, Math.round(n)))
}
