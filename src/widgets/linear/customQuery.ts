import type {
  LinearAssigneeFilter,
  LinearCustomFilter,
  LinearGlobalMetadata,
  LinearTeamMetadata,
} from '#/ipc/bindings'

export type CompleteCustomFilter = {
  teamIds: string[]
  assignee: LinearAssigneeFilter
  stateTypes: string[]
  projectIds: string[]
  labelIds: string[]
  priorities: number[]
  createdFrom: string | null
  createdTo: string | null
  updatedFrom: string | null
  updatedTo: string | null
}

export function emptyCustomFilter(): CompleteCustomFilter {
  return {
    teamIds: [],
    assignee: 'any',
    stateTypes: [],
    projectIds: [],
    labelIds: [],
    priorities: [],
    createdFrom: null,
    createdTo: null,
    updatedFrom: null,
    updatedTo: null,
  }
}

export function normalizeCustomFilter(filter: LinearCustomFilter): CompleteCustomFilter {
  return {
    teamIds: filter.teamIds ?? [],
    assignee: filter.assignee ?? 'any',
    stateTypes: filter.stateTypes ?? [],
    projectIds: filter.projectIds ?? [],
    labelIds: filter.labelIds ?? [],
    priorities: filter.priorities ?? [],
    createdFrom: filter.createdFrom ?? null,
    createdTo: filter.createdTo ?? null,
    updatedFrom: filter.updatedFrom ?? null,
    updatedTo: filter.updatedTo ?? null,
  }
}

export function pruneTeamDependentSelections(
  filter: CompleteCustomFilter,
  teamIds: string[],
  teamMetadata: Record<string, LinearTeamMetadata>,
  globalMetadata: LinearGlobalMetadata | null = null,
): CompleteCustomFilter {
  const knownTeamIds = globalMetadata
    ? new Set(globalMetadata.teams.items.map((team) => team.id))
    : null
  const nextTeamIds = knownTeamIds ? teamIds.filter((teamId) => knownTeamIds.has(teamId)) : teamIds
  const knownLabelIds = globalMetadata
    ? new Set(globalMetadata.labels.items.map((label) => label.id))
    : null
  const selectedMetadata = nextTeamIds
    .map((teamId) => teamMetadata[teamId])
    .filter((metadata): metadata is LinearTeamMetadata => metadata !== undefined)
  const next = {
    ...filter,
    teamIds: nextTeamIds,
    ...(knownLabelIds
      ? { labelIds: filter.labelIds.filter((labelId) => knownLabelIds.has(labelId)) }
      : {}),
  }
  if (selectedMetadata.length !== nextTeamIds.length) return next

  const stateTypes = new Set(
    selectedMetadata.flatMap((metadata) => metadata.states.items.map((state) => state.typeName)),
  )
  const projectIds = new Set(
    selectedMetadata.flatMap((metadata) => metadata.projects.items.map((project) => project.id)),
  )

  return {
    ...next,
    stateTypes: filter.stateTypes.filter((value) => stateTypes.has(value)),
    projectIds: filter.projectIds.filter((value) => projectIds.has(value)),
  }
}

export function localDateStartIso(value: string): string {
  const [year = 0, month = 1, day = 1] = value.split('-').map(Number)
  return new Date(year, month - 1, day, 0, 0, 0, 0).toISOString()
}

export function localDateEndIso(value: string): string {
  const [year = 0, month = 1, day = 1] = value.split('-').map(Number)
  return new Date(year, month - 1, day, 23, 59, 59, 999).toISOString()
}

export function isoToLocalDate(value: string | null | undefined): string {
  if (!value) return ''
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return ''
  const pad = (part: number) => String(part).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

export function isEmptyCustomFilter(filter: LinearCustomFilter): boolean {
  return (
    (filter.teamIds?.length ?? 0) === 0 &&
    (filter.assignee ?? 'any') === 'any' &&
    (filter.stateTypes?.length ?? 0) === 0 &&
    (filter.projectIds?.length ?? 0) === 0 &&
    (filter.labelIds?.length ?? 0) === 0 &&
    (filter.priorities?.length ?? 0) === 0 &&
    !filter.createdFrom &&
    !filter.createdTo &&
    !filter.updatedFrom &&
    !filter.updatedTo
  )
}

export function hasReversedDateRange(filter: LinearCustomFilter): boolean {
  return (
    (!!filter.createdFrom && !!filter.createdTo && filter.createdFrom > filter.createdTo) ||
    (!!filter.updatedFrom && !!filter.updatedTo && filter.updatedFrom > filter.updatedTo)
  )
}
