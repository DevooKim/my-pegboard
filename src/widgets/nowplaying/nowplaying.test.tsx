import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { NowPlayingState } from '#/ipc/bindings'
import type { WidgetEnvelope } from '#/widgets/types'
import { envelopeFrom, estimateElapsedSecs, formatTime, mergeArtwork } from './state'

/** View가 부르는 커맨드. 렌더 테스트에서는 누르지 않는다. */
vi.mock('#/ipc/bindings', () => ({
  commands: {
    nowplayingSend: vi.fn(),
    nowplayingOpenApp: vi.fn(),
  },
}))

const { NowPlayingView } = await import('./View')
const { nowPlayingWidget } = await import('./index')

function state(overrides: Partial<NowPlayingState> = {}): NowPlayingState {
  return {
    bundleId: 'com.spotify.client',
    title: '곡 제목',
    artist: '아티스트',
    album: '앨범',
    playing: true,
    durationSecs: 200,
    elapsedSecs: 50,
    sampledAtMs: 1_000_000,
    playbackRate: 1,
    artwork: null,
    artworkToken: null,
    ...overrides,
  }
}

// ───────────────────────────── 봉투 변환 ─────────────────────────────

describe('envelopeFrom', () => {
  it('error가 있으면 error-permanent — 어댑터 실패는 화면에 드러나야 한다', () => {
    const env = envelopeFrom({ state: null, error: '어댑터가 죽었다' }, null)
    expect(env.status).toBe('error-permanent')
    expect(env.error?.message).toBe('어댑터가 죽었다')
  })

  it('state가 없으면 empty — 재생 없음은 에러가 아니다', () => {
    const env = envelopeFrom({ state: null, error: null }, null)
    expect(env.status).toBe('empty')
    expect(env.error).toBeNull()
  })

  it('state가 있으면 ready', () => {
    const env = envelopeFrom({ state: state(), error: null }, null)
    expect(env.status).toBe('ready')
    expect(env.data?.title).toBe('곡 제목')
  })
})

// ───────────────────────────── 앨범아트 병합 ─────────────────────────────

describe('mergeArtwork', () => {
  const art = 'data:image/jpeg;base64,AAA'

  it('토큰이 같고 artwork가 비어 오면 직전 아트를 이어받는다', () => {
    // Rust는 같은 아트를 반복 전송하지 않는다. 이 병합이 빠지면
    // 타임라인 갱신(수 초 간격)마다 아트가 깜빡 사라진다.
    const prev = state({ artwork: art, artworkToken: 7 })
    const next = state({ artwork: null, artworkToken: 7, elapsedSecs: 60 })
    expect(mergeArtwork(prev, next)?.artwork).toBe(art)
  })

  it('토큰이 다르면 이어받지 않는다 — 다른 곡의 아트를 그리면 안 된다', () => {
    const prev = state({ artwork: art, artworkToken: 7 })
    const next = state({ artwork: null, artworkToken: 8 })
    expect(mergeArtwork(prev, next)?.artwork).toBeNull()
  })

  it('새 아트가 실려 오면 그것을 쓴다', () => {
    const prev = state({ artwork: art, artworkToken: 7 })
    const next = state({ artwork: 'data:image/png;base64,BBB', artworkToken: 8 })
    expect(mergeArtwork(prev, next)?.artwork).toBe('data:image/png;base64,BBB')
  })

  it('토큰이 없으면(아트 없는 곡) null 그대로', () => {
    const prev = state({ artwork: art, artworkToken: 7 })
    const next = state({ artwork: null, artworkToken: null })
    expect(mergeArtwork(prev, next)?.artwork).toBeNull()
  })
})

// ───────────────────────────── 재생 위치 보간 ─────────────────────────────

