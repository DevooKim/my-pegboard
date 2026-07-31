import { Image } from 'lucide-react'
import { renderBlocks } from '#/widgets/jira/adf/blocks'
import { ExternalLink } from '#/widgets/jira/adf/inline'
import { type AdfNode, countMedia, type RenderCtx } from '#/widgets/jira/adf/shared'

/**
 * ADF(Atlassian Document Format) 렌더러.
 *
 * `@atlaskit/renderer`를 쓰지 않는다 — Atlaskit 전체를 끌고 오기 때문이다
 * (DECISIONS 11.4). 의존성 0으로 직접 그린다.
 *
 * # 이 렌더러가 지키는 규칙
 *
 * **모르는 것을 조용히 건너뛰지 않는다.** 미지원 노드는 회색 플레이스홀더를 남긴다.
 * 건너뛰면 사용자는 설명이 원래 그런 줄 알고, 우리는 무엇이 빠졌는지 영영 모른다.
 *
 * 예외는 **마크**다. 모르는 마크는 텍스트만 그리고 표시하지 않는다 —
 * 마크마다 배지를 붙이면 본문이 읽히지 않는다.
 *
 * 이미지는 인증된 URL을 다시 요청해야 해서 지금은 그리지 않는다(4차).
 * 대신 개수를 세어 본문 끝에 "이미지 N개 — Jira에서 보기"를 한 번 붙인다.
 */
export function AdfDoc({
  doc,
  onOpenIssue,
  baseUrl,
  issueUrl,
}: {
  /** Rust가 그대로 통과시킨 ADF. specta에서 any로 온다. */
  doc: unknown
  /** 티켓 참조 클릭 → 모달 안에서 전환 (D4). */
  onOpenIssue: (key: string) => void
  /** 우리 Jira 사이트. inlineCard가 내부 티켓인지 판별한다. */
  baseUrl?: string | null
  /** 이 티켓의 Jira URL. "이미지는 Jira에서 보기" 링크. */
  issueUrl?: string | null
}) {
  if (!isDoc(doc)) {
    if (doc != null) {
      // 콘솔에 원문을 남긴다 — 화면의 한 줄만으로는 무엇이 왔는지 알 수 없다.
      console.warn('[adf] doc 타입이 아닌 값을 받았습니다', doc)
      return (
        <p className="text-body text-text-tertiary">
          <span className="rounded-xs bg-surface-inset px-1.5 py-0.5 text-caption">
            [ADF 문서가 아닙니다]
          </span>
        </p>
      )
    }
    return <p className="text-body text-text-tertiary">설명이 없습니다</p>
  }

  if (!doc.content?.length) {
    return <p className="text-body text-text-tertiary">설명이 없습니다</p>
  }

  const ctx: RenderCtx = { onOpenIssue, baseUrl: baseUrl ?? null }
  const mediaCount = countMedia(doc)

  return (
    <div className="space-y-3">
      {renderBlocks(doc.content, ctx)}
      {mediaCount > 0 && (
        <p className="flex items-center gap-1.5 text-caption text-text-tertiary">
          <Image size={12} aria-hidden="true" />
          이미지 {mediaCount}개 —{' '}
          {issueUrl ? (
            <ExternalLink href={issueUrl}>Jira에서 보기</ExternalLink>
          ) : (
            <span>Jira에서 확인하세요</span>
          )}
        </p>
      )}
    </div>
  )
}

function isDoc(v: unknown): v is AdfNode {
  return typeof v === 'object' && v !== null && (v as { type?: unknown }).type === 'doc'
}
