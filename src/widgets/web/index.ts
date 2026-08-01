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
 *
 * # 앱을 끄면 로그인이 풀린다 (실측, 2026-08-02)
 *
 * `allowSession`을 켜도 **앱 종료 시 iframe의 쿠키·localStorage가 사라진다.**
 * 실행 중에는 정상 동작하므로 눈치채기 어렵다.
 *
 * 원인은 WebKit의 **ITP**(Intelligent Tracking Prevention)다. iframe 안의
 * 출처는 서드파티로 분류되고, 사용자 상호작용 기록이 없으면 스토리지를
 * 비영구로 취급해 종료 시 버린다. 실측한 ITP 기록:
 *
 * | 도메인 | hadUserInteraction | 결과 |
 * |---|---|---|
 * | `localhost` (앱 본체 `tauri://`) | 1 | **유지됨** |
 * | iframe 안의 출처 | 0 | **사라짐** |
 *
 * ITP 기록에 `<iframe 출처> (안) ← localhost (밖)` 관계가 남는 것으로
 * 서드파티 판정을 확인했다.
 *
 * **우리가 고칠 수 없다.** Tauri는 incognito만 노출하고(이미 꺼져 있다),
 * wry도 WKWebView의 ITP 설정을 노출하지 않는다. 앱 본체가 쓰는
 * `defaultDataStore`는 영구 저장소가 맞다 — 앱 자신의 localStorage는 남는다.
 *
 * 그래서 **드러내는 쪽을 택했다**(CLAUDE.md 대전제 2). 설정 폼의 "세션 유지"
 * 설명에 이 사실을 적는다. 조용히 로그인이 풀리면 사용자는 앱을 의심한다.
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
