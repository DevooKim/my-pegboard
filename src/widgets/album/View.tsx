import { convertFileSrc } from '@tauri-apps/api/core'
import { FolderOpen, ImageOff, Images } from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { commands } from '#/ipc/bindings'
import { useBoardStore } from '#/store/board'
import type { WidgetViewProps } from '#/widgets/types'
import { DEFAULT_INTERVAL_SECS } from './defaults'
import type { AlbumWidgetConfig } from './index'
import { advance, currentIndex, newPlayback, type Playback } from './shuffle'
import type { AlbumData } from './useAlbumData'

/**
 * 위젯 id → 마지막 재생 상태(순서 + 위치).
 *
 * 보드 탭을 오가면 View가 언마운트·리마운트되는데, 그때마다 새로 섞으면
 * "셔플 순서는 세션 동안 고정"이라는 약속이 깨진다. 사진 인덱스 배열이라
 * 위젯당 수백 바이트 수준이고, 세션이 끝나면 같이 사라진다.
 */
const lastPlaybacks = new Map<string, Playback>()

/**
 * 테스트 전용. 모듈 스코프 상태는 테스트 사이에 남으므로 비워줘야 한다
 * (`registry.ts`의 `__resetRegistry`와 같은 이유).
 */
export function __resetPlaybacks(): void {
  lastPlaybacks.clear()
}

/** 크로스페이드 길이. 이보다 길면 "느리게 반응한다"로 읽힌다. */
const FADE_MS = 300

/**
 * 앨범 위젯 본문 — 사진 한 장이 조용히 바뀐다.
 *
 * ## 이미지를 어떻게 넣나
 *
 * `convertFileSrc(path)`가 절대 경로를 `asset://localhost/...`로 바꾼다. 네이티브가
 * 파일을 스트리밍하므로 **IPC 페이로드가 0이고 원본 화질이 그대로 나온다.**
 * base64로 내리면 사진 한 장에 수 MB가 IPC를 타는데, 그건 "필요한 필드만
 * 남긴다"는 원칙(CLAUDE.md)을 정면으로 위반한다.
 *
 * 대가는 **스코프**다. `tauri.conf.json`의 정적 scope는 빈 배열이고, 사용자가
 * 고른 경로만 Rust가 런타임에 허용한다. 스코프가 없으면 `<img>`는 **에러 없이
 * 깨진 이미지**가 된다 — CSP가 `asset:`을 허용하므로 콘솔에도 아무 말이 없다.
 * (재시작 복원은 `lib.rs` setup이 한다)
 *
 * ## `cover`인 이유
 *
 * `contain`은 사진 비율이 위젯과 다를 때 여백을 만든다. 배경으로 놔두는
 * 위젯에서 검은 띠가 절반을 차지하면 배경 역할을 못 한다. 잘리는 쪽을 택했다.
 *
 * ## 상호작용은 하나뿐
 *
 * **위젯 면적 전체가 "다음 장" 버튼이다.** 화살표 버튼을 놓으면 작은 위젯에서
 * 사진의 상당 부분을 가린다. 이 위젯에서 누를 만한 것이 하나뿐이므로
 * 면적 전체를 주는 것이 맞다.
 */
