import { RefreshCw } from 'lucide-react'
import type {
  LinearCustomFilter,
  LinearGlobalMetadata,
  LinearTeam,
  LinearTeamMetadata,
} from '#/ipc/bindings'
import type { CompleteCustomFilter } from './customQuery'
import { isoToLocalDate, localDateEndIso, localDateStartIso } from './customQuery'

const PRIORITIES = [
  { value: 0, label: 'No priority' },
  { value: 1, label: 'Urgent' },
  { value: 2, label: 'High' },
  { value: 3, label: 'Normal' },
  { value: 4, label: 'Low' },
]

export function CustomQueryFields({
  filter,
  teams,
  globalMetadata,
  teamMetadata,
  onChange,
  onTeamToggle,
  refreshing,
  onRefreshGlobal,
  onRefreshTeam,
}: {
  filter: CompleteCustomFilter
  teams: LinearTeam[]
  globalMetadata: LinearGlobalMetadata | null
  teamMetadata: Record<string, LinearTeamMetadata>
  onChange: (next: CompleteCustomFilter) => void
  onTeamToggle: (teamId: string) => void
  refreshing: boolean
  onRefreshGlobal: () => void
  onRefreshTeam: (teamId: string) => void
}) {
  const selectedTeamIds = filter.teamIds ?? []
  const selectedTeamMetadata = selectedTeamIds
    .map((teamId) => teamMetadata[teamId])
    .filter((metadata): metadata is LinearTeamMetadata => metadata !== undefined)
  const stateTypes = unique(
    selectedTeamMetadata.flatMap((metadata) =>
      metadata.states.items.map((state) => state.typeName),
    ),
  )
  const projects = uniqueBy(
    selectedTeamMetadata.flatMap((metadata) => metadata.projects.items),
    (project) => project.id,
  )

  const toggle = <T,>(key: 'stateTypes' | 'projectIds' | 'labelIds' | 'priorities', value: T) => {
    const current = (filter[key] ?? []) as T[]
    onChange({
      ...filter,
      [key]: current.includes(value)
        ? current.filter((item) => item !== value)
        : [...current, value],
    })
  }

  const setDate = (
    key: 'createdFrom' | 'createdTo' | 'updatedFrom' | 'updatedTo',
    value: string,
  ) => {
    onChange({
      ...filter,
      [key]: value
        ? key.endsWith('From')
          ? localDateStartIso(value)
          : localDateEndIso(value)
        : null,
    })
  }

  return (
    <div className="flex flex-col gap-3">
      <p className="rounded bg-surface-inset px-2 py-1.5 text-caption text-text-secondary leading-relaxed-ko">
        모든 조건을 동시에 만족하는 이슈만 표시합니다
      </p>

      <fieldset className="flex flex-col gap-1">
        <legend className="flex items-center gap-2 text-caption text-text-secondary">
          <span>팀</span>
          <button
            type="button"
            aria-label="전역 메타데이터 새로고침"
            title="전역 메타데이터 새로고침"
            onClick={onRefreshGlobal}
            disabled={refreshing}
            className="rounded p-0.5 text-text-quaternary hover:text-text-secondary disabled:opacity-40"
          >
            <RefreshCw size={11} className={refreshing ? 'animate-spin' : ''} />
          </button>
        </legend>
        {teams.map((team) => (
          <label key={team.id} className="flex items-center gap-2">
            <input
              type="checkbox"
              aria-label={team.name}
              checked={selectedTeamIds.includes(team.id)}
              onChange={() => onTeamToggle(team.id)}
              className="accent-accent"
            />
            <span className="text-body text-text-primary">{team.name}</span>
            <span className="ticket-key text-text-quaternary">{team.key}</span>
          </label>
        ))}
      </fieldset>

      {selectedTeamIds.length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="text-caption text-text-tertiary">선택한 팀 메타데이터</span>
          {selectedTeamIds.map((teamId) => {
            const teamName = teams.find((team) => team.id === teamId)?.name ?? teamId
            return (
              <button
                key={teamId}
                type="button"
                aria-label={`${teamName} 메타데이터 새로고침`}
                title={`${teamName} 메타데이터 새로고침`}
                onClick={() => onRefreshTeam(teamId)}
                disabled={refreshing}
                className="flex items-center gap-1 rounded border border-border-subtle px-1.5 py-0.5 text-caption text-text-secondary disabled:opacity-40"
              >
                <RefreshCw size={11} className={refreshing ? 'animate-spin' : ''} />
                {teamName} 새로고침
              </button>
            )
          })}
        </div>
      )}

      <label className="flex flex-col gap-1">
        <span className="text-caption text-text-secondary">담당자 관계</span>
        <select
          aria-label="담당자 조건"
          value={filter.assignee ?? 'any'}
          onChange={(event) =>
            onChange({
              ...filter,
              assignee: event.target.value as NonNullable<LinearCustomFilter['assignee']>,
            })
          }
          className="rounded border border-border-subtle bg-surface-inset px-2 py-2 text-body text-text-primary"
        >
          <option value="any">모든 담당자</option>
          <option value="viewer">내게 할당</option>
          <option value="unassigned">미할당</option>
        </select>
      </label>

      <CheckboxGroup
        legend="상태 유형"
        values={stateTypes}
        selected={filter.stateTypes ?? []}
        label={(value) => value}
        onToggle={(value) => toggle('stateTypes', value)}
      />

      <CheckboxGroup
        legend="프로젝트"
        values={projects}
        selected={filter.projectIds ?? []}
        label={(project) => project.name}
        value={(project) => project.id}
        onToggle={(project) => toggle('projectIds', project.id)}
      />

      <CheckboxGroup
        legend="라벨"
        values={globalMetadata?.labels.items ?? []}
        selected={filter.labelIds ?? []}
        label={(label) => label.name}
        value={(label) => label.id}
        onToggle={(label) => toggle('labelIds', label.id)}
      />

      <CheckboxGroup
        legend="우선순위"
        values={PRIORITIES}
        selected={filter.priorities ?? []}
        label={(priority) => priority.label}
        value={(priority) => priority.value}
        onToggle={(priority) => toggle('priorities', priority.value)}
      />

      <DateRange
        legend="생성일"
        from={filter.createdFrom}
        to={filter.createdTo}
        onChange={(key, value) => setDate(key, value)}
      />
      <DateRange
        legend="수정일"
        from={filter.updatedFrom}
        to={filter.updatedTo}
        onChange={(key, value) => setDate(key, value)}
      />
    </div>
  )
}

