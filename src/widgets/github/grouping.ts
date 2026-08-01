import type { GithubItem } from '#/ipc/bindings'

/**
 * 저장소별 묶음. 화면이 그리는 단위 그대로다.
 */
export interface RepoGroup {
  repo: string
  items: GithubItem[]
}

/**
 * 항목을 저장소별로 묶고 순서를 정한다.
 *
 * # 그룹 순서
 *
 * 1. `order`에 지정된 저장소를 그 순서대로 (사용자가 설정창에서 끌어 정한 것)
 * 2. 나머지는 **그룹 안 최신 항목 기준 내림차순**
 *
 * 2번이 최신순인 이유: "지금 뭐가 움직였나"가 이 앱의 목적이다. 이름순이나
 * 항목 수순으로 두면 오래된 저장소가 위에 눌러앉아 최신 항목이 아래로 밀린다.
 *
 * **지정되지 않은 저장소도 반드시 나온다.** 숨기면 리뷰 요청이 조용히 사라진다
 * (CLAUDE.md 대전제 2). 필터가 필요하면 설정의 저장소 범위를 쓴다 — 순서와
 * 필터는 다른 기능이다.
 *
 * 그룹 안 항목은 입력 순서를 지킨다. Rust가 준 순서가 곧 GitHub의 관련도순이다.
 */
export function groupByRepo(items: GithubItem[], order: string[]): RepoGroup[] {
  const groups = new Map<string, GithubItem[]>()
  for (const item of items) {
    const bucket = groups.get(item.repository)
    if (bucket) bucket.push(item)
    else groups.set(item.repository, [item])
  }

  // 지정된 순서를 인덱스로 바꿔 비교에 쓴다. 목록에 없으면 Infinity.
  const rank = new Map(order.map((repo, i) => [repo, i]))

  return [...groups.entries()]
    .map(([repo, groupItems]) => ({ repo, items: groupItems }))
    .sort((a, b) => {
      const ra = rank.get(a.repo) ?? Number.POSITIVE_INFINITY
      const rb = rank.get(b.repo) ?? Number.POSITIVE_INFINITY
      if (ra !== rb) return ra - rb
      // 둘 다 미지정이면 최신 항목이 있는 쪽이 위로.
      return newestOf(b.items).localeCompare(newestOf(a.items))
    })
}

/** 그룹 안에서 가장 최근에 갱신된 시각. 문자열 비교로 충분하다 — ISO 8601이다. */
function newestOf(items: GithubItem[]): string {
  let newest = ''
  for (const item of items) {
    if (item.updatedAt > newest) newest = item.updatedAt
  }
  return newest
}

/**
 * 저장소 이름을 화면 폭에 맞춰 줄인다.
 *
 * `owner/name`에서 소유자는 대개 자명하다(내 저장소이거나 늘 보는 조직).
 * 좁을 때 버리는 쪽이 이름을 자르는 것보다 정보 손실이 적다.
 */
export function shortRepo(nameWithOwner: string, compact: boolean): string {
  if (!compact) return nameWithOwner
  const slash = nameWithOwner.indexOf('/')
  return slash === -1 ? nameWithOwner : nameWithOwner.slice(slash + 1)
}
