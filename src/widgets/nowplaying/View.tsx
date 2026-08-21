import { Music, Pause, Play, SkipBack, SkipForward, VolumeX } from 'lucide-react'
import { useEffect, useState } from 'react'
import { commands, type NowPlayingCommand, type NowPlayingState } from '#/ipc/bindings'
import type { WidgetViewProps } from '#/widgets/types'
import type { NowPlayingWidgetConfig } from './index'
import { estimateElapsedSecs, formatTime } from './state'

/**
 * "지금 재생 중" 본문.
 *
 * ## 그리는 것
 *
 * 앨범아트 · 곡명 · 아티스트/앨범 · 진행바(보기 전용) · 제어 3종(이전/재생·일시정지/다음).
 * 셔플·반복·탐색은 일부러 없다 — 상태를 신뢰성 있게 못 읽는 토글은 거짓말을
 * 한다 (DECISIONS 27).
 *
 * ## 진행바가 스스로 흐른다
 *
 * 어댑터는 초마다 push하지 않는다(실측: 수 초 간격). `elapsedSecs`+`sampledAtMs`로
 * 여기서 보간한다 — 재생 중일 때만 0.5초 타이머를 돌리고, 일시정지면 멈춘다.
 *
 * ## 앨범아트/곡명 클릭 = 재생 중인 앱 열기
 *
 * "더 보고 싶으면 원본 앱으로"라는 GitHub 위젯과 같은 패턴. 제어 버튼과
 * 겹치지 않게 버튼 영역은 클릭 대상에서 뺐다.
 */
export function NowPlayingView({
  envelope,
  width,
}: WidgetViewProps<NowPlayingWidgetConfig, NowPlayingState>) {
  const state = envelope.data

  if (envelope.status === 'error-permanent' || envelope.error) {
    return <ErrorState message={envelope.error?.message ?? '재생 정보를 읽을 수 없습니다'} />
  }
  if (envelope.status === 'idle' || envelope.status === 'loading') {
    return null // 첫 push가 곧 온다. 셸의 스윕 바가 로딩을 말한다.
  }
  if (!state) return <EmptyState />

  return <Playing state={state} width={width} />
}

