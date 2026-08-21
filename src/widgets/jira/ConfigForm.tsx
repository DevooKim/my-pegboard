import { RefreshCw } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
import type { SortDirection, SortField } from '#/ipc/bindings'
import {
  commands,
  type JiraFilter,
  type JiraProject,
  type JiraWidgetConfig,
  type Preset,
} from '#/ipc/bindings'
import { relativeTime, useNow } from '#/ui/relativeTime'
import type { WidgetConfigFormProps } from '#/widgets/types'
import { COLUMN_LABELS, TOGGLEABLE_COLUMNS, type ToggleableColumn, visibleColumns } from './columns'

const RAW = '__raw__'

/**
 * 저장된 필터 셀렉트 값의 프리픽스.
 *
 * 프리셋 id와 필터 id를 **한 셀렉트 안에서** 구분해야 한다. 프리셋 id는
 * `assigned-to-me` 같은 문자열이고 필터 id는 숫자라 사실상 겹치지 않지만,
 * 프리픽스가 있으면 겹칠 수 없다는 것이 코드에 드러난다.
 */
const FILTER_PREFIX = 'filter:'

/**
 * DECISIONS 11.1 — 프리셋 + 저장된 필터 + JQL 탈출구.
 *
 * 폼 빌더를 만들지 않는 이유: "우리 팀 티켓"의 정의가 조직마다 달라서
 * 결국 JQL의 표현력이 필요해진다. 프리셋으로 흔한 경우를 덮고,
 * 이미 Jira에 만들어둔 필터는 그대로 불러오고, 나머지는 JQL을 열어준다.
 */
