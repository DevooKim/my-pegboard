import { RefreshCw } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
import type { SortDirection, SortField } from '#/ipc/bindings'
import { commands, type JiraProject, type JiraWidgetConfig, type Preset } from '#/ipc/bindings'
import { relativeTime, useNow } from '#/ui/relativeTime'
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
  const [fetchedAt, setFetchedAt] = useState<string | null>(null)
  const [refreshing, setRefreshing] = useState(false)
  const now = useNow()

  // 생성 폼과 **같은 캐시**를 쓴다 (D9). jiraProjects를 따로 부르면 같은
  // 데이터를 두 경로로 가져오게 되고 캐시가 둘이 된다.
  const loadProjects = useCallback(async (force: boolean) => {
    if (force) setRefreshing(true)
    const r = await commands.jiraCreateOptions(force)
    if (r.status === 'ok') {
      setProjects(r.data.projects.map((p) => ({ key: p.key, name: p.name })))
      setFetchedAt(r.data.fetchedAt)
    }
    setRefreshing(false)
  }, [])

  useEffect(() => {
    void commands.jiraPresets().then(setPresets)
    void loadProjects(false)
  }, [loadProjects])

  // 정렬과 프로젝트 범위는 프리셋에만 적용된다. 생 JQL은 사용자가 ORDER BY와
  // project 조건을 직접 쓰므로, 우리가 UI로 덧붙이면 의도를 덮어쓴다.
  const isPreset = config.query.kind === 'preset'
  const scoped = config.projects ?? []

  // placeholder로 보여줄 기본 이름 — 프리셋 이름이거나 'Jira'.
  const defaultTitle =
    config.query.kind === 'preset'
      ? (presets.find((p) => p.id === presetId(config))?.name ?? 'Jira')
      : 'Jira'
  const toggleProject = (key: string) => {
    onChange({
      ...config,
      projects: scoped.includes(key) ? scoped.filter((k) => k !== key) : [...scoped, key],
    })
  }

  const selected = config.query.kind === 'preset' ? config.query.id : RAW

  return (
    <div className="flex flex-col">
      <Section>
        <label className="flex flex-col gap-1">
          <span className="text-caption text-text-secondary">위젯 이름</span>
          <input
            data-selectable
            value={config.title ?? ''}
            onChange={(e) => onChange({ ...config, title: e.target.value })}
            placeholder={defaultTitle}
            className="rounded border border-border-subtle bg-surface-inset px-2 py-1.5
                     text-body text-text-primary placeholder:text-text-quaternary"
          />
        </label>

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
            className="rounded border border-border-subtle bg-surface-inset px-2 py-2.5
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

        {/* 프로젝트 범위와 정렬은 프리셋 전용이다 (생 JQL에는 사용자가 직접 쓴다) */}
        {isPreset && (
          <div className="flex flex-col gap-1">
            <span className="flex items-center gap-2">
              <span className="text-caption text-text-secondary">프로젝트</span>
              {/* 자동 갱신하지 않는다 (D9). 언제 받은 것인지 보여주고 사용자가 정한다. */}
              <button
                type="button"
                onClick={() => void loadProjects(true)}
                title="프로젝트 목록 새로고침"
                aria-label="프로젝트 목록 새로고침"
                className="rounded p-0.5 text-text-tertiary hover:bg-surface-inset hover:text-text-primary
                           focus-visible:outline-2 focus-visible:outline-accent"
              >
                <RefreshCw size={11} className={refreshing ? 'animate-spin' : ''} />
              </button>
              {fetchedAt && (
                <span className="text-caption text-text-quaternary">
                  {relativeTime(fetchedAt, new Date(now))}
                </span>
              )}
            </span>
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
        )}

        {isPreset && (
          <div className="flex flex-col gap-1">
            <span className="text-caption text-text-secondary">정렬</span>
            <div className="flex gap-1">
              <select
                value={config.sortField ?? 'updated'}
                onChange={(e) => onChange({ ...config, sortField: e.target.value as SortField })}
                className="flex-1 rounded border border-border-subtle bg-surface-inset px-2 py-2.5
                         text-body text-text-primary"
              >
                <option value="updated">수정일</option>
                <option value="created">생성일</option>
                <option value="due">마감일</option>
                <option value="priority">우선순위</option>
                <option value="key">키</option>
              </select>
              <select
                value={config.sortDirection ?? 'desc'}
                onChange={(e) =>
                  onChange({ ...config, sortDirection: e.target.value as SortDirection })
                }
                className="w-28 rounded border border-border-subtle bg-surface-inset px-2 py-2.5
                         text-body text-text-primary"
              >
                <option value="desc">내림차순</option>
                <option value="asc">오름차순</option>
              </select>
            </div>
            {(config.sortField ?? 'updated') === 'due' && (
              // 실측 9/22만 채워져 있다. 정렬하면 나머지가 뭉텅이로 몰린다.
              <span className="text-caption text-stale">
                마감일이 없는 티켓이 많으면 한쪽에 몰려 보입니다
              </span>
            )}
          </div>
        )}
      </Section>

      <Section>
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

        <div className="flex flex-col gap-1">
          <span className="text-caption text-text-secondary">표시 개수</span>
          <NumberField
            value={config.maxResults}
            min={5}
            max={100}
            clamp={(n) => clamp(n, 5, 100)}
            onCommit={(n) => onChange({ ...config, maxResults: n })}
          />
          <span className="text-caption text-text-tertiary">
            많을수록 응답이 커집니다. 기본 15건.
          </span>
        </div>
      </Section>

      <Section last>
        <div className="flex flex-col gap-1">
          <span className="text-caption text-text-secondary">자동 새로고침</span>
          <div className="flex items-center gap-2">
            <NumberField
              value={Math.round((config.refreshSecs ?? 300) / 60)}
              min={0}
              max={120}
              // 0은 '자동 갱신 안 함'. 그 외에는 1분이 하한이다.
              clamp={(n) => (n <= 0 ? 0 : Math.min(120, Math.max(1, n)))}
              onCommit={(mins) => onChange({ ...config, refreshSecs: mins * 60 })}
            />
            <span className="text-caption text-text-tertiary">분마다</span>
          </div>
          <span className="text-caption text-text-tertiary">
            {(config.refreshSecs ?? 300) === 0
              ? '자동 갱신하지 않습니다 — 새로고침 버튼으로만 갱신됩니다'
              : `${Math.round((config.refreshSecs ?? 300) / 60)}분마다 자동으로 갱신합니다`}
          </span>
        </div>
      </Section>
    </div>
  )
}

/**
 * 설정 폼의 구획.
 *
 * 항목이 열 개를 넘어가면서 한 덩어리로는 무엇이 무엇인지 읽히지 않는다.
 * 제목 없이 구분선만 둔다 — 묶음이 보이면 충분하고, 이름표는 오히려 소음이다.
 * 순서는 무엇을 → 어떻게 → 언제.
 */
function Section({ last, children }: { last?: boolean; children: React.ReactNode }) {
  return (
    <section className={`flex flex-col gap-3 py-4 ${last ? '' : 'border-border-subtle border-b'}`}>
      {children}
    </section>
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

/**
 * 숫자 입력.
 *
 * 타이핑 중에는 **문자열을 그대로 둔다.** 매 키 입력마다 clamp를 걸면
 * 15를 치려고 '1'을 누른 순간 하한 5로 튀어 커서가 밀리고, 사실상 입력이 안 된다.
 * 확정은 blur와 Enter에서 한 번만 한다.
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

  // 바깥에서 값이 바뀌면(다른 위젯 열기 등) 따라간다.
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
