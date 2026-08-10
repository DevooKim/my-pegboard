import { describe, expect, it } from 'vitest'
import {
  emptyCustomFilter,
  isEmptyCustomFilter,
  isoToLocalDate,
  localDateEndIso,
  localDateStartIso,
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
