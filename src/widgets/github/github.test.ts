import { describe, expect, it } from 'vitest'
import type { GithubItem } from '#/ipc/bindings'
import { groupByRepo, shortRepo } from '#/widgets/github/grouping'

function item(over: Partial<GithubItem> = {}): GithubItem {
  return {
    id: 'o/r#1',
    number: 1,
    title: '제목',
    repository: 'o/r',
    url: 'https://github.com/o/r/pull/1',
    author: 'someone',
    isPullRequest: true,
    state: 'open',
    review: null,
    ci: null,
    additions: 1,
    deletions: 0,
    updatedAt: '2026-08-01T00:00:00Z',
    comments: 0,
    ...over,
  }
}

describe('groupByRepo', () => {
  it('저장소별로 묶는다', () => {
    const groups = groupByRepo(
      [
        item({ id: 'a#1', repository: 'o/a' }),
        item({ id: 'b#1', repository: 'o/b' }),
        item({ id: 'a#2', repository: 'o/a' }),
      ],
      [],
    )

    expect(groups).toHaveLength(2)
    expect(groups.find((g) => g.repo === 'o/a')?.items).toHaveLength(2)
  })

  /**
   * "지금 뭐가 움직였나"가 이 앱의 목적이다. 이름순이나 개수순으로 두면
   * 오래된 저장소가 위에 눌러앉아 최신 항목이 아래로 밀린다.
   */
  it('지정이 없으면 최신 항목이 있는 저장소가 위로', () => {
    const groups = groupByRepo(
      [
        item({ id: 'old#1', repository: 'o/old', updatedAt: '2026-07-01T00:00:00Z' }),
        item({ id: 'new#1', repository: 'o/new', updatedAt: '2026-08-02T00:00:00Z' }),
      ],
      [],
    )

    expect(groups.map((g) => g.repo)).toEqual(['o/new', 'o/old'])
  })

  it('지정한 순서가 최신순을 이긴다', () => {
    const groups = groupByRepo(
      [
        item({ id: 'new#1', repository: 'o/new', updatedAt: '2026-08-02T00:00:00Z' }),
        item({ id: 'pinned#1', repository: 'o/pinned', updatedAt: '2026-01-01T00:00:00Z' }),
      ],
      ['o/pinned'],
    )

    expect(groups[0]?.repo).toBe('o/pinned')
  })

  it('지정 순서를 그대로 따른다', () => {
    const groups = groupByRepo(
      [
        item({ id: 'a#1', repository: 'o/a' }),
        item({ id: 'b#1', repository: 'o/b' }),
        item({ id: 'c#1', repository: 'o/c' }),
      ],
      ['o/c', 'o/a', 'o/b'],
    )

    expect(groups.map((g) => g.repo)).toEqual(['o/c', 'o/a', 'o/b'])
  })

  /**
   * **숨기면 리뷰 요청이 조용히 사라진다** (CLAUDE.md 대전제 2).
   * 순서와 필터는 다른 기능이다.
   */
  it('지정하지 않은 저장소도 반드시 나온다', () => {
    const groups = groupByRepo(
      [
        item({ id: 'pinned#1', repository: 'o/pinned' }),
        item({ id: 'other#1', repository: 'o/other' }),
      ],
      ['o/pinned'],
    )

    expect(groups.map((g) => g.repo)).toEqual(['o/pinned', 'o/other'])
  })

  /** 목록에 없는 저장소를 지정해도 깨지지 않아야 한다(설정만 남은 경우). */
  it('결과에 없는 저장소를 지정해도 무시된다', () => {
    const groups = groupByRepo([item({ repository: 'o/a' })], ['o/사라진저장소', 'o/a'])

    expect(groups.map((g) => g.repo)).toEqual(['o/a'])
  })

  it('그룹 안 항목은 입력 순서를 지킨다', () => {
    const groups = groupByRepo(
      [item({ id: 'first', repository: 'o/a' }), item({ id: 'second', repository: 'o/a' })],
      [],
    )

    expect(groups[0]?.items.map((i) => i.id)).toEqual(['first', 'second'])
  })

  it('빈 목록이면 빈 결과', () => {
    expect(groupByRepo([], ['o/a'])).toEqual([])
  })
})

describe('shortRepo', () => {
  it('좁으면 owner를 버린다', () => {
    expect(shortRepo('DevooKim/my-gallery', true)).toBe('my-gallery')
  })

  it('넓으면 그대로 둔다', () => {
    expect(shortRepo('DevooKim/my-gallery', false)).toBe('DevooKim/my-gallery')
  })

  /** 슬래시가 없는 이상한 값이 와도 잘라내지 않는다. */
  it('슬래시가 없으면 그대로', () => {
    expect(shortRepo('weird', true)).toBe('weird')
  })
})
