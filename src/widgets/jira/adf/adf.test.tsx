import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { AdfDoc } from '#/widgets/jira/adf/AdfDoc'
import { issueKeyFromUrl, splitIssueKeys } from '#/widgets/jira/adf/issueKeys'

vi.mock('@tauri-apps/plugin-opener', () => ({ openUrl: vi.fn() }))

/** ADF 문서 한 개를 감싸는 헬퍼. */
function doc(...content: unknown[]) {
  return { type: 'doc', version: 1, content }
}

function para(...content: unknown[]) {
  return { type: 'paragraph', content }
}

function text(value: string, marks?: unknown[]) {
  return marks ? { type: 'text', text: value, marks } : { type: 'text', text: value }
}

function renderDoc(d: unknown, onOpenIssue = vi.fn()) {
  render(<AdfDoc doc={d} onOpenIssue={onOpenIssue} baseUrl="https://team.atlassian.net" />)
  return onOpenIssue
}

describe('AdfDoc', () => {
  it('문단·굵게·링크를 그린다', () => {
    renderDoc(
      doc(
        para(
          text('보통 '),
          text('굵게', [{ type: 'strong' }]),
          text(' 그리고 '),
          text('링크', [{ type: 'link', attrs: { href: 'https://example.com' } }]),
        ),
      ),
    )

    expect(screen.getByText('굵게').tagName).toBe('STRONG')
    const link = screen.getByText('링크')
    expect(link.tagName).toBe('A')
    expect(link).toHaveAttribute('href', 'https://example.com')
  })

  /** 이 앱의 핵심 규칙 — 조용한 실패 금지 (CLAUDE.md 대전제 2). */
  it('모르는 노드를 회색 플레이스홀더로 드러낸다', () => {
    renderDoc(doc({ type: 'expand', attrs: { title: '접힌 영역' } }))
    expect(screen.getByText('[지원하지 않는 요소: expand]')).toBeInTheDocument()
  })

  it('모르는 노드의 자식 텍스트를 잃지 않는다', () => {
    renderDoc(doc({ type: 'expand', content: [para(text('안에 있는 내용'))] }))

    expect(screen.getByText('[지원하지 않는 요소: expand]')).toBeInTheDocument()
    expect(screen.getByText('안에 있는 내용')).toBeInTheDocument()
  })

  it('이미지 2개를 본문 끝에 한 번만 요약한다', () => {
    renderDoc(
      doc(
        { type: 'mediaSingle', content: [{ type: 'media', attrs: { id: 'a' } }] },
        para(text('사이 문단')),
        { type: 'mediaSingle', content: [{ type: 'media', attrs: { id: 'b' } }] },
      ),
    )

    const summaries = screen.getAllByText(/이미지 2개/)
    expect(summaries).toHaveLength(1)
  })

  it('표를 가로 스크롤 컨테이너로 감싼다', () => {
    const { container } = render(
      <AdfDoc
        doc={doc({
          type: 'table',
          content: [
            {
              type: 'tableRow',
              content: [
                { type: 'tableHeader', content: [para(text('머리'))] },
                { type: 'tableCell', content: [para(text('값'))] },
              ],
            },
          ],
        })}
        onOpenIssue={vi.fn()}
      />,
    )

    const table = container.querySelector('table')
    expect(table).not.toBeNull()
    // 모달 폭을 뚫으면 본문 전체가 가로로 밀린다.
    expect(table?.closest('.overflow-x-auto')).not.toBeNull()
    expect(screen.getByText('머리').closest('th')).not.toBeNull()
  })

  it('코드블록 복사 버튼이 원문을 클립보드에 넣는다', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.assign(navigator, { clipboard: { writeText } })

    renderDoc(
      doc({
        type: 'codeBlock',
        attrs: { language: 'bash' },
        content: [{ type: 'text', text: 'bun run test' }],
      }),
    )

    fireEvent.click(screen.getByRole('button', { name: '코드 복사' }))
    await waitFor(() => expect(writeText).toHaveBeenCalledWith('bun run test'))
  })

  it('doc이 null이면 "설명이 없습니다"', () => {
    renderDoc(null)
    expect(screen.getByText('설명이 없습니다')).toBeInTheDocument()
  })

  it('doc 타입이 아니면 그 사실을 드러낸다', () => {
    renderDoc({ type: 'paragraph', content: [] })
    expect(screen.getByText('[ADF 문서가 아닙니다]')).toBeInTheDocument()
  })

  it('평문 안의 티켓 키를 누르면 모달 전환을 요청한다', () => {
    const onOpenIssue = renderDoc(doc(para(text('관련: ABC-142 참고'))))

    fireEvent.click(screen.getByRole('button', { name: 'ABC-142' }))
    expect(onOpenIssue).toHaveBeenCalledWith('ABC-142')
  })

  it('code·link 마크가 걸린 텍스트는 티켓 키로 바꾸지 않는다', () => {
    renderDoc(
      doc(
        para(text('ABC-1', [{ type: 'code' }])),
        para(text('XYZ-2', [{ type: 'link', attrs: { href: 'https://example.com' } }])),
      ),
    )

    // 링크 안에 링크가 생기거나 코드 안의 문자열이 링크가 되면 안 된다.
    expect(screen.queryByRole('button', { name: 'ABC-1' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'XYZ-2' })).toBeNull()
    expect(screen.getByText('ABC-1').tagName).toBe('CODE')
  })

  it('mention에 text가 없으면 계정 id를 노출하지 않는다', () => {
    renderDoc(doc(para({ type: 'mention', attrs: { id: '5f8a-uuid-비밀' } })))

    expect(screen.getByText('@알 수 없는 사용자')).toBeInTheDocument()
    expect(screen.queryByText(/5f8a-uuid/)).toBeNull()
  })

  it('panel을 종류에 맞는 색으로 그린다', () => {
    const { container } = render(
      <AdfDoc
        doc={doc({
          type: 'panel',
          attrs: { panelType: 'warning' },
          content: [para(text('주의하세요'))],
        })}
        onOpenIssue={vi.fn()}
      />,
    )
    expect(screen.getByText('주의하세요')).toBeInTheDocument()
    const panel = container.querySelector('[style*="--color-warning"]')
    expect(panel).not.toBeNull()
  })
})

