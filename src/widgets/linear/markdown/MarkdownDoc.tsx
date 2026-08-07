import { openUrl } from '@tauri-apps/plugin-opener'
import { Check, Copy } from 'lucide-react'
import { type ReactNode, useState } from 'react'
import { type MdBlock, type MdInline, parseMarkdown } from './parse'

/**
 * markdown 렌더러. **의존성 0** (DECISIONS 25.6).
 *
 * Linear의 `description`은 markdown이다 — Jira의 ADF와 다르므로 ADF 렌더러를
 * 재사용할 수 없다. 그렇다고 markdown 라이브러리를 추가하지 않는다: ADF도
 * 직접 그렸고(11.4), 그 근거(HTML 구조·스타일 통제, 메모리)가 여기서도 같다.
 *
 * # 미지원 문법은 회색 박스로 드러낸다
 *
 * ADF 렌더러의 `Unsupported`와 같은 규칙이다. 표·이미지를 조용히 건너뛰면
 * 사용자는 설명이 원래 그런 줄 안다 (CLAUDE.md 대전제 2).
 *
 * 문법은 `parse.ts`가 해석하고, 이 파일은 그리기만 한다 — 파싱 규칙을
 * 렌더 트리 없이 테스트할 수 있어야 한다.
 */
export function MarkdownDoc({ source }: { source: string | null }) {
  if (!source || source.trim() === '') {
    return <p className="text-body text-text-tertiary">설명이 없습니다</p>
  }

  const blocks = parseMarkdown(source)
  if (blocks.length === 0) {
    return <p className="text-body text-text-tertiary">설명이 없습니다</p>
  }

  return (
    <div className="space-y-3">
      {blocks.map((block, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: markdown 블록에 안정된 id가 없다
        <Block key={i} block={block} />
      ))}
    </div>
  )
}

function Block({ block }: { block: MdBlock }) {
  switch (block.type) {
    case 'heading':
      return <Heading level={block.level} inline={block.inline} />

    case 'paragraph':
      // DESIGN 7.3 — 본문에는 한글 행간(1.75)을 쓴다.
      return (
        <p className="text-body text-text-primary leading-relaxed-ko">
          <Inline nodes={block.inline} />
        </p>
      )

    case 'list':
      return block.ordered ? (
        <ol
          start={block.start > 1 ? block.start : undefined}
          className="list-decimal space-y-1 pl-5 text-body text-text-primary leading-relaxed-ko"
        >
          {block.items.map((item, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: 목록 항목에 안정된 id가 없다
            <li key={i}>
              <Inline nodes={item.inline} />
            </li>
          ))}
        </ol>
      ) : (
        <ul
          className={`space-y-1 text-body text-text-primary leading-relaxed-ko ${
            // 체크박스 목록은 마커 대신 체크박스가 있으므로 불릿을 지운다.
            block.items.some((i) => i.checked !== null) ? 'pl-1' : 'list-disc pl-5'
          }`}
        >
          {block.items.map((item, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: 목록 항목에 안정된 id가 없다
            <li key={i} className={item.checked !== null ? 'flex items-start gap-2' : undefined}>
              {item.checked !== null && (
                // 읽기 전용이다. **누를 수 있게 만들지 않는다** — 우리는 이슈
                // 본문을 수정하지 않고(25.1 조작 범위), 눌리는 체크박스는
                // 저장된다는 약속으로 읽힌다.
                <input
                  type="checkbox"
                  checked={item.checked}
                  readOnly
                  disabled
                  aria-label={item.checked ? '완료된 항목' : '완료되지 않은 항목'}
                  className="mt-1 accent-accent"
                />
              )}
              <span className={item.checked ? 'text-text-tertiary line-through' : undefined}>
                <Inline nodes={item.inline} />
              </span>
            </li>
          ))}
        </ul>
      )

    case 'code':
      return <CodeBlock language={block.language} code={block.code} />

    case 'quote':
      return (
        <blockquote className="space-y-2 border-border-strong border-l-2 pl-3 text-text-secondary">
          {block.blocks.map((inner, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: markdown 블록에 안정된 id가 없다
            <Block key={i} block={inner} />
          ))}
        </blockquote>
      )

    case 'rule':
      return <hr className="border-border-subtle" />

    case 'unsupported':
      // **회색 박스 + 원문.** 무엇이 빠졌는지와 그 내용까지 보여준다 —
      // 표는 원문만으로도 대개 읽을 수 있다.
      return (
        <div className="space-y-1">
          <span className="rounded-xs bg-surface-inset px-1.5 py-0.5 text-caption text-text-tertiary">
            [지원하지 않는 문법: {block.label}]
          </span>
          <pre className="overflow-x-auto rounded bg-surface-inset px-3 py-2">
            <code className="font-mono text-caption text-text-secondary">{block.raw}</code>
          </pre>
        </div>
      )

    default:
      return null
  }
}

