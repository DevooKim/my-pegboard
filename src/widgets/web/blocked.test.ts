import { describe, expect, it } from 'vitest'
import { isKnownBlocked } from '#/widgets/web/blocked'

describe('isKnownBlocked', () => {
  it('실측으로 확인한 차단 도메인을 잡는다', () => {
    // 전부 브라우저에서 직접 확인했다 — iframe에 빈 화면이 뜬다.
    expect(isKnownBlocked('https://github.com')).toBe('github.com')
    expect(isKnownBlocked('https://www.google.com')).toBe('google.com')
    expect(isKnownBlocked('https://news.ycombinator.com')).toBe('news.ycombinator.com')
  })

  it('서브도메인도 잡는다', () => {
    // 어느 항목에 먼저 걸리는지는 목록 순서에 달렸다(google.com이
    // calendar.google.com보다 앞). 중요한 건 '차단으로 판정되는가'다.
    expect(isKnownBlocked('https://gist.github.com/foo')).toBe('github.com')
    expect(isKnownBlocked('https://calendar.google.com')).not.toBeNull()
  })

  it('우연한 접미사 일치는 잡지 않는다', () => {
    // mygithub.com은 github.com이 아니다.
    expect(isKnownBlocked('https://mygithub.com')).toBeNull()
    expect(isKnownBlocked('https://notgoogle.com')).toBeNull()
  })

  it('임베드가 되는 사이트는 통과시킨다', () => {
    // 실측으로 정상 표시를 확인한 것들.
    expect(isKnownBlocked('https://example.com')).toBeNull()
    expect(isKnownBlocked('https://en.wikipedia.org')).toBeNull()
  })

  it('로컬 서버는 통과시킨다', () => {
    // 로컬 대시보드가 이 위젯의 주 용도다.
    expect(isKnownBlocked('http://127.0.0.1:4158/')).toBeNull()
    expect(isKnownBlocked('http://localhost:3000')).toBeNull()
  })

  it('잘못된 URL에 예외를 던지지 않는다', () => {
    // 사용자가 타이핑하는 도중에도 매 글자 호출된다.
    expect(isKnownBlocked('')).toBeNull()
    expect(isKnownBlocked('http')).toBeNull()
    expect(isKnownBlocked('그냥 글자')).toBeNull()
  })
})
