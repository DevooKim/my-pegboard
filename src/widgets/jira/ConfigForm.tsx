import { useEffect, useState } from 'react'
import { commands, type JiraProject, type JiraWidgetConfig, type Preset } from '#/ipc/bindings'
import type { WidgetConfigFormProps } from '#/widgets/types'
import { COLUMN_LABELS, TOGGLEABLE_COLUMNS, type ToggleableColumn, visibleColumns } from './columns'

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
  const [projects, setProjects] = useState<JiraProject[]>([])

  useEffect(() => {
    void commands.jiraPresets().then(setPresets)
    void commands.jiraProjects().then((r) => {
      if (r.status === 'ok') setProjects(r.data)
    })
  }, [])

  const scoped = config.projects ?? []
  const toggleProject = (key: string) => {
    onChange({
      ...config,
      projects: scoped.includes(key) ? scoped.filter((k) => k !== key) : [...scoped, key],
    })
  }

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
          className="rounded border border-border-subtle bg-surface-inset px-2 py-2
                     text-body text-text-primary"
        >
          {/*
            프리셋을 아직 못 불러왔는데 현재 설정이 프리셋이면, 그 id를 임시 옵션으로
            넣어둔다. 안 그러면 select가 매칭되는 option을 못 찾아 마지막 항목(RAW)을
            고른 것처럼 보이고, 사용자가 건드리지도 않은 설정이 바뀐 듯 보인다.
          */}
          {presets.length === 0 && selected !== RAW && (
            <option value={selected}>불러오는 중…</option>
          )}
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

      {/*
        프로젝트 범위. 쿼리와 분리해 둔 이유는 프리셋이든 생 JQL이든
        똑같이 적용돼야 하기 때문이다 — 프리셋마다 프로젝트별 변종을
        만들면 조합 폭발이 된다.
      */}
      <div className="flex flex-col gap-1">
        <span className="text-caption text-text-secondary">프로젝트</span>
        {projects.length === 0 ? (
          <span className="text-caption text-text-tertiary">불러오는 중…</span>
        ) : (
          <div className="flex flex-wrap gap-1">
            <Chip
              active={scoped.length === 0}
              onClick={() => onChange({ ...config, projects: [] })}
            >
              전체
            </Chip>
            {projects.map((p) => (
              <Chip
                key={p.key}
                active={scoped.includes(p.key)}
                onClick={() => toggleProject(p.key)}
                title={p.name}
              >
                {p.key}
              </Chip>
            ))}
          </div>
        )}
        <span className="text-caption text-text-tertiary">
          {scoped.length === 0
            ? '모든 프로젝트에서 검색합니다'
            : `${scoped.join(', ')} 로 범위를 좁힙니다`}
        </span>
      </div>

      <div className="flex flex-col gap-1">
        <span className="text-caption text-text-secondary">표시할 열</span>
        <div className="flex flex-wrap gap-1">
          {TOGGLEABLE_COLUMNS.map((col) => {
            const shown = visibleColumns(config.columns)
            const on = shown.includes(col)
            return (
              <Chip
                key={col}
                active={on}
                onClick={() => {
                  const next = on ? shown.filter((c) => c !== col) : [...shown, col]
                  onChange({ ...config, columns: next as ToggleableColumn[] })
                }}
              >
                {COLUMN_LABELS[col]}
              </Chip>
            )
          })}
        </div>
        <span className="text-caption text-text-tertiary">제목은 항상 표시됩니다</span>
      </div>

      <label className="flex flex-col gap-1">
        <span className="text-caption text-text-secondary">자동 새로고침</span>
        <div className="flex items-center gap-2">
          <input
            data-selectable
            type="number"
            min={0}
            max={120}
            step={1}
            value={Math.round((config.refreshSecs ?? 300) / 60)}
            onChange={(e) => {
              const m = Number(e.target.value)
              if (!Number.isFinite(m)) return
              // 0은 '자동 갱신 안 함'. 그 외에는 1분이 하한이다.
              const mins = m <= 0 ? 0 : Math.min(120, Math.max(1, Math.round(m)))
              onChange({ ...config, refreshSecs: mins * 60 })
            }}
            className="w-20 rounded border border-border-subtle bg-surface-inset px-2 py-1
                       text-body text-text-primary tabular-nums"
          />
          <span className="text-caption text-text-tertiary">분마다</span>
        </div>
        <span className="text-caption text-text-tertiary">
          {(config.refreshSecs ?? 300) === 0
            ? '자동 갱신하지 않습니다 — 새로고침 버튼으로만 갱신됩니다'
            : `${Math.round((config.refreshSecs ?? 300) / 60)}분마다 자동으로 갱신합니다`}
        </span>
      </label>

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
          className="w-24 rounded border border-border-subtle bg-surface-inset px-2 py-1
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

function Chip({
  active,
  onClick,
  title,
  children,
}: {
  active: boolean
  onClick: () => void
  title?: string
  children: React.ReactNode
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      className={`rounded border px-2 py-0.5 text-caption transition-colors duration-fast ${
        active
          ? 'border-accent bg-accent/15 text-accent'
          : 'border-border-subtle text-text-tertiary hover:bg-surface-inset'
      }`}
    >
      {children}
    </button>
  )
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, Math.round(n)))
}
