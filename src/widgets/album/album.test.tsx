import { fireEvent, render, screen } from '@testing-library/react'
import { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { WidgetEnvelope } from '#/widgets/types'
import { advance, currentIndex, newPlayback, shuffled } from './shuffle'
import type { AlbumData } from './useAlbumData'

/**
 * `convertFileSrc`는 Tauri 런타임 함수다. jsdom에는 `__TAURI_INTERNALS__`가
 * 없어서 그냥 부르면 던진다. 테스트에서 확인하려는 것은 "어느 경로로 img를
 * 만들었나"이므로 경로를 그대로 돌려준다.
 */
vi.mock('@tauri-apps/api/core', () => ({
  convertFileSrc: (path: string) => `asset://localhost/${path}`,
}))

/** 빈 상태의 '폴더 선택' 버튼이 부르는 곳. 테스트에서는 누르지 않는다. */
vi.mock('#/ipc/bindings', () => ({
  commands: {
    albumPickFolder: vi.fn(),
    albumPickFiles: vi.fn(),
  },
}))

vi.mock('#/store/board', () => ({
  useBoardStore: () => vi.fn(),
}))

// View는 위 mock에 의존하므로 mock 선언 뒤에 가져온다.
const { AlbumView, __resetPlaybacks } = await import('./View')
const { AlbumConfigForm } = await import('./ConfigForm')
const { albumWidget, sourceLabel } = await import('./index')

// ─────────────────────────────── 셔플 ───────────────────────────────

describe('shuffled', () => {
  it('원본을 바꾸지 않는다', () => {
    const original = [1, 2, 3, 4, 5]
    shuffled(original)
    expect(original).toEqual([1, 2, 3, 4, 5])
  })

  it('같은 원소를 모두 그대로 갖는다', () => {
    const out = shuffled([1, 2, 3, 4, 5])
    expect([...out].sort()).toEqual([1, 2, 3, 4, 5])
  })
})

describe('재생 순서', () => {
  /**
   * **이 테스트가 셔플 설계의 핵심이다.**
   *
   * 매번 독립 무작위 추출이면 같은 사진이 연달아 나오고, 사용자에게는
   * "안 바뀌었다 = 고장났다"로 읽힌다. 전체를 다 돌기 전에는 같은 사진이
   * 두 번 나오지 않아야 한다.
   */
  it('한 바퀴 안에서 모든 사진을 정확히 한 번씩 보여준다', () => {
    const count = 7
    let playback = newPlayback(count)

    const seen = [currentIndex(playback)]
    for (let i = 1; i < count; i++) {
      playback = advance(playback, count)
      seen.push(currentIndex(playback))
    }

    expect(seen).toHaveLength(count)
    expect(new Set(seen).size).toBe(count)
    expect([...seen].sort((a, b) => (a ?? 0) - (b ?? 0))).toEqual([0, 1, 2, 3, 4, 5, 6])
  })

  it('끝에 닿으면 다시 섞어 처음으로 돌아간다', () => {
    const count = 4
    let playback = newPlayback(count)
    for (let i = 0; i < count - 1; i++) playback = advance(playback, count)
    expect(playback.cursor).toBe(count - 1)

    // 한 바퀴를 다 돌았다. 다음은 새 순서의 첫 장.
    playback = advance(playback, count)
    expect(playback.cursor).toBe(0)
    expect(playback.order).toHaveLength(count)
  })

  /**
   * 같은 순서를 반복하면 두 바퀴째부터 "다음에 뭐 나올지 아는" 상태가 된다.
   * `rng`를 주입해 두 바퀴의 순서가 실제로 다른지 본다.
   */
  it('두 번째 바퀴는 첫 바퀴와 다른 순서다', () => {
    // 첫 바퀴는 항등 순서(0.99 → 자기 자신과 swap), 두 번째 바퀴는 뒤집힌다
    // (0 → 항상 0번과 swap). 결정적이라 flaky하지 않다.
    const count = 5
    const swapsPerShuffle = count - 1
    let calls = 0
    const rng = () => {
      calls += 1
      return calls <= swapsPerShuffle ? 0.99 : 0
    }

    let playback = newPlayback(count, rng)
    const first = [...playback.order]
    expect(first).toEqual([0, 1, 2, 3, 4])

    for (let i = 0; i < count; i++) playback = advance(playback, count, rng)

    expect(playback.order).not.toEqual(first)
    // 원소는 그대로여야 한다 — 순서만 바뀐다.
    expect([...playback.order].sort((a, b) => a - b)).toEqual([0, 1, 2, 3, 4])
  })

  it('사진 개수가 바뀌면 순서를 새로 만든다', () => {
    // 재스캔으로 사진이 늘었다. 낡은 order를 그대로 쓰면 인덱스가 범위를 벗어난다.
    const playback = { order: [0, 1, 2], cursor: 1 }
    const next = advance(playback, 10)
    expect(next.order).toHaveLength(10)
    expect(next.cursor).toBe(0)
  })

  it('사진이 없으면 빈 순서를 돌려준다', () => {
    expect(currentIndex(newPlayback(0))).toBeNull()
    expect(advance({ order: [0], cursor: 0 }, 0)).toEqual({ order: [], cursor: 0 })
  })
})

// ─────────────────────────── 제목 파생 ───────────────────────────

describe('sourceLabel', () => {
  it('새 앨범은 호버할 때 헤더를 표시한다', () => {
    expect(albumWidget.defaultConfig.headerMode).toBe('hover')
  })

  it('폴더는 마지막 조각만 쓴다', () => {
    // 전체 경로를 헤더에 넣으면 잘려서 `/Users/me/…`만 보인다.
    expect(sourceLabel({ kind: 'folder', path: '/Users/me/Pictures/여행' })).toBe('여행')
    expect(sourceLabel({ kind: 'folder', path: '/Users/me/Pictures/여행/' })).toBe('여행')
  })

  it('사진 한 장이면 파일명, 여러 장이면 개수를 쓴다', () => {
    expect(sourceLabel({ kind: 'files', paths: ['/p/sunset.jpg'] })).toBe('sunset.jpg')
    expect(sourceLabel({ kind: 'files', paths: ['/p/a.jpg', '/p/b.jpg'] })).toBe('사진 2장')
  })

  it('아직 안 골랐으면 null', () => {
    expect(sourceLabel(null)).toBeNull()
  })
})

describe('AlbumConfigForm', () => {
  it('헤더를 항상 표시하도록 바꿀 수 있다', () => {
    const onChange = vi.fn()
    render(<AlbumConfigForm config={config({ headerMode: 'hover' })} onChange={onChange} />)

    fireEvent.click(screen.getByRole('checkbox', { name: '헤더 항상 표시' }))
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ headerMode: 'always' }))
  })
})

