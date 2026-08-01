import type { JiraIssueTypeOption } from '#/ipc/bindings'

/**
 * 어떤 티켓 아래에 어떤 유형을 만들 수 있나.
 *
 * Jira의 계층은 `hierarchyLevel`로 정해진다 (실측, 2026-08-01):
 *
 * ```
 *    1  에픽
 *    0  작업 · 기능 · 버그 · 스토리
 *   -1  하위 작업   (subtask: true)
 * ```
 *
 * 규칙은 **바로 한 단계 아래**다. 에픽 아래에는 작업을, 작업 아래에는 하위
 * 작업을 만든다. 두 단계를 건너뛰지 않는다 — 에픽 아래에 하위 작업을 직접
 * 두는 것은 Jira가 허용하지 않는다.
 *
 * 순수 함수로 뽑은 이유: 이 판단이 틀리면 "만들기" 버튼이 안 나오거나
 * (조용한 기능 상실) 만들 수 없는 유형을 제안해 400을 받는다. 둘 다
 * 렌더 트리를 통해 확인하기 번거롭다.
 */

/**
 * 이슈의 계층 레벨을 프로젝트 유형 목록에서 찾는다.
 *
 * 상세 응답의 `issueType`에는 **이름과 subtask만** 있고 `hierarchyLevel`이
 * 없다. 그래서 이름으로 맞춰 프로젝트 목록에서 레벨을 가져온다.
 *
 * 이름이 안 맞으면(다른 프로젝트의 유형, 이름 변경 등) `subtask` 플래그로
 * 근사한다 — 그것만으로도 -1인지 아닌지는 안다.
 */
export function levelOf(
  typeName: string | null | undefined,
  isSubtask: boolean | null | undefined,
  projectTypes: JiraIssueTypeOption[],
): number | null {
  if (typeName) {
    const found = projectTypes.find((t) => t.name === typeName)
    if (found) return found.hierarchyLevel ?? (found.subtask ? -1 : 0)
  }
  if (isSubtask) return -1
  // 유형을 모르면 추측하지 않는다. 호출부가 "만들기 없음"으로 처리한다.
  return null
}

/**
 * 이 레벨의 티켓 아래에 만들 수 있는 유형들.
 *
 * 빈 배열이면 만들 수 있는 것이 없다 — 하위 작업(-1) 아래가 그렇다.
 */
export function childTypesFor(
  parentLevel: number | null,
  projectTypes: JiraIssueTypeOption[],
): JiraIssueTypeOption[] {
  if (parentLevel === null) return []
  const target = parentLevel - 1
  // -2는 존재하지 않는다. 하위 작업 아래로는 못 만든다.
  if (target < -1) return []
  return projectTypes.filter((t) => (t.hierarchyLevel ?? (t.subtask ? -1 : 0)) === target)
}

/** `ABC-123` → `ABC`. 상세 화면은 프로젝트 키를 따로 들고 있지 않다. */
export function projectKeyOf(issueKey: string): string | null {
  const m = /^([A-Z][A-Z0-9_]+)-\d+$/.exec(issueKey.trim().toUpperCase())
  return m?.[1] ?? null
}
