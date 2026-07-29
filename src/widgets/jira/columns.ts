/**
 * 목록 열 너비.
 *
 * 요약 열만 남는 공간을 먹고(`1fr`), 나머지는 사용자가 px로 조절한다.
 * 위젯별로 저장되므로 "내 티켓"은 담당자를 넓게, "팀 티켓"은 좁게 둘 수 있다.
 */
export interface ColumnWidths {
  key: number
  status: number
  assignee: number
  updated: number
}

export const DEFAULT_COLUMN_WIABCS: ColumnWidths = {
  key: 64,
  status: 56,
  assignee: 20,
  updated: 44,
}

/** 이보다 좁으면 내용이 완전히 잘려 열의 의미가 없어진다. */
export const MIN_COLUMN_WIABC: Record<keyof ColumnWidths, number> = {
  key: 40,
  status: 8,
  assignee: 20,
  updated: 32,
}

export const MAX_COLUMN_WIABC = 240

export function clampColumn(col: keyof ColumnWidths, px: number): number {
  return Math.min(MAX_COLUMN_WIABC, Math.max(MIN_COLUMN_WIABC[col], Math.round(px)))
}

export function withDefaults(partial: Partial<ColumnWidths> | undefined): ColumnWidths {
  return { ...DEFAULT_COLUMN_WIABCS, ...partial }
}

/**
 * grid-template-columns 문자열.
 * 밀도에 따라 열이 빠지므로(3열에서는 시간 없음) 여기서 함께 결정한다.
 */
export function gridTemplate(widths: ColumnWidths, density: 'compact' | 'normal' | 'wide'): string {
  const status = density === 'compact' ? 6 : widths.status
  const cols = [`${widths.key}px`, 'minmax(0, 1fr)', `${status}px`, `${widths.assignee}px`]
  if (density === 'wide') cols.push(`${widths.updated}px`)
  return cols.join(' ')
}

/** 밀도별로 실제 존재하는, 드래그 가능한 열 경계. */
export function resizableColumns(
  density: 'compact' | 'normal' | 'wide',
): Array<keyof ColumnWidths> {
  if (density === 'compact') return ['key', 'assignee']
  if (density === 'normal') return ['key', 'status', 'assignee']
  return ['key', 'status', 'assignee', 'updated']
}
