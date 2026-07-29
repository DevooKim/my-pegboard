import { Ticket } from 'lucide-react'
import type { JiraWidgetConfig } from '#/ipc/bindings'
import { registerWidget } from '#/widgets/registry'
import type { WidgetDefinition } from '#/widgets/types'
import { JiraConfigForm } from './ConfigForm'
import { JiraView } from './View'

/** 프리셋 id → 표시 이름. Rust의 PRESETS와 짝을 이룬다. */
const PRESET_TITLES: Record<string, string> = {
  'assigned-to-me': '내게 할당된 티켓',
  'reported-by-me': '내가 보고한 티켓',
  'my-projects-recent': '최근 업데이트',
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
    query: { kind: 'preset', id: 'assigned-to-me' },
    maxResults: 30,
  },
  // 3열은 DESIGN.md가 검증한 최소 가독 폭. 기본은 4열로 여유를 준다.
  defaultLayout: { w: 4, h: 10 },
  minLayout: { w: 3, h: 5 },

  pollable: true,
  View: JiraView,
  ConfigForm: JiraConfigForm,

  deriveTitle: (config) =>
    config.query.kind === 'preset'
      ? (PRESET_TITLES[config.query.id] ?? 'Jira')
      : '직접 입력한 쿼리',
}

registerWidget(jiraWidget)
