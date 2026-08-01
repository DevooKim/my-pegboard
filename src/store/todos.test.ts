import { describe, expect, it } from 'vitest'
import type { TodoItem } from '#/ipc/bindings'
import { addDays, dateKey, daysSinceOrigin, itemsOn, parseDateKey } from '#/store/todos'

function item(over: Partial<TodoItem> = {}): TodoItem {
  return {
    id: 'x',
    text: '할 일',
    done: false,
    date: '2026-08-01',
    originDate: '2026-08-01',
    carriedCount: 0,
    ...over,
  }
}

describe('dateKey', () => {
  /**
   * 이게 이 파일에서 가장 중요한 테스트다.
   * `toISOString()`을 쓰면 UTC라 한국 시간 오전 9시 이전에는 어제가 나온다 —
   * 자정 직후에 이월이 하루 밀리는 버그가 된다.
   */
  it('로컬 시각 기준이다 (UTC가 아니다)', () => {
    // 한국 시간 8월 1일 오전 2시. UTC로는 7월 31일 17시다.
    const earlyMorning = new Date(2026, 7, 1, 2, 0, 0)
    expect(dateKey(earlyMorning)).toBe('2026-08-01')
  })

  it('한 자리 월·일을 0으로 채운다', () => {
    expect(dateKey(new Date(2026, 0, 5))).toBe('2026-01-05')
  })

  it('연말 자정 직전도 그날로 친다', () => {
    expect(dateKey(new Date(2026, 11, 31, 23, 59, 59))).toBe('2026-12-31')
  })
})

describe('parseDateKey', () => {
  /** `new Date("2026-08-01")`은 UTC 자정 = 한국 오전 9시라 하루가 밀릴 수 있다. */
  it('로컬 자정으로 해석한다', () => {
    const d = parseDateKey('2026-08-01')
    expect(d.getFullYear()).toBe(2026)
    expect(d.getMonth()).toBe(7)
    expect(d.getDate()).toBe(1)
    expect(d.getHours()).toBe(0)
  })

  it('왕복해도 같은 키다', () => {
    for (const key of ['2026-01-01', '2026-02-28', '2026-12-31']) {
      expect(dateKey(parseDateKey(key))).toBe(key)
    }
  })
})

describe('addDays', () => {
  it('하루 앞뒤로 움직인다', () => {
    expect(addDays('2026-08-01', 1)).toBe('2026-08-02')
    expect(addDays('2026-08-01', -1)).toBe('2026-07-31')
  })

  it('월 경계를 넘는다', () => {
    expect(addDays('2026-07-31', 1)).toBe('2026-08-01')
    expect(addDays('2026-08-01', -1)).toBe('2026-07-31')
  })

  it('연 경계를 넘는다', () => {
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01')
    expect(addDays('2027-01-01', -1)).toBe('2026-12-31')
  })

  it('윤년 2월을 안다', () => {
    // 2028은 윤년이다.
    expect(addDays('2028-02-28', 1)).toBe('2028-02-29')
    expect(addDays('2026-02-28', 1)).toBe('2026-03-01')
  })
})

describe('daysSinceOrigin', () => {
  /**
   * 배지 숫자는 **경과일**이고 좀비 판정은 **이월 횟수**다. 둘은 다른 것을 잰다.
   * 금요일에 만들어 월요일에 이월되면 이월은 1회지만 3일이 지났다 —
   * 배지에 "1일째"라고 쓰면 거짓말이다.
   */
  it('주말을 건너뛴 이월도 실제 경과일을 센다', () => {
    const friday = item({ originDate: '2026-07-31', carriedCount: 1 })
    // 8/3은 월요일. 이월은 1회지만 3일이 지났다.
    expect(daysSinceOrigin(friday, '2026-08-03')).toBe(3)
  })

  it('같은 날이면 0이다', () => {
    expect(daysSinceOrigin(item(), '2026-08-01')).toBe(0)
  })

  it('월 경계를 넘어도 센다', () => {
    expect(daysSinceOrigin(item({ originDate: '2026-07-30' }), '2026-08-02')).toBe(3)
  })

  it('미래 originDate에도 음수를 내지 않는다', () => {
    expect(daysSinceOrigin(item({ originDate: '2026-08-05' }), '2026-08-01')).toBe(0)
  })
})

describe('itemsOn', () => {
  it('그 날짜의 항목만 고른다', () => {
    const items = [
      item({ id: 'a', date: '2026-08-01' }),
      item({ id: 'b', date: '2026-07-31' }),
      item({ id: 'c', date: '2026-08-01' }),
    ]
    expect(itemsOn(items, '2026-08-01').map((i) => i.id)).toEqual(['a', 'c'])
  })

  /**
   * 배열 순서 = 추가된 순서를 지킨다. 이월 항목은 원래 배열에 먼저 들어가
   * 있으므로 위로 온다 — 미루는 것을 압박한다는 목적에 맞는다.
   * 매일 재정렬하면 어제 있던 자리에 오늘도 있다는 안정감이 사라진다.
   */
  it('배열 순서를 바꾸지 않는다', () => {
    const items = [
      item({ id: 'carried', date: '2026-08-01', carriedCount: 3 }),
      item({ id: 'fresh', date: '2026-08-01' }),
    ]
    expect(itemsOn(items, '2026-08-01').map((i) => i.id)).toEqual(['carried', 'fresh'])
  })

  it('없는 날짜는 빈 배열이다', () => {
    expect(itemsOn([item()], '2026-09-09')).toEqual([])
  })
})