export function AlbumView({
  widgetId,
  config,
  envelope,
  width,
}: WidgetViewProps<AlbumWidgetConfig, AlbumData>) {
  const photos = envelope.data?.photos ?? []
  const skipped = envelope.data?.skipped ?? 0
  const reducedMotion = usePrefersReducedMotion()
  // 손으로 편집한 board.json에서 빠졌을 수 있다. `?? 0`으로 떨어지면
  // 자동 순환이 조용히 꺼지므로 기본값을 명시한다 (defaults.ts의 주석 참조).
  const intervalSecs = config.intervalSecs ?? DEFAULT_INTERVAL_SECS

  // 재생 순서와 위치는 **보드 탭을 오가도 유지된다.**
  //
  // 비활성 보드는 언마운트되므로(폴링을 멈추는 방식이다) 탭을 돌아올 때마다
  // 여기가 새로 마운트된다. 매번 새로 섞으면 "순서는 세션 동안 고정"이라는
  // 약속이 깨지고, 무엇보다 방금 보던 사진이 다른 사진으로 바뀐다 —
  // 돌아왔을 때 화면이 튀는 것으로 보인다.
  const photoCount = photos.length
  const [playback, setPlayback] = useState(
    () => lastPlaybacks.get(widgetId) ?? newPlayback(photoCount),
  )
  /** 표시할 수 없었던 경로. 개수를 화면에 드러내려고 센다. */
  const [broken, setBroken] = useState<Set<string>>(() => new Set())

  useEffect(() => {
    lastPlaybacks.set(widgetId, playback)
  }, [widgetId, playback])

  // 사진 목록이 **바뀌었을 때만** 순서를 새로 만든다(첫 스캔, 재스캔).
  //
  // 장수를 기억해 두고 비교하는 이유: 이 효과는 리마운트에서도 돌기 때문에
  // 그냥 두면 탭을 돌아올 때마다 다시 섞인다. 위에서 playback을 살려둔 것이
  // 무의미해진다.
  const knownCount = useRef<number | null>(playback.order.length || null)
  useEffect(() => {
    if (knownCount.current === photoCount) return
    knownCount.current = photoCount
    setPlayback(newPlayback(photoCount))
    setBroken(new Set())
  }, [photoCount])

  const next = useCallback(() => {
    setPlayback((prev) => advance(prev, photoCount))
  }, [photoCount])

  /**
   * 자동 순환.
   *
   * `intervalSecs: 0`이면 걸지 않는다 (web 위젯의 `refreshSecs: 0`과 같은 관례).
   *
   * **`prefers-reduced-motion`이면 자동 순환을 멈춘다.** 10초마다 화면이 바뀌는
   * 것은 크로스페이드를 끄는 것과 별개로 그 자체가 움직임이다. 그 설정을 켠
   * 사용자는 "가만히 있어라"를 말한 것이므로 페이드만 끄고 계속 도는 건
   * 설정을 반쯤 무시하는 것이다. 누르면 여전히 넘어간다.
   */
  useEffect(() => {
    if (reducedMotion) return
    if (intervalSecs <= 0) return
    if (photoCount <= 1) return // 한 장이면 넘길 곳이 없다
    const id = setInterval(next, intervalSecs * 1000)
    return () => clearInterval(id)
  }, [reducedMotion, intervalSecs, photoCount, next])

  const index = currentIndex(playback)
  const photo = index === null ? null : photos[index]

  /**
   * 깨진/사라진 장을 만나면 **즉시 다음 장으로 넘긴다.**
   *
   * 배경으로서 계속 동작해야 하므로 멈추지 않는다. 대신 건너뛴 사실을
   * 아래 배너에 개수로 드러낸다 — 조용히 묻으면 사용자는 사진이 몇 장
   * 없어진 것을 모른다.
   */
  const onImageError = useCallback(
    (path: string) => {
      setBroken((prev) => {
        if (prev.has(path)) return prev
        const nextSet = new Set(prev)
        nextSet.add(path)
        return nextSet
      })
      next()
    },
    [next],
  )

  // 전부 깨졌다. 폴더는 있는데 안에 있는 것을 하나도 못 여는 상태 —
  // 권한 문제거나 확장자만 이미지인 파일들이다.
  const allBroken = photoCount > 0 && broken.size >= photoCount

  // **소스 없음이 에러보다 먼저다.** 아무것도 고르지 않은 상태에서 에러 화면을
  // 보여주면 사용자가 할 일("폴더 선택")이 안 보인다. 위젯을 방금 놓았을 때
  // 하고 싶은 일은 하나뿐이므로 그 버튼을 먼저 준다.
  if (!config.source) return <EmptyState widgetId={widgetId} config={config} />

  if (envelope.status === 'error-permanent' && !photo) {
    return <ErrorState message={envelope.error?.message ?? '사진을 불러올 수 없습니다'} />
  }

  if (allBroken) {
    return (
      <ErrorState
        message={`${photoCount}장을 모두 표시할 수 없습니다.\n${describeSource(config)}\n파일이 이동·삭제됐거나 읽을 수 없는 형식입니다.`}
      />
    )
  }

  if (!photo) {
    // 소스는 있는데 사진이 0장. 폴더가 비었거나 이미지가 아닌 파일만 있다.
    if (envelope.status === 'loading' || envelope.status === 'idle') return null // 셸이 그린다
    return (
      <ErrorState
        message={`표시할 사진이 없습니다.\n${describeSource(config)}\njpg · png · gif · webp · heic만 표시합니다 (하위 폴더는 보지 않습니다).`}
      />
    )
  }

  return (
    <div className="relative h-full">
      {/*
        면적 전체가 "다음 장" 버튼이다. `<button>`으로 감싸는 이유는 키보드와
        스크린리더 때문 — div에 onClick만 걸면 Tab으로 닿지 않는다.
        사진이 한 장이면 누를 것이 없으므로 비활성으로 둔다.
      */}
      <button
        type="button"
        onClick={next}
        disabled={photoCount <= 1}
        aria-label="다음 사진"
        title={photoCount > 1 ? '다음 사진' : undefined}
        className="block h-full w-full cursor-pointer overflow-hidden bg-surface-inset
                   focus-visible:outline-2 focus-visible:outline-accent
                   disabled:cursor-default"
      >
        {/*
          key에 경로를 넣어 사진이 바뀔 때마다 새 <img>가 마운트되게 한다.
          그래야 CSS 애니메이션(페이드인)이 매번 처음부터 돈다 — 같은 노드의
          src만 갈면 애니메이션이 다시 시작하지 않는다.

          reduced-motion이면 애니메이션 없이 즉시 교체한다.
        */}
        <img
          key={photo.path}
          src={convertFileSrc(photo.path)}
          alt=""
          draggable={false}
          onError={() => onImageError(photo.path)}
          className="h-full w-full object-cover"
          style={
            reducedMotion ? undefined : { animation: `album-fade-in ${FADE_MS}ms ease-out both` }
          }
        />
      </button>

      {/*
        건너뛴 장수를 드러낸다. 위젯 하단에 반투명 한 줄 —
        사진을 가리되 최소한으로. 조용히 묻지 않는 것이 목적이다.
      */}
      {(skipped > 0 || broken.size > 0) && (
        <p
          className="pointer-events-none absolute inset-x-0 bottom-0 truncate bg-surface-raised/85
                     px-2 py-1 text-caption text-stale"
          title={noticeText(skipped, broken.size)}
        >
          {noticeText(skipped, broken.size)}
        </p>
      )}

      {/* 폭이 아주 좁으면 장수 표시가 사진을 잡아먹는다. 240px부터만 그린다. */}
      {width >= 240 && photoCount > 1 && (
        <span
          className="pointer-events-none absolute top-1 right-1 rounded bg-surface-raised/70 px-1.5
                     py-0.5 text-caption text-text-tertiary tabular-nums"
        >
          {playback.cursor + 1} / {photoCount}
        </span>
      )}
    </div>
  )
}