// ─────────────────────────── View 동작 ───────────────────────────

function config(over: Partial<Parameters<typeof AlbumView>[0]['config']> = {}) {
  return {
    title: null,
    source: { kind: 'folder' as const, path: '/p' },
    intervalSecs: 10,
    ...over,
  }
}

function ready(paths: string[], skipped = 0): WidgetEnvelope<AlbumData> {
  return {
    status: 'ready',
    data: { photos: paths.map((path) => ({ path })), skipped },
    fetchedAt: '2026-08-06T00:00:00Z',
    error: null,
  }
}

function renderView(paths: string[], over: Partial<ReturnType<typeof config>> = {}, skipped = 0) {
  return render(
    <AlbumView widgetId="a1" config={config(over)} envelope={ready(paths, skipped)} width={400} />,
  )
}

/** `matchMedia`를 세운다. jsdom에는 없다. */
function setReducedMotion(reduce: boolean) {
  window.matchMedia = vi.fn().mockImplementation((query: string) => ({
    matches: reduce && query.includes('prefers-reduced-motion'),
    media: query,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    addListener: vi.fn(),
    removeListener: vi.fn(),
    dispatchEvent: vi.fn(),
    onchange: null,
  })) as unknown as typeof window.matchMedia
}

describe('AlbumView', () => {
  beforeEach(() => {
    setReducedMotion(false)
    // 재생 상태는 탭을 오가도 유지되도록 모듈 스코프에 남는다.
    // 테스트 사이에는 비워야 앞 테스트의 위치가 새어들지 않는다.
    __resetPlaybacks()
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('사진 한 장을 asset: URL로 그린다', () => {
    renderView(['/p/a.jpg'])
    const img = screen.getByRole('presentation', { hidden: true }) as HTMLImageElement
    expect(img.src).toContain('/p/a.jpg')
    // cover가 아니면 여백이 생겨 배경 역할을 못 한다.
    expect(img.className).toContain('object-cover')
  })

  it('누르면 다음 장으로 넘어간다', () => {
    renderView(['/p/a.jpg', '/p/b.jpg', '/p/c.jpg'])
    const first = (screen.getByRole('presentation', { hidden: true }) as HTMLImageElement).src

    fireEvent.click(screen.getByRole('button', { name: '다음 사진' }))

    const second = (screen.getByRole('presentation', { hidden: true }) as HTMLImageElement).src
    expect(second).not.toBe(first)
  })

  it('사진이 한 장이면 넘길 곳이 없으므로 버튼을 잠근다', () => {
    renderView(['/p/only.jpg'])
    expect(screen.getByRole('button', { name: '다음 사진' })).toBeDisabled()
  })

  it('주기가 지나면 자동으로 다음 장으로 넘어간다', () => {
    renderView(['/p/a.jpg', '/p/b.jpg', '/p/c.jpg'], { intervalSecs: 10 })
    const first = (screen.getByRole('presentation', { hidden: true }) as HTMLImageElement).src

    act(() => {
      vi.advanceTimersByTime(10_000)
    })

    const second = (screen.getByRole('presentation', { hidden: true }) as HTMLImageElement).src
    expect(second).not.toBe(first)
  })

  /** web 위젯의 `refreshSecs: 0`과 같은 관례. */
  it('주기가 0이면 자동으로 넘기지 않는다', () => {
    renderView(['/p/a.jpg', '/p/b.jpg', '/p/c.jpg'], { intervalSecs: 0 })
    const first = (screen.getByRole('presentation', { hidden: true }) as HTMLImageElement).src

    act(() => {
      vi.advanceTimersByTime(120_000)
    })

    expect((screen.getByRole('presentation', { hidden: true }) as HTMLImageElement).src).toBe(first)
  })

  /**
   * **동작 줄이기 설정에서 10초마다 사진이 바뀌면 그 설정을 무시하는 것이다.**
   * 페이드만 끄는 것으로는 부족하다 — 화면이 바뀌는 것 자체가 움직임이다.
   */
  it('prefers-reduced-motion이면 자동 순환을 멈춘다', () => {
    setReducedMotion(true)
    renderView(['/p/a.jpg', '/p/b.jpg', '/p/c.jpg'], { intervalSecs: 10 })
    const first = (screen.getByRole('presentation', { hidden: true }) as HTMLImageElement).src

    act(() => {
      vi.advanceTimersByTime(300_000)
    })

    expect((screen.getByRole('presentation', { hidden: true }) as HTMLImageElement).src).toBe(first)
  })

  it('prefers-reduced-motion이면 페이드 애니메이션도 걸지 않는다', () => {
    setReducedMotion(true)
    renderView(['/p/a.jpg'])
    const img = screen.getByRole('presentation', { hidden: true }) as HTMLImageElement
    expect(img.style.animation).toBe('')
  })

  it('reduced-motion이어도 누르면 넘어간다', () => {
    // 자동 순환만 멈춘다. 사용자가 직접 누른 것은 사용자의 뜻이다.
    setReducedMotion(true)
    renderView(['/p/a.jpg', '/p/b.jpg', '/p/c.jpg'])
    const first = (screen.getByRole('presentation', { hidden: true }) as HTMLImageElement).src

    fireEvent.click(screen.getByRole('button', { name: '다음 사진' }))

    expect((screen.getByRole('presentation', { hidden: true }) as HTMLImageElement).src).not.toBe(
      first,
    )
  })

  // ───────────────────── 실패 처리 ─────────────────────

  /**
   * 깨진 장은 **즉시 다음 장으로 넘기고**, 건너뛴 사실을 화면에 적는다.
   * 조용히 묻으면 사용자는 사진 몇 장이 없어진 것을 모른다.
   */
  it('깨진 사진을 만나면 다음 장으로 넘기고 개수를 표시한다', () => {
    renderView(['/p/a.jpg', '/p/b.jpg', '/p/c.jpg'])
    const img = screen.getByRole('presentation', { hidden: true }) as HTMLImageElement
    const brokenSrc = img.src

    fireEvent.error(img)

    // 다음 장으로 넘어갔다.
    expect((screen.getByRole('presentation', { hidden: true }) as HTMLImageElement).src).not.toBe(
      brokenSrc,
    )
    // 그리고 건너뛴 사실이 화면에 있다.
    expect(screen.getByText(/1장을 표시할 수 없습니다/)).toBeInTheDocument()
  })

  it('여러 장이 깨지면 개수가 쌓인다', () => {
    renderView(['/p/a.jpg', '/p/b.jpg', '/p/c.jpg'])

    fireEvent.error(screen.getByRole('presentation', { hidden: true }))
    fireEvent.error(screen.getByRole('presentation', { hidden: true }))

    expect(screen.getByText(/2장을 표시할 수 없습니다/)).toBeInTheDocument()
  })

  /**
   * 보드 탭을 오가면 이 View는 언마운트·리마운트된다(비활성 보드를 렌더하지
   * 않는 것이 폴링을 멈추는 방식이다). 그때 새로 섞으면 방금 보던 사진이
   * 다른 사진으로 바뀐다 — 돌아왔을 때 화면이 튀는 것으로 보인다.
   */
  it('탭을 오가도 같은 사진에서 이어진다', () => {
    const paths = ['/p/a.jpg', '/p/b.jpg', '/p/c.jpg', '/p/d.jpg', '/p/e.jpg']
    const first = renderView(paths)
    const before = screen.getByRole('presentation', { hidden: true }).getAttribute('src')

    // 탭을 떠났다가 돌아온다.
    first.unmount()
    renderView(paths)

    const after = screen.getByRole('presentation', { hidden: true }).getAttribute('src')
    expect(after).toBe(before)
  })

  /** 사진이 추가·삭제되면 순서를 새로 만드는 것이 맞다. */
  it('사진 목록이 바뀌면 순서를 새로 만든다', () => {
    const first = renderView(['/p/a.jpg', '/p/b.jpg'])
    first.unmount()

    // 장수가 달라졌다 = 재스캔에서 목록이 바뀌었다.
    renderView(['/p/a.jpg', '/p/b.jpg', '/p/c.jpg'])
    expect(screen.getByRole('presentation', { hidden: true })).toBeInTheDocument()
  })

  /** 같은 장에서 onError가 두 번 와도 두 장으로 세지 않는다. */
  it('같은 사진의 반복된 실패를 중복으로 세지 않는다', () => {
    renderView(['/p/a.jpg'])
    const img = screen.getByRole('presentation', { hidden: true })

    fireEvent.error(img)
    fireEvent.error(img)

    // 한 장뿐이라 전부 깨진 상태 화면으로 넘어간다.
    expect(screen.getByText(/1장을 모두 표시할 수 없습니다/)).toBeInTheDocument()
  })

  it('전부 깨지면 경로와 함께 에러 화면을 보여준다', () => {
    renderView(['/p/a.jpg'], { source: { kind: 'folder', path: '/Volumes/NAS/사진' } })

    fireEvent.error(screen.getByRole('presentation', { hidden: true }))

    // 어느 폴더가 문제인지 모르면 고칠 수 없다.
    expect(screen.getByText(/\/Volumes\/NAS\/사진/)).toBeInTheDocument()
  })

  /** 1000장 상한을 조용히 넘기지 않는다. */
  it('상한을 넘긴 장수를 화면에 적는다', () => {
    renderView(['/p/a.jpg', '/p/b.jpg'], {}, 42)
    expect(screen.getByText(/42장은 표시하지 않음/)).toBeInTheDocument()
  })

  it('버릴 것도 깨진 것도 없으면 알림 줄이 없다', () => {
    renderView(['/p/a.jpg', '/p/b.jpg'])
    expect(screen.queryByText(/표시하지 않음/)).toBeNull()
    expect(screen.queryByText(/표시할 수 없습니다/)).toBeNull()
  })

  // ───────────────────── 빈 상태 ─────────────────────

  it('소스가 없으면 폴더 선택 버튼을 바로 보여준다', () => {
    // 설정창을 열게 만들면 한 단계가 더 붙는다.
    render(
      <AlbumView
        widgetId="a1"
        config={config({ source: null })}
        envelope={{ status: 'empty', data: null, fetchedAt: null, error: null }}
        width={400}
      />,
    )
    expect(screen.getByRole('button', { name: '폴더 선택' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '사진 선택' })).toBeInTheDocument()
  })

  it('영구 실패는 Rust가 준 메시지를 그대로 보여준다', () => {
    // 메시지를 다시 쓰면 나빠지기만 한다 — 경로가 거기 들어 있다.
    render(
      <AlbumView
        widgetId="a1"
        config={config()}
        envelope={{
          status: 'error-permanent',
          data: null,
          fetchedAt: null,
          error: {
            status: 'error-permanent',
            message: '폴더를 찾을 수 없습니다: /Volumes/NAS/사진',
          },
        }}
        width={400}
      />,
    )
    expect(screen.getByText(/\/Volumes\/NAS\/사진/)).toBeInTheDocument()
  })

  /** 캐시된 사진이 있으면 실패 중에도 목록을 비우지 않는다. */
  it('실패해도 직전 사진이 있으면 계속 보여준다', () => {
    render(
      <AlbumView
        widgetId="a1"
        config={config()}
        envelope={{
          status: 'error-permanent',
          data: { photos: [{ path: '/p/cached.jpg' }], skipped: 0 },
          fetchedAt: '2026-08-06T00:00:00Z',
          error: { status: 'error-permanent', message: '폴더를 찾을 수 없습니다: /p' },
        }}
        width={400}
      />,
    )
    const img = screen.getByRole('presentation', { hidden: true }) as HTMLImageElement
    expect(img.src).toContain('/p/cached.jpg')
  })

  it('폭이 좁으면 장수 표시를 그리지 않는다', () => {
    // 240px 미만에서는 표시가 사진을 잡아먹는다.
    render(
      <AlbumView
        widgetId="a1"
        config={config()}
        envelope={ready(['/p/a.jpg', '/p/b.jpg'])}
        width={200}
      />,
    )
    expect(screen.queryByText('1 / 2')).toBeNull()
  })
})
