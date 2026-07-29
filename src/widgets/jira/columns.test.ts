import { describe, expect, it } from 'vitest'
import {
  clampColumn,
  DEFAULT_COLUMN_WIABCS,
  gridTemplate,
  MAX_COLUMN_WIABC,
  MIN_COLUMN_WIABC,
  nextWidth,
  resizableColumns,
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

  it('수정 열은 wide에서만 나온다', () => {
    const cols = (d: 'compact' | 'normal' | 'wide') =>
      gridTemplate(DEFAULT_COLUMN_WIABCS, d).split(' ').length
    expect(cols('wide')).toBeGreaterThan(cols('normal'))
    expect(gridTemplate(DEFAULT_COLUMN_WIABCS, 'normal')).not.toContain(
      `${DEFAULT_COLUMN_WIABCS.updated}px`,
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

  it('수정 열 경계는 wide에서만 존재한다', () => {
    expect(resizableColumns('normal')).not.toContain('updated')
    expect(resizableColumns('wide')).toContain('updated')
  })
})
