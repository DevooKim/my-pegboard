import { openUrl } from '@tauri-apps/plugin-opener'
import type { ReactNode } from 'react'
import { absoluteDate } from '#/ui/relativeTime'
import { issueKeyFromUrl, splitIssueKeys } from '#/widgets/jira/adf/issueKeys'
import { type AdfNode, type RenderCtx, Unsupported } from '#/widgets/jira/adf/shared'

/**
 * 인라인 노드와 마크.
 *
 * 마크는 노드와 다르게 취급한다 — 모르는 **노드**는 회색 플레이스홀더를 그리지만,
 * 모르는 **마크**는 조용히 무시하고 텍스트만 그린다. 마크마다 배지를 붙이면
 * 본문이 읽히지 않기 때문이다 (CLAUDE.md 대전제 2의 예외이자 그 이유).
 */

export function renderInline(nodes: AdfNode[] | undefined, ctx: RenderCtx): ReactNode {
  if (!nodes?.length) return null
  return nodes.map((node, i) => (
    // biome-ignore lint/suspicious/noArrayIndexKey: ADF 노드에 안정된 id가 없다
    <InlineNode key={i} node={node} ctx={ctx} />
  ))
}

function InlineNode({ node, ctx }: { node: AdfNode; ctx: RenderCtx }) {
  switch (node.type) {
    case 'text':
      return <TextNode node={node} ctx={ctx} />

    case 'hardBreak':
      return <br />

    case 'mention': {
      // attrs.text가 없으면 attrs.id(계정 UUID)를 그리지 않는다 — 사용자에게
      // 아무 의미가 없고 본문만 어지럽힌다.
      const label = str(node.attrs?.text) ?? '@알 수 없는 사용자'
      return (
        <span className="rounded-xs bg-accent-muted px-1 text-accent">
          {label.startsWith('@') ? label : `@${label}`}
        </span>
      )
    }

    case 'emoji':
      return <span>{str(node.attrs?.text) ?? str(node.attrs?.shortName) ?? '□'}</span>

    case 'date': {
      const ts = str(node.attrs?.timestamp)
      if (!ts) return null
      const ms = Number(ts)
      if (!Number.isFinite(ms)) return null
      // absoluteDate는 `YYYY-MM-DD`를 받는다.
      const ymd = new Date(ms).toISOString().slice(0, 10)
      return <span className="text-text-secondary tabular-nums">{absoluteDate(ymd)}</span>
    }

    case 'status': {
      const label = str(node.attrs?.text)
      if (!label) return null
      return (
        <span className="rounded-xs bg-surface-inset px-1.5 py-0.5 text-caption text-text-secondary uppercase">
          {label}
        </span>
      )
    }

    case 'inlineCard': {
      const url = str(node.attrs?.url)
      if (!url) return <Unsupported type="inlineCard" />
      const key = issueKeyFromUrl(url, ctx.baseUrl)
      if (key) {
        return <IssueRef issueKey={key} ctx={ctx} />
      }
      return <ExternalLink href={url}>{url}</ExternalLink>
    }

    default:
      // 자식이 있으면 살린다 — 내용이 통째로 사라지는 것보다 낫다.
      return (
        <>
          <Unsupported type={node.type} />
          {node.content ? renderInline(node.content, ctx) : null}
        </>
      )
  }
}

/**
 * 텍스트 노드 + 마크 적용.
 *
 * 티켓 키 자동 링크는 `link`/`code` 마크가 없을 때만 한다:
 * 링크 안에 링크를 넣으면 HTML이 깨지고, 코드 안의 문자열은 링크가 아니다.
 */
function TextNode({ node, ctx }: { node: AdfNode; ctx: RenderCtx }) {
  const text = typeof node.text === 'string' ? node.text : ''
  if (!text) return null

  const marks = node.marks ?? []
  const linkMark = marks.find((m) => m.type === 'link')
  const hasCode = marks.some((m) => m.type === 'code')

  let content: ReactNode
  if (linkMark) {
    const href = str(linkMark.attrs?.href)
    content = href ? <ExternalLink href={href}>{text}</ExternalLink> : text
  } else if (hasCode) {
    content = text
  } else {
    content = <AutoLinkedText text={text} ctx={ctx} />
  }

  // 남은 마크를 안쪽부터 감싼다.
  for (const mark of marks) {
    content = applyMark(mark.type, mark.attrs, content)
  }
  return <>{content}</>
}

function applyMark(
  type: string,
  attrs: Record<string, unknown> | undefined,
  child: ReactNode,
): ReactNode {
  switch (type) {
    case 'strong':
      return <strong className="font-semibold">{child}</strong>
    case 'em':
      return <em className="italic">{child}</em>
    case 'strike':
      return <s className="line-through">{child}</s>
    case 'underline':
      return <u className="underline">{child}</u>
    case 'code':
      return (
        <code className="rounded-xs bg-surface-inset px-1 py-0.5 font-mono text-caption text-text-secondary">
          {child}
        </code>
      )
    case 'subsup':
      return str(attrs?.type) === 'sub' ? <sub>{child}</sub> : <sup>{child}</sup>
    case 'textColor': {
      const color = str(attrs?.color)
      return color ? <span style={{ color }}>{child}</span> : child
    }
    // link는 TextNode가 이미 처리했다. 모르는 마크는 조용히 통과 — 위 주석 참조.
    default:
      return child
  }
}

/** 평문 안의 `PROJ-123`을 모달 전환 버튼으로 바꾼다. */
function AutoLinkedText({ text, ctx }: { text: string; ctx: RenderCtx }) {
  const pieces = splitIssueKeys(text)
  // 키가 하나도 없으면 원문 그대로 — 불필요한 span 중첩을 만들지 않는다.
  if (pieces.every((p) => p.kind === 'text')) return <>{text}</>

  return (
    <>
      {pieces.map((piece, i) =>
        piece.kind === 'key' ? (
          // biome-ignore lint/suspicious/noArrayIndexKey: 텍스트 조각에 id가 없다
          <IssueRef key={i} issueKey={piece.value} ctx={ctx} />
        ) : (
          // biome-ignore lint/suspicious/noArrayIndexKey: 텍스트 조각에 id가 없다
          <span key={i}>{piece.value}</span>
        ),
      )}
    </>
  )
}

/** 모달 안에서 다른 티켓으로 전환하는 참조 (D4). */
function IssueRef({ issueKey, ctx }: { issueKey: string; ctx: RenderCtx }) {
  return (
    <button
      type="button"
      onClick={() => ctx.onOpenIssue(issueKey)}
      title={`${issueKey} 상세 보기`}
      className="ticket-key cursor-pointer rounded-xs text-accent hover:underline
                 focus-visible:outline-2 focus-visible:outline-accent"
    >
      {issueKey}
    </button>
  )
}

/**
 * 외부 링크. **기본 이동을 막고 브라우저로 넘긴다** — 그대로 두면 Tauri 웹뷰가
 * 앱 창 안에서 열어버려 돌아올 방법이 없다.
 */
export function ExternalLink({ href, children }: { href: string; children: ReactNode }) {
  return (
    <a
      href={href}
      title={href}
      onClick={(e) => {
        e.preventDefault()
        e.stopPropagation()
        void openUrl(href)
      }}
      className="cursor-pointer text-accent hover:underline
                 focus-visible:outline-2 focus-visible:outline-accent"
    >
      {children}
    </a>
  )
}

/** attrs 값은 unknown이다. 문자열일 때만 쓴다. */
export function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined
}
