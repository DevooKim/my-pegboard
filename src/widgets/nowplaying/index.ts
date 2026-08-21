import { AudioLines } from 'lucide-react'
import { registerWidget } from '#/widgets/registry'
import type { WidgetDefinition } from '#/widgets/types'
import { NowPlayingConfigForm } from './ConfigForm'
import { NowPlayingView } from './View'

/**
 * "지금 재생 중" 위젯 — macOS 시스템 Now Playing을 그대로 보여주고 제어한다.
 *
 * ## 특정 서비스 위젯이 아니다
 *
 * Spotify든 브라우저 탭의 YouTube Music이든 Apple Music이든, 시스템에
 * "지금 재생 중"으로 등록되는 것을 전부 잡는다. 그래서 로그인·토큰·설정이 0이고,
 * Spotify 앱이 없는 사용자도 그대로 쓸 수 있다 (DECISIONS 27 — 서비스별 API
 * 연동을 검토하고 버린 이유가 거기 있다).
 *
 * ## 일부러 없는 것
 *
 * - 플레이리스트 탐색·재생 시작 — 시스템 정보로는 불가능하다. 시작은 원본 앱에서.
 * - 셔플·반복·탐색바 조작 — 상태를 신뢰성 있게 못 읽는 토글은 거짓말을 한다.
 * - 디스크 캐시 — 지난 "지금 재생 중"은 거짓말이다 (대전제 1의 명시적 예외).
 */

export interface NowPlayingWidgetConfig {
  /** 사용자가 붙인 이름. 비우면 "지금 재생 중". */
  title: string | null
}

export const nowPlayingWidget: WidgetDefinition<NowPlayingWidgetConfig> = {
  type: 'nowplaying',
  label: '지금 재생 중',
  description: '재생 중인 음악·미디어를 표시하고 제어합니다',
  icon: AudioLines,
  // Todo와 같은 논리로 1. 시스템 재생 상태는 전역 하나뿐이라 두 번째 위젯은
  // 같은 것을 한 번 더 그릴 뿐이다. Rust instance_limit과 같은 값이어야 한다.
  maxInstances: 1,

  defaultConfig: { title: null },
  // 내용이 한 곡 분량으로 고정이라 낮게 시작한다.
  defaultLayout: { w: 4, h: 5 },
  // 이보다 작으면 곡명·제어가 같이 들어가지 못한다.
  minLayout: { w: 3, h: 4 },

  // 새로고침 = 어댑터 재연결. 스트림이 죽었을 때의 복구 경로라 버튼이 필요하다.
  // (주기 폴링은 없다 — Rust가 이벤트를 push한다)
  pollable: true,
  View: NowPlayingView,
  ConfigForm: NowPlayingConfigForm,

  deriveTitle: (config) => config.title?.trim() || '지금 재생 중',
}

registerWidget(nowPlayingWidget)
