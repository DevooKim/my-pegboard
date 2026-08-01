import { useMemo } from 'react'
import type { GithubItem, GithubWidgetConfig } from '#/ipc/bindings'
import { useNow } from '#/ui/relativeTime'
import type { WidgetViewProps } from '#/widgets/types'
import { groupByRepo } from './grouping'
import { ItemRow } from './ItemRow'

/**
 * 폭이 이보다 좁으면 저장소 이름에서 `owner/`를 버린다.
 *
 * 3열(≈240px)이 최소 가독 폭인데, 거기에 `DevooKim/Unofficial-Flex-time-extension`
 * 같은 이름이 들어가면 나머지가 다 밀린다.
 */
const COMPACT_WIDTH = 320

/**
 * GitHub 위젯 본문.
 *
 * **한 번 데이터가 그려진 뒤로는 본문을 비우지 않는다** (DESIGN.md).
 * 갱신 중이든 일시적 실패든 직전 목록을 계속 보여준다.
 */
export function GithubView({
  config,
  envelope,
  width,
}: WidgetViewProps<GithubWidgetConfig, { items: GithubItem[]; total: number }>) {
  const now = useNow()
  const items = envelope.data?.items ?? []
  const compact = width < COMPACT_WIDTH

  // `serde(default)`라 생성 타입에서 optional이다. 이 설정이 생기기 전에 만든
  // 위젯은 값이 없는데, 그대로 두면 그룹핑이 조용히 꺼진다 — 기본은 켬이다.
  const grouped = config.groupByRepo ?? true
  const groups = useMemo(
    () => (grouped ? groupByRepo(items, config.repoOrder ?? []) : null),
    [items, grouped, config.repoOrder],
  )

  if (items.length === 0) return null // WidgetShell이 빈/로딩/에러를 그린다

  return (
    <div className="h-full overflow-y-auto px-1.5 py-1">
      {groups ? (
        groups.map((group) => (
          <section key={group.repo}>
            {/* 그룹 헤더. sticky로 두어 스크롤 중에도 어느 저장소인지 보인다. */}
            <h3
              className="sticky top-0 z-10 truncate bg-surface-raised px-1.5 py-0.5
                         text-caption text-text-tertiary"
              title={group.repo}
            >
              {group.repo}
            </h3>
            <ul>
              {group.items.map((item) => (
                <ItemRow
                  key={item.id}
                  item={item}
                  now={now}
                  compact={compact}
                  // 헤더가 이미 저장소를 보여주므로 행에서는 뺀다.
                  showRepo={false}
                />
              ))}
            </ul>
          </section>
        ))
      ) : (
        <ul>
          {items.map((item) => (
            <ItemRow key={item.id} item={item} now={now} compact={compact} showRepo={true} />
          ))}
        </ul>
      )}
    </div>
  )
}
