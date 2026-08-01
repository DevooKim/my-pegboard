import { fireEvent, render, screen, waitFor } from '@testing-library/react'
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

  /**
   * 행 전체가 draggable이면 텍스트를 집으려다 행이 딸려오고, 체크박스를
   * 누르려다 드래그가 걸린다. 손잡이를 눌러야 켜진다.
   */
  it('손잡이를 누르기 전에는 끌 수 없다', () => {
    const li = renderDraggable(dragProps())
    expect(li.getAttribute('draggable')).toBe('false')
  })

  it('손잡이를 누르면 끌 수 있게 된다', () => {
    const li = renderDraggable(dragProps())
    fireEvent.pointerDown(screen.getByTitle('끌어서 순서 변경'))
    expect(li.getAttribute('draggable')).toBe('true')
  })

  /** 끌지 않고 손을 떼면 원래대로 — 안 그러면 다음에 텍스트를 집을 때 딸려온다. */
  it('손을 떼면 다시 끌 수 없다', () => {
    const li = renderDraggable(dragProps())
    const handle = screen.getByTitle('끌어서 순서 변경')
    fireEvent.pointerDown(handle)
    fireEvent.pointerUp(handle)
    expect(li.getAttribute('draggable')).toBe('false')
  })

  /**
   * **회귀 방지.** 드래그는 손잡이 밖(다른 행 위)에서 끝난다. 손잡이의
   * onPointerUp만 듣고 있으면 그 이벤트를 못 받아 grabbed가 켜진 채로 남고,
   * 다음 드래그가 안 걸린다 — 한 번 클릭해야 풀리는 증상이었다.
   */
  it('손잡이 밖에서 놓아도 해제된다', () => {
    const li = renderDraggable(dragProps())
    fireEvent.pointerDown(screen.getByTitle('끌어서 순서 변경'))
    expect(li.getAttribute('draggable')).toBe('true')

    // 손잡이가 아니라 문서에서 놓는다.
    fireEvent.pointerUp(document)
    expect(li.getAttribute('draggable')).toBe('false')
  })

  it('드래그가 끝나면 해제된다', () => {
    const li = renderDraggable(dragProps())
    fireEvent.pointerDown(screen.getByTitle('끌어서 순서 변경'))
    fireEvent.dragEnd(document)
    expect(li.getAttribute('draggable')).toBe('false')
  })

  it('drag prop이 없으면 손잡이도 없다', () => {
    render(
      <TodoRow
        item={item()}
        today="2026-08-01"
        onToggle={vi.fn()}
        onEdit={vi.fn()}
        onRemove={vi.fn()}
      />,
    )
    expect(screen.queryByTitle('끌어서 순서 변경')).toBeNull()
  })

  /** Firefox는 dataTransfer가 비면 드래그를 아예 시작하지 않는다. */
  it('dragStart에서 dataTransfer에 id를 넣는다', () => {
    const drag = dragProps()
    const li = renderDraggable(drag)
    const dataTransfer = { setData: vi.fn(), effectAllowed: '' }

    fireEvent.dragStart(li, { dataTransfer })

    expect(dataTransfer.setData).toHaveBeenCalledWith('text/plain', 'x')
  })

  /**
   * 접는 것은 **다음 프레임**이어야 한다.
   *
   * 브라우저는 dragstart 직후 소스 요소를 캡처해 드래그 이미지를 만든다.
   * 그 자리에서 h-0으로 접으면 캡처할 것이 사라져 드래그가 취소된다 —
   * 포인터만 잠깐 뜨고 끝난다(실측).
   */
  it('모양 변경을 한 프레임 미룬다', async () => {
    const drag = dragProps()
    const li = renderDraggable(drag)

    fireEvent.dragStart(li, { dataTransfer: { setData: vi.fn(), effectAllowed: '' } })
    expect(
      drag.onStart,
      'dragstart 그 자리에서 모양을 바꾸면 캡처가 어긋난다',
    ).not.toHaveBeenCalled()

    await waitFor(() => expect(drag.onStart).toHaveBeenCalled())
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
   * 끌리는 동안 **자리는 지킨다.** 접어서 없애면(h-0) 돌아올 자리가 사라져
   * 제자리로 되돌릴 수가 없다 — 실제로 그렇게 만들었다가 되돌렸다.
   */
  it('끌리는 중에도 자리를 지킨다', () => {
    const li = renderDraggable(dragProps({ dragging: true }))
    expect(li.className).not.toContain('h-0')
    expect(li.className).toContain('py-1')
  })

  it('끌리는 중에는 빈 홈처럼 보인다', () => {
    const li = renderDraggable(dragProps({ dragging: true }))
    expect(li.className).toContain('opacity-25')
    expect(li.className).toContain('bg-surface-inset')
  })

  /** 자리를 지켜야 제자리 드롭이 가능하다 — pointer-events를 죽이면 안 된다. */
  it('끌리는 중에도 드롭을 받을 수 있다', () => {
    const li = renderDraggable(dragProps({ dragging: true }))
    expect(li.className).not.toContain('pointer-events-none')
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

  /** 텍스트를 드래그로 선택하려는 동작과 행 이동이 충돌한다. */
  /**
   * 손잡이를 잡은 상태에서 편집으로 들어가도 끌 수 없어야 한다.
   * (손잡이를 안 잡으면 애초에 false라, 잡은 상태에서 확인해야 의미가 있다.)
   */
  it('편집 중에는 손잡이를 잡아도 끌 수 없다', () => {
    const li = renderDraggable(dragProps())
    fireEvent.pointerDown(screen.getByTitle('끌어서 순서 변경'))
    expect(li.getAttribute('draggable')).toBe('true')

    fireEvent.click(screen.getByText('배포 스크립트 정리'))
    expect(li.getAttribute('draggable')).toBe('false')
  })
})
