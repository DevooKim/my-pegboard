import { describe, expect, it } from 'vitest'
import type { JiraIssueTypeOption } from '#/ipc/bindings'
import { childTypesFor, levelOf, projectKeyOf } from '#/widgets/jira/childTypes'

/**
 * 하위 티켓 생성 규칙.
 *
 * 계층은 `hierarchyLevel`로 정해진다 (EDU 실측, 2026-08-01):
 *
 * ```
 *    1  에픽
 *    0  작업 · 기능 · 버그 · 스토리
 *   -1  하위 작업  (subtask: true)
 * ```
 *
 * 상위는 화면 맥락에서 온다 — 상세 모달에서 "만들기"를 누르면 그 티켓이
 * 상위가 된다. Jira가 `parent`에 `allowedValues`도 `autoCompleteUrl`도 주지
 * 않아서(실측) 사용자가 고를 방법이 없기 때문이다.
 */

function type(name: string, level: number, subtask = false): JiraIssueTypeOption {
  return {
    id: `t-${name}`,
    name,
    description: null,
    iconUrl: null,
    subtask,
    hierarchyLevel: level,
  }
}

/** EDU의 실제 유형 구성. */
const EDU = [
  type('에픽', 1),
  type('작업', 0),
  type('기능', 0),
  type('버그', 0),
  type('스토리', 0),
  type('하위 작업', -1, true),
]

describe('levelOf', () => {
  it('이름으로 프로젝트 목록에서 레벨을 찾는다', () => {
    expect(levelOf('에픽', false, EDU)).toBe(1)
    expect(levelOf('작업', false, EDU)).toBe(0)
    expect(levelOf('하위 작업', true, EDU)).toBe(-1)
  })

  /** 다른 프로젝트의 유형이거나 이름이 바뀌었을 때. */
  it('목록에 없으면 subtask 플래그로 근사한다', () => {
    expect(levelOf('알 수 없는 유형', true, EDU)).toBe(-1)
  })

  it('유형을 전혀 모르면 null — 추측하지 않는다', () => {
    expect(levelOf(null, null, EDU)).toBeNull()
    expect(levelOf('알 수 없는 유형', false, EDU)).toBeNull()
  })

  it('프로젝트 목록이 아직 안 왔어도 subtask는 판단한다', () => {
    expect(levelOf('하위 작업', true, [])).toBe(-1)
  })
})

describe('childTypesFor', () => {
  it('에픽 아래에는 표준 유형들을 만든다', () => {
    const names = childTypesFor(1, EDU).map((t) => t.name)
    expect(names).toEqual(['작업', '기능', '버그', '스토리'])
  })

  it('작업 아래에는 하위 작업만 만든다', () => {
    const names = childTypesFor(0, EDU).map((t) => t.name)
    expect(names).toEqual(['하위 작업'])
  })

  /** 하위 작업 아래로는 더 내려갈 수 없다 — 버튼이 사라져야 한다. */
  it('하위 작업 아래에는 아무것도 못 만든다', () => {
    expect(childTypesFor(-1, EDU)).toEqual([])
  })

  it('레벨을 모르면 아무것도 제안하지 않는다', () => {
    expect(childTypesFor(null, EDU)).toEqual([])
  })

  /** 두 단계를 건너뛰지 않는다 — 에픽 바로 아래에 하위 작업을 두면 Jira가 거부한다. */
  it('에픽 아래에 하위 작업을 제안하지 않는다', () => {
    const names = childTypesFor(1, EDU).map((t) => t.name)
    expect(names).not.toContain('하위 작업')
  })

  /**
   * `hierarchyLevel`이 빠진 응답(구 사이트·필드 누락)에서도 동작해야 한다.
   * Rust가 `#[serde(default)]`로 0을 채우지만, 프론트까지 오지 않는 경우를
   * 대비해 `subtask` 플래그로 유추한다.
   */
  it('hierarchyLevel이 없으면 subtask로 유추한다', () => {
    const legacy = [
      { id: 'a', name: '작업', description: null, iconUrl: null, subtask: false },
      { id: 'b', name: '하위 작업', description: null, iconUrl: null, subtask: true },
    ] as unknown as JiraIssueTypeOption[]
    expect(childTypesFor(0, legacy).map((t) => t.name)).toEqual(['하위 작업'])
  })
})

describe('projectKeyOf', () => {
  it('티켓 키에서 프로젝트 키를 뽑는다', () => {
    expect(projectKeyOf('EDU-60')).toBe('EDU')
    expect(projectKeyOf('LAAS-1234')).toBe('LAAS')
  })

  it('소문자·공백을 정규화한다', () => {
    expect(projectKeyOf('  edu-60 ')).toBe('EDU')
  })

  it('키 형태가 아니면 null', () => {
    expect(projectKeyOf('EDU')).toBeNull()
    expect(projectKeyOf('60')).toBeNull()
    expect(projectKeyOf('')).toBeNull()
  })
})
