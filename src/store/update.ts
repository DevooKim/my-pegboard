import { relaunch } from '@tauri-apps/plugin-process'
import { check, type Update } from '@tauri-apps/plugin-updater'
import { create } from 'zustand'
import { commands } from '#/ipc/bindings'
import { IN_TAURI } from '#/ipc/env'
import { flushPendingSaves } from '#/store/persist'

/** 릴리즈 목록. 서명 검증이 실패했을 때 사용자가 갈 수 있는 유일한 출구다. */
export const RELEASES_PAGE = 'https://github.com/DevooKim/my-pegboard/releases'

/** 시작 직후 조회를 미루는 시간. 보드가 먼저 그려져야 한다. */
const FIRST_CHECK_DELAY_MS = 5_000
/** 주기 조회. 릴리즈 빈도가 며칠 단위라 6시간이면 충분하다. */
const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000
/**
 * 다운로드 타임아웃. dmg가 6MB라 정상이면 1~3초에 끝난다.
 * 이 값을 넘겼다면 진행이 아니라 막힌 것이다 — 영원히 도는 스피너를 만들지 않는다.
 */
const DOWNLOAD_TIMEOUT_MS = 60_000

/**
 * 업데이트 확인 상태.
 *
 * `idle` 확인해본 적 없음 / `checking` 조회 중 /
 * `latest` 최신임 (수동 확인 결과를 반드시 보여줘야 하므로 별도 상태) /
 * `available` 새 버전 있음 → 배지가 뜬다 /
 * `downloading` 받아서 설치 중 / `installed` 설치 완료, 재시작 대기 /
 * `failed` 실패 (사유와 출구를 화면에 적는다)
 */
export type UpdatePhase =
  | { kind: 'idle' }
  | { kind: 'checking' }
  | { kind: 'latest' }
  | { kind: 'available'; version: string; notes: string | null }
  | { kind: 'downloading'; version: string }
  | { kind: 'installed'; version: string }
  | { kind: 'failed'; message: string; signature: boolean }

interface UpdateState {
  currentVersion: string
  phase: UpdatePhase
  /** 배지를 그릴지. 새 버전을 발견한 뒤로는 업데이트할 때까지 계속 켜져 있다. */
  hasUpdate: boolean

  loadCurrentVersion: () => Promise<void>
  check: (opts?: { manual?: boolean }) => Promise<void>
  downloadAndInstall: () => Promise<void>
  restart: () => Promise<void>
}

/**
 * `check()`가 돌려준 Update 핸들을 들고 있는다. 다운로드는 이 핸들로만 할 수
 * 있어서 store 밖에 보관한다 — 직렬화 대상이 아니고 리렌더와도 무관하다.
 */
let pendingUpdate: Update | null = null

export const useUpdateStore = create<UpdateState>((set, get) => ({
  currentVersion: '',
  phase: { kind: 'idle' },
  hasUpdate: false,

  loadCurrentVersion: async () => {
    if (!IN_TAURI) return
    const info = await commands.appInfo()
    set({ currentVersion: info.version })
  },

  check: async ({ manual = false } = {}) => {
    if (!IN_TAURI) return
    // 이미 받고 있거나 설치가 끝났으면 다시 조회하지 않는다.
    const phase = get().phase
    if (phase.kind === 'downloading' || phase.kind === 'installed') return
    // 자동 조회는 이미 발견한 상태를 덮어쓰지 않는다. 수동은 항상 다시 본다.
    if (!manual && phase.kind === 'available') return

    set({ phase: { kind: 'checking' } })
    try {
      const update = await check()
      if (update) {
        pendingUpdate = update
        set({
          phase: { kind: 'available', version: update.version, notes: update.body ?? null },
          hasUpdate: true,
        })
      } else {
        pendingUpdate = null
        set({ phase: { kind: 'latest' }, hasUpdate: false })
      }
    } catch (e) {
      // 조용히 실패하지 않는다. 다만 자동 조회의 실패로 화면을 어지럽히지는
      // 않는다 — 수동으로 눌렀을 때만 결과를 상태로 남긴다.
      const message = describeError(e)
      if (manual) set({ phase: { kind: 'failed', message, signature: false } })
      else {
        console.error('업데이트 확인 실패:', e)
        set({ phase: { kind: 'idle' } })
      }
    }
  },

  downloadAndInstall: async () => {
    const update = pendingUpdate
    if (!update || !IN_TAURI) return
    const version = update.version
    set({ phase: { kind: 'downloading', version } })

    try {
      // 진행률은 표시하지 않는다(6MB — 볼 시간이 없다). 대신 타임아웃을 둔다.
      await withTimeout(update.downloadAndInstall(), DOWNLOAD_TIMEOUT_MS)
      set({ phase: { kind: 'installed', version } })
    } catch (e) {
      const message = describeError(e)
      set({
        phase: { kind: 'failed', message, signature: isSignatureError(e) },
      })
    }
  },

  restart: async () => {
    if (!IN_TAURI) return
    // 디바운스 대기 중인 배치 저장을 먼저 확정한다. 이걸 빼먹으면 방금 옮긴
    // 위젯 위치가 조용히 사라진다.
    await flushPendingSaves()
    await relaunch()
  },
}))

/**
 * 앱 시작 시 한 번 호출한다. 시작 경로를 막지 않도록 첫 조회를 미룬다.
 * 반환값은 정리 함수 — 주기 타이머를 끈다.
 */
export function startUpdateChecks(): () => void {
  const store = useUpdateStore.getState()
  void store.loadCurrentVersion()

  if (!IN_TAURI) return () => {}

  const first = setTimeout(() => {
    void useUpdateStore.getState().check()
  }, FIRST_CHECK_DELAY_MS)

  const interval = setInterval(() => {
    void useUpdateStore.getState().check()
  }, CHECK_INTERVAL_MS)

  return () => {
    clearTimeout(first)
    clearInterval(interval)
  }
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`시간이 초과됐습니다 (${Math.round(ms / 1000)}초)`)),
      ms,
    )
    p.then(
      (v) => {
        clearTimeout(timer)
        resolve(v)
      },
      (e) => {
        clearTimeout(timer)
        reject(e)
      },
    )
  })
}

/**
 * 서명 검증 실패인가.
 *
 * 이 경우만 특별히 구분하는 이유: 사용자가 앱 안에서 할 수 있는 일이 없다.
 * 재시도해도 같은 결과라, 릴리즈 페이지로 내보내야 한다. 개인키가 바뀐 채로
 * 릴리즈가 올라갔을 때 사용자가 갇히지 않는 유일한 출구다.
 */
function isSignatureError(e: unknown): boolean {
  const s = String(e).toLowerCase()
  return s.includes('signature') || s.includes('minisign') || s.includes('verify')
}

function describeError(e: unknown): string {
  const raw = e instanceof Error ? e.message : String(e)
  if (isSignatureError(e)) {
    return `업데이트 파일을 검증할 수 없습니다. 릴리즈 페이지에서 직접 받아 설치하세요. (${raw})`
  }
  return raw
}