describe('splitIssueKeys', () => {
  it('평문 안의 티켓 키를 찾는다', () => {
    expect(splitIssueKeys('앞 ABC-1 뒤')).toEqual([
      { kind: 'text', value: '앞 ' },
      { kind: 'key', value: 'ABC-1' },
      { kind: 'text', value: ' 뒤' },
    ])
  })

  it('소문자·하이픈 없음·숫자만은 키가 아니다', () => {
    for (const notKey of ['abc-1', 'ABC1', 'ABC-', '123-456', 'A-1']) {
      const pieces = splitIssueKeys(notKey)
      expect(
        pieces.every((p) => p.kind === 'text'),
        `${notKey}가 키로 잡혔다`,
      ).toBe(true)
    }
  })

  it('키가 없으면 원문 한 조각을 준다', () => {
    expect(splitIssueKeys('아무것도 없음')).toEqual([{ kind: 'text', value: '아무것도 없음' }])
  })

  it('여러 키를 모두 찾는다', () => {
    const keys = splitIssueKeys('ABC-1 와 XYZ-22')
      .filter((p) => p.kind === 'key')
      .map((p) => p.value)
    expect(keys).toEqual(['ABC-1', 'XYZ-22'])
  })
})

describe('issueKeyFromUrl', () => {
  const base = 'https://team.atlassian.net'

  it('우리 사이트의 browse URL에서 키를 뽑는다', () => {
    expect(issueKeyFromUrl(`${base}/browse/ABC-142`, base)).toBe('ABC-142')
  })

  it('다른 사이트는 무시한다', () => {
    expect(issueKeyFromUrl('https://other.atlassian.net/browse/ABC-1', base)).toBeNull()
  })

  it('browse가 아닌 경로는 무시한다', () => {
    expect(issueKeyFromUrl(`${base}/wiki/spaces/ABC-1`, base)).toBeNull()
  })

  it('baseUrl이 없으면 판별하지 않는다', () => {
    expect(issueKeyFromUrl(`${base}/browse/ABC-1`, null)).toBeNull()
  })
})
