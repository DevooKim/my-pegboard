import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { Modal } from '#/ui/Modal'

/**
 * 모달을 연 요소의 포커스 처리.
 *
 * 목록 행은 `focus-visible`로 링을 그린다 — 마우스 클릭에는 안 뜨고 키보드
 * 이동에만 뜨게 하려는 것이다. 그런데 모달을 열어도 포커스가 그 행에 **남아
 * 있으면**, ESC를 누르는 순간 브라우저의 :focus-visible 판정이 "키보드 사용 중"
 * 으로 뒤집혀 모달을 닫자마자 행에 링이 뜬다. 마우스로 열었는데 키보드 표시가
 * 나오는 셈이라 어색하다.
 */
describe('Modal 포커스', () => {
  it('열릴 때 연 요소의 포커스를 걷어낸다', () => {
    // 실제 순서를 그대로 재현한다: 행에 포커스가 있는 상태에서 모달이 열린다.
    function Harness({ open }: { open: boolean }) {
      return (
        <>
          <button type="button" data-testid="row">
            행
          </button>
          <Modal open={open} onClose={vi.fn()} labelledBy="t">
            <h2 id="t">내용</h2>
          </Modal>
        </>
      )
    }

    const { rerender } = render(<Harness open={false} />)
    const row = screen.getByTestId('row')
    row.focus()
    expect(document.activeElement, '전제: 행이 포커스를 갖는다').toBe(row)

    rerender(<Harness open />)

    // 포커스가 남아 있으면 ESC를 누르는 순간 행에 링이 뜬다.
    expect(document.activeElement).not.toBe(row)
  })

  it('ESC로 onClose를 부른다', () => {
    const onClose = vi.fn()
    render(
      <Modal open onClose={onClose} labelledBy="t">
        <h2 id="t">내용</h2>
      </Modal>,
    )

    fireEvent.keyDown(document, { key: 'Escape' })
    expect(onClose).toHaveBeenCalled()
  })

  it('닫혀 있으면 아무것도 그리지 않는다', () => {
    const { container } = render(
      <Modal open={false} onClose={vi.fn()} labelledBy="t">
        <h2 id="t">내용</h2>
      </Modal>,
    )
    expect(container).toBeEmptyDOMElement()
    expect(screen.queryByText('내용')).toBeNull()
  })
})