function Heading({ level, inline }: { level: number; inline: MdInline[] }) {
  // 모달 안이므로 크기를 한 단계씩 줄인다. h1이 이슈 제목보다 크면 안 된다.
  const cls =
    level <= 2
      ? 'text-md font-semibold text-text-primary'
      : level === 3
        ? 'text-base font-semibold text-text-primary'
        : 'text-body font-semibold text-text-secondary'
  const children = <Inline nodes={inline} />

  if (level <= 2) return <h3 className={cls}>{children}</h3>
  if (level === 3) return <h4 className={cls}>{children}</h4>
  if (level === 4) return <h5 className={cls}>{children}</h5>
  return <h6 className={cls}>{children}</h6>
}

function Inline({ nodes }: { nodes: MdInline[] }): ReactNode {
  return nodes.map((node, i) => (
    // biome-ignore lint/suspicious/noArrayIndexKey: 인라인 노드에 안정된 id가 없다
    <InlineNode key={i} node={node} />
  ))
}

function InlineNode({ node }: { node: MdInline }) {
  switch (node.type) {
    case 'text':
      return <>{node.text}</>

    case 'strong':
      return (
        <strong className="font-semibold">
          <Inline nodes={node.children} />
        </strong>
      )

    case 'em':
      return (
        <em className="italic">
          <Inline nodes={node.children} />
        </em>
      )

    case 'strike':
      return (
        <s className="text-text-tertiary">
          <Inline nodes={node.children} />
        </s>
      )

    case 'code':
      return (
        <code className="rounded-xs bg-surface-inset px-1 py-0.5 font-mono text-caption text-text-secondary">
          {node.text}
        </code>
      )

    case 'link':
      // 안전하지 않은 스킴은 `href`가 null이다. 링크로 만들지 않되
      // **텍스트는 남긴다** — 조용히 지우면 무엇이 있었는지 알 수 없다.
      if (!node.href) {
        return (
          <span className="text-text-secondary underline decoration-dotted">
            <Inline nodes={node.children} />
          </span>
        )
      }
      return (
        <button
          type="button"
          onClick={(e) => {
            // 모달 안에서 열릴 수 있다. 바깥으로 번지면 뒤의 행이 반응한다.
            e.stopPropagation()
            if (node.href) void openUrl(node.href)
          }}
          title={node.href}
          className="cursor-pointer rounded text-accent hover:underline
                     focus-visible:outline-2 focus-visible:outline-accent"
        >
          <Inline nodes={node.children} />
        </button>
      )

    default:
      return null
  }
}

/**
 * 코드 블록 + 복사 버튼.
 *
 * 복사가 있는 이유는 ADF 렌더러와 같다 — 이슈에 붙은 명령어나 스택트레이스를
 * 옮기는 것이 상세를 여는 흔한 이유이고, 드래그 선택은 스크롤되는 `<pre>` 안에서
 * 불편하다.
 */
function CodeBlock({ language, code }: { language: string | null; code: string }) {
  const [copied, setCopied] = useState(false)

  const copy = () => {
    void navigator.clipboard.writeText(code).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    })
  }

  return (
    <div className="group relative">
      <div className="absolute top-1.5 right-1.5 flex items-center gap-2">
        {language && <span className="text-caption text-text-quaternary">{language}</span>}
        <button
          type="button"
          onClick={copy}
          title="코드 복사"
          aria-label="코드 복사"
          className="rounded p-1 text-text-tertiary opacity-0 transition-opacity
                     duration-fast hover:bg-surface-raised hover:text-text-primary
                     focus-visible:opacity-100 focus-visible:outline-2
                     focus-visible:outline-accent group-hover:opacity-100"
        >
          {copied ? <Check size={12} /> : <Copy size={12} />}
        </button>
      </div>
      <pre className="overflow-x-auto rounded bg-surface-inset px-3 py-2">
        <code className="font-mono text-caption text-text-secondary">{code}</code>
      </pre>
    </div>
  )
}
