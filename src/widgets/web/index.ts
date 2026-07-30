import { Globe } from 'lucide-react'
import { registerWidget } from '#/widgets/registry'
import type { WidgetDefinition } from '#/widgets/types'
import { WebConfigForm } from './ConfigForm'
import { WebView } from './View'

/**
 * 웹 위젯 — 임의의 URL을 iframe으로 띄운다.
 *
 * **이것은 실험(spike)이다.** iframe 방식이 쓸 만한지 판단하려고 만들었다.
 * 많은 사이트가 X-Frame-Options / CSP frame-ancestors로 임베드를 거부하는데,
 * 그때 iframe은 **에러 없이 그냥 빈 화면**이 된다. View.tsx가 이걸 최대한
 * 드러내려고 시도하지만 완전하지 않다 — 자세한 사정은 View.tsx의 주석에.
 */

export interface WebWidgetConfig {
  /** 사용자가 붙인 이름. 비우면 URL의 호스트명을 쓴다. */
  title: string | null
  url: string
  /** CSS transform scale. 50~150(%). */
  zoom: number
  /** 0이면 자동 새로고침 없음 */
  refreshSecs: number
  /** false면 sandbox에서 allow-same-origin을 뺀다 → 로그인 세션이 끊긴다 */
  allowSession: boolean
  /** false면 컨테이너를 overflow: hidden으로 막는다 */
  allowScroll: boolean
}

export const webWidget: WidgetDefinition<WebWidgetConfig> = {
  type: 'web',
  label: '웹',
  description: '웹 페이지를 그대로 띄웁니다 (임베드를 거부하는 사이트가 많습니다)',
  icon: Globe,
  maxInstances: 4,

  defaultConfig: {
    title: null,
    url: '',
    zoom: 100,
    refreshSecs: 0,
    allowSession: true,
    allowScroll: true,
  },
  // 웹 페이지는 목록보다 넓고 높아야 읽힌다.
  defaultLayout: { w: 6, h: 12 },
  minLayout: { w: 3, h: 5 },

  // 외부 API를 우리가 호출하는 게 아니라 iframe이 스스로 로드한다.
  // 그래도 '새로고침'은 의미가 있어서(=iframe 재로드) true로 둔다.
  pollable: true,
  View: WebView,
  ConfigForm: WebConfigForm,

  deriveTitle: (config) => {
    const custom = config.title?.trim()
    if (custom) return custom
    return hostOf(config.url) ?? '웹'
  },
}

/** URL에서 호스트명만 뽑는다. 파싱 실패(입력 중인 URL 등)면 null. */
function hostOf(url: string): string | null {
  try {
    return new URL(url).host
  } catch {
    return null
  }
}

registerWidget(webWidget)
