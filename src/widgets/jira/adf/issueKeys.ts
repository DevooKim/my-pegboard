/**
 * 평문 안의 티켓 키(`PROJ-123`)를 찾아 조각으로 쪼갠다.
 *
 * Jira는 본문에 쓴 티켓 키를 링크로 만들어주지 않는다 — ADF에는 그냥 text 노드로
 * 남는다. 그래서 우리가 찾아서 모달 안 전환(D4)에 연결한다.
 *
 * 순수 함수로 뽑아둔 이유: 정규식의 경계 조건(소문자, 하이픈 없음, 숫자만)이
 * 틀리면 본문 곳곳에 엉뚱한 링크가 생기는데, 그건 렌더 트리를 통해 확인하기
 * 번거롭다.
 */

/**
 * 프로젝트 키는 대문자로 시작하고 대문자·숫자·밑줄이 이어진 뒤 `-숫자`가 붙는다.
 * 최소 두 글자를 요구한다(`A-1` 같은 단일 문자 키는 실재하지 않고,
 * 수식 `x-1`을 잘못 잡을 위험만 늘린다).
 */
const ISSUE_KEY = /\b[A-Z][A-Z0-9_]+-\d+\b/g

export interface TextPiece {
  kind: 'text' | 'key'
  value: string
}

export function splitIssueKeys(text: string): TextPiece[] {
  const pieces: TextPiece[] = []
  let last = 0

  // 정규식이 g 플래그를 가지므로 lastIndex를 공유하지 않도록 매번 새로 만든다.
  const re = new RegExp(ISSUE_KEY.source, 'g')
  let m = re.exec(text)
  while (m !== null) {
    if (m.index > last) {
      pieces.push({ kind: 'text', value: text.slice(last, m.index) })
    }
    pieces.push({ kind: 'key', value: m[0] })
    last = m.index + m[0].length
    m = re.exec(text)
  }

  if (last < text.length) {
    pieces.push({ kind: 'text', value: text.slice(last) })
  }

  // 하나도 못 찾았으면 원문 한 조각. 호출부가 빈 배열을 신경 쓰지 않아도 되게.
  if (pieces.length === 0) {
    return [{ kind: 'text', value: text }]
  }
  return pieces
}

/**
 * Jira URL이 우리 사이트의 티켓을 가리키면 그 키를 돌려준다.
 *
 * `inlineCard`(스마트 링크)가 티켓을 가리키는 경우를 모달 전환으로 바꾸기 위한 것.
 * 다른 사이트의 Jira이거나 티켓이 아니면 `null`.
 */
export function issueKeyFromUrl(url: string, baseUrl: string | null): string | null {
  if (!baseUrl) return null
  try {
    const target = new URL(url)
    const base = new URL(baseUrl)
    if (target.host !== base.host) return null

    // `/browse/ABC-123` 형태만 인정한다. 쿼리·해시는 무시.
    const m = /^\/browse\/([A-Z][A-Z0-9_]+-\d+)$/.exec(target.pathname)
    return m?.[1] ?? null
  } catch {
    return null
  }
}
