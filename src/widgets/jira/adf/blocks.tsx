import { Check, Copy } from 'lucide-react'
import { type ReactNode, useState } from 'react'
import { renderInline, str } from '#/widgets/jira/adf/inline'
import { type AdfNode, type RenderCtx, Unsupported } from '#/widgets/jira/adf/shared'

/**
 * 블록 노드.
 *
 * 표는 반드시 `overflow-x-auto` 컨테이너 안에 있어야 한다 — 넓은 표가
 * 모달 폭을 뚫으면 본문 전체가 가로로 밀린다.
 */

export function renderBlocks(nodes: AdfNode[] | undefined, ctx: RenderCtx): ReactNode {
  if (!nodes?.length) return null
  return nodes.map((node, i) => (
    // biome-ignore lint/suspicious/noArrayIndexKey: ADF 노드에 안정된 id가 없다
    <BlockNode key={i} node={node} ctx={ctx} />
  ))
}

function BlockNode({ node, ctx }: { node: AdfNode; ctx: RenderCtx }) {
  switch (node.type) {
    case 'paragraph':
      // DESIGN 7.3이 ADF 본문에 한글 행간(1.75)을 지정했다.
      return (
        <p className="text-body text-text-primary leading-relaxed-ko">
          {renderInline(node.content, ctx)}
        </p>
      )

    case 'heading':
      return <Heading node={node} ctx={ctx} />

    case 'bulletList':
      return (
        <ul className="list-disc space-y-1 pl-5 text-body text-text-primary leading-relaxed-ko">
          {renderBlocks(node.content, ctx)}
        </ul>
      )

    case 'orderedList': {
      // attrs.order는 시작 번호. 1이 아닌 목록이 실제로 있다.
      const start = Number(node.attrs?.order)
      return (
        <ol
          start={Number.isFinite(start) && start > 0 ? start : undefined}
          className="list-decimal space-y-1 pl-5 text-body text-text-primary leading-relaxed-ko"
        >
          {renderBlocks(node.content, ctx)}
        </ol>
      )
    }

    case 'listItem':
      return <li>{renderBlocks(node.content, ctx)}</li>

    case 'codeBlock':
      return <CodeBlock node={node} />

    case 'blockquote':
      return (
        <blockquote className="border-border-strong border-l-2 pl-3 text-text-secondary">
          {renderBlocks(node.content, ctx)}
        </blockquote>
      )

    case 'panel':
      return <Panel node={node} ctx={ctx} />

    case 'rule':
      return <hr className="border-border-subtle" />

    case 'table':
      // 넓은 표가 모달을 뚫지 않게 자기 컨테이너 안에서 스크롤한다.
      return (
        <div className="overflow-x-auto rounded border border-border-subtle">
          <table className="w-full border-collapse text-body">
            <tbody>{renderBlocks(node.content, ctx)}</tbody>
          </table>
        </div>
      )

    case 'tableRow':
      return (
        <tr className="border-border-subtle border-b last:border-0">
          {renderBlocks(node.content, ctx)}
        </tr>
      )

    case 'tableHeader':
      return (
        <th
          colSpan={num(node.attrs?.colspan)}
          rowSpan={num(node.attrs?.rowspan)}
          className="border-border-subtle border-r bg-surface-inset px-2 py-1 text-left
                     font-semibold text-text-secondary last:border-r-0"
        >
          {renderBlocks(node.content, ctx)}
        </th>
      )

    case 'tableCell':
      return (
        <td
          colSpan={num(node.attrs?.colspan)}
          rowSpan={num(node.attrs?.rowspan)}
          className="border-border-subtle border-r px-2 py-1 align-top text-text-primary last:border-r-0"
        >
          {renderBlocks(node.content, ctx)}
        </td>
      )

    // 이미지는 본문 끝에 한 번 요약한다(AdfDoc). 자리에는 표시만 남긴다.
    case 'media':
    case 'mediaSingle':
    case 'mediaGroup':
    case 'mediaInline':
      return (
        <span className="rounded-xs bg-surface-inset px-1.5 py-0.5 text-caption text-text-tertiary">
          [이미지]
        </span>
      )

    // 인라인 노드가 블록 자리에 오는 경우가 있다(문단 없이 바로 text).
    case 'text':
    case 'hardBreak':
    case 'mention':
    case 'emoji':
    case 'inlineCard':
    case 'date':
    case 'status':
      return <>{renderInline([node], ctx)}</>

    default:
      // 자식은 계속 렌더한다 — 내용이 통째로 사라지는 것보다 낫다.
      return (
        <div className="space-y-2">
          <Unsupported type={node.type} />
          {node.content ? renderBlocks(node.content, ctx) : null}
        </div>
      )
  }
}

function Heading({ node, ctx }: { node: AdfNode; ctx: RenderCtx }) {
  const level = Number(node.attrs?.level)
  const children = renderInline(node.content, ctx)
  // 모달 안이므로 크기를 한 단계씩 줄여 그린다. h1이 티켓 제목보다 크면 안 된다.
  const cls =
    level <= 2
      ? 'text-md font-semibold text-text-primary'
      : level === 3
        ? 'text-base font-semibold text-text-primary'
        : 'text-body font-semibold text-text-secondary'

  if (level <= 2) return <h3 className={cls}>{children}</h3>
  if (level === 3) return <h4 className={cls}>{children}</h4>
  if (level === 4) return <h5 className={cls}>{children}</h5>
  return <h6 className={cls}>{children}</h6>
}

/** panelType → 색. Jira가 주는 다섯 종류를 우리 토큰에 매핑한다. */
const PANEL_INFO = { bg: 'var(--color-info-muted)', border: 'var(--color-info)' }

const PANEL_STYLES: Record<string, { bg: string; border: string }> = {
  info: PANEL_INFO,
  note: { bg: 'var(--color-accent-muted)', border: 'var(--color-accent)' },
  warning: { bg: 'var(--color-warning-muted)', border: 'var(--color-warning)' },
  success: { bg: 'var(--color-success-muted)', border: 'var(--color-success)' },
  error: { bg: 'var(--color-danger-muted)', border: 'var(--color-danger)' },
}

function Panel({ node, ctx }: { node: AdfNode; ctx: RenderCtx }) {
  const kind = str(node.attrs?.panelType) ?? 'info'
  const style = PANEL_STYLES[kind] ?? PANEL_INFO
  return (
    <div
      className="space-y-2 rounded border-l-2 px-3 py-2"
      style={{ backgroundColor: style.bg, borderColor: style.border }}
    >
      {renderBlocks(node.content, ctx)}
    </div>
  )
}

/**
 * 코드 블록 + 복사 버튼.
 *
 * 복사가 있는 이유: 티켓에 붙은 명령어나 스택트레이스를 옮기는 것이
 * 상세를 여는 흔한 이유이고, 드래그 선택은 스크롤되는 `<pre>` 안에서 불편하다.
 */
function CodeBlock({ node }: { node: AdfNode }) {
  const [copied, setCopied] = useState(false)
  // 코드블록 안은 text 노드뿐이다. 마크는 무시한다.
  const code = (node.content ?? []).map((c) => (typeof c.text === 'string' ? c.text : '')).join('')
  const language = str(node.attrs?.language)

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

/** colspan/rowspan은 숫자여야 한다. 1은 그리지 않는다(기본값). */
function num(v: unknown): number | undefined {
  const n = Number(v)
  return Number.isFinite(n) && n > 1 ? n : undefined
}
