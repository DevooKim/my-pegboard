import type { WidgetDefinition, WidgetType } from '#/widgets/types'

/**
 * 위젯 타입 레지스트리.
 *
 * 새 위젯을 추가하려면 여기에 한 줄만 등록하면 된다.
 * 보드·스케줄러·설정창은 이 레지스트리만 보고 동작하며, 개별 위젯 타입을 알지 못한다.
 */

/**
 * 레지스트리는 서로 다른 config/data 타입을 한 맵에 담아야 한다.
 * 타입 안전성은 각 위젯을 정의하는 시점에 보장된다.
 */
// biome-ignore lint/suspicious/noExplicitAny: 이종 위젯 타입을 담는 맵의 불가피한 경계
type AnyWidgetDefinition = WidgetDefinition<any, any>

const registry = new Map<WidgetType, AnyWidgetDefinition>()

export function registerWidget(definition: AnyWidgetDefinition): void {
  if (registry.has(definition.type)) {
    throw new Error(`위젯 타입이 중복 등록되었습니다: ${definition.type}`)
  }
  registry.set(definition.type, definition)
}

export function getWidget(type: WidgetType): AnyWidgetDefinition {
  const definition = registry.get(type)
  if (!definition) {
    throw new Error(`등록되지 않은 위젯 타입입니다: ${type}`)
  }
  return definition
}

export function tryGetWidget(type: WidgetType): AnyWidgetDefinition | undefined {
  return registry.get(type)
}

export function listWidgets(): AnyWidgetDefinition[] {
  return [...registry.values()]
}

/** 테스트 전용 */
export function __resetRegistry(): void {
  registry.clear()
}
