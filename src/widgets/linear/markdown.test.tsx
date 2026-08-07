import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { parseInline, parseMarkdown, safeHref } from './markdown/parse'

/** `openUrl`은 Tauri 런타임 함수다. jsdom에는 없어서 그냥 부르면 던진다. */
vi.mock('@tauri-apps/plugin-opener', () => ({ openUrl: vi.fn() }))

const { MarkdownDoc } = await import('./markdown/MarkdownDoc')

// ─────────────────────────── 파서 ───────────────────────────

describe('parseMarkdown 블록', () => {
  it('제목 레벨을 읽는다', () => {
    const blocks = parseMarkdown('# 하나\n\n### 셋')
    expect(blocks).toHaveLength(2)
    expect(blocks[0]).toMatchObject({ type: 'heading', level: 1 })
    expect(blocks[1]).toMatchObject({ type: 'heading', level: 3 })
  })

  it('코드블록 안쪽은 markdown으로 해석하지 않는다', () => {
    // 이게 깨지면 코드 안의 `**`가 굵게로 먹혀서 코드가 바뀐다.
    const blocks = parseMarkdown('```ts\nconst a = **1**\n# not a heading\n```')
    expect(blocks).toHaveLength(1)
    expect(blocks[0]).toEqual({
      type: 'code',
      language: 'ts',
      code: 'const a = **1**\n# not a heading',
    })
  })

  /** 닫히지 않은 코드블록에서 본문이 통째로 사라지면 안 된다. */
  it('닫히지 않은 코드블록도 받아들인다', () => {
    const blocks = parseMarkdown('```\n미완성 코드')
    expect(blocks[0]).toMatchObject({ type: 'code', code: '미완성 코드' })
  })

  it('불릿·번호 목록을 구분한다', () => {
    const blocks = parseMarkdown('- 하나\n- 둘\n\n1. 첫째\n2. 둘째')
    expect(blocks[0]).toMatchObject({ type: 'list', ordered: false })
    expect(blocks[1]).toMatchObject({ type: 'list', ordered: true, start: 1 })
  })

  it('번호 목록의 시작 번호를 살린다', () => {
    const blocks = parseMarkdown('3. 셋째\n4. 넷째')
    expect(blocks[0]).toMatchObject({ type: 'list', ordered: true, start: 3 })
  })

  it('체크박스 목록의 체크 여부를 읽는다', () => {
    const blocks = parseMarkdown('- [x] 했다\n- [ ] 안 했다')
    expect(blocks[0]).toMatchObject({
      type: 'list',
      items: [{ checked: true }, { checked: false }],
    })
  })

  it('인용 안쪽을 다시 파싱한다', () => {
    const blocks = parseMarkdown('> ## 인용 속 제목\n> 문단')
    expect(blocks[0]).toMatchObject({ type: 'quote' })
    const quote = blocks[0]
    if (quote?.type !== 'quote') throw new Error('인용이 아니다')
    expect(quote.blocks[0]).toMatchObject({ type: 'heading', level: 2 })
  })

  it('구분선을 읽는다', () => {
    expect(parseMarkdown('---')[0]).toEqual({ type: 'rule' })
    expect(parseMarkdown('***')[0]).toEqual({ type: 'rule' })
  })

  /** 목록 바로 위의 줄이 목록을 삼키면 목록이 사라진다. */
  it('문단이 뒤따르는 목록을 삼키지 않는다', () => {
    const blocks = parseMarkdown('설명 문단\n- 항목')
    expect(blocks).toHaveLength(2)
    expect(blocks[0]?.type).toBe('paragraph')
    expect(blocks[1]?.type).toBe('list')
  })

  // ── 미지원 문법 ──

  /**
   * **이 앱의 규칙이다** (CLAUDE.md 대전제 2): 모르는 것을 조용히 건너뛰지 않는다.
   * ADF 렌더러가 미지원 노드에 회색 박스를 그리는 것과 같은 이유다.
   */
  it('표를 미지원으로 표시한다 — 조용히 버리지 않는다', () => {
    const source = '| a | b |\n|---|---|\n| 1 | 2 |'
    const blocks = parseMarkdown(source)

    expect(blocks).toHaveLength(1)
    expect(blocks[0]).toMatchObject({ type: 'unsupported', label: '표' })
    const block = blocks[0]
    if (block?.type !== 'unsupported') throw new Error('unsupported가 아니다')
    // 원문을 들고 있어야 표 내용을 읽을 수 있다.
    expect(block.raw).toContain('| 1 | 2 |')
  })

  it('표 여러 줄을 플레이스홀더 하나로 묶는다', () => {
    // 줄마다 회색 박스를 그리면 그것대로 읽을 수 없다.
    const blocks = parseMarkdown('| a |\n| b |\n| c |')
    expect(blocks.filter((b) => b.type === 'unsupported')).toHaveLength(1)
  })

  it('이미지를 미지원으로 표시한다', () => {
    const blocks = parseMarkdown('![스크린샷](https://example.com/a.png)')
    expect(blocks[0]).toMatchObject({ type: 'unsupported', label: '이미지' })
  })
})

