import { openUrl } from '@tauri-apps/plugin-opener'
import { ExternalLink } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import type { WidgetViewProps } from '#/widgets/types'
import type { WebWidgetConfig } from './index'

/** load 이벤트를 이만큼 기다려도 안 오면 '거부당했을 가능성'을 띄운다. */
const LOAD_TIMEOUT_MS = 5000

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
 * ## 그래서 쓴 휴리스틱 (그리고 그 한계)
 *
 * `load`가 5초 안에 안 오면 "거부당한 것 같다" 오버레이를 띄운다.
 *
 * **이 휴리스틱은 불완전하다.** 엔진에 따라 차단된 프레임에서도 `load`가
 * (빈 문서에 대해) 발화한다 — 실제로 Chromium/WebKit 모두 그렇다.
 * 그러면 우리는 '로드 성공'으로 판단하고 오버레이를 띄우지 않는데,
 * 화면은 여전히 백지다. 반대로 그냥 느린 사이트는 5초를 넘겨서
 * 멀쩡히 뜰 페이지에 거짓 경고를 씌운다. 양쪽으로 다 틀릴 수 있다.
 *
 * → 그래서 오버레이와 별개로 헤더 아래 '브라우저에서 열기'를 **상시** 둔다.
 *   감지가 실패해도 위젯이 무용지물이 되지는 않게.
 */
export function WebView({ config }: WidgetViewProps<WebWidgetConfig, unknown>) {
  const [loaded, setLoaded] = useState(false)
  const [timedOut, setTimedOut] = useState(false)
  // URL·설정이 바뀌면 iframe을 통째로 새로 만든다(key). 그래야 로드 상태도 초기화된다.
  const [reloadNonce, setReloadNonce] = useState(0)
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)

  const url = config.url.trim()
  const frameKey = `${url}|${config.allowSession}|${reloadNonce}`

  // 로드 감시 타이머. iframe이 새로 만들어질 때마다 다시 건다.
  useEffect(() => {
    if (!url) return
    setLoaded(false)
    setTimedOut(false)
    timer.current = setTimeout(() => setTimedOut(true), LOAD_TIMEOUT_MS)
    return () => clearTimeout(timer.current)
  }, [url])

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

  // load가 안 왔고 타임아웃까지 지났으면 '거부당한 듯'으로 본다.
  const looksBlocked = timedOut && !loaded

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
          onLoad={() => {
            // 주의: 차단된 프레임에서도 이 핸들러가 불릴 수 있다(위 주석 참조).
            // 즉 loaded=true가 '정상 표시'를 보장하지 않는다.
            setLoaded(true)
            setTimedOut(false)
          }}
          className="block border-0 bg-white"
          style={{
            width: compensated,
            height: compensated,
            transform: `scale(${scale})`,
            transformOrigin: '0 0',
          }}
        />

        {looksBlocked && (
          <div
            className="absolute inset-0 grid place-items-center gap-2 bg-surface-raised/95 p-4
                       text-center"
          >
            <div className="flex flex-col items-center gap-2">
              <p className="text-body text-text-primary">
                이 사이트는 embed를 거부하는 것 같습니다
              </p>
              <p className="text-caption text-text-tertiary">
                {LOAD_TIMEOUT_MS / 1000}초 안에 로드되지 않았습니다. X-Frame-Options 또는
                frame-ancestors로 막혔거나, 그냥 느린 것일 수도 있습니다.
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
                <button
                  type="button"
                  onClick={() => setReloadNonce((n) => n + 1)}
                  className="rounded border border-border-subtle px-2 py-1 text-caption
                             text-text-tertiary hover:bg-surface-inset"
                >
                  다시 시도
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
