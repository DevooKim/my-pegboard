import { RefreshCw } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
import {
  commands,
  type GithubPreset,
  type GithubRepo,
  type GithubWidgetConfig,
} from '#/ipc/bindings'
import { relativeTime, useNow } from '#/ui/relativeTime'
import type { WidgetConfigFormProps } from '#/widgets/types'
import { ScopePicker } from './ScopePicker'

const RAW = '__raw__'

/**
 * DECISIONS 12 — 프리셋 + 검색 문법 탈출구.
 *
 * Jira 설정 폼과 같은 구조다. 다른 점은 **열 설정이 없다는 것** — GitHub은
 * 필드가 고정이고 전부 의미가 있어서 고를 이유가 없다.
 */
export function GithubConfigForm({ config, onChange }: WidgetConfigFormProps<GithubWidgetConfig>) {
  const [presets, setPresets] = useState<GithubPreset[]>([])
  const [repos, setRepos] = useState<GithubRepo[]>([])
  const [fetchedAt, setFetchedAt] = useState<string | null>(null)
  const [refreshing, setRefreshing] = useState(false)
  const [reposError, setReposError] = useState<string | null>(null)
  const now = useNow()

  const loadRepos = useCallback(async (force: boolean) => {
    if (force) setRefreshing(true)
    const r = await commands.githubRepos(force)
    if (r.status === 'ok') {
      setRepos(r.data.repos)
      setFetchedAt(r.data.fetchedAt)
      setReposError(null)
    } else {
      // 조용히 빈 목록을 두지 않는다. 왜 비었는지 말한다.
      setReposError(r.error)
    }
    setRefreshing(false)
  }, [])

  useEffect(() => {
    void commands.githubPresets().then(setPresets)
    void loadRepos(false)
  }, [loadRepos])

  const scoped = config.repos ?? []
  const selected = config.query.kind === 'preset' ? config.query.id : RAW

  const defaultTitle =
    config.query.kind === 'preset'
      ? (presets.find((p) => p.id === presetId(config))?.name ?? 'GitHub')
      : 'GitHub'

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
                    ? { kind: 'raw', query: currentSearch(config, presets) }
                    : { kind: 'preset', id: v },
              })
            }}
            className="rounded border border-border-subtle bg-surface-inset px-2 py-2.5
                       text-body text-text-primary"
          >
            {/* 프리셋을 아직 못 불러왔는데 현재 설정이 프리셋이면 임시 옵션을 넣는다.
                안 그러면 select가 마지막 항목(RAW)을 고른 것처럼 보인다. */}
            {presets.length === 0 && selected !== RAW && (
              <option value={selected}>불러오는 중…</option>
            )}
            {presets.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
            <option value={RAW}>직접 입력 (검색 문법)</option>
          </select>
          {config.query.kind === 'preset' && (
            <span className="text-caption text-text-tertiary">
              {presets.find((p) => p.id === presetId(config))?.description}
            </span>
          )}
        </label>

        {config.query.kind === 'raw' && (
          <label className="flex flex-col gap-1">
            <span className="text-caption text-text-secondary">검색</span>
            <textarea
              data-selectable
              value={config.query.query}
              onChange={(e) =>
                onChange({ ...config, query: { kind: 'raw', query: e.target.value } })
              }
              rows={2}
              spellCheck={false}
              placeholder="is:pr is:open review-requested:@me"
              className="resize-none rounded border border-border-subtle bg-surface-inset px-2 py-1.5
                         font-mono text-caption text-text-primary"
            />
            <span className="text-caption text-text-tertiary">
              GitHub 검색 문법 그대로입니다. 문법 오류는 위젯에 GitHub의 메시지가 표시됩니다
            </span>
          </label>
        )}
      </Section>

      {/* 범위 — 프리셋·직접 입력 **양쪽 모두**에 적용된다. */}
      <Section>
        <div className="flex flex-col gap-1.5">
          <span className="flex items-center gap-2">
            <span className="text-caption text-text-secondary">범위</span>
            <button
              type="button"
              onClick={() => void loadRepos(true)}
              disabled={refreshing}
              title="저장소 목록 새로고침"
              className="rounded p-0.5 text-text-quaternary hover:text-text-secondary
                         disabled:opacity-40 focus-visible:outline-2 focus-visible:outline-accent"
            >
              <RefreshCw size={11} className={refreshing ? 'animate-spin' : ''} />
            </button>
            {fetchedAt && (
              <span className="text-caption text-text-quaternary">
                {relativeTime(fetchedAt, new Date(now))}
              </span>
            )}
          </span>

          {reposError && (
            <p className="rounded bg-danger-muted px-2 py-1 text-caption text-danger">
              {reposError}
            </p>
          )}

          {/* 조직 저장소가 안 보이는 흔한 이유를 미리 알린다. 빈 목록만 보여주면
              "왜 없지"를 겪는다 (CLAUDE.md 대전제 2). */}
          {!reposError && repos.length === 0 && (
            <p className="text-caption text-text-tertiary">
              저장소가 없습니다. 조직 저장소가 안 보이면 토큰에 SSO 인증이 필요할 수 있습니다 —
              GitHub 토큰 설정에서 “Configure SSO”를 확인하세요.
            </p>
          )}

          <ScopePicker
            repos={repos}
            selectedRepos={scoped}
            selectedOrgs={config.orgs ?? []}
            onChangeRepos={(next) => onChange({ ...config, repos: next })}
            onChangeOrgs={(next) => onChange({ ...config, orgs: next })}
          />
        </div>
      </Section>

      {/* 그룹핑.
          순서 지정 UI가 여기 없는 이유: 위 "범위"에서 고른 순서가 곧 그룹
          순서다. 같은 저장소 목록을 두 군데서 고르게 하지 않는다. */}
      <Section>
        <label className="flex items-center gap-2">
          <input
            type="checkbox"
            checked={config.groupByRepo ?? true}
            onChange={(e) => onChange({ ...config, groupByRepo: e.target.checked })}
            className="accent-accent"
          />
          <span className="text-body text-text-primary">저장소별로 묶어서 보기</span>
        </label>
        {(config.groupByRepo ?? true) && (
          <span className="text-caption text-text-tertiary">
            그룹 순서는 위 <b>범위</b>에서 고른 순서를 따릅니다. 범위를 지정하지 않으면 최근
            갱신순입니다.
          </span>
        )}
      </Section>

      <Section last>
        <NumberField
          label="최대 건수"
          value={config.maxResults}
          min={5}
          max={100}
          onChange={(v) => onChange({ ...config, maxResults: v })}
        />
        <NumberField
          label="새로고침 주기 (초)"
          value={config.refreshSecs ?? 300}
          min={0}
          max={3600}
          hint="0이면 자동 갱신하지 않습니다"
          onChange={(v) => onChange({ ...config, refreshSecs: v })}
        />
      </Section>
    </div>
  )
}

