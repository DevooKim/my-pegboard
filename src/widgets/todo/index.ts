import { SquareCheck } from 'lucide-react'
import { registerWidget } from '#/widgets/registry'
import type { WidgetDefinition } from '#/widgets/types'
import { TodoConfigForm } from './ConfigForm'
import { TodoView } from './View'

/**
 * Todo 위젯 — 날짜 축을 가진 daily todo (DECISIONS 13).
 *
 * # 왜 1개만 놓을 수 있나
 *
 * 모든 Todo 위젯이 같은 `todos.json`을 읽는다. 두 번째 위젯은 같은 목록을
 * 한 번 더 그릴 뿐이면서 위젯 간 동기화 비용을 만든다. 8개까지 허용했던 것은
 * "Todo는 API 비용이 없으니 많이 놔도 된다"는 이유였지 쓰임을 따진 결과가
 * 아니었다 (2026-08-01 뒤집음, DECISIONS 21).
 *
 * # 왜 pollable: false 인가
 *
 * 우리가 호출할 외부 API가 없다. 데이터는 로컬 파일이고 변경은 사용자가
 * 직접 만든다 — 새로고침 버튼이 할 일이 없으므로 WidgetShell이 숨긴다.
 */

export interface TodoWidgetConfig {
  /** 사용자가 붙인 이름. 비우면 '할 일'. */
  title: string | null
  /**
   * 날짜가 바뀔 때 지난 미완료 항목을 오늘로 옮길 것인가 (DECISIONS 13).
   *
   * 끄면 과거 날짜에 그대로 남는다. 그때는 헤더의 ↓ 버튼으로 필요할 때만
   * 가져온다 — 미루는 것을 자동으로 눈앞에 끌어오는 게 부담스러운 경우가 있다.
   *
   * 기본은 켬. 이월이 이 위젯의 존재 이유다.
   */
  autoCarryOver: boolean
}

export const todoWidget: WidgetDefinition<TodoWidgetConfig, null> = {
  type: 'todo',
  label: '할 일',
  description: '날짜별 할 일. 못 끝낸 항목은 다음 날로 넘어갑니다',
  icon: SquareCheck,
  maxInstances: 1,

  defaultConfig: { title: null, autoCarryOver: true },
  // 목록이라 세로가 길어야 쓸모 있다. 가로는 Jira보다 좁아도 된다.
  defaultLayout: { w: 3, h: 10 },
  minLayout: { w: 2, h: 5 },

  pollable: false,
  View: TodoView,
  ConfigForm: TodoConfigForm,

  deriveTitle: (config) => config.title?.trim() || '할 일',
}

registerWidget(todoWidget)
