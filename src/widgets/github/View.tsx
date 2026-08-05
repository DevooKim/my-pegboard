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

  // **범위에서 고른 순서가 곧 그룹 순서다.** 별도 설정을 두지 않는다.
  //
  // `repoOrder`를 따로 갖고 있었는데, 같은 저장소 목록을 두 군데서 고르게
  // 만드는 것이라 없앴다. 범위를 지정하지 않으면 여기가 빈 배열이 되고
  // `groupByRepo`가 최근 갱신순으로 정렬한다.
  const groups = useMemo(
    () => (grouped ? groupByRepo(items, config.repos ?? []) : null),
    [items, grouped, config.repos],
  )

  if (items.length === 0) return null // WidgetShell이 빈/로딩/에러를 그린다

  return (
    <div className="h-full overflow-y-auto px-1.5 py-1">
      {groups ? (
        groups.map((group) => (
          <section key={group.repo}>
            {/* 그룹 헤더.
                14px(text-base)은 위젯 제목과 같은 크기다 — 이것도 제목이므로 맞다.
                항목(13px)보다 크지만 색을 한 단 낮춰(secondary) 본문을 이기지
                않게 한다. 12px일 때는 저장소를 읽기 위해 눈을 모아야 했다.

                **sticky를 쓰지 않는다.** 처음엔 "스크롤 중에도 어느 저장소인지
                보이게" 하려고 걸었는데, 위젯 높이가 10행 남짓이라 고정된 헤더가
                보이는 행을 잡아먹는다. 첫 헤더만 상단에 붙어 있는 것처럼 보여
                고장으로 읽힌다. 그룹이 짧으면 헤더가 곧 다시 나타나므로
                고정할 값어치가 없다. */}
            <h3
              className="truncate px-1.5 pt-2 pb-1 text-base text-text-secondary"
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
