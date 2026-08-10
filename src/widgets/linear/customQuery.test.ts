import { describe, expect, it } from 'vitest'
import type { LinearGlobalMetadata, LinearTeamMetadata } from '#/ipc/bindings'
import {
  emptyCustomFilter,
  isEmptyCustomFilter,
  isoToLocalDate,
  localDateEndIso,
  localDateStartIso,
  pruneTeamDependentSelections,
} from './customQuery'

describe('Linear custom query date boundaries', () => {
  it('converts a local date to inclusive local-day ISO boundaries', () => {
    expect(localDateStartIso('2026-08-10')).toBe(new Date(2026, 7, 10, 0, 0, 0, 0).toISOString())
    expect(localDateEndIso('2026-08-10')).toBe(new Date(2026, 7, 10, 23, 59, 59, 999).toISOString())
  })

  it('converts an ISO boundary back to the local date input value', () => {
    expect(isoToLocalDate(localDateEndIso('2026-08-10'))).toBe('2026-08-10')
  })
})

describe('Linear custom query validity', () => {
  it('recognizes the empty typed filter', () => {
    expect(isEmptyCustomFilter(emptyCustomFilter())).toBe(true)
    expect(isEmptyCustomFilter({ ...emptyCustomFilter(), priorities: [2] })).toBe(false)
  })
})

function globalMetadata(over: Partial<LinearGlobalMetadata> = {}): LinearGlobalMetadata {
  return {
    teams: {
      items: [{ id: 'team-eng', key: 'ENG', name: 'Engineering' }],
      fetchedAt: '2026-08-10T00:00:00Z',
      truncated: false,
    },
    viewer: null,
    labels: {
      items: [{ id: 'label-bug', name: 'Bug', color: '#ff0000' }],
      fetchedAt: '2026-08-10T00:00:00Z',
      truncated: false,
    },
    ...over,
  }
}

function teamMetadata(teamId: string): LinearTeamMetadata {
  return {
    teamId,
    states: {
      items: [
        {
          id: `state-${teamId}`,
          name: 'Started',
          color: '#f2c94c',
          typeName: 'started',
          position: 1,
        },
      ],
      fetchedAt: '2026-08-10T00:00:00Z',
      truncated: false,
    },
    members: { items: [], fetchedAt: '2026-08-10T00:00:00Z', truncated: false },
    projects: {
      items: [{ id: `project-${teamId}`, name: 'Auth', teamId }],
      fetchedAt: '2026-08-10T00:00:00Z',
      truncated: false,
    },
  }
}

describe('Linear custom query metadata completeness', () => {
  it('preserves team, label, state, and project selections when global lists are truncated', () => {
    const filter = {
      ...emptyCustomFilter(),
      teamIds: ['team-eng', 'team-unknown'],
      stateTypes: ['started', 'completed'],
      projectIds: ['project-team-eng', 'project-team-unknown'],
      labelIds: ['label-bug', 'label-unknown'],
    }

    expect(
      pruneTeamDependentSelections(
        filter,
        filter.teamIds,
        { 'team-eng': teamMetadata('team-eng') },
        globalMetadata({
          teams: { ...globalMetadata().teams, truncated: true },
          labels: { ...globalMetadata().labels, truncated: true },
        }),
      ),
    ).toEqual(filter)
  })

  it('prunes selections only against complete global lists', () => {
    const filter = {
      ...emptyCustomFilter(),
      teamIds: ['team-eng', 'team-gone'],
      stateTypes: ['started', 'completed'],
      projectIds: ['project-team-eng', 'project-team-gone'],
      labelIds: ['label-bug', 'label-gone'],
    }

    expect(
      pruneTeamDependentSelections(
        filter,
        filter.teamIds,
        { 'team-eng': teamMetadata('team-eng') },
        globalMetadata(),
      ),
    ).toEqual({
      ...filter,
      teamIds: ['team-eng'],
      stateTypes: ['started'],
      projectIds: ['project-team-eng'],
      labelIds: ['label-bug'],
    })
  })
})
