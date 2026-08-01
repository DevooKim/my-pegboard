import { describe, expect, it } from 'vitest'
import type { CreateMeta, JiraIssueTypeOption } from '#/ipc/bindings'

/**
 * 하위 작업 생성 규칙.
 *
 * 실측(EDU 하위 작업 10006, 2026-08-01): `parent`는 `required: true`,
 * `hasDefaultValue: false`이고 **`allowedValues`도 `autoCompleteUrl`도 없다.**
 * 드롭다운을 만들 수 없어 사용자가 키를 직접 적어야 한다는 뜻이다.
 *
 * 아래 함수들은 모달의 판단 로직을 그대로 복제한 것이다. UI를 통째로 렌더하지
 * 않고 규칙만 검증한다 — 규칙이 틀리면 상위 칸이 안 나오거나(400 실패) 표준
 * 이슈에 엉뚱한 칸이 뜬다.
 */

/** 모달의 `needsParent` 판단. */
function needsParent(type: JiraIssueTypeOption | null, meta: CreateMeta | null): boolean {
  const metaWantsParent = meta?.fields.some((f) => f.fieldId === 'parent' && f.required) ?? false
  return type?.subtask === true || metaWantsParent
}

/** 모달의 `parentSatisfied` 판단. */
function canSubmit(needs: boolean, parentKey: string, summary: string): boolean {
  const parentSatisfied = !needs || parentKey.trim().length > 0
  return summary.trim().length > 0 && parentSatisfied
}

function type(over: Partial<JiraIssueTypeOption> = {}): JiraIssueTypeOption {
  return {
    id: '10006',
    name: '하위 작업',
    description: null,
    iconUrl: null,
    subtask: false,
    hierarchyLevel: 0,
    ...over,
  }
}

function metaWith(fields: { fieldId: string; required: boolean }[]): CreateMeta {
  return {
    fields: fields.map((f) => ({
      fieldId: f.fieldId,
      name: f.fieldId,
      required: f.required,
      hasDefaultValue: false,
      schemaType: null,
      allowedValues: [],
    })),
  } as CreateMeta
}

describe('needsParent', () => {
  it('하위 작업 유형이면 상위가 필요하다', () => {
    expect(needsParent(type({ subtask: true, hierarchyLevel: -1 }), null)).toBe(true)
  })

  it('표준 유형이면 필요 없다', () => {
    expect(
      needsParent(type({ subtask: false }), metaWith([{ fieldId: 'summary', required: true }])),
    ).toBe(false)
  })

  /** createmeta가 아직 안 왔거나 실패해도 subtask 플래그로 즉시 판단한다. */
  it('createmeta 없이도 subtask 플래그만으로 판단한다', () => {
    expect(needsParent(type({ subtask: true }), null)).toBe(true)
  })

  /** 반대로 플래그가 없어도 createmeta가 요구하면 따른다(에픽 하위 등). */
  it('createmeta가 parent를 required로 주면 따른다', () => {
    const meta = metaWith([{ fieldId: 'parent', required: true }])
    expect(needsParent(type({ subtask: false }), meta)).toBe(true)
  })

  it('parent가 있어도 required가 아니면 요구하지 않는다', () => {
    const meta = metaWith([{ fieldId: 'parent', required: false }])
    expect(needsParent(type({ subtask: false }), meta)).toBe(false)
  })

  it('유형을 아직 안 골랐으면 요구하지 않는다', () => {
    expect(needsParent(null, null)).toBe(false)
  })
})

describe('canSubmit', () => {
  it('하위 작업인데 상위가 비면 막는다', () => {
    expect(canSubmit(true, '', '요약')).toBe(false)
    expect(canSubmit(true, '   ', '요약')).toBe(false)
  })

  it('하위 작업이고 상위가 있으면 보낸다', () => {
    expect(canSubmit(true, 'EDU-10', '요약')).toBe(true)
  })

  it('표준 이슈는 상위가 없어도 보낸다', () => {
    expect(canSubmit(false, '', '요약')).toBe(true)
  })

  it('요약이 비면 어느 경우든 막는다', () => {
    expect(canSubmit(false, '', '')).toBe(false)
    expect(canSubmit(true, 'EDU-10', '  ')).toBe(false)
  })
})

describe('상위 키 정규화', () => {
  // 모달은 보내기 전에 trim + 대문자로 만든다. Jira 키는 대문자다.
  const normalize = (raw: string) => raw.trim().toUpperCase()

  it('소문자를 대문자로 올린다', () => {
    expect(normalize('edu-10')).toBe('EDU-10')
  })

  it('앞뒤 공백을 없앤다', () => {
    expect(normalize('  EDU-10  ')).toBe('EDU-10')
  })
})