function Playing({ state, width }: { state: NowPlayingState; width: number }) {
  // 밀도 전환. 경계는 Jira의 실측 기준(300/420)을 따르되 이 위젯의 내용에 맞췄다.
  const compact = width < 300
  const showAlbum = width >= 340

  const [nowMs, setNowMs] = useState(() => Date.now())
  const [busy, setBusy] = useState(false)
  const [commandError, setCommandError] = useState<string | null>(null)

  // 재생 중일 때만 시계를 돌린다. 일시정지면 그릴 것이 안 바뀐다.
  useEffect(() => {
    if (!state.playing) return
    const id = setInterval(() => setNowMs(Date.now()), 500)
    return () => clearInterval(id)
  }, [state.playing])

  // 새 push가 오면(트랙·상태 변화) 지난 제어 실패 표시를 거둔다.
  // biome-ignore lint/correctness/useExhaustiveDependencies: state 객체 교체가 곧 push다
  useEffect(() => {
    setCommandError(null)
    setNowMs(Date.now())
  }, [state])

  const send = async (command: NowPlayingCommand) => {
    // 재시도 없음 — "다음 곡"은 멱등이 아니다. busy는 재시도가 아니라
    // 한 클릭이 처리되는 동안의 겹침만 막는다.
    if (busy) return
    setBusy(true)
    try {
      const result = await commands.nowplayingSend(command)
      if (result.status !== 'ok') setCommandError(result.error)
    } finally {
      setBusy(false)
    }
  }

  const openApp = () => {
    void commands.nowplayingOpenApp(state.bundleId).then((result) => {
      if (result.status !== 'ok') setCommandError(result.error)
    })
  }

  const elapsed = estimateElapsedSecs(state, nowMs)
  const duration = state.durationSecs !== null && state.durationSecs > 0 ? state.durationSecs : null
  const progress = elapsed !== null && duration !== null ? Math.min(1, elapsed / duration) : null

  const artSize = compact ? 'size-12' : 'size-16'
  const subtitle = [state.artist, showAlbum ? state.album : null].filter(Boolean).join(' · ')

  return (
    <div className="flex h-full flex-col justify-center gap-2 p-3">
      <div className="flex min-h-0 items-center gap-3">
        {/* 앨범아트. 없으면 자리 유지용 아이콘 박스 — 레이아웃이 튀지 않는다. */}
        <button
          type="button"
          onClick={openApp}
          title="재생 중인 앱 열기"
          aria-label="재생 중인 앱 열기"
          className={`${artSize} shrink-0 cursor-pointer overflow-hidden rounded
                      bg-surface-inset focus-visible:outline-2 focus-visible:outline-accent`}
        >
          {state.artwork ? (
            <img
              src={state.artwork}
              alt=""
              draggable={false}
              className="h-full w-full object-cover"
            />
          ) : (
            <span className="grid h-full w-full place-items-center text-text-quaternary">
              <Music size={compact ? 16 : 20} />
            </span>
          )}
        </button>

        <div className="flex min-w-0 flex-1 flex-col">
          <button
            type="button"
            onClick={openApp}
            title={`${state.title} — 재생 중인 앱 열기`}
            className="cursor-pointer truncate text-left font-medium text-body text-text-primary
                       hover:underline focus-visible:outline-2 focus-visible:outline-accent"
          >
            {state.title}
          </button>
          {subtitle && (
            <p className="truncate text-caption text-text-tertiary" title={subtitle}>
              {subtitle}
            </p>
          )}
        </div>
      </div>

      {/* 진행바. 보기 전용 — 탐색은 플레이어별 지원 편차가 있어 만들지 않았다. */}
      {progress !== null && elapsed !== null && duration !== null && (
        <div className="flex items-center gap-2">
          {!compact && (
            <span className="shrink-0 text-caption text-text-quaternary tabular-nums">
              {formatTime(elapsed)}
            </span>
          )}
          <div
            role="progressbar"
            aria-valuemin={0}
            aria-valuemax={Math.round(duration)}
            aria-valuenow={Math.round(elapsed)}
            aria-label="재생 위치"
            className="h-1 min-w-0 flex-1 overflow-hidden rounded-full bg-surface-inset"
          >
            <div className="h-full bg-accent" style={{ width: `${progress * 100}%` }} />
          </div>
          {!compact && (
            <span className="shrink-0 text-caption text-text-quaternary tabular-nums">
              {formatTime(duration)}
            </span>
          )}
        </div>
      )}

      <div className="flex items-center justify-center gap-1">
        <ControlButton label="이전 곡" disabled={busy} onClick={() => void send('previous')}>
          <SkipBack size={16} />
        </ControlButton>
        <ControlButton
          label={state.playing ? '일시정지' : '재생'}
          disabled={busy}
          onClick={() => void send('playPause')}
        >
          {state.playing ? <Pause size={18} /> : <Play size={18} />}
        </ControlButton>
        <ControlButton label="다음 곡" disabled={busy} onClick={() => void send('next')}>
          <SkipForward size={16} />
        </ControlButton>
      </div>

      {/* 제어 실패는 여기 드러난다. 토스트를 쓰지 않는다 (DESIGN 5.3). */}
      {commandError && (
        <p className="truncate text-caption text-danger" title={commandError}>
          {commandError}
        </p>
      )}
    </div>
  )
}

function ControlButton({
  label,
  disabled,
  onClick,
  children,
}: {
  label: string
  disabled: boolean
  onClick: () => void
  children: React.ReactNode
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={label}
      aria-label={label}
      className="grid size-8 cursor-pointer place-items-center rounded-full text-text-secondary
                 transition-colors duration-fast hover:bg-surface-inset hover:text-text-primary
                 disabled:opacity-40 focus-visible:outline-2 focus-visible:outline-accent"
    >
      {children}
    </button>
  )
}

/** 재생 중인 것이 없다. 에러가 아니라 정상적인 빈 상태 — 캐시도 없다 (DECISIONS 27). */
function EmptyState() {
  return (
    <div className="grid h-full place-items-center p-4">
      <div className="flex flex-col items-center gap-2 text-center">
        <Music size={22} className="text-text-quaternary" />
        <p className="text-caption text-text-tertiary leading-relaxed-ko">
          재생 중인 미디어가 없습니다
        </p>
        <p className="text-caption text-text-quaternary leading-relaxed-ko">
          음악 앱이나 브라우저에서 재생을 시작하면 여기에 표시됩니다.
        </p>
      </div>
    </div>
  )
}

/**
 * 어댑터 실패. macOS가 미디어 정보 접근을 막았거나 프로세스가 죽은 경우다.
 * 무엇을 하면 되는지까지 적는다 — 복구 경로는 헤더의 새로고침(재연결)이다.
 */
function ErrorState({ message }: { message: string }) {
  return (
    <div className="grid h-full place-items-center p-4">
      <div className="flex flex-col items-center gap-2 text-center">
        <VolumeX size={20} className="text-danger" />
        <p className="whitespace-pre-line text-caption text-text-secondary leading-relaxed-ko">
          {message}
        </p>
        <p className="text-caption text-text-quaternary leading-relaxed-ko">
          헤더의 새로고침(↻)이 다시 연결을 시도합니다.
        </p>
      </div>
    </div>
  )
}