/** 하단 알림 문구. 상한 초과와 표시 실패는 원인이 달라 따로 적는다. */
function noticeText(skipped: number, brokenCount: number): string {
  const parts: string[] = []
  if (skipped > 0) parts.push(`${skipped}장은 표시하지 않음 (1000장 상한)`)
  if (brokenCount > 0) parts.push(`${brokenCount}장을 표시할 수 없습니다`)
  return parts.join(' · ')
}

/** 에러 화면에 적을 경로. 어느 폴더가 문제인지 모르면 고칠 수 없다. */
function describeSource(config: AlbumWidgetConfig): string {
  const source = config.source
  if (!source) return ''
  if (source.kind === 'folder') return source.path
  if (source.paths.length === 1) return source.paths[0] ?? ''
  return `고른 사진 ${source.paths.length}장`
}

/**
 * 아직 폴더를 고르지 않았을 때.
 *
 * **여기서 바로 고를 수 있어야 한다.** 설정창을 열게 만들면 "위젯을 추가했는데
 * 아무것도 없다 → 설정 버튼을 찾는다"는 한 단계가 더 붙는다. 위젯을 놓은 직후에
 * 하고 싶은 일은 하나뿐이므로 그 버튼을 바로 준다.
 */
function EmptyState({ widgetId, config }: { widgetId: string; config: AlbumWidgetConfig }) {
  return (
    <div className="grid h-full place-items-center p-4">
      <div className="flex flex-col items-center gap-3 text-center">
        <Images size={22} className="text-text-quaternary" />
        <p className="text-caption text-text-tertiary leading-relaxed-ko">
          보여줄 사진을 고르세요. 폴더를 고르면 그 안의 사진이 번갈아 표시됩니다.
        </p>
        <SourceButtons widgetId={widgetId} config={config} />
        <p className="text-caption text-text-quaternary leading-relaxed-ko">
          하위 폴더는 보지 않습니다 · jpg png gif webp heic
        </p>
      </div>
    </div>
  )
}

