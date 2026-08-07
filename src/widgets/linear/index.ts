import { CircleDashed } from 'lucide-react'
import type { LinearWidgetConfig } from '#/ipc/bindings'
import { registerWidget } from '#/widgets/registry'
import type { WidgetDefinition } from '#/widgets/types'
import { LinearConfigForm } from './ConfigForm'
import { LinearView } from './View'

/**
 * Linear 위젯 — 이슈 목록 + 상태 변경 + 상세 (DECISIONS 25).
 *
 * ## 조작 범위가 GitHub과 다르다
 *
 * GitHub 위젯은 읽기 전용이고 상세 모달도 없다(12.5). Linear에는 **상세와
 * 상태 변경이 있다** — 사용자가 "Jira 위젯과 같은 수준으로"라고 정했다.
 * Jira에 그 둘을 넣은 근거(빈도가 높다, 11.5)가 Linear에도 그대로 적용된다.
 *
 * ## 프리셋만 있고 직접 입력이 없다
 *
 * Jira는 생 JQL, GitHub은 생 검색 문자열이라는 탈출구가 있는데 Linear는 없다.
 * 필터가 문자열이 아니라 `IssueFilter` **JSON 객체**여서, 사용자에게 그것을
 * 쓰게 하는 것은 탈출구가 아니라 함정이다. 프리셋 × 팀 범위 조합으로 커버한다.
 */

/** 프리셋 id → 표시 이름. Rust의 PRESETS와 짝을 이룬다. */
const PRESET_TITLES: Record<string, string> = {
  'assigned-to-me': '내게 할당된 이슈',
  'created-by-me': '내가 만든 이슈',
  'assigned-to-me-all': '내게 할당된 이슈 (완료 포함)',
  'recently-updated': '최근 업데이트된 이슈',
}

export const linearWidget: WidgetDefinition<LinearWidgetConfig> = {
  type: 'linear',
  label: 'Linear',
  description: '이슈를 프리셋으로 가져오고 상태를 바꿉니다',
  icon: CircleDashed,
  maxInstances: 4,

  defaultConfig: {
    title: null,
    // 위젯을 처음 놓았을 때 **내 것이 보이는 것**이 가장 예상에 맞다.
    // "최근 업데이트된 이슈"를 기본으로 두면 팀 범위를 안 고른 상태에서
    // 조직 전체가 쏟아진다.
    query: { kind: 'preset', id: 'assigned-to-me' },
    maxResults: 30,
    teams: [],
    sort: 'updatedAt',
    groupByTeam: true,
    refreshSecs: 300,
  },
  // GitHub 위젯과 같은 2행 구성이라 행당 높이가 크다. 기본 높이를 넉넉히 준다.
  defaultLayout: { w: 4, h: 10 },
  minLayout: { w: 3, h: 5 },

  pollable: true,
  View: LinearView,
  ConfigForm: LinearConfigForm,

  deriveTitle: (config) => {
    // 사용자가 붙인 이름이 항상 이긴다.
    const custom = config.title?.trim()
    if (custom) return custom
    return PRESET_TITLES[config.query.id] ?? 'Linear'
  },
}

registerWidget(linearWidget)
