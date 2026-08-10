/**
 * 최소 markdown 파서. **의존성 0.**
 *
 * Jira의 ADF 렌더러와 같은 판단이다 (DECISIONS 11.4 / 25.6): 라이브러리를
 * 하나 끌어오면 그 라이브러리의 HTML 구조와 스타일을 통제할 수 없고, 이 앱은
 * 메모리 목표(150MB)와 "이 앱만의 UI"를 이유로 그 통제권을 택했다.
 *
 * # 지원하는 것
 *
 * 블록: 제목(`#`~`######`) · 문단 · 불릿 목록 · 번호 목록 · 코드블록(```) ·
 *       인용(`>`) · 구분선(`---`) · 체크박스 목록(`- [ ]` / `- [x]`)
 * 인라인: 굵게 · 기울임 · 인라인코드 · 링크 · 취소선
 *
 * # ★ 모르는 것을 조용히 건너뛰지 않는다
 *
 * 표·이미지처럼 **우리가 못 그리는 블록은 회색 플레이스홀더**로 남긴다.
 * ADF 렌더러가 미지원 노드에 회색 박스를 그리는 것과 같은 규칙이다 —
 * 건너뛰면 사용자는 설명이 원래 그런 줄 알고, 우리는 무엇이 빠졌는지 영영 모른다
 * (CLAUDE.md 대전제 2).
 *
 * 예외는 **인라인 마크**다. 모르는 마크는 텍스트로 그리고 표시하지 않는다 —
 * 마크마다 배지를 붙이면 본문이 읽히지 않는다. ADF 렌더러도 같은 예외를 둔다.
 *
 * # 왜 파서가 별도 파일인가
 *
 * 순수 함수로 빼는 기준은 "테스트하고 싶은가"다. 미지원 문법이 플레이스홀더로
 * 나오는지, 링크 URL을 안전하게 걸러내는지는 렌더 트리를 거치지 않고 확인해야
 * 한다.
 */

/** 블록 노드. */
export type MdBlock =
  | { type: 'heading'; level: number; inline: MdInline[] }
  | { type: 'paragraph'; inline: MdInline[] }
  | { type: 'list'; ordered: boolean; start: number; items: MdListItem[] }
  | { type: 'code'; language: string | null; code: string }
  | { type: 'quote'; blocks: MdBlock[] }
  | { type: 'rule' }
  /** 우리가 못 그리는 문법. **회색 박스로 반드시 표시한다.** */
  | { type: 'unsupported'; label: string; raw: string }

export interface MdListItem {
  inline: MdInline[]
  /** 체크박스 목록이면 체크 여부. 아니면 null. */
  checked: boolean | null
}

/** 인라인 노드. */
export type MdInline =
  | { type: 'text'; text: string }
  | { type: 'strong'; children: MdInline[] }
  | { type: 'em'; children: MdInline[] }
  | { type: 'strike'; children: MdInline[] }
  | { type: 'code'; text: string }
  /** `href`가 null이면 안전하지 않은 스킴이라 링크로 만들지 않는다. */
  | { type: 'link'; href: string | null; children: MdInline[] }

/**
 * markdown 문자열을 블록 목록으로.
 *
 * 줄 단위로 읽는다 — 재귀 하강 파서를 만들지 않는다. 지원 범위가 좁고
 * (제목·목록·코드·인용) 중첩은 인용 안의 블록 한 겹뿐이라, 줄 기반이면
 * 코드를 읽는 사람이 무슨 일이 일어나는지 바로 안다.
 */
export function parseMarkdown(source: string): MdBlock[] {
  // `\r\n`을 정규화한다. 안 하면 `\r`이 텍스트에 남아 줄 끝이 이상해진다.
  const lines = source.replace(/\r\n?/g, '\n').split('\n')
  return parseLines(lines)
}

