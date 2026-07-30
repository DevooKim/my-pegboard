/**
 * 임베드를 거부하는 것으로 **확인된** 도메인.
 *
 * ## 왜 목록이 필요한가
 *
 * 차단은 런타임에 감지할 수 없다. `X-Frame-Options`나 `frame-ancestors`로
 * 막히면 브라우저가 빈 문서를 렌더하는데, 그때도 `load` 이벤트는 정상 발화한다
 * (실측: github/google/news.ycombinator 전부 800ms 안에 load 발생).
 * `onerror`는 안 오고, `contentWindow`는 차단 여부와 무관하게 SecurityError다.
 * 즉 **성공과 실패를 구분할 신호가 없다.**
 *
 * 그래서 감지 대신 **미리 아는 것을 알려주는** 쪽을 택했다.
 * 목록에 없는 사이트는 여전히 조용히 실패하지만, 가장 흔한 경우는 막는다.
 *
 * 이 목록은 완전하지 않고 완전해질 수도 없다. 그래서 위젯에는 항상
 * "브라우저에서 열기"가 있다 — 감지가 실패해도 막다른 길이 되지 않도록.
 */

/** 실측으로 확인한 차단 도메인 (2026-07). */
const KNOWN_BLOCKED = [
  'github.com',
  'google.com',
  'accounts.google.com',
  'calendar.google.com',
  'mail.google.com',
  'docs.google.com',
  'drive.google.com',
  'news.ycombinator.com',
  'grafana.com',
  'x.com',
  'twitter.com',
  'facebook.com',
  'instagram.com',
  'linkedin.com',
  'notion.so',
  'atlassian.net',
  'slack.com',
  'figma.com',
] as const

/**
 * 이 URL이 임베드를 거부할 것으로 알려져 있는가.
 *
 * 서브도메인도 잡는다 — `foo.github.com`은 `github.com`으로 친다.
 * 다만 `mygithub.com` 같은 우연한 접미사 일치는 피한다.
 */
export function isKnownBlocked(url: string): string | null {
  let host: string
  try {
    host = new URL(url).hostname.toLowerCase()
  } catch {
    return null
  }

  for (const domain of KNOWN_BLOCKED) {
    if (host === domain || host.endsWith(`.${domain}`)) {
      return domain
    }
  }
  return null
}