function CheckboxGroup<T>({
  legend,
  values,
  selected,
  label,
  value = (item) => item as string,
  onToggle,
}: {
  legend: string
  values: T[]
  selected: (string | number)[]
  label: (item: T) => string
  value?: (item: T) => string | number
  onToggle: (item: T) => void
}) {
  if (values.length === 0) return null
  return (
    <fieldset className="flex flex-col gap-1">
      <legend className="text-caption text-text-secondary">{legend}</legend>
      {values.map((item) => {
        const itemValue = value(item)
        return (
          <label key={String(itemValue)} className="flex items-center gap-2">
            <input
              type="checkbox"
              aria-label={`${legend}: ${label(item)}`}
              checked={selected.includes(itemValue)}
              onChange={() => onToggle(item)}
              className="accent-accent"
            />
            <span className="text-body text-text-primary">{label(item)}</span>
          </label>
        )
      })}
    </fieldset>
  )
}

function DateRange({
  legend,
  from,
  to,
  onChange,
}: {
  legend: string
  from: string | null | undefined
  to: string | null | undefined
  onChange: (key: 'createdFrom' | 'createdTo' | 'updatedFrom' | 'updatedTo', value: string) => void
}) {
  const prefix = legend === '생성일' ? 'created' : 'updated'
  const fromKey = `${prefix}From` as 'createdFrom' | 'updatedFrom'
  const toKey = `${prefix}To` as 'createdTo' | 'updatedTo'
  const reversed = !!from && !!to && from > to
  return (
    <fieldset className="flex flex-col gap-1">
      <legend className="text-caption text-text-secondary">{legend}</legend>
      <div className="grid grid-cols-2 gap-2">
        <label className="flex flex-col gap-1">
          <span className="text-caption text-text-tertiary">시작</span>
          <input
            type="date"
            aria-label={`${legend} 시작`}
            value={isoToLocalDate(from)}
            onChange={(event) => onChange(fromKey, event.target.value)}
            className="rounded border border-border-subtle bg-surface-inset px-2 py-1.5 text-body text-text-primary"
          />
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-caption text-text-tertiary">종료</span>
          <input
            type="date"
            aria-label={`${legend} 종료`}
            value={isoToLocalDate(to)}
            onChange={(event) => onChange(toKey, event.target.value)}
            className="rounded border border-border-subtle bg-surface-inset px-2 py-1.5 text-body text-text-primary"
          />
        </label>
      </div>
      {reversed && <p className="text-caption text-danger">시작일이 종료일보다 늦습니다</p>}
    </fieldset>
  )
}

function unique(values: string[]): string[] {
  return [...new Set(values)]
}

function uniqueBy<T>(values: T[], key: (value: T) => string): T[] {
  const seen = new Set<string>()
  return values.filter((value) => {
    const id = key(value)
    if (seen.has(id)) return false
    seen.add(id)
    return true
  })
}
