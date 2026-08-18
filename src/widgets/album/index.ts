import { Images } from 'lucide-react'
import { lazy } from 'react'
import type { AlbumSource } from '#/ipc/bindings'
import { registerWidget } from '#/widgets/registry'
import type { WidgetDefinition } from '#/widgets/types'
import { DEFAULT_INTERVAL_SECS } from './defaults'
import { AlbumView } from './View'

const AlbumConfigForm = lazy(() =>
  import('./ConfigForm').then((module) => ({ default: module.AlbumConfigForm })),
)

/**
 * 앨범 위젯 — 로컬 폴더의 사진을 조용히 순환시킨다.
 *
 * ## 이건 사진 뷰어가 아니다
 *
 * 작업용 대시보드 한쪽에서 **기분 전환용 배경**으로 도는 위젯이다. 그래서
 * 일부러 없는 것들이 있다: 파일명·촬영일·EXIF·썸네일 그리드·확대보기.
 * 사진을 제대로 보려면 미리보기 앱이 훨씬 낫고, 우리가 어설프게 만들면
 * 둘 다 하는 것이 된다 (GitHub 상세 모달을 안 만든 것과 같은 논리 —
 * DECISIONS 12.5 / 24).
 *
 * 상호작용은 하나뿐이다: **위젯을 누르면 다음 장.**
 *
 * ## 설정 타입을 프론트가 소유하는 이유
 *
 * Rust가 설정에서 쓰는 것은 `source`뿐이다. 제목과 순환 주기는 **표시 방식**이라
 * Rust가 알 이유가 없고, 알게 만들면 순환 주기를 바꿀 때마다 폴더를 다시 훑는
 * 코드가 되기 쉽다. GitHub 위젯이 반대인 것은 거기서 쿼리·범위·최대 건수를
 * 전부 Rust가 해석하기 때문이다.
 *
 * `AlbumSource`만 Rust에서 온다 — 그건 IPC 양쪽이 같은 모양을 알아야 한다.
 */

export interface AlbumWidgetConfig {
  /** 사용자가 붙인 이름. 비우면 폴더 이름을 쓴다. */
  title: string | null
  /** 아직 고르지 않았으면 `null` — 빈 상태 화면이 뜬다. */
  source: AlbumSource | null
  /** 순환 주기(초). **0이면 자동 순환 없음** (web 위젯 `refreshSecs: 0` 관례). */
  intervalSecs: number
  /** 사진 위 헤더를 호버할 때만 보일지, 항상 공간을 차지할지. */
  headerMode?: 'hover' | 'always'
}

export const albumWidget: WidgetDefinition<AlbumWidgetConfig> = {
  type: 'album',
  label: '앨범',
  description: '로컬 폴더의 사진을 번갈아 보여줍니다',
  icon: Images,
  maxInstances: 4,

  defaultConfig: {
    title: null,
    source: null,
    intervalSecs: DEFAULT_INTERVAL_SECS,
    headerMode: 'hover',
  },
  // 사진은 가로가 길어야 대개 잘 맞는다. 4×8이면 12열 보드에서 세 개가 들어간다.
  defaultLayout: { w: 4, h: 8 },
  // 이보다 작으면 사진이 우표가 된다. 배경으로서 의미가 없어지는 지점.
  minLayout: { w: 2, h: 4 },

  // 새로고침 = 폴더 재스캔. 사진을 추가하고 나서 누를 일이 있다.
  // (주기 폴링은 하지 않는다 — 사진 폴더는 5분마다 바뀌지 않는다)
  pollable: true,
  View: AlbumView,
  ConfigForm: AlbumConfigForm,

  deriveTitle: (config) => {
    const custom = config.title?.trim()
    if (custom) return custom
    return sourceLabel(config.source) ?? '앨범'
  },
}

/**
 * 소스를 위젯 제목으로 쓸 짧은 이름으로 만든다.
 *
 * - 폴더 → 폴더 이름 (`/Users/me/Pictures/여행` → `여행`)
 * - 파일 하나 → 파일명
 * - 파일 여럿 → `사진 N장`
 *
 * 전체 경로를 헤더에 넣지 않는다. 헤더는 한 줄이고 경로는 길다 —
 * 잘리면 앞부분(`/Users/me/…`)만 보여서 아무 정보가 아니다.
 */
export function sourceLabel(source: AlbumWidgetConfig['source']): string | null {
  if (!source) return null
  if (source.kind === 'folder') return baseName(source.path)
  if (source.paths.length === 0) return null
  if (source.paths.length === 1) return baseName(source.paths[0] ?? '')
  return `사진 ${source.paths.length}장`
}

/** 경로에서 마지막 조각. 끝의 `/`는 무시한다. */
function baseName(path: string): string {
  const parts = path.split('/').filter((p) => p.length > 0)
  return parts[parts.length - 1] ?? path
}

registerWidget(albumWidget)