describe('parseInline', () => {
  it('굵게·기울임·취소선·인라인코드를 읽는다', () => {
    expect(parseInline('**굵게**')[0]).toMatchObject({ type: 'strong' })
    expect(parseInline('*기울임*')[0]).toMatchObject({ type: 'em' })
    expect(parseInline('~~취소~~')[0]).toMatchObject({ type: 'strike' })
    expect(parseInline('`코드`')[0]).toMatchObject({ type: 'code', text: '코드' })
  })

  /** `**x**`가 `*<em>x</em>*`이 되면 별표가 화면에 남는다. */
  it('굵게가 기울임보다 먼저 잡힌다', () => {
    const nodes = parseInline('**굵게**')
    expect(nodes).toHaveLength(1)
    expect(nodes[0]?.type).toBe('strong')
  })

  /** 인라인 코드가 가장 강하다. 코드 안의 기호는 문법이 아니다. */
  it('인라인 코드 안의 별표를 마크로 해석하지 않는다', () => {
    const nodes = parseInline('`**굵지 않다**`')
    expect(nodes).toHaveLength(1)
    expect(nodes[0]).toEqual({ type: 'code', text: '**굵지 않다**' })
  })

  it('링크 텍스트 안의 마크도 살린다', () => {
    const nodes = parseInline('[**굵은 링크**](https://example.com)')
    const link = nodes[0]
    if (link?.type !== 'link') throw new Error('링크가 아니다')
    expect(link.href).toBe('https://example.com')
    expect(link.children[0]?.type).toBe('strong')
  })

  it('마크 앞뒤의 평문을 잃지 않는다', () => {
    const nodes = parseInline('앞 **가운데** 뒤')
    expect(nodes.map((n) => n.type)).toEqual(['text', 'strong', 'text'])
  })
})

describe('safeHref', () => {
  /**
   * **이 값이 `<a href>`/`openUrl`로 들어간다.** 남이 쓴 이슈 본문이므로
   * 신뢰할 수 없는 입력이다. 화이트리스트로 막는다.
   */
  it('http·https·mailto만 통과시킨다', () => {
    expect(safeHref('https://example.com')).toBe('https://example.com')
    expect(safeHref('http://example.com')).toBe('http://example.com')
    expect(safeHref('mailto:me@example.com')).toBe('mailto:me@example.com')
  })

  it('javascript·data·file 스킴을 막는다', () => {
    expect(safeHref('javascript:alert(1)')).toBeNull()
    expect(safeHref('JavaScript:alert(1)')).toBeNull()
    expect(safeHref('data:text/html,<script>')).toBeNull()
    expect(safeHref('file:///etc/passwd')).toBeNull()
  })

  it('빈 값과 상대 경로도 막는다', () => {
    expect(safeHref('')).toBeNull()
    expect(safeHref('  ')).toBeNull()
    expect(safeHref('/relative')).toBeNull()
  })
})

// ─────────────────────────── 렌더 ───────────────────────────

describe('MarkdownDoc', () => {
  it('본문이 없으면 그 사실을 적는다', () => {
    render(<MarkdownDoc source={null} />)
    expect(screen.getByText('설명이 없습니다')).toBeInTheDocument()
  })

  it('빈 문자열도 없는 것으로 본다', () => {
    render(<MarkdownDoc source="   " />)
    expect(screen.getByText('설명이 없습니다')).toBeInTheDocument()
  })

  /**
   * **이 테스트가 markdown 렌더러의 핵심 규칙을 고정한다.**
   * 미지원 문법이 회색 플레이스홀더로 화면에 나와야 한다 — 조용히 건너뛰면
   * "안 그려진 줄도 모르는" 상태가 된다.
   */
  it('미지원 문법을 회색 플레이스홀더로 드러낸다', () => {
    render(<MarkdownDoc source={'| 열1 | 열2 |\n|---|---|\n| 값1 | 값2 |'} />)

    expect(screen.getByText('[지원하지 않는 문법: 표]')).toBeInTheDocument()
    // 원문도 함께 보여준다 — 표는 원문만으로도 대개 읽을 수 있다.
    expect(screen.getByText(/값1/)).toBeInTheDocument()
  })

  it('이미지도 플레이스홀더로 드러낸다', () => {
    render(<MarkdownDoc source="![그림](https://example.com/a.png)" />)
    expect(screen.getByText('[지원하지 않는 문법: 이미지]')).toBeInTheDocument()
  })

  it('제목과 문단을 그린다', () => {
    render(<MarkdownDoc source={'## 재현 절차\n\n본문입니다'} />)
    expect(screen.getByRole('heading', { name: '재현 절차' })).toBeInTheDocument()
    expect(screen.getByText('본문입니다')).toBeInTheDocument()
  })

  it('코드블록에 복사 버튼을 준다', () => {
    render(<MarkdownDoc source={'```sh\nbun run dev\n```'} />)
    expect(screen.getByText('bun run dev')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '코드 복사' })).toBeInTheDocument()
  })

  /** 읽기 전용이다. 눌리는 체크박스는 저장된다는 약속으로 읽힌다. */
  it('체크박스를 그리되 누를 수 없게 한다', () => {
    render(<MarkdownDoc source={'- [x] 완료\n- [ ] 미완료'} />)
    const boxes = screen.getAllByRole('checkbox')
    expect(boxes).toHaveLength(2)
    expect(boxes[0]).toBeChecked()
    expect(boxes[0]).toBeDisabled()
  })

  /**
   * 안전하지 않은 스킴은 링크로 만들지 않되 **텍스트는 남긴다.**
   * 조용히 지우면 무엇이 있었는지 알 수 없다.
   */
  it('안전하지 않은 링크는 버튼이 아니라 텍스트로 그린다', () => {
    render(<MarkdownDoc source="[누르지 마세요](javascript:alert(1))" />)

    expect(screen.getByText('누르지 마세요')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '누르지 마세요' })).toBeNull()
  })

  it('안전한 링크는 버튼으로 그린다', () => {
    render(<MarkdownDoc source="[문서](https://example.com/docs)" />)
    const link = screen.getByRole('button', { name: '문서' })
    expect(link).toHaveAttribute('title', 'https://example.com/docs')
  })
})
