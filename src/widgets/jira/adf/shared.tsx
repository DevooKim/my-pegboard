/**
 * ADF 렌더러의 공통 타입과 미지원 표시.
 *
 * `blocks`와 `inline`이 서로를 부르므로(문단 안에 텍스트, 표 셀 안에 문단)
 * 공용 조각은 여기 둔다. 순환 import를 피하는 것이 목적이다.
 */

/** ADF 노드. Rust가 `serde_json::Value`로 통과시키므로 프론트에서 처음 해석한다. */
export interface AdfNode {
  type: string
  content?: AdfNode[]
  text?: string
  marks?: AdfMark[]
  attrs?: Record<string, unknown>
}

export interface AdfMark {
  type: string
  attrs?: Record<string, unknown>
}

export interface RenderCtx {
  /** 티켓 참조 클릭 → 모달 안에서 전환 (D4). */
  onOpenIssue: (key: string) => void
  /** 우리 Jira 사이트. inlineCard가 내부 티켓인지 판별하는 데 쓴다. */
  baseUrl: string | null
}

/**
 * 모르는 노드 자리에 그리는 회색 표시.
 *
 * **건너뛰지 않는 것이 이 앱의 규칙이다** (CLAUDE.md 대전제 2).
 * 조용히 넘기면 "안 그려진 줄도 모르는" 상태가 되고, 사용자는 설명이
 * 원래 그런 줄 안다.
 */
export function Unsupported({ type }: { type: string }) {
  return (
    <span className="rounded-xs bg-surface-inset px-1.5 py-0.5 text-caption text-text-tertiary">
      [지원하지 않는 요소: {type}]
    </span>
  )
}

/** 이미지 계열 노드. 개수만 세어 본문 끝에 한 번 요약한다. */
export const MEDIA_TYPES = new Set(['media', 'mediaSingle', 'mediaGroup', 'mediaInline'])

/**
 * 문서 전체의 이미지 개수. `mediaSingle`/`mediaGroup`은 컨테이너라
 * 안의 `media`를 세면 중복이므로, 컨테이너를 만나면 그 아래로 내려가지 않는다.
 */
export function countMedia(node: AdfNode | undefined): number {
  if (!node) return 0
  if (MEDIA_TYPES.has(node.type)) {
    if (node.type === 'mediaGroup' || node.type === 'mediaSingle') {
      // 컨테이너 안의 media 개수가 실제 이미지 수다.
      const inner = node.content?.filter((c) => c.type === 'media').length ?? 0
      return inner > 0 ? inner : 1
    }
    return 1
  }
  return (node.content ?? []).reduce((sum, child) => sum + countMedia(child), 0)
}