function parseLines(lines: string[]): MdBlock[] {
  const blocks: MdBlock[] = []
  let i = 0

  while (i < lines.length) {
    const line = lines[i] ?? ''

    // 빈 줄 — 블록 경계일 뿐이다.
    if (line.trim() === '') {
      i += 1
      continue
    }

    // 코드블록. **가장 먼저 본다** — 안쪽 내용은 markdown이 아니다.
    const fence = /^\s*(`{3,}|~{3,})\s*(\S*)\s*$/.exec(line)
    if (fence) {
      const marker = fence[1] ?? '```'
      const language = fence[2] || null
      const body: string[] = []
      i += 1
      // 닫히지 않은 코드블록도 받아들인다. 남은 줄 전부가 코드다 —
      // 여기서 실패하면 본문이 통째로 안 그려진다.
      while (i < lines.length && !isClosingFence(lines[i] ?? '', marker[0] ?? '`')) {
        body.push(lines[i] ?? '')
        i += 1
      }
      i += 1 // 닫는 줄을 넘긴다
      blocks.push({ type: 'code', language, code: body.join('\n') })
      continue
    }

    // 구분선. `---` `***` `___`
    if (/^\s*([-*_])\s*(\1\s*){2,}$/.test(line)) {
      blocks.push({ type: 'rule' })
      i += 1
      continue
    }

    // 표 — **우리가 그리지 않는다.** 연속된 표 줄을 한 덩어리로 묶어
    // 플레이스홀더 하나로 만든다. 줄마다 회색 박스를 그리면 그것대로 읽을 수 없다.
    if (isTableLine(line)) {
      const raw: string[] = []
      while (i < lines.length && isTableLine(lines[i] ?? '')) {
        raw.push(lines[i] ?? '')
        i += 1
      }
      blocks.push({ type: 'unsupported', label: '표', raw: raw.join('\n') })
      continue
    }

    // 제목. `#` 1~6개 + 공백.
    const heading = /^(#{1,6})\s+(.*)$/.exec(line)
    if (heading) {
      blocks.push({
        type: 'heading',
        level: (heading[1] ?? '#').length,
        inline: parseInline(heading[2] ?? ''),
      })
      i += 1
      continue
    }

    // 인용. 연속된 `>` 줄을 모아 안쪽을 다시 파싱한다 (중첩 한 겹).
    if (/^\s*>/.test(line)) {
      const inner: string[] = []
      while (i < lines.length && /^\s*>/.test(lines[i] ?? '')) {
        inner.push((lines[i] ?? '').replace(/^\s*>\s?/, ''))
        i += 1
      }
      blocks.push({ type: 'quote', blocks: parseLines(inner) })
      continue
    }

    // 목록. 불릿(`-` `*` `+`)과 번호(`1.`), 그리고 체크박스.
    const listStart = matchListItem(line)
    if (listStart) {
      const ordered = listStart.ordered
      const items: MdListItem[] = []
      const start = listStart.number ?? 1

      while (i < lines.length) {
        const current = lines[i] ?? ''
        const item = matchListItem(current)
        // 같은 종류의 목록만 이어붙인다. 불릿에서 번호로 바뀌면 새 블록이다.
        if (!item || item.ordered !== ordered) break
        items.push({ inline: parseInline(item.text), checked: item.checked })
        i += 1
      }

      blocks.push({ type: 'list', ordered, start, items })
      continue
    }

    // 이미지만 있는 줄 — 그리지 않으므로 드러낸다.
    // 첨부 이미지는 인증된 URL이 필요해 Jira에서도 그리지 않았다(11.4).
    if (/^\s*!\[[^\]]*\]\([^)]*\)\s*$/.test(line)) {
      blocks.push({ type: 'unsupported', label: '이미지', raw: line.trim() })
      i += 1
      continue
    }

    // 나머지는 문단. 빈 줄까지 이어 붙이되, 다른 블록이 시작되면 끊는다 —
    // 목록 바로 위의 줄이 목록을 삼키면 목록이 사라진다.
    const paragraph: string[] = []
    while (i < lines.length) {
      const current = lines[i] ?? ''
      if (current.trim() === '' || startsNewBlock(current)) break
      paragraph.push(current.trim())
      i += 1
    }
    if (paragraph.length > 0) {
      blocks.push({ type: 'paragraph', inline: parseInline(paragraph.join('\n')) })
    }
  }

  return blocks
}

function isClosingFence(line: string, char: string): boolean {
  return new RegExp(`^\\s*${char === '`' ? '`' : '~'}{3,}\\s*$`).test(line)
}

/** 표로 보이는 줄. `|`로 시작하거나 구분 행(`---|---`)이다. */
function isTableLine(line: string): boolean {
  const trimmed = line.trim()
  if (trimmed.startsWith('|') && trimmed.length > 1) return true
  return /^[\s:|-]+$/.test(trimmed) && trimmed.includes('|')
}

