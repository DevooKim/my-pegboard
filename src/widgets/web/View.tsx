import { openUrl } from '@tauri-apps/plugin-opener'
import { ExternalLink } from 'lucide-react'
import { useEffect, useState } from 'react'
import type { WidgetViewProps } from '#/widgets/types'
import { isKnownBlocked } from './blocked'
import type { WebWidgetConfig } from './index'

/**
 * 웹 위젯 본문 — iframe 하나.
 *
 * ## 이 파일의 진짜 주제: 실패를 드러내는 것
 *
 * 많은 사이트가 `X-Frame-Options: DENY|SAMEORIGIN` 또는
 * `Content-Security-Policy: frame-ancestors ...`로 임베드를 거부한다.
 * 문제는 **거부당했을 때 JS로 감지할 방법이 사실상 없다는 것**이다:
 *
 * - `onError`는 이 경우 발화하지 않는다. 네트워크 오류가 아니라 브라우저가
 *   차단한 것이라서 iframe 입장에서는 '에러'가 아니다.
 * - 차단된 프레임의 `contentDocument`를 들여다보는 건 cross-origin이라 막힌다.
 *   차단 여부와 무관하게 똑같이 SecurityError가 난다 → 구분에 쓸 수 없다.
 * - 그래서 화면에는 **아무 말 없는 빈 사각형**만 남는다.
 *   이 앱의 대전제("조용한 실패 금지")와 정면으로 충돌한다.
 *
 * ## 감지를 포기하고 택한 것
 *
 * 처음엔 "load가 5초 안에 안 오면 차단"이라는 휴리스틱을 넣었다.
 * **실측해보니 쓸모가 없었다** — github·google·news.ycombinator 전부
 * 800ms 안에 load를 발화시킨다. 차단돼도 load는 온다. 타임아웃은
 * 진짜 느린 사이트에만 걸려서, 정작 필요한 경우는 못 잡고
 * 멀쩡한 사이트에 거짓 경고만 씌운다.
 *
 * 그래서 런타임 감지를 버리고 두 가지로 대신한다:
 *
 * 1. **알려진 차단 도메인 목록**(`blocked.ts`) — 설정 단계에서 미리 경고.
 *    완전하지 않지만 가장 흔한 경우는 잡는다.
 * 2. **상시 '브라우저에서 열기'** — 목록에 없어 조용히 실패하더라도
 *    위젯이 막다른 길이 되지 않게.
 */
export function WebView({ config }: WidgetViewProps<WebWidgetConfig, unknown>) {
  // URL·설정이 바뀌면 iframe을 통째로 새로 만든다(key). 그래야 로드 상태도 초기화된다.
  const [reloadNonce, setReloadNonce] = useState(0)

  const url = config.url.trim()
  const frameKey = `${url}|${config.allowSession}|${reloadNonce}`

  // 자동 새로고침. 0이면 걸지 않는다.
  useEffect(() => {
    if (!url || config.refreshSecs <= 0) return
    const id = setInterval(() => setReloadNonce((n) => n + 1), config.refreshSecs * 1000)
    return () => clearInterval(id)
  }, [url, config.refreshSecs])

  if (!url) {
    return (
      <div className="grid h-full place-items-center p-4 text-center text-caption text-text-tertiary">
        설정에서 주소를 입력하세요
      </div>
    )
  }

  // zoom을 걸면 iframe이 그만큼 작아지므로, 역수만큼 키워서 위젯을 꽉 채운다.
  const scale = config.zoom / 100
  const compensated = `${100 / scale}%`

  // allowSession이 꺼지면 allow-same-origin을 뺀다. 그러면 iframe은
  // 불투명한 출처(opaque origin)가 되어 쿠키·로컬스토리지를 못 쓴다.
  const sandbox = [
    'allow-scripts',
    config.allowSession ? 'allow-same-origin' : null,
    'allow-forms',
    'allow-popups-to-escape-sandbox',
  ]
    .filter(Boolean)
    .join(' ')

  // 런타임 감지는 불가능하므로 알려진 목록으로 판단한다(위 주석 참조).
  const blockedDomain = isKnownBlocked(url)

  return (
    <div className="flex h-full flex-col">
      {/*
        상시 노출하는 탈출구. 감지 휴리스틱이 틀려도(빈 화면인데 오버레이가
        안 뜨는 경우) 사용자가 막히지 않도록.
      */}
      <div className="flex shrink-0 items-center gap-1 border-border-subtle border-b px-2 py-1">
        <span className="min-w-0 flex-1 truncate text-caption text-text-quaternary">{url}</span>
        <button
          type="button"
          onClick={() => void openUrl(url)}
          className="flex shrink-0 items-center gap-1 rounded px-1.5 py-0.5 text-caption
                     text-text-tertiary transition-colors duration-fast
                     hover:bg-surface-inset hover:text-text-primary"
        >
          <ExternalLink size={11} />
          브라우저에서 열기
        </button>
      </div>

      <div
        className="relative min-h-0 flex-1"
        style={{ overflow: config.allowScroll ? 'auto' : 'hidden' }}
      >
        <iframe
          key={frameKey}
          src={url}
          title={config.title ?? url}
          sandbox={sandbox}
          referrerPolicy="no-referrer"
          className="block border-0 bg-white"
          style={{
            width: compensated,
            height: compensated,
            transform: `scale(${scale})`,
            transformOrigin: '0 0',
          }}
        />

        {blockedDomain && (
          <div
            className="absolute inset-0 grid place-items-center gap-2 bg-surface-raised/95 p-4
                       text-center"
          >
            <div className="flex flex-col items-center gap-2">
              <p className="text-body text-text-primary">{blockedDomain}은 임베드를 거부합니다</p>
              <p className="text-caption text-text-tertiary leading-relaxed-ko">
                이 사이트는 X-Frame-Options로 다른 앱에 표시되는 것을 막습니다. 우리가 우회할 수
                없으니 브라우저에서 여세요.
              </p>
              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={() => void openUrl(url)}
                  className="flex items-center gap-1 rounded border border-accent bg-accent/15 px-2
                             py-1 text-caption text-accent"
                >
                  <ExternalLink size={12} />
                  브라우저에서 열기
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
