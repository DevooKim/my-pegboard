/**
 * 목록 열 너비.
 *
 * 요약 열만 남는 공간을 먹고(`1fr`), 나머지는 사용자가 px로 조절한다.
 * 위젯별로 저장되므로 "내 티켓"은 담당자를 넓게, "팀 티켓"은 좁게 둘 수 있다.
 */
export type ColumnWidths = Record<ToggleableColumn, number>

export const DEFAULT_COLUMN_WIABCS: ColumnWidths = {
  key: 64,
  issueType: 48,
  status: 56,
  priority: 52,
  assignee: 20,
  sprint: 72,
  parent: 68,
  updated: 44,
  created: 44,
  dueDate: 52,
}

/** 이보다 좁으면 내용이 완전히 잘려 열의 의미가 없어진다. */
export const MIN_COLUMN_WIABC: Record<keyof ColumnWidths, number> = {
  key: 40,
  issueType: 24,
  status: 8,
  priority: 24,
  assignee: 20,
  sprint: 40,
  parent: 40,
  updated: 32,
  created: 32,
  dueDate: 32,
}

export const MAX_COLUMN_WIABC = 240

/**
 * 드래그 중의 새 너비.
 *
 * **경계선은 자기 오른쪽 열을 조절한다** — 선을 왼쪽으로 끌면 오른쪽 열이 넓어진다.
 * "경계 왼쪽 열을 키운다"가 더 직관적으로 들리지만 이 그리드에서는 틀리다.
 * 제목이 1fr이라 벌어진 자리를 전부 흡수해서, 왼쪽 열을 키우면 화면에서는
 * 제목만 줄어든 것처럼 보이기 때문이다.
 *
 * `invert`는 키 열 전용이다. 그 오른쪽이 제목(1fr)이라 조절할 px가 없으므로
 * 자기 자신을 정방향으로 키운다.
 */
export function nextWidth(
  col: keyof ColumnWidths,
  startWidth: number,
  deltaX: number,
  invert: boolean,
): number {
  return clampColumn(col, startWidth + (invert ? deltaX : -deltaX))
}

export function clampColumn(col: keyof ColumnWidths, px: number): number {
  return Math.min(MAX_COLUMN_WIABC, Math.max(MIN_COLUMN_WIABC[col], Math.round(px)))
}

export function withDefaults(partial: Partial<ColumnWidths> | undefined): ColumnWidths {
  return { ...DEFAULT_COLUMN_WIABCS, ...partial }
}

/** 사용자가 켜고 끌 수 있는 열. `summary`(제목)는 끌 수 없다 — 목록의 본체다. */
export const TOGGLEABLE_COLUMNS = [
  'key',
  'issueType',
  'status',
  'priority',
  'assignee',
  'sprint',
  'parent',
  'updated',
  'created',
  'dueDate',
] as const
export type ToggleableColumn = (typeof TOGGLEABLE_COLUMNS)[number]

export const COLUMN_LABELS: Record<ToggleableColumn, string> = {
  key: '키',
  issueType: '타입',
  status: '상태',
  priority: '우선순위',
  assignee: '담당',
  sprint: '스프린트',
  parent: '상위',
  updated: '수정',
  created: '생성',
  dueDate: '마감',
}

/** 좁은 위젯에서 자리를 너무 먹어 wide에서만 그리는 열. */
const WIDE_ONLY: ToggleableColumn[] = ['updated', 'created', 'dueDate', 'parent', 'sprint']

export const DEFAULT_VISIBLE_COLUMNS: ToggleableColumn[] = ['key', 'status', 'assignee', 'sprint']

/** 저장된 값을 정규화한다. 모르는 이름은 버리고, 순서는 항상 고정한다. */
export function visibleColumns(saved: string[] | null | undefined): ToggleableColumn[] {
  if (!saved) return DEFAULT_VISIBLE_COLUMNS
  const set = new Set(saved)
  return TOGGLEABLE_COLUMNS.filter((c) => set.has(c))
}

/**
 * grid-template-columns 문자열.
 * 밀도에 따라 열이 빠지므로(3열에서는 시간 없음) 여기서 함께 결정한다.
 */
export function gridTemplate(
  widths: ColumnWidths,
  density: 'compact' | 'normal' | 'wide',
  visible: ToggleableColumn[] = DEFAULT_VISIBLE_COLUMNS,
): string {
  const rendered = renderedColumns(density, visible)
  const cols: string[] = []
  if (rendered.includes('key')) cols.push(`${widths.key}px`)
  cols.push('minmax(0, 1fr)') // 제목은 항상 있고 항상 1fr
  for (const c of rendered) {
    if (c === 'key') continue
    cols.push(`${c === 'status' && density === 'compact' ? 6 : widths[c]}px`)
  }
  return cols.join(' ')
}

/** 실제로 그려지는 열. 밀도와 표시 설정을 모두 반영한다. */
export function renderedColumns(
  density: 'compact' | 'normal' | 'wide',
  visible: ToggleableColumn[] = DEFAULT_VISIBLE_COLUMNS,
): ToggleableColumn[] {
  const order = TOGGLEABLE_COLUMNS.filter((c) => visible.includes(c))
  return density === 'wide' ? [...order] : order.filter((c) => !WIDE_ONLY.includes(c))
}

/**
 * 밀도별로 조절 가능한 열.
 *
 * 각 경계선은 자기 **오른쪽** 열을 조절한다(ColumnHeader 참조). 따라서
 * 여기 담기는 것은 '경계가 존재하는 열'이다.
 *
 * compact에서는 상태가 6px 점으로 축약되므로 조절 대상이 아니고,
 * 수정 열은 wide에서만 존재한다.
 */
export function resizableColumns(
  density: 'compact' | 'normal' | 'wide',
  visible: ToggleableColumn[] = DEFAULT_VISIBLE_COLUMNS,
): Array<keyof ColumnWidths> {
  return renderedColumns(density, visible).filter(
    // compact의 상태는 6px 점이라 조절할 것이 없다.
    (c) => !(c === 'status' && density === 'compact'),
  )
}

/**
 * 열별 정렬. **헤더와 행이 이 하나의 표를 공유한다** — 따로 두면 반드시 어긋난다.
 *
 * 좌·중앙 두 가지만 쓴다. 오른쪽 정렬을 쓰지 않는 이유는 시간 값이
 * "2일 전"·"19일 지남"처럼 길이가 제각각이라 오른쪽에 붙여도 자릿수가
 * 맞지 않고, 헤더와 멀어져 어느 열인지 읽기 어려워지기 때문이다.
 *
 *   왼쪽  자유 길이 텍스트 — 왼쪽 끝이 맞아야 훑기 좋다.
 *   중앙  고정 어휘 값(상태·우선순위) + 시간 — 폭이 좁고 값이 짧다.
 */
export const COLUMN_ALIGN: Record<ToggleableColumn | 'summary', 'left' | 'center'> = {
  key: 'left',
  summary: 'left',
  issueType: 'left',
  status: 'center',
  priority: 'center',
  assignee: 'left',
  sprint: 'left',
  parent: 'left',
  updated: 'center',
  created: 'center',
  dueDate: 'center',
}

/** 텍스트 정렬 클래스. */
export function alignClass(col: ToggleableColumn | 'summary'): string {
  return COLUMN_ALIGN[col] === 'center' ? 'text-center' : 'text-left'
}

/** flex 컨테이너(담당자 셀 등)에서 쓰는 정렬. */
export function justifyClass(col: ToggleableColumn | 'summary'): string {
  return COLUMN_ALIGN[col] === 'center' ? 'justify-center' : 'justify-start'
}