/** 문단을 끊어야 하는 줄인가. */
function startsNewBlock(line: string): boolean {
  return (
    /^(#{1,6})\s+/.test(line) ||
    /^\s*(`{3,}|~{3,})/.test(line) ||
    /^\s*>/.test(line) ||
    /^\s*([-*_])\s*(\1\s*){2,}$/.test(line) ||
    isTableLine(line) ||
    matchListItem(line) !== null
  )
}

interface ListMatch {
  ordered: boolean
  number: number | null
  text: string
  checked: boolean | null
}

/**
 * 목록 항목 한 줄.
 *
 * **중첩 목록을 들여쓰기로 표현하지 않는다.** 깊이를 지원하면 파서가 재귀
 * 하강으로 커지고, 위젯 상세 모달에서 3단 목록을 볼 일이 드물다. 들여쓴 항목은
 * 같은 층의 항목으로 평평해진다 — 내용이 사라지지 않는 것이 우선이다.
 */
function matchListItem(line: string): ListMatch | null {
  const bullet = /^\s*[-*+]\s+(.*)$/.exec(line)
  if (bullet) {
    const rest = bullet[1] ?? ''
    const task = /^\[([ xX])\]\s+(.*)$/.exec(rest)
    if (task) {
      return {
        ordered: false,
        number: null,
        text: task[2] ?? '',
        checked: (task[1] ?? ' ').toLowerCase() === 'x',
      }
    }
    return { ordered: false, number: null, text: rest, checked: null }
  }

  const numbered = /^\s*(\d{1,9})[.)]\s+(.*)$/.exec(line)
  if (numbered) {
    return {
      ordered: true,
      number: Number.parseInt(numbered[1] ?? '1', 10),
      text: numbered[2] ?? '',
      checked: null,
    }
  }

  return null
}

/**
 * 인라인 문법을 파싱한다.
 *
 * 순서가 중요하다: **인라인 코드가 가장 강하다.** `` `**not bold**` `` 안의
 * 별표는 문법이 아니다. 코드를 먼저 잘라내지 않으면 코드 안의 기호가 마크로
 * 해석된다.
 */
export function parseInline(source: string): MdInline[] {
  const out: MdInline[] = []
  let rest = source

  // 각 패턴을 "가장 먼저 나타나는 것"부터 처리한다. 정규식을 순서대로 시도하면
  // 뒤에 있는 코드가 앞의 굵게보다 먼저 잡히는 일이 생긴다.
  while (rest.length > 0) {
    const next = findFirstMark(rest)
    if (!next) {
      out.push({ type: 'text', text: rest })
      break
    }

    if (next.index > 0) {
      out.push({ type: 'text', text: rest.slice(0, next.index) })
    }
    out.push(next.node)
    rest = rest.slice(next.index + next.length)
  }

  return out
}

interface MarkMatch {
  index: number
  length: number
  node: MdInline
}

function findFirstMark(source: string): MarkMatch | null {
  const candidates: MarkMatch[] = []

  // 인라인 코드. 백틱 1개 이상을 짝으로 본다.
  const code = /(`+)([^`]+?)\1/.exec(source)
  if (code) {
    candidates.push({
      index: code.index,
      length: code[0].length,
      node: { type: 'code', text: code[2] ?? '' },
    })
  }

  // 링크. `[텍스트](url)`
  const link = /\[([^\]]*)\]\(([^)\s]*)(?:\s+"[^"]*")?\)/.exec(source)
  if (link) {
    candidates.push({
      index: link.index,
      length: link[0].length,
      node: {
        type: 'link',
        href: safeHref(link[2] ?? ''),
        // 링크 텍스트 안의 마크도 살린다 (`[**굵은 링크**](url)`).
        children: parseInline(link[1] ?? ''),
      },
    })
  }

  // 굵게. `**` 또는 `__`. 기울임보다 먼저 찾아야 `**x**`가 `*<em>x</em>*`이
  // 되지 않는다 — 그래서 별표 2개 패턴을 별도로 둔다.
  const strong = /(\*\*|__)(?=\S)([\s\S]*?\S)\1/.exec(source)
  if (strong) {
    candidates.push({
      index: strong.index,
      length: strong[0].length,
      node: { type: 'strong', children: parseInline(strong[2] ?? '') },
    })
  }

  // 취소선. `~~`
  const strike = /~~(?=\S)([\s\S]*?\S)~~/.exec(source)
  if (strike) {
    candidates.push({
      index: strike.index,
      length: strike[0].length,
      node: { type: 'strike', children: parseInline(strike[1] ?? '') },
    })
  }

  // 기울임. 별표·밑줄 하나. 굵게와 겹치는 자리는 위에서 이미 잡힌다.
  const em = /(?<![*\w])(\*|_)(?=\S)([^*_]*?\S)\1(?![*\w])/.exec(source)
  if (em) {
    candidates.push({
      index: em.index,
      length: em[0].length,
      node: { type: 'em', children: parseInline(em[2] ?? '') },
    })
  }

  if (candidates.length === 0) return null

  // 가장 앞에 있는 것을 고른다. 같은 자리면 긴 쪽이 이긴다 —
  // `**굵게**`에서 굵게(4자 마커)가 기울임(2자)보다 먼저 잡혀야 한다.
  candidates.sort((a, b) => a.index - b.index || b.length - a.length)
  return candidates[0] ?? null
}

/**
 * 링크 URL을 걸러낸다.
 *
 * **이 값이 `<a href>`로 들어간다.** `javascript:` 같은 스킴을 그대로 넣으면
 * 이슈 본문이 코드 실행 경로가 된다 — 남이 쓴 이슈를 우리 앱에서 여는 것이므로
 * 신뢰할 수 없는 입력이다. 이스케이프가 아니라 **화이트리스트**로 막는다
 * (Rust 쪽에서 상태 색을 다루는 것과 같은 판단).
 *
 * 통과하지 못하면 `null`을 주고, 렌더러가 **링크 대신 텍스트**로 그린다.
 * 조용히 지우지 않는다 — 주소가 본문에 남아 있어야 사용자가 직접 열 수 있다.
 */
export function safeHref(raw: string): string | null {
  const url = raw.trim()
  if (url === '') return null
  // 스킴이 없는 상대 경로는 우리 앱 안에서 의미가 없다. 앵커(`#`)도 마찬가지.
  if (/^(https?:|mailto:)/i.test(url)) return url
  return null
}