/**
 * 에러 화면.
 *
 * 무엇이 잘못됐는지 + **어느 경로인지** + 무엇을 하면 되는지를 함께 적는다
 * (CLAUDE.md: 실패는 무엇을 해야 하는지까지 적는다). "다시 선택" 버튼은
 * 여기가 막다른 길이 되지 않게 한다.
 */
function ErrorState({ message }: { message: string }) {
  return (
    <div className="grid h-full place-items-center p-4">
      <div className="flex flex-col items-center gap-2 text-center">
        <ImageOff size={20} className="text-danger" />
        <p className="whitespace-pre-line text-caption text-text-secondary leading-relaxed-ko">
          {message}
        </p>
        <p className="text-caption text-text-quaternary leading-relaxed-ko">
          위젯 설정에서 폴더를 다시 고를 수 있습니다.
        </p>
      </div>
    </div>
  )
}

/**
 * 폴더/사진 선택 버튼.
 *
 * 다이얼로그를 여는 것도, 스코프를 허용하는 것도, 스캔하는 것도 전부 Rust
 * 커맨드 하나가 한다. 여기서는 결과로 온 소스를 board.json에 저장하고
 * 재스캔 이벤트를 쏴서 봉투가 갱신되게 한다.
 */
function SourceButtons({ widgetId, config }: { widgetId: string; config: AlbumWidgetConfig }) {
  const updateConfig = useBoardStore((s) => s.updateWidgetConfig)
  const [picking, setPicking] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const pick = async (kind: 'folder' | 'files') => {
    setPicking(true)
    setError(null)
    try {
      const result =
        kind === 'folder'
          ? await commands.albumPickFolder(widgetId)
          : await commands.albumPickFiles(widgetId)

      if (result.status !== 'ok') {
        setError(result.error)
        return
      }
      // 취소했다. 아무것도 바꾸지 않는다.
      if (!result.data) return

      updateConfig(widgetId, {
        ...config,
        source: result.data.source,
      } as unknown as Record<string, unknown>)
      // 봉투를 갱신시킨다. 설정이 바뀌면 훅이 알아서 다시 훑지만,
      // 이벤트로 한 번 더 밀어주면 첫 장이 곧바로 뜬다.
      window.dispatchEvent(new Event('pegboard:refresh-all'))
    } finally {
      setPicking(false)
    }
  }

  return (
    <div className="flex flex-col items-center gap-2">
      <div className="flex gap-2">
        <button
          type="button"
          disabled={picking}
          onClick={() => void pick('folder')}
          className="flex items-center gap-1 rounded border border-accent bg-accent/15 px-2 py-1
                     text-caption text-accent disabled:opacity-50"
        >
          <FolderOpen size={12} />
          폴더 선택
        </button>
        <button
          type="button"
          disabled={picking}
          onClick={() => void pick('files')}
          className="flex items-center gap-1 rounded border border-border-subtle px-2 py-1
                     text-caption text-text-secondary hover:bg-surface-inset disabled:opacity-50"
        >
          <Images size={12} />
          사진 선택
        </button>
      </div>
      {/* 다이얼로그가 실패하는 일은 드물지만, 드물다는 이유로 숨기지 않는다. */}
      {error && <p className="text-caption text-danger leading-relaxed-ko">{error}</p>}
    </div>
  )
}

/**
 * `prefers-reduced-motion` 감지.
 *
 * 시스템 설정을 도중에 바꿀 수 있으므로 이벤트를 듣는다 — 한 번 읽고 끝내면
 * 설정을 켜도 앱을 다시 켤 때까지 계속 움직인다.
 */
function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState(() => matchesReducedMotion())

  useEffect(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return
    const query = window.matchMedia('(prefers-reduced-motion: reduce)')
    const onChange = () => setReduced(query.matches)
    query.addEventListener('change', onChange)
    return () => query.removeEventListener('change', onChange)
  }, [])

  return reduced
}

function matchesReducedMotion(): boolean {
  if (typeof window === 'undefined' || !window.matchMedia) return false
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches
}