function Section({ last, children }: { last?: boolean; children: React.ReactNode }) {
  return (
    <div className={`flex flex-col gap-3 px-3 py-3 ${last ? '' : 'border-border-subtle border-b'}`}>
      {children}
    </div>
  )
}

function presetId(config: GithubWidgetConfig): string | null {
  return config.query.kind === 'preset' ? config.query.id : null
}

/** 프리셋 → 직접 입력으로 바꿀 때 현재 쿼리를 씨앗으로 넣어준다. */
function currentSearch(config: GithubWidgetConfig, presets: GithubPreset[]): string {
  const query = config.query
  if (query.kind === 'raw') return query.query
  return presets.find((p) => p.id === query.id)?.query ?? 'is:open'
}

function NumberField({
  label,
  value,
  min,
  max,
  hint,
  onChange,
}: {
  label: string
  value: number
  min: number
  max: number
  hint?: string
  onChange: (v: number) => void
}) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-caption text-text-secondary">{label}</span>
      <input
        type="number"
        data-selectable
        value={value}
        min={min}
        max={max}
        onChange={(e) => {
          const n = Number.parseInt(e.target.value, 10)
          if (!Number.isNaN(n)) onChange(Math.min(Math.max(n, min), max))
        }}
        className="w-28 rounded border border-border-subtle bg-surface-inset px-2 py-1.5
                   text-body text-text-primary"
      />
      {hint && <span className="text-caption text-text-tertiary">{hint}</span>}
    </label>
  )
}
