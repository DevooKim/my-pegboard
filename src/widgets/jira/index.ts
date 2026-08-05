import { Ticket } from 'lucide-react'
import type { JiraWidgetConfig } from '#/ipc/bindings'
import { registerWidget } from '#/widgets/registry'
import type { WidgetDefinition } from '#/widgets/types'
import { JiraConfigForm } from './ConfigForm'
import { JiraView } from './View'

/** 프리셋 id → 표시 이름. Rust의 PRESETS와 짝을 이룬다. */
const PRESET_TITLES: Record<string, string> = {
  'assigned-to-me': '내게 할당된 티켓',
  'current-sprint-mine': '현재 스프린트 — 내 티켓',
  'current-sprint-team': '현재 스프린트 — 전체',
  'reported-by-me': '내가 보고한 티켓',
  'my-projects-recent': '최근 내가 관련된 티켓',
  'watched-by-me': '지켜보는 티켓',
  'mentioned-recently': '나를 언급한 티켓',
}

export const jiraWidget: WidgetDefinition<JiraWidgetConfig> = {
  type: 'jira',
  label: 'Jira',
  description: '티켓 목록을 쿼리로 가져옵니다',
  icon: Ticket,
  maxInstances: 4,

  defaultConfig: {
    title: null,
    query: { kind: 'preset', id: 'assigned-to-me' },
    maxResults: 15,
    projects: [],
    refreshSecs: 300,
    columns: null,
  },
  // 3열은 DESIGN.md가 검증한 최소 가독 폭. 기본은 4열로 여유를 준다.
  defaultLayout: { w: 4, h: 10 },
  minLayout: { w: 3, h: 5 },

  pollable: true,
  View: JiraView,
  ConfigForm: JiraConfigForm,

  deriveTitle: (config) => {
    // 사용자가 붙인 이름이 항상 이긴다.
    const custom = config.title?.trim()
    if (custom) return custom
    if (config.query.kind === 'preset') return PRESET_TITLES[config.query.id] ?? 'Jira'
    // 저장된 필터는 config에 이름이 함께 저장돼 있다. **여기가 그 이유다** —
    // 이 함수는 앱 시작 0ms에 불린다. 이름을 서버에서 풀어야 했다면 제목이
    // 'Jira'로 떴다가 목록이 도착한 뒤 바뀌었을 것이다(깜빡임).
    if (config.query.kind === 'savedFilter') return config.query.name || 'Jira'
    return '직접 입력한 쿼리'
  },
}

registerWidget(jiraWidget)
