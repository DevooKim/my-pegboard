import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { TodoItem } from '#/ipc/bindings'
import { TodoRow } from '#/widgets/todo/TodoRow'

function item(over: Partial<TodoItem> = {}): TodoItem {
  return {
    id: 'x',
    text: '배포 스크립트 정리',
    done: false,
    date: '2026-08-01',
    originDate: '2026-08-01',
    carriedCount: 0,
    ...over,
  }
}

function renderRow(over: Partial<TodoItem> = {}, handlers = {}) {
  const props = {
    onToggle: vi.fn(),
    onEdit: vi.fn(),
    onRemove: vi.fn(),
    ...handlers,
  }
  render(<TodoRow item={item(over)} today="2026-08-01" {...props} />)
  return props
}

describe('TodoRow', () => {
  it('체크하면 onToggle을 부른다', () => {
    const { onToggle } = renderRow()
    fireEvent.click(screen.getByRole('checkbox'))
    expect(onToggle).toHaveBeenCalledWith(true)
  })

  it('완료 항목은 취소선으로 그린다', () => {
    renderRow({ done: true })
    expect(screen.getByText('배포 스크립트 정리').className).toContain('line-through')
  })

  it('이월하지 않은 항목에는 배지가 없다', () => {
    renderRow({ carriedCount: 0 })
    expect(screen.queryByText(/일째/)).toBeNull()
  })

  /**
   * 배지 숫자는 경과일(originDate 기준)이지 이월 횟수가 아니다.
   * 금요일에 만들어 월요일에 이월되면 1회 이월이지만 3일째다.
   */
  it('배지는 이월 횟수가 아니라 경과일을 보여준다', () => {
    render(
      <TodoRow
        item={item({ originDate: '2026-07-31', carriedCount: 1 })}
        today="2026-08-03"
        onToggle={vi.fn()}
        onEdit={vi.fn()}
        onRemove={vi.fn()}
      />,
    )
    expect(screen.getByText('3일째')).toBeInTheDocument()
  })

  /** DECISIONS 13 — carriedCount >= 7이면 "이거 정말 할 건가요?" 힌트. */
  it('7번 이상 미룬 항목은 danger 색과 힌트 문구를 갖는다', () => {
    render(
      <TodoRow
        item={item({ originDate: '2026-07-25', carriedCount: 7 })}
        today="2026-08-01"
        onToggle={vi.fn()}
        onEdit={vi.fn()}
        onRemove={vi.fn()}
      />,
    )
    const badge = screen.getByText('7일째')
    expect(badge.className).toContain('text-danger')
    expect(badge.getAttribute('title')).toContain('이거 정말 할 건가요?')
  })

  it('6번까지는 danger가 아니다', () => {
    render(
      <TodoRow
        item={item({ originDate: '2026-07-26', carriedCount: 6 })}
        today="2026-08-01"
        onToggle={vi.fn()}
        onEdit={vi.fn()}
        onRemove={vi.fn()}
      />,
    )
    expect(screen.getByText('6일째').className).not.toContain('text-danger')
  })

  it('텍스트를 눌러 수정하고 Enter로 저장한다', () => {
    const { onEdit } = renderRow()
    fireEvent.click(screen.getByText('배포 스크립트 정리'))

    const input = screen.getByDisplayValue('배포 스크립트 정리')
    fireEvent.change(input, { target: { value: '고친 내용' } })
    fireEvent.keyDown(input, { key: 'Enter' })

    expect(onEdit).toHaveBeenCalledWith('고친 내용')
  })

  it('Escape로 수정을 취소하면 저장하지 않는다', () => {
    const { onEdit } = renderRow()
    fireEvent.click(screen.getByText('배포 스크립트 정리'))

    const input = screen.getByDisplayValue('배포 스크립트 정리')
    fireEvent.change(input, { target: { value: '버릴 내용' } })
    fireEvent.keyDown(input, { key: 'Escape' })

    expect(onEdit).not.toHaveBeenCalled()
    expect(screen.getByText('배포 스크립트 정리')).toBeInTheDocument()
  })

  /** 빈 텍스트로 항목을 지우는 경로를 만들지 않는다. 삭제는 명시적으로만. */
  it('빈 텍스트로 저장하지 않는다', () => {
    const { onEdit } = renderRow()
    fireEvent.click(screen.getByText('배포 스크립트 정리'))

    const input = screen.getByDisplayValue('배포 스크립트 정리')
    fireEvent.change(input, { target: { value: '   ' } })
    fireEvent.keyDown(input, { key: 'Enter' })

    expect(onEdit).not.toHaveBeenCalled()
  })

  it('삭제 버튼이 onRemove를 부른다', () => {
    const { onRemove } = renderRow()
    fireEvent.click(screen.getByRole('button', { name: /삭제/ }))
    expect(onRemove).toHaveBeenCalled()
  })
})
