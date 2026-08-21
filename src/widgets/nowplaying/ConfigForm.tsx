import type { WidgetConfigFormProps } from '#/widgets/types'
import type { NowPlayingWidgetConfig } from './index'

/**
 * "지금 재생 중" 설정 — 이름뿐이다.
 *
 * 데이터 소스(시스템 Now Playing)는 하나뿐이고 폴링 주기도 없으므로(이벤트
 * push) 설정할 것이 없다. Todo와 같은 상황이다: 가져올 게 하나뿐이면 제목만
 * 남기고 나머지는 본문 상호작용으로 옮긴다 (patterns.md).
 */
export function NowPlayingConfigForm({
  config,
  onChange,
}: WidgetConfigFormProps<NowPlayingWidgetConfig>) {
  return (
    <div className="flex flex-col gap-3 py-4">
      <label className="flex flex-col gap-1">
        <span className="text-caption text-text-secondary">위젯 이름</span>
        <input
          data-selectable
          value={config.title ?? ''}
          onChange={(e) => onChange({ ...config, title: e.target.value })}
          placeholder="지금 재생 중"
          className="rounded border border-border-subtle bg-surface-inset px-2 py-1.5
                     text-body text-text-primary placeholder:text-text-quaternary"
        />
      </label>
      <p className="text-caption text-text-tertiary leading-relaxed-ko">
        Spotify·브라우저·Apple Music 등 macOS에 "지금 재생 중"으로 등록되는 모든 미디어를
        표시합니다. 별도 로그인이 필요 없습니다.
      </p>
    </div>
  )
}
