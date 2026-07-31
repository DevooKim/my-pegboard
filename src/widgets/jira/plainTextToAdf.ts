/**
 * 평문 → ADF 변환 (D7).
 *
 * 생성 폼의 설명은 평문 textarea다. 마크다운을 지원하지 않는 이유는
 * 절반만 되는 문법이 아무것도 없는 것보다 나쁘기 때문이다 — `**굵게**`가
 * 되는데 표가 안 되면 사용자는 매번 무엇이 되는지 시험해야 한다.
 * 서식이 필요하면 만든 뒤 Jira에서 고치는 편이 빠르다.
 *
 * 규칙은 두 개뿐이다:
 *   빈 줄     → 새 paragraph
 *   한 줄 개행 → hardBreak (같은 paragraph 안)
 */

/** ADF `doc` 또는 설명 없음(`null`). */
export function plainTextToAdf(text: string): unknown | null {
  if (!text.trim()) return null

  // CRLF를 먼저 정규화한다. 붙여넣기로 섞여 들어온다.
  const normalized = text.replace(/\r\n?/g, '\n')

  // 빈 줄로 문단을 가른다. 연속 빈 줄이 몇 개든 문단 하나의 경계일 뿐이라
  // 빈 paragraph를 만들지 않는다.
  const blocks = normalized.split(/\n{2,}/)

  const content = blocks
    .map((block) => block.replace(/\s+$/, ''))
    .filter((block) => block.trim().length > 0)
    .map((block) => ({
      type: 'paragraph',
      content: toInline(block),
    }))

  if (content.length === 0) return null
  return { type: 'doc', version: 1, content }
}

/** 문단 안의 한 줄 개행을 hardBreak으로. */
function toInline(block: string): unknown[] {
  const lines = block.split('\n')
  const out: unknown[] = []

  lines.forEach((line, i) => {
    if (i > 0) out.push({ type: 'hardBreak' })
    // 빈 텍스트 노드는 Jira가 거부한다. hardBreak만 남기고 건너뛴다.
    if (line.length > 0) out.push({ type: 'text', text: line })
  })

  return out
}
