import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { JiraIssue } from '#/ipc/bindings'
import { DEFAULT_COLUMN_WIABCS, type ToggleableColumn } from '#/widgets/jira/columns'
import { IssueRow } from '#/widgets/jira/IssueRow'

const openUrl = vi.hoisted(() => vi.fn())
vi.mock('@tauri-apps/plugin-opener', () => ({ openUrl }))

/**
 * 행 클릭의 세 갈래를 고정한다 (D1).
 *
 *   행 클릭      → 상세 모달
 *   ⌘+행 클릭    → 브라우저
 *   키 링크 클릭 → 브라우저만 (모달이 같이 열리면 안 된다)
 *
 * 세 번째가 특히 중요하다. stopPropagation을 빠뜨리면 키를 눌렀을 때
 * 브라우저와 모달이 동시에 열린다.
 */

const issue: JiraIssue = {
  key: 'ABC-142',
  summary: '위젯 드래그 시 레이아웃 저장이 중복 호출됨',
  status: {
    name: '진행 중',
    statusCategory: { key: 'indeterminate', colorName: null, name: null },
  },
  assignee: null,
  priority: null,
  issueType: null,
  updated: '2026-07-29T14:03:11.482+0900',
  created: '2026-07-20T09:00:00.000+0900',
  dueDate: null,
  parent: null,
  sprint: null,
}

const visible: ToggleableColumn[] = ['key', 'status']

function renderRow(onOpen = vi.fn()) {
  render(
    <IssueRow
      issue={issue}
      density="wide"
      widths={DEFAULT_COLUMN_WIABCS}
      visible={visible}
      now={Date.parse('2026-07-30T00:00:00+0900')}
      browseUrl={(key) => `https://team.atlassian.net/browse/${key}`}
      onOpen={onOpen}
    />,
  )
  return onOpen
}

/** 행은 role="button"이다 — 안에 <a>가 있어 <button> 중첩이 불가능하다. */
function row() {
  return screen.getByRole('button', { name: /위젯 드래그/ })
}

describe('IssueRow', () => {
  beforeEach(() => {
    openUrl.mockClear()
  })

  it('행을 클릭하면 상세 모달을 요청한다', () => {
    const onOpen = renderRow()
    fireEvent.click(row())

    expect(onOpen).toHaveBeenCalledWith('ABC-142')
    expect(openUrl).not.toHaveBeenCalled()
  })

  it('⌘+클릭은 브라우저로 나가고 모달을 열지 않는다', () => {
    const onOpen = renderRow()
    fireEvent.click(row(), { metaKey: true })

    expect(openUrl).toHaveBeenCalledWith('https://team.atlassian.net/browse/ABC-142')
    expect(onOpen).not.toHaveBeenCalled()
  })

  it('키 링크를 클릭하면 브라우저만 열린다 (모달은 안 열린다)', () => {
    const onOpen = renderRow()
    // 링크는 행 안에 있다. stopPropagation이 없으면 행 클릭까지 번진다.
    fireEvent.click(screen.getByRole('link', { name: /ABC-142/ }))

    expect(openUrl).toHaveBeenCalledWith('https://team.atlassian.net/browse/ABC-142')
    expect(onOpen).not.toHaveBeenCalled()
  })

  it('Enter로도 상세를 연다', () => {
    const onOpen = renderRow()
    fireEvent.keyDown(row(), { key: 'Enter' })
    expect(onOpen).toHaveBeenCalledWith('ABC-142')
  })

  it('Space로도 상세를 연다', () => {
    const onOpen = renderRow()
    fireEvent.keyDown(row(), { key: ' ' })
    expect(onOpen).toHaveBeenCalledWith('ABC-142')
  })

  it('키보드로 도달할 수 있다', () => {
    renderRow()
    expect(row()).toHaveAttribute('tabIndex', '0')
  })
})
