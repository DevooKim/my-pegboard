import { render } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import type { JiraIssue } from '#/ipc/bindings'
import { ColumnHeader } from '#/widgets/jira/ColumnHeader'
import { DEFAULT_COLUMN_WIABCS, TOGGLEABLE_COLUMNS } from '#/widgets/jira/columns'
import { IssueRow } from '#/widgets/jira/IssueRow'

/**
 * 헤더 글자와 값 글자의 시작점이 같은 x에 있는지 검사한다.
 *
 * 이 문제로 네 번 헛짚었다. 매번 눈으로 스크린샷을 보고 원인을 추측했는데,
 * 진짜 원인(flex 안의 span이 콘텐츠 폭으로 줄어들어 트랙 가운데 놓임)은
 * 클래스만 읽어서는 보이지 않았다. 그래서 좌표로 고정한다.
 *
 * jsdom은 실제 레이아웃을 계산하지 않으므로 픽셀값 자체는 검증할 수 없다.
 * 대신 **정렬을 좌우하는 클래스 조합**을 검사한다 — 헤더 셀과 행 셀이
 * 트랙을 채우는지(w-full), 그리고 좌측 정렬인지.
 */

const issue: JiraIssue = {
  key: 'XYZ-1',
  summary: '아키텍쳐 결합성 개선',
  status: { name: '진행 중', statusCategory: { key: 'indeterminate', colorName: 'yellow' } },
  assignee: { accountId: 'a', displayName: '김현우', avatarUrl: null },
  priority: { name: 'Highest', iconUrl: null },
  issueType: { name: '에픽', iconUrl: null, subtask: false },
  updated: '2026-07-24T10:00:00.000+0900',
  created: '2026-07-01T10:00:00.000+0900',
  dueDate: null,
  parent: null,
  sprint: { name: '2026 3Q2', state: 'active' },
}

/** 그리드의 직계 자식 = 열 하나. */
function trackChildren(root: HTMLElement): HTMLElement[] {
  const grid = root.querySelector<HTMLElement>('.grid')
  if (!grid) throw new Error('그리드를 찾지 못했다')
  return [...grid.children] as HTMLElement[]
}

describe('헤더와 행의 글자 시작점', () => {
  const visible = TOGGLEABLE_COLUMNS.slice()

  it('헤더와 행의 열 개수가 같다', () => {
    const header = render(
      <ColumnHeader
        widths={DEFAULT_COLUMN_WIABCS}
        density="wide"
        visible={visible}
        onResize={() => {}}
      />,
    )
    const row = render(
      <IssueRow
        issue={issue}
        density="wide"
        widths={DEFAULT_COLUMN_WIABCS}
        visible={visible}
        now={Date.parse('2026-07-30T00:00:00+0900')}
        browseUrl={() => null}
        onOpen={() => {}}
      />,
    )
    expect(trackChildren(header.container)).toHaveLength(trackChildren(row.container).length)
  })

  it('헤더와 행이 같은 grid-template-columns를 쓴다', () => {
    const header = render(
      <ColumnHeader
        widths={DEFAULT_COLUMN_WIABCS}
        density="wide"
        visible={visible}
        onResize={() => {}}
      />,
    )
    const row = render(
      <IssueRow
        issue={issue}
        density="wide"
        widths={DEFAULT_COLUMN_WIABCS}
        visible={visible}
        now={Date.parse('2026-07-30T00:00:00+0900')}
        browseUrl={() => null}
        onOpen={() => {}}
      />,
    )
    const h = header.container.querySelector<HTMLElement>('.grid')?.style.gridTemplateColumns
    const r = row.container.querySelector<HTMLElement>('.grid')?.style.gridTemplateColumns
    expect(h).toBe(r)
  })

  it('헤더 셀이 트랙을 꽉 채운다 (w-full 없으면 가운데로 밀린다)', () => {
    const { container } = render(
      <ColumnHeader
        widths={DEFAULT_COLUMN_WIABCS}
        density="wide"
        visible={visible}
        onResize={() => {}}
      />,
    )
    for (const track of trackChildren(container)) {
      // 래퍼 안의 실제 라벨 span
      const label = track.querySelector<HTMLElement>('span')
      expect(label, '헤더 셀에 라벨이 없다').not.toBeNull()
      expect(label?.className, `헤더 셀이 트랙을 안 채운다: ${label?.className}`).toContain(
        'w-full',
      )
    }
  })

  it('행 셀도 트랙을 꽉 채운다 — 헤더만 채우면 반대로 어긋난다', () => {
    const { container } = render(
      <IssueRow
        issue={issue}
        density="wide"
        widths={DEFAULT_COLUMN_WIABCS}
        visible={visible}
        now={Date.parse('2026-07-30T00:00:00+0900')}
        browseUrl={() => null}
        onOpen={() => {}}
      />,
    )
    const offenders: string[] = []
    for (const track of trackChildren(container)) {
      // 래퍼(flex)가 아니라 그 안의 내용물이 트랙을 채워야 한다.
      const inner = track.matches('.flex') ? track.firstElementChild : track
      if (!inner) continue
      const cls = String(inner.className)
      // 아바타처럼 고정 크기가 의도인 요소는 제외
      if (cls.includes('size-5') || cls.includes('size-1.5')) continue
      if (!cls.includes('w-full') && !cls.includes('flex-1')) {
        offenders.push(`${inner.textContent?.slice(0, 8)} → ${cls.slice(0, 60)}`)
      }
    }
    expect(offenders, `트랙을 안 채우는 행 셀:\n${offenders.join('\n')}`).toHaveLength(0)
  })

  it('헤더와 행의 좌측 여백이 같다', () => {
    const header = render(
      <ColumnHeader
        widths={DEFAULT_COLUMN_WIABCS}
        density="wide"
        visible={visible}
        onResize={() => {}}
      />,
    )
    const row = render(
      <IssueRow
        issue={issue}
        density="wide"
        widths={DEFAULT_COLUMN_WIABCS}
        visible={visible}
        now={Date.parse('2026-07-30T00:00:00+0900')}
        browseUrl={() => null}
        onOpen={() => {}}
      />,
    )
    const pad = (el: Element | null) =>
      String(el?.className).match(/\bpl-\d+(\.\d+)?\b/)?.[0] ?? 'none'

    expect(pad(header.container.querySelector('.grid'))).toBe(
      pad(row.container.querySelector('.grid')),
    )
  })
})