describe('estimateElapsedSecs', () => {
  it('재생 중이면 샘플 시각 이후 흐른 시간을 더한다', () => {
    const s = state({ elapsedSecs: 50, sampledAtMs: 1_000_000, playing: true })
    expect(estimateElapsedSecs(s, 1_010_000)).toBe(60) // 10초 뒤
  })

  it('일시정지면 시간이 흐르지 않는다', () => {
    const s = state({ playing: false, elapsedSecs: 50 })
    expect(estimateElapsedSecs(s, 9_999_999_999)).toBe(50)
  })

  it('배속을 반영한다', () => {
    const s = state({ elapsedSecs: 50, sampledAtMs: 1_000_000, playing: true, playbackRate: 2 })
    expect(estimateElapsedSecs(s, 1_010_000)).toBe(70)
  })

  it('duration을 넘지 않는다 — "3:31 / 3:30"은 말이 안 된다', () => {
    const s = state({ elapsedSecs: 195, sampledAtMs: 1_000_000, playing: true, durationSecs: 200 })
    expect(estimateElapsedSecs(s, 1_060_000)).toBe(200)
  })

  it('elapsed가 없으면 null', () => {
    expect(estimateElapsedSecs(state({ elapsedSecs: null }), 0)).toBeNull()
  })
})

describe('formatTime', () => {
  it('분:초', () => {
    expect(formatTime(0)).toBe('0:00')
    expect(formatTime(65)).toBe('1:05')
    expect(formatTime(200)).toBe('3:20')
  })

  it('한 시간이 넘으면 시:분:초', () => {
    expect(formatTime(3661)).toBe('1:01:01')
  })
})

// ───────────────────────────── View 렌더 ─────────────────────────────

function env(overrides: Partial<WidgetEnvelope<NowPlayingState>>): WidgetEnvelope<NowPlayingState> {
  return { status: 'ready', data: null, fetchedAt: null, error: null, ...overrides }
}

function renderView(envelope: WidgetEnvelope<NowPlayingState>, width = 400) {
  return render(
    <NowPlayingView widgetId="w1" config={{ title: null }} envelope={envelope} width={width} />,
  )
}

describe('NowPlayingView', () => {
  it('빈 상태 — 무엇을 하면 표시되는지 적는다', () => {
    renderView(env({ status: 'empty' }))
    expect(screen.getByText('재생 중인 미디어가 없습니다')).toBeInTheDocument()
    expect(screen.getByText(/재생을 시작하면/)).toBeInTheDocument()
  })

  it('에러 상태 — 메시지와 복구 경로(새로고침)를 함께 적는다', () => {
    renderView(
      env({
        status: 'error-permanent',
        error: { status: 'error-permanent', message: '접근이 막혔습니다' },
      }),
    )
    expect(screen.getByText('접근이 막혔습니다')).toBeInTheDocument()
    expect(screen.getByText(/새로고침/)).toBeInTheDocument()
  })

  it('재생 상태 — 곡명·부제·제어 3종이 그려진다', () => {
    renderView(env({ data: state() }))
    expect(screen.getByText('곡 제목')).toBeInTheDocument()
    expect(screen.getByText('아티스트 · 앨범')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '이전 곡' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '일시정지' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '다음 곡' })).toBeInTheDocument()
    expect(screen.getByRole('progressbar', { name: '재생 위치' })).toBeInTheDocument()
  })

  it('일시정지 중이면 재생 버튼이 뜬다', () => {
    renderView(env({ data: state({ playing: false }) }))
    expect(screen.getByRole('button', { name: '재생' })).toBeInTheDocument()
  })

  it('duration이 없으면(라이브 등) 진행바를 그리지 않는다', () => {
    renderView(env({ data: state({ durationSecs: null }) }))
    expect(screen.queryByRole('progressbar')).not.toBeInTheDocument()
  })

  it('좁은 폭에서는 앨범명을 줄인다', () => {
    renderView(env({ data: state() }), 300)
    expect(screen.getByText('아티스트')).toBeInTheDocument()
    expect(screen.queryByText('아티스트 · 앨범')).not.toBeInTheDocument()
  })
})

describe('nowPlayingWidget 정의', () => {
  it('maxInstances가 Rust instance_limit(1)과 같아야 한다', () => {
    // 어긋나면 프론트에서는 추가되는데 board_save가 거부한다.
    expect(nowPlayingWidget.maxInstances).toBe(1)
  })

  it('타입 문자열이 Rust as_str과 같아야 한다', () => {
    expect(nowPlayingWidget.type).toBe('nowplaying')
  })

  it('제목: 비우면 기본, 채우면 그 값', () => {
    expect(nowPlayingWidget.deriveTitle({ title: null })).toBe('지금 재생 중')
    expect(nowPlayingWidget.deriveTitle({ title: ' 음악 ' })).toBe('음악')
  })
})
