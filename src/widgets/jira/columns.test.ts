import { describe, expect, it } from 'vitest'
import {
  clampColumn,
  DEFAULT_COLUMN_WIABCS,
  DEFAULT_VISIBLE_COLUMNS,
  gridTemplate,
  MAX_COLUMN_WIABC,
  MIN_COLUMN_WIABC,
  nextWidth,
  renderedColumns,
  resizableColumns,
  TOGGLEABLE_COLUMNS,
  type ToggleableColumn,
  withDefaults,
} from '#/widgets/jira/columns'

/**
 * 드래그 방향 계산을 여기서 고정한다.
 *
 * 이 부분에서 한 번 틀렸다 — 상태|담당 경계를 끌었는데 담당이 아니라 상태가
 * 움직였다. 원인은 "경계 왼쪽 열을 키운다"는 직관이 이 그리드에서 틀리기
 * 때문이다. 제목이 1fr이라 벌어진 자리를 전부 흡수해버려서, 왼쪽 열을 키우면
 * 화면에서는 제목만 줄어든 것처럼 보인다.
 */
// 실제 구현을 그대로 부른다. 여기서 공식을 베껴 쓰면 코드가 틀려도 통과한다.
const dragResult = (start: number, dx: number, invert: boolean) =>
  nextWidth('status', start, dx, invert)

describe('열 드래그 방향', () => {
  it('경계를 왼쪽으로 끌면 오른쪽 열이 넓어진다', () => {
    // 상태|담당 경계에서 왼쪽으로 20px → 오른쪽 열이 20px 넓어져야 한다
    expect(dragResult(60, -20, false)).toBe(80)
  })

  it('경계를 오른쪽으로 끌면 오른쪽 열이 좁아진다', () => {
    expect(dragResult(56, +20, false)).toBe(36)
  })

  it('키 열만 역방향 — 오른쪽으로 끌면 넓어진다', () => {
    // 키 오른쪽은 제목(1fr)이라 조절할 px가 없다. 키 자신을 키운다.
    expect(nextWidth('key', 64, +20, true)).toBe(84)
  })
})

describe('clampColumn', () => {
  it('최솟값 아래로 내려가지 않는다', () => {
    expect(clampColumn('key', 0)).toBe(MIN_COLUMN_WIABC.key)
    expect(clampColumn('assignee', -100)).toBe(MIN_COLUMN_WIABC.assignee)
  })

  it('최댓값을 넘지 않는다', () => {
    expect(clampColumn('status', 9999)).toBe(MAX_COLUMN_WIABC)
  })

  it('소수점을 정리한다', () => {
    expect(clampColumn('key', 80.6)).toBe(81)
  })
})

describe('gridTemplate', () => {
  it('제목만 1fr이고 나머지는 고정 px다', () => {
    const t = gridTemplate(DEFAULT_COLUMN_WIABCS, 'wide')
    expect(t.match(/fr/g)).toHaveLength(1)
    expect(t).toContain('minmax(0, 1fr)')
  })

  it('compact에서는 상태가 6px 점으로 축약된다', () => {
    const t = gridTemplate({ ...DEFAULT_COLUMN_WIABCS, status: 200 }, 'compact')
    expect(t).toContain('6px')
    expect(t).not.toContain('200px')
  })

  it('넓은 열은 wide에서만 나온다', () => {
    const cols = (d: 'compact' | 'normal' | 'wide') =>
      gridTemplate(DEFAULT_COLUMN_WIABCS, d).split(' ').length
    expect(cols('wide')).toBeGreaterThan(cols('normal'))
    expect(gridTemplate(DEFAULT_COLUMN_WIABCS, 'normal')).not.toContain(
      `${DEFAULT_COLUMN_WIABCS.sprint}px`,
    )
  })
})

describe('withDefaults', () => {
  it('저장된 값이 없으면 기본값을 쓴다', () => {
    expect(withDefaults(undefined)).toEqual(DEFAULT_COLUMN_WIABCS)
  })

  it('일부만 저장돼 있어도 나머지는 기본값으로 채운다', () => {
    // 열이 추가된 뒤 옛 config를 읽는 경우.
    expect(withDefaults({ key: 100 })).toEqual({ ...DEFAULT_COLUMN_WIABCS, key: 100 })
  })
})

describe('resizableColumns', () => {
  it('compact에서는 상태를 조절하지 않는다 (6px 점이라 조절할 것이 없다)', () => {
    expect(resizableColumns('compact')).not.toContain('status')
  })

  it('넓은 열(수정·생성·마감·상위·스프린트)은 wide에서만 그려진다', () => {
    // 기본 표시 세트에 sprint가 들어 있으므로 그걸로 확인한다.
    expect(resizableColumns('normal')).not.toContain('sprint')
    expect(resizableColumns('wide')).toContain('sprint')

    // 명시적으로 켠 경우에도 마찬가지다.
    expect(resizableColumns('normal', ['key', 'updated'])).not.toContain('updated')
    expect(resizableColumns('wide', ['key', 'updated'])).toContain('updated')
  })
})

describe('헤더와 행의 열 정렬', () => {
  /**
   * 실제로 겪은 버그: 열을 추가하면서 행에 스프린트·상위 셀을 빠뜨려
   * 뒤의 값들이 한 칸씩 왼쪽으로 밀렸다. 헤더는 5칸인데 데이터는 4칸이었다.
   *
   * 이제 헤더와 행이 같은 renderedColumns()를 map으로 돌기 때문에
   * 구조적으로 어긋날 수 없다. 그 계약을 여기서 고정한다.
   */
  const densities = ['compact', 'normal', 'wide'] as const

  it('grid 열 개수가 렌더 열 개수 + 제목과 항상 일치한다', () => {
    for (const d of densities) {
      for (const visible of [
        DEFAULT_VISIBLE_COLUMNS,
        TOGGLEABLE_COLUMNS.slice(),
        ['key'] as ToggleableColumn[],
        ['sprint', 'dueDate'] as ToggleableColumn[],
        [] as ToggleableColumn[],
      ]) {
        const tracks = gridTemplate(DEFAULT_COLUMN_WIABCS, d, visible)
          // minmax(0, 1fr)에 공백이 있어 단순 split이 안 된다
          .replace(/minmax\([^)]*\)/g, 'FR')
          .split(/\s+/)
          .filter(Boolean)
        const cells = renderedColumns(d, visible).length + 1 // +1 = 제목
        expect(tracks).toHaveLength(cells)
      }
    }
  })

  it('렌더 순서는 TOGGLEABLE_COLUMNS 순서를 따른다 (설정에서 고른 순서가 아니라)', () => {
    // 사용자가 아무 순서로 켜도 화면 순서는 일정해야 한다.
    const shuffled = ['dueDate', 'key', 'sprint', 'status'] as ToggleableColumn[]
    expect(renderedColumns('wide', shuffled)).toEqual(['key', 'status', 'sprint', 'dueDate'])
  })

  it('조절 가능한 열은 항상 렌더되는 열의 부분집합이다', () => {
    for (const d of densities) {
      const rendered = renderedColumns(d, TOGGLEABLE_COLUMNS.slice())
      for (const c of resizableColumns(d, TOGGLEABLE_COLUMNS.slice())) {
        expect(rendered).toContain(c)
      }
    }
  })
})
