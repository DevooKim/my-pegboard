import { describe, expect, it } from 'vitest'
import { plainTextToAdf } from '#/widgets/jira/plainTextToAdf'

/** 문단 개수와 각 문단의 노드 종류만 본다 — 그게 이 변환의 전부다. */
function paragraphs(doc: unknown): { type: string; text?: string }[][] {
  const d = doc as { content: { content: { type: string; text?: string }[] }[] }
  return d.content.map((p) => p.content)
}

describe('plainTextToAdf', () => {
  it('빈 문자열은 설명을 보내지 않는다', () => {
    expect(plainTextToAdf('')).toBeNull()
  })

  it('공백만 있어도 설명을 보내지 않는다', () => {
    expect(plainTextToAdf('   \n\n  \t ')).toBeNull()
  })

  it('빈 줄로 문단을 가른다', () => {
    const doc = plainTextToAdf('a\n\nb')
    const ps = paragraphs(doc)

    expect(ps).toHaveLength(2)
    expect(ps[0]).toEqual([{ type: 'text', text: 'a' }])
    expect(ps[1]).toEqual([{ type: 'text', text: 'b' }])
  })

  it('한 줄 개행은 hardBreak으로 같은 문단에 남는다', () => {
    const doc = plainTextToAdf('a\nb')
    const ps = paragraphs(doc)

    expect(ps).toHaveLength(1)
    expect(ps[0]).toEqual([
      { type: 'text', text: 'a' },
      { type: 'hardBreak' },
      { type: 'text', text: 'b' },
    ])
  })

  /** 연속 빈 줄은 경계일 뿐이다. 빈 paragraph가 생기면 Jira에서 허공이 보인다. */
  it('연속 빈 줄 3개가 빈 문단을 만들지 않는다', () => {
    const ps = paragraphs(plainTextToAdf('a\n\n\n\nb'))

    expect(ps).toHaveLength(2)
    for (const p of ps) {
      expect(p.length).toBeGreaterThan(0)
    }
  })

  it('CRLF를 정규화한다', () => {
    const ps = paragraphs(plainTextToAdf('a\r\n\r\nb'))
    expect(ps).toHaveLength(2)
    expect(ps[0]).toEqual([{ type: 'text', text: 'a' }])
  })

  it('doc 봉투를 갖춰서 낸다', () => {
    const doc = plainTextToAdf('내용') as { type: string; version: number }
    expect(doc.type).toBe('doc')
    expect(doc.version).toBe(1)
  })

  it('앞뒤 공백이 있는 한 줄도 문단 하나다', () => {
    const ps = paragraphs(plainTextToAdf('  내용  '))
    expect(ps).toHaveLength(1)
  })
})
