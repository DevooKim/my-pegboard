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

describe('TodoRow 드래그', () => {
  const dragProps = (over: Partial<Record<string, unknown>> = {}) => ({
    onStart: vi.fn(),
    onOver: vi.fn(),
    onDrop: vi.fn(),
    onEnd: vi.fn(),
    dragging: false,
    over: null as 'above' | 'below' | null,
    ...over,
  })

  function renderDraggable(drag: ReturnType<typeof dragProps>) {
    render(
      <TodoRow
        item={item()}
        today="2026-08-01"
        onToggle={vi.fn()}
        onEdit={vi.fn()}
        onRemove={vi.fn()}
        drag={drag}
      />,
    )
    // biome-ignore lint/style/noNonNullAssertion: 방금 렌더한 li가 없을 수 없다
    return document.querySelector('li')!
  }

  it('drag prop이 있으면 끌 수 있다', () => {
    const li = renderDraggable(dragProps())
    expect(li.getAttribute('draggable')).toBe('true')
  })

  it('drag prop이 없으면 끌 수 없다', () => {
    render(
      <TodoRow
        item={item()}
        today="2026-08-01"
        onToggle={vi.fn()}
        onEdit={vi.fn()}
        onRemove={vi.fn()}
      />,
    )
    expect(document.querySelector('li')?.getAttribute('draggable')).toBe('false')
  })

  /** Firefox는 dataTransfer가 비면 드래그를 아예 시작하지 않는다. */
  it('dragStart에서 dataTransfer에 id를 넣는다', () => {
    const drag = dragProps()
    const li = renderDraggable(drag)
    const dataTransfer = { setData: vi.fn(), effectAllowed: '' }

    fireEvent.dragStart(li, { dataTransfer })

    expect(dataTransfer.setData).toHaveBeenCalledWith('text/plain', 'x')
    expect(drag.onStart).toHaveBeenCalled()
  })

  it('dragOver에서 onOver를 부른다', () => {
    const drag = dragProps()
    const li = renderDraggable(drag)
    fireEvent.dragOver(li, { dataTransfer: { dropEffect: '' } })
    expect(drag.onOver).toHaveBeenCalled()
  })

  it('drop에서 onDrop을 부른다', () => {
    const drag = dragProps()
    const li = renderDraggable(drag)
    fireEvent.drop(li, { dataTransfer: {} })
    expect(drag.onDrop).toHaveBeenCalled()
  })

  /**
   * 끌리는 동안 **자리를 비운다.** 흐리게만 하면 원본이 그대로 남아,
   * 커서를 따라다니는 OS 드래그 이미지와 겹쳐 같은 항목이 둘로 보인다.
   */
  it('끌리는 중에는 자리를 비운다', () => {
    const li = renderDraggable(dragProps({ dragging: true }))
    expect(li.className).toContain('h-0')
    expect(li.className).toContain('opacity-0')
  })

  it('끌지 않을 때는 정상 높이다', () => {
    const li = renderDraggable(dragProps())
    expect(li.className).not.toContain('h-0')
    expect(li.className).toContain('py-1')
  })

  /**
   * 표시선은 행의 border가 아니라 **경계에 띄운 별도 요소**다.
   * border로 그리면 py-1 안쪽에 붙어 텍스트에 닿고, 완료 구분선과
   * 위치가 겹쳐 어느 것이 드롭 표시인지 알 수 없다.
   */
  it('위로 끌면 대상 위 경계에 선을 띄운다', () => {
    const li = renderDraggable(dragProps({ over: 'above' }))
    const line = li.querySelector('[aria-hidden="true"].bg-accent')
    expect(line).not.toBeNull()
    expect(line?.className).toContain('-top-px')
  })

  /** 아래로 끌 때 선이 위에만 뜨면 한 칸 어긋나 보인다. */
  it('아래로 끌면 대상 아래 경계에 선을 띄운다', () => {
    const li = renderDraggable(dragProps({ over: 'below' }))
    const line = li.querySelector('[aria-hidden="true"].bg-accent')
    expect(line?.className).toContain('-bottom-px')
  })

  it('드롭 대상이 아니면 선이 없다', () => {
    const li = renderDraggable(dragProps())
    expect(li.querySelector('[aria-hidden="true"].bg-accent')).toBeNull()
  })

  /** 버튼은 WebKit에서 기본 draggable이라 행의 드래그를 가로챈다. */
  it('안쪽 버튼은 드래그를 삼키지 않는다', () => {
    renderDraggable(dragProps())
    const textButton = screen.getByText('배포 스크립트 정리')
    expect(textButton.getAttribute('draggable')).toBe('false')
  })

  /** 텍스트를 드래그로 선택하려는 동작과 행 이동이 충돌한다. */
  it('편집 중에는 끌 수 없다', () => {
    renderDraggable(dragProps())
    fireEvent.click(screen.getByText('배포 스크립트 정리'))
    expect(document.querySelector('li')?.getAttribute('draggable')).toBe('false')
  })
})
