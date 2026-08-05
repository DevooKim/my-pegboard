import type { ComponentType } from 'react'

/**
 * 위젯 시스템의 계약.
 *
 * 위젯 하나 = 폴더 하나. 새 위젯을 추가할 때 건드리는 곳은
 * `widgets/<name>/`, `providers/<name>/`(Rust), 그리고 registry.ts 한 줄뿐이다.
 * 다른 위젯 코드를 열 필요가 없어야 한다.
 */

export type WidgetType = 'jira' | 'github' | 'todo' | 'web' | 'album'

/** 위젯의 표시 상태. WidgetShell이 이 값으로 무엇을 그릴지 결정한다. */
export type WidgetStatus =
  /** 아직 한 번도 불러오지 않음 */
  | 'idle'
  /** 최초 로딩 — 보여줄 데이터가 없음 */
  | 'loading'
  /** 정상 */
  | 'ready'
  /** 갱신 실패했으나 직전 성공 데이터를 표시 중. 목록을 비우지 않는다. */
  | 'stale'
  /** 일시적 실패 (429/5xx/네트워크). 재시도 중. */
  | 'error-transient'
  /** 영구적 실패 (401/403/400). 재시도하지 않음. 사용자 조치 필요. */
  | 'error-permanent'
  /** 정상이지만 결과가 0건 */
  | 'empty'

export interface WidgetError {
  status: WidgetStatus & (`error-${string}` | never)
  /** 사용자에게 보여줄 메시지. Jira의 JQL 오류 원문 등은 가공하지 않고 그대로. */
  message: string
  /** 사용자가 취할 수 있는 행동 */
  action?: { label: string; kind: 'open-settings' | 'open-config' | 'retry' }
}

/** Rust가 push하는 위젯 데이터 봉투. 로딩/에러 상태를 명시적으로 담는다. */
export interface WidgetEnvelope<T> {
  status: WidgetStatus
  data: T | null
  /** 데이터를 실제로 가져온 시각 (ISO 8601). stale 표시에 사용. */
  fetchedAt: string | null
  error: WidgetError | null
}

/** board.json에 저장되는 위젯 인스턴스 */
export interface WidgetInstance {
  id: string
  type: WidgetType
  layout: { x: number; y: number; w: number; h: number }
  /** 타입별 설정. 각 위젯이 자기 스키마를 소유한다. */
  config: Record<string, unknown>
}

export interface WidgetViewProps<TConfig, TData> {
  widgetId: string
  config: TConfig
  envelope: WidgetEnvelope<TData>
  /**
   * 위젯 본문의 실제 픽셀 폭. 밀도 전환의 근거다.
   * 그리드 열 수가 아니라 픽셀인 이유: 창 크기에 따라 같은 열 수라도 폭이 다르다.
   */
  width: number
}

export interface WidgetConfigFormProps<TConfig> {
  config: TConfig
  onChange: (next: TConfig) => void
}

/**
 * 위젯 타입 정의. registry에 등록되는 단위.
 */
/**
 * TData 기본값이 `any`인 이유: `unknown`이면 구체 타입을 가진 View를
 * 레지스트리에 담을 수 없다(props 반공변). 타입 안전성은 각 위젯을
 * 정의하는 시점에 보장된다.
 */
// biome-ignore lint/suspicious/noExplicitAny: 위 주석 참조 — 레지스트리 경계의 불가피한 any
export interface WidgetDefinition<TConfig = Record<string, unknown>, TData = any> {
  type: WidgetType
  /** 위젯 추가 메뉴에 표시될 이름 */
  label: string
  /** 위젯 추가 메뉴의 설명 한 줄 */
  description: string
  /** lucide-react 아이콘 이름 */
  icon: ComponentType<{ size?: number; className?: string }>

  /** 타입별 인스턴스 상한 (DECISIONS 3장: jira 4 / github 4 / todo 8) */
  maxInstances: number

  /** 새로 추가할 때의 기본 설정 */
  defaultConfig: TConfig
  /** 새로 추가할 때의 기본 크기 (12열 기준) */
  defaultLayout: { w: number; h: number }
  /** 리사이즈 하한 — 이보다 작으면 내용이 읽히지 않는 크기 */
  minLayout: { w: number; h: number }

  /** 외부 API에 의존하는가. false면 WidgetShell이 새로고침 버튼을 숨긴다. */
  pollable: boolean

  View: ComponentType<WidgetViewProps<TConfig, TData>>
  ConfigForm: ComponentType<WidgetConfigFormProps<TConfig>>

  /** 설정에서 표시할 위젯 제목을 파생 (예: 프리셋 이름) */
  deriveTitle: (config: TConfig) => string
}
