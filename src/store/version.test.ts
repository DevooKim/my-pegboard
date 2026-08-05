import { describe, expect, it } from 'vitest'
import { compareVersions, isNewer, parseVersion } from '#/store/version'

describe('parseVersion', () => {
  it('pre-release 접미사를 무시한다', () => {
    expect(parseVersion('0.3.1-alpha')).toEqual([0, 3, 1])
    expect(parseVersion('1.0.0')).toEqual([1, 0, 0])
  })

  it('앞의 v를 떼어낸다 — 태그 이름을 그대로 넘겨도 동작해야 한다', () => {
    expect(parseVersion('v0.4.0-alpha')).toEqual([0, 4, 0])
  })

  it('빠진 자리는 0으로 채운다', () => {
    expect(parseVersion('1')).toEqual([1, 0, 0])
    expect(parseVersion('1.2')).toEqual([1, 2, 0])
  })

  it('숫자가 아니면 0으로 떨어진다 — 파싱 실패가 NaN 비교로 번지면 안 된다', () => {
    expect(parseVersion('')).toEqual([0, 0, 0])
    expect(parseVersion('없음')).toEqual([0, 0, 0])
  })
})

describe('compareVersions', () => {
  it('자리별로 비교한다', () => {
    expect(compareVersions('0.4.0', '0.3.1')).toBeGreaterThan(0)
    expect(compareVersions('0.3.1', '0.4.0')).toBeLessThan(0)
    expect(compareVersions('0.3.1', '0.3.1')).toBe(0)
  })

  it('10을 9보다 크게 본다 — 문자열 비교였다면 틀린다', () => {
    expect(compareVersions('0.10.0', '0.9.0')).toBeGreaterThan(0)
  })

  it('접미사만 다르면 같다고 본다', () => {
    expect(compareVersions('0.3.1-alpha', '0.3.1')).toBe(0)
  })
})

describe('isNewer', () => {
  it('새 릴리즈를 발견한다', () => {
    expect(isNewer('0.4.0-alpha', '0.3.1-alpha')).toBe(true)
  })

  it('같은 버전은 새것이 아니다 — 같은 버전에 배지가 뜨면 안 된다', () => {
    expect(isNewer('0.3.1-alpha', '0.3.1-alpha')).toBe(false)
  })

  it('구버전을 새것으로 보지 않는다 — 릴리즈를 되돌렸을 때 다운그레이드를 권하면 안 된다', () => {
    expect(isNewer('0.2.0-alpha', '0.3.1-alpha')).toBe(false)
  })
})
