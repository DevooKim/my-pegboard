import { RefreshCw } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  commands,
  type LinearGlobalMetadata,
  type LinearPreset,
  type LinearSort,
  type LinearSortDirection,
  type LinearTeam,
  type LinearTeamMetadata,
  type LinearWidgetConfig,
} from '#/ipc/bindings'
import { relativeTime, useNow } from '#/ui/relativeTime'
import type { WidgetConfigFormProps } from '#/widgets/types'
import { CustomQueryFields } from './CustomQueryFields'
import {
  emptyCustomFilter,
  hasReversedDateRange,
  isEmptyCustomFilter,
  normalizeCustomFilter,
  pruneTeamDependentSelections,
} from './customQuery'

function transportErrorMessage(error: unknown): string {
  const detail = error instanceof Error ? error.message : String(error)
  return `Linear 메타데이터를 불러오지 못했습니다: ${detail}. 새로고침하세요.`
}

export function LinearConfigForm({
  config,
  onChange,
  onValidityChange,
}: WidgetConfigFormProps<LinearWidgetConfig>) {
  const [presets, setPresets] = useState<LinearPreset[]>([])
  const [presetsError, setPresetsError] = useState<string | null>(null)
  const [metadata, setMetadata] = useState<LinearGlobalMetadata | null>(null)
  const [teamMetadata, setTeamMetadata] = useState<Record<string, LinearTeamMetadata>>({})
  const [metadataError, setMetadataError] = useState<string | null>(null)
  const [metadataErrorTeamId, setMetadataErrorTeamId] = useState<string | null>(null)
  const [refreshing, setRefreshing] = useState(false)
  const metadataRequestRef = useRef(new Map<string, number>())
  const activeRefreshRef = useRef<{ key: string; requestId: number } | null>(null)
  const [globalRefreshVersion, setGlobalRefreshVersion] = useState(0)
  const now = useNow()
  const isCustom = config.query.kind === 'custom'
  const filter = useMemo(() => {
    return config.query.kind === 'custom'
      ? normalizeCustomFilter(config.query.filter)
      : emptyCustomFilter()
  }, [config.query])

  const loadMetadata = useCallback(async (teamId: string | null, refresh: boolean) => {
    const key = teamId ?? '__global__'
    const requestId = (metadataRequestRef.current.get(key) ?? 0) + 1
    metadataRequestRef.current.set(key, requestId)
    if (refresh) {
      activeRefreshRef.current = { key, requestId }
      setRefreshing(true)
    } else if (activeRefreshRef.current === null) {
      setRefreshing(false)
    }
    try {
      const result = await commands.linearMetadata(teamId, refresh)
      if (metadataRequestRef.current.get(key) !== requestId) return
      if (result.status !== 'ok') {
        setMetadataError(result.error)
        setMetadataErrorTeamId(teamId)
        return
      }

      const error = result.data.refreshError?.message ?? null
      if (teamId === null && (!refresh || !error)) setMetadata(result.data.global)
      const team = result.data.team
      if (team) {
        setTeamMetadata((current) => ({
          ...current,
          [team.teamId]: team,
        }))
      }
      setMetadataError(error)
      setMetadataErrorTeamId(error ? teamId : null)
      if (teamId === null && refresh && !error) {
        setGlobalRefreshVersion((version) => version + 1)
      }
    } catch (error) {
      if (metadataRequestRef.current.get(key) !== requestId) return
      setMetadataError(transportErrorMessage(error))
      setMetadataErrorTeamId(teamId)
    } finally {
      if (metadataRequestRef.current.get(key) === requestId) {
        if (
          activeRefreshRef.current?.key === key &&
          activeRefreshRef.current.requestId === requestId
        ) {
          activeRefreshRef.current = null
          setRefreshing(false)
        } else if (activeRefreshRef.current === null) {
          setRefreshing(false)
        }
      }
    }
  }, [])

  const loadPresets = useCallback(async () => {
    try {
      setPresets(await commands.linearPresets())
      setPresetsError(null)
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      setPresetsError(`Linear 쿼리 목록을 불러오지 못했습니다: ${detail}. 다시 시도하세요.`)
    }
  }, [])

  useEffect(() => {
    void loadPresets()
    void loadMetadata(null, false)
  }, [loadMetadata, loadPresets])

  const selectedCustomTeams = filter.teamIds ?? []
  useEffect(() => {
    if (!isCustom) return
    for (const teamId of selectedCustomTeams) {
      if (!teamMetadata[teamId]) void loadMetadata(teamId, false)
    }
  }, [isCustom, loadMetadata, selectedCustomTeams, teamMetadata])

  const valid = !isCustom || (!isEmptyCustomFilter(filter) && !hasReversedDateRange(filter))
  useEffect(() => {
    onValidityChange?.(valid)
  }, [onValidityChange, valid])

  const updateFilter = useCallback(
    (next: typeof filter) => {
      onChange({ ...config, query: { kind: 'custom', filter: next } })
    },
    [config, onChange],
  )

  useEffect(() => {
    if (!isCustom) return
    const next = pruneTeamDependentSelections(
      filter,
      selectedCustomTeams,
      teamMetadata,
      globalRefreshVersion > 0 ? metadata : null,
    )
    const teamIdsChanged =
      next.teamIds.length !== filter.teamIds.length ||
      next.teamIds.some((value, index) => value !== filter.teamIds[index])
    const stateTypesChanged =
      next.stateTypes.length !== filter.stateTypes.length ||
      next.stateTypes.some((value, index) => value !== filter.stateTypes[index])
    const projectIdsChanged =
      next.projectIds.length !== filter.projectIds.length ||
      next.projectIds.some((value, index) => value !== filter.projectIds[index])
    const labelIdsChanged =
      next.labelIds.length !== filter.labelIds.length ||
      next.labelIds.some((value, index) => value !== filter.labelIds[index])
    if (teamIdsChanged || stateTypesChanged || projectIdsChanged || labelIdsChanged) {
      updateFilter(next)
    }
  }, [
    filter,
    globalRefreshVersion,
    isCustom,
    metadata,
    selectedCustomTeams,
    teamMetadata,
    updateFilter,
  ])

  const chooseQuery = (value: string) => {
    if (value === '__custom__') {
      const next =
        config.query.kind === 'custom'
          ? config.query.filter
          : { ...emptyCustomFilter(), teamIds: [...(config.teams ?? [])] }
      onChange({ ...config, query: { kind: 'custom', filter: next } })
      return
    }
    onChange({ ...config, query: { kind: 'preset', id: value } })
  }

  const togglePresetTeam = (id: string) => {
    const selected = config.teams ?? []
    onChange({
      ...config,
      teams: selected.includes(id) ? selected.filter((teamId) => teamId !== id) : [...selected, id],
    })
  }

  const presetQuery = config.query.kind === 'preset' ? config.query : null
  const preset = presetQuery ? presets.find((p) => p.id === presetQuery.id) : null
  const defaultTitle = isCustom ? '직접 구성한 이슈' : (preset?.name ?? 'Linear')
  const teams = metadata?.teams.items ?? []

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
            className="rounded border border-border-subtle bg-surface-inset px-2 py-1.5 text-body text-text-primary placeholder:text-text-quaternary"
          />
        </label>

        <label className="flex flex-col gap-1">
          <span className="text-caption text-text-secondary">쿼리</span>
          <select
            aria-label="쿼리"
            value={isCustom ? '__custom__' : (presetQuery?.id ?? '')}
            onChange={(e) => chooseQuery(e.target.value)}
            className="rounded border border-border-subtle bg-surface-inset px-2 py-2.5 text-body text-text-primary"
          >
            <option value="__custom__">직접 구성</option>
            {presets.length === 0 && !isCustom && (
              <option value={presetQuery?.id ?? ''}>
                {presetsError ? '불러오지 못했습니다' : '불러오는 중…'}
              </option>
            )}
            {presets.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
          {preset && <span className="text-caption text-text-tertiary">{preset.description}</span>}
          {presetsError && (
            <div className="flex flex-wrap items-center gap-2 rounded bg-danger-muted px-2 py-1 text-caption text-danger">
              <span>{presetsError}</span>
              <button
                type="button"
                onClick={() => void loadPresets()}
                className="rounded border border-danger-muted px-1.5 py-0.5 text-text-primary"
              >
                쿼리 목록 다시 시도
              </button>
            </div>
          )}
        </label>

        <div className="grid grid-cols-2 gap-2">
          <label className="flex flex-col gap-1">
            <span className="text-caption text-text-secondary">정렬 필드</span>
            <select
              aria-label="정렬 필드"
              value={config.sort ?? 'updatedAt'}
              onChange={(e) => onChange({ ...config, sort: e.target.value as LinearSort })}
              className="rounded border border-border-subtle bg-surface-inset px-2 py-2.5 text-body text-text-primary"
            >
              <option value="updatedAt">최근 수정</option>
              <option value="createdAt">최근 생성</option>
            </select>
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-caption text-text-secondary">정렬 방향</span>
            <select
              aria-label="정렬 방향"
              value={config.sortDirection ?? 'descending'}
              onChange={(e) =>
                onChange({ ...config, sortDirection: e.target.value as LinearSortDirection })
              }
              className="rounded border border-border-subtle bg-surface-inset px-2 py-2.5 text-body text-text-primary"
            >
              <option value="descending">최신순</option>
              <option value="ascending">오래된순</option>
            </select>
          </label>
        </div>
        <span className="text-caption text-text-tertiary leading-relaxed-ko">
          Linear API가 제공하는 정렬은 생성일과 수정일뿐입니다.
        </span>
      </Section>

      {isCustom ? (
        <Section>
          <CustomQueryFields
            filter={filter}
            teams={teams}
            globalMetadata={metadata}
            teamMetadata={teamMetadata}
            onChange={updateFilter}
            refreshing={refreshing}
            onRefreshGlobal={() => void loadMetadata(null, true)}
            onRefreshTeam={(teamId) => void loadMetadata(teamId, true)}
            onTeamToggle={(id) => {
              const nextTeamIds = selectedCustomTeams.includes(id)
                ? selectedCustomTeams.filter((teamId) => teamId !== id)
                : [...selectedCustomTeams, id]
              updateFilter(
                pruneTeamDependentSelections(
                  { ...filter, teamIds: nextTeamIds },
                  nextTeamIds,
                  teamMetadata,
                ),
              )
              if (!teamMetadata[id]) void loadMetadata(id, false)
            }}
          />
          {!valid && isEmptyCustomFilter(filter) && (
            <p className="mt-3 rounded bg-danger-muted px-2 py-1 text-caption text-danger">
              조건을 하나 이상 선택하세요
            </p>
          )}
        </Section>
      ) : (
        <TeamScope
          teams={teams}
          selected={config.teams ?? []}
          error={metadataError}
          fetchedAt={metadata?.teams.fetchedAt ?? null}
          refreshing={refreshing}
          now={now}
          truncated={metadata?.teams.truncated ?? false}
          onRefresh={() => void loadMetadata(null, true)}
          onToggle={togglePresetTeam}
        />
      )}

      {isCustom && metadataError && (
        <div className="mx-3 mt-3 flex flex-wrap items-center gap-2 rounded bg-danger-muted px-2 py-1 text-caption text-danger">
          <span>{metadataError}</span>
          <button
            type="button"
            onClick={() => void loadMetadata(metadataErrorTeamId, true)}
            disabled={refreshing}
            className="rounded border border-danger-muted px-1.5 py-0.5 text-text-primary disabled:opacity-40"
          >
            다시 시도
          </button>
        </div>
      )}
      {isCustom && (
        <MetadataWarnings
          metadata={metadata}
          teamMetadata={teamMetadata}
          teamIds={selectedCustomTeams}
        />
      )}

      <Section>
        <label className="flex items-center gap-2">
          <input
            type="checkbox"
            checked={config.groupByTeam ?? true}
            onChange={(e) => onChange({ ...config, groupByTeam: e.target.checked })}
            className="accent-accent"
          />
          <span className="text-body text-text-primary">팀별로 묶어서 보기</span>
        </label>
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

function TeamScope({
  teams,
  selected,
  error,
  fetchedAt,
  refreshing,
  now,
  truncated,
  onRefresh,
  onToggle,
}: {
  teams: LinearTeam[]
  selected: string[]
  error: string | null
  fetchedAt: string | null
  refreshing: boolean
  now: number
  truncated: boolean
  onRefresh: () => void
  onToggle: (id: string) => void
}) {
  return (
    <Section>
      <div className="flex flex-col gap-1.5">
        <span className="flex items-center gap-2">
          <span className="text-caption text-text-secondary">팀 범위</span>
          <button
            type="button"
            onClick={onRefresh}
            disabled={refreshing}
            aria-label="팀 목록 새로고침"
            className="rounded p-0.5 text-text-quaternary hover:text-text-secondary disabled:opacity-40"
          >
            <RefreshCw size={11} className={refreshing ? 'animate-spin' : ''} />
          </button>
          {fetchedAt && (
            <span className="text-caption text-text-quaternary">
              {relativeTime(fetchedAt, new Date(now))}
            </span>
          )}
        </span>
        {error && (
          <p className="rounded bg-danger-muted px-2 py-1 text-caption text-danger">{error}</p>
        )}
        {truncated && <p className="text-caption text-stale">API 상한으로 일부만 표시됩니다</p>}
        {teams.length === 0 ? (
          <p className="text-caption text-text-tertiary">
            팀이 없습니다. 메타데이터를 새로고침하세요.
          </p>
        ) : (
          <ul className="max-h-40 space-y-0.5 overflow-y-auto rounded border border-border-subtle bg-surface-inset p-1.5">
            {teams.map((team) => (
              <li key={team.id}>
                <label className="flex cursor-pointer items-center gap-2 rounded px-1 py-0.5">
                  <input
                    type="checkbox"
                    aria-label={team.name}
                    checked={selected.includes(team.id)}
                    onChange={() => onToggle(team.id)}
                    className="accent-accent"
                  />
                  <span className="min-w-0 flex-1 truncate text-body text-text-primary">
                    {team.name}
                  </span>
                  <span className="ticket-key shrink-0 text-text-quaternary">{team.key}</span>
                </label>
              </li>
            ))}
          </ul>
        )}
      </div>
    </Section>
  )
}

function MetadataWarnings({
  metadata,
  teamMetadata,
  teamIds,
}: {
  metadata: LinearGlobalMetadata | null
  teamMetadata: Record<string, LinearTeamMetadata>
  teamIds: string[]
}) {
  const lists = [
    metadata?.teams,
    metadata?.labels,
    ...teamIds.flatMap((id) => {
      const team = teamMetadata[id]
      return team ? [team.states, team.members, team.projects] : []
    }),
  ]
  if (!lists.some((list) => list?.truncated)) return null
  return <p className="mx-3 mt-3 text-caption text-stale">API 상한으로 일부만 표시됩니다</p>
}

function Section({ last, children }: { last?: boolean; children: React.ReactNode }) {
  return (
    <div className={`flex flex-col gap-3 px-3 py-3 ${last ? '' : 'border-border-subtle border-b'}`}>
      {children}
    </div>
  )
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
        className="w-28 rounded border border-border-subtle bg-surface-inset px-2 py-1.5 text-body text-text-primary"
      />
      {hint && <span className="text-caption text-text-tertiary">{hint}</span>}
    </label>
  )
}
