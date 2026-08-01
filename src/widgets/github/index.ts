import { GitPullRequest } from 'lucide-react'
import type { GithubWidgetConfig } from '#/ipc/bindings'
import { registerWidget } from '#/widgets/registry'
import type { WidgetDefinition } from '#/widgets/types'
import { GithubConfigForm } from './ConfigForm'
import { GithubView } from './View'

/** 프리셋 id → 표시 이름. Rust의 PRESETS와 짝을 이룬다. */
const PRESET_TITLES: Record<string, string> = {
  'involves-me': '내가 관련된 것',
  'review-requested': '리뷰 요청받은 PR',
  'my-prs': '내 PR',
  'assigned-issues': '내게 할당된 이슈',
  'my-issues': '내가 만든 이슈',
}

export const githubWidget: WidgetDefinition<GithubWidgetConfig> = {
  type: 'github',
  label: 'GitHub',
  description: 'PR과 이슈를 쿼리로 가져옵니다',
  icon: GitPullRequest,
  maxInstances: 4,

  defaultConfig: {
    title: null,
    // 실측에서 가장 건수가 많다(13). 위젯을 처음 놓았을 때 빈 화면이면
    // 고장으로 보이므로 기본값은 뭐라도 나오는 쪽으로 잡는다.
    query: { kind: 'preset', id: 'involves-me' },
    maxResults: 30,
    repos: [],
    groupByRepo: true,
    repoOrder: [],
    refreshSecs: 300,
  },
  // 2행 구성이라 Jira보다 행당 높이가 크다. 기본 높이를 넉넉히 준다.
  defaultLayout: { w: 4, h: 10 },
  minLayout: { w: 3, h: 5 },

  pollable: true,
  View: GithubView,
  ConfigForm: GithubConfigForm,

  deriveTitle: (config) => {
    // 사용자가 붙인 이름이 항상 이긴다.
    const custom = config.title?.trim()
    if (custom) return custom
    return config.query.kind === 'preset'
      ? (PRESET_TITLES[config.query.id] ?? 'GitHub')
      : '직접 입력한 쿼리'
  },
}

registerWidget(githubWidget)