export function JiraConfigForm({ config, onChange }: WidgetConfigFormProps<JiraWidgetConfig>) {
  const [presets, setPresets] = useState<Preset[]>([])
  const [projects, setProjects] = useState<JiraProject[]>([])
  const [fetchedAt, setFetchedAt] = useState<string | null>(null)
  const [refreshing, setRefreshing] = useState(false)
  const now = useNow()

  // 저장된 필터 목록. 프리셋과 달리 서버에 물어봐야 하므로 실패할 수 있다.
  //
  // **실패해도 프리셋 선택을 막지 않는다.** 필터 조회가 안 됐다고 위젯 설정
  // 자체를 못 하게 되면, 원래 되던 일이 새 기능 때문에 막히는 것이다.
  // 그래서 에러를 셀렉트 옆에 인라인으로 드러내고(조용한 실패 금지) 셀렉트는 살려둔다.
  const [filters, setFilters] = useState<JiraFilter[]>([])
  const [filtersError, setFiltersError] = useState<string | null>(null)
  const [filtersLoading, setFiltersLoading] = useState(true)

  const loadFilters = useCallback(async () => {
    setFiltersLoading(true)
    setFiltersError(null)
    const r = await commands.jiraFilters()
    if (r.status === 'ok') {
      setFilters(r.data)
    } else {
      setFiltersError(r.error.message)
    }
    setFiltersLoading(false)
  }, [])

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

  // 설정창을 열 때 1회. **앱 시작 경로가 아니다** — 위젯을 그리는 데는
  // config에 저장된 필터 이름만 있으면 되고, 목록은 여기서만 필요하다.
  useEffect(() => {
    void commands.jiraPresets().then(setPresets)
    void loadProjects(false)
    void loadFilters()
  }, [loadProjects, loadFilters])

  // 정렬과 프로젝트 범위는 프리셋과 저장된 필터에 적용된다 (Rust와 같은 판단 —
  // 둘 다 우리가 만든 완결된 JQL이라 ORDER BY를 잘라 붙이는 것이 안전하다).
  // 생 JQL만 손대지 않는다 — 사용자가 ORDER BY와 project 조건을 직접 쓴다.
  const isPreset = config.query.kind === 'preset'
  const isSavedFilter = config.query.kind === 'savedFilter'
  const isGenerated = isPreset || isSavedFilter
  const scoped = config.projects ?? []

  // placeholder로 보여줄 기본 이름 — 프리셋/필터 이름이거나 'Jira'.
  const defaultTitle =
    config.query.kind === 'preset'
      ? (presets.find((p) => p.id === presetId(config))?.name ?? 'Jira')
      : config.query.kind === 'savedFilter'
        ? config.query.name || 'Jira'
        : 'Jira'
  const toggleProject = (key: string) => {
    onChange({
      ...config,
      projects: scoped.includes(key) ? scoped.filter((k) => k !== key) : [...scoped, key],
    })
  }

  const selected =
    config.query.kind === 'preset'
      ? config.query.id
      : config.query.kind === 'savedFilter'
        ? `${FILTER_PREFIX}${config.query.id}`
        : RAW

  /** 셀렉트 값 → config.query. 프리픽스로 세 갈래를 가른다. */
  const selectQuery = (value: string) => {
    if (value === RAW) {
      onChange({ ...config, query: { kind: 'raw', jql: currentJql(config, presets) } })
      return
    }
    if (value.startsWith(FILTER_PREFIX)) {
      const id = value.slice(FILTER_PREFIX.length)
      // 이름을 함께 저장한다 — 위젯 제목과 에러 메시지가 서버 응답을 기다리지
      // 않아도 되게. 진실의 원천은 id이고 name은 표시용 캐시다.
      const name = filters.find((f) => f.id === id)?.name ?? ''
      onChange({ ...config, query: { kind: 'savedFilter', id, name } })
      return
    }
    onChange({ ...config, query: { kind: 'preset', id: value } })
  }

  // 현재 고른 필터. 목록에 없으면(지워졌거나 조회 실패) 셀렉트가 매칭 option을
  // 못 찾아 엉뚱한 항목을 고른 것처럼 보인다 — 아래에서 임시 option으로 막는다.
  const savedFilter = config.query.kind === 'savedFilter' ? config.query : null
  const selectedFilterMissing =
    savedFilter !== null && !filters.some((f) => f.id === savedFilter.id)

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
            onChange={(e) => selectQuery(e.target.value)}
            className="rounded border border-border-subtle bg-surface-inset px-2 py-2.5
                     text-body text-text-primary"
          >
            {/*
            프리셋을 아직 못 불러왔는데 현재 설정이 프리셋이면, 그 id를 임시 옵션으로
            넣어둔다. 안 그러면 select가 매칭되는 option을 못 찾아 마지막 항목(RAW)을
            고른 것처럼 보이고, 사용자가 건드리지도 않은 설정이 바뀐 듯 보인다.
          */}
            {presets.length === 0 && !savedFilter && selected !== RAW && (
              <option value={selected}>불러오는 중…</option>
            )}
            {presets.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}

            {/*
              저장된 필터를 프리셋과 **같은 목록 안**에 둔다. 둘은 사용자에게
              "무엇을 볼지 고르는 일" 하나이고, 셀렉트를 두 개로 나누면
              어느 쪽이 이기는지를 사용자가 추론해야 한다.

              현재 고른 필터가 목록에 없으면 그것만 임시 항목으로 넣는다 —
              위 프리셋 로딩과 같은 이유(선택이 조용히 튀는 것을 막는다).
            */}
            {selectedFilterMissing && savedFilter && (
              <optgroup label="저장된 필터">
                <option value={`${FILTER_PREFIX}${savedFilter.id}`}>
                  {savedFilter.name || `필터 ${savedFilter.id}`}
                  {filtersLoading ? ' (불러오는 중…)' : ' (목록에 없음)'}
                </option>
              </optgroup>
            )}
            {filters.length > 0 && (
              <optgroup label="저장된 필터">
                {filters.map((f) => (
                  <option key={f.id} value={`${FILTER_PREFIX}${f.id}`}>
                    {f.name}
                    {f.ownerIsMe ? '' : ' (공유받음)'}
                  </option>
                ))}
              </optgroup>
            )}

            <option value={RAW}>직접 입력 (JQL)</option>
          </select>

          {config.query.kind === 'preset' && (
            <span className="text-caption text-text-tertiary">
              {presets.find((p) => p.id === presetId(config))?.description}
            </span>
          )}

          {/*
            필터 조회 실패를 화면에 드러낸다 (CLAUDE.md 대전제 2 — 조용한 실패 금지).
            셀렉트 자체는 살아 있으므로 프리셋은 그대로 고를 수 있다.
          */}
          {filtersError && (
            <span className="flex flex-wrap items-center gap-2 text-caption text-danger">
              <span>저장된 필터 목록을 불러오지 못했습니다: {filtersError}</span>
              <button
                type="button"
                onClick={() => void loadFilters()}
                className="rounded border border-border-subtle px-1.5 py-0.5
                           text-text-secondary hover:bg-surface-inset"
              >
                다시 시도
              </button>
              <span className="text-text-tertiary">프리셋은 그대로 선택할 수 있습니다</span>
            </span>
          )}
          {filtersLoading && !filtersError && (
            <span className="text-caption text-text-quaternary">저장된 필터 불러오는 중…</span>
          )}
          {/* 필터의 JQL을 보여준다 — 이 필터가 무엇을 보는지 확인용(저장하지는 않는다) */}
          {savedFilter && (
            <span className="font-mono text-caption text-text-tertiary">
              {filters.find((f) => f.id === savedFilter.id)?.jql ?? `filter = ${savedFilter.id}`}
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

        {/* 프로젝트 범위와 정렬은 프리셋·저장된 필터에만 (생 JQL에는 사용자가 직접 쓴다) */}
        {isGenerated && (
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

        {isGenerated && (
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

      <Section>
        <label className="flex items-center gap-2">
          <input
            type="checkbox"
            checked={config.groupByParent ?? false}
            onChange={(e) => onChange({ ...config, groupByParent: e.target.checked })}
            className="accent-accent"
          />
          <span className="text-body text-text-primary">상위 항목별로 묶어서 보기</span>
        </label>
        {(config.groupByParent ?? false) && (
          <span className="text-caption text-text-tertiary">
            상위 항목이 없는 티켓은 별도 그룹에 모읍니다. 상위 열은 그룹 헤더로 대체됩니다.
          </span>
        )}
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

/**
 * 프리셋·저장된 필터 → 직접 입력으로 전환할 때의 시작점.
 *
 * 저장된 필터는 `filter = <id>`를 준다. 필터의 실제 JQL을 펼쳐 넣지 않는 이유:
 * 그러면 Jira에서 필터를 고쳐도 위젯이 따라가지 않는데, 사용자는 "저장된 필터를
 * 쓰던 위젯"이라고 기억한다. `filter = <id>`로 남기면 연결이 유지되고,
 * 펼치고 싶으면 Jira에서 복사해 붙이면 된다.
 */
function currentJql(config: JiraWidgetConfig, presets: Preset[]): string {
  const q = config.query
  if (q.kind === 'raw') return q.jql
  if (q.kind === 'savedFilter') return `filter = ${q.id} ORDER BY updated DESC`
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
