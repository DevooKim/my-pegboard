import { openUrl } from '@tauri-apps/plugin-opener'
import {
  CircleCheck,
  CircleDot,
  CircleSlash,
  GitMerge,
  GitPullRequest,
  GitPullRequestDraft,
  MessageSquare,
} from 'lucide-react'
import type { GithubItem } from '#/ipc/bindings'
import { relativeTime } from '#/ui/relativeTime'
import { shortRepo } from './grouping'

/**
 * 목록 한 줄. **2행 구성**이다.
 *
 * ```
 * ⇅ feat: 로비 세리머니 동상 2개 + 이동 범위 확장
 *   my-gallery #1 · ✓ · CI✓ · +1149 −29 · 2일 전
 * ```
 *
 * Jira 위젯은 1행 밀집인데 여기가 2행인 이유: **GitHub 제목이 훨씬 길다.**
 * 실측에서 "feat: 설치형 앱 창으로 띄울 수 있도록 PWA 지원 추가" 같은 것이
 * 나온다. 제목을 메타데이터와 한 줄에 두면 둘 다 잘린다.
 *
 * 상세 모달은 없다 — 누르면 브라우저로 나간다 (DECISIONS 12).
 */
export function ItemRow({
  item,
  now,
  compact,
  showRepo,
}: {
  item: GithubItem
  /** 상대 시간 갱신용. 1분마다 바뀐다. */
  now: number
  /** 폭이 좁은가. 저장소 이름에서 owner를 버린다. */
  compact: boolean
  /** 저장소 이름을 2행에 그릴까. 그룹 헤더가 이미 보여주면 끈다. */
  showRepo: boolean
}) {
  return (
    <li>
      <button
        type="button"
        onClick={() => void openUrl(item.url)}
        title={`${item.repository}#${item.number} — GitHub에서 열기`}
        className="group flex w-full flex-col gap-0.5 rounded px-1.5 py-1 text-left
                   transition-colors duration-fast hover:bg-surface-inset
                   focus-visible:outline-2 focus-visible:outline-accent"
      >
        {/* 1행 — 아이콘 + 제목. 제목이 가장 중요하므로 한 줄을 통째로 준다. */}
        <span className="flex min-w-0 items-start gap-1.5">
          <StateIcon item={item} />
          <span className="min-w-0 flex-1 truncate text-body text-text-primary">{item.title}</span>
        </span>

        {/* 2행 — 메타데이터. 흐리게. */}
        <span className="flex min-w-0 items-center gap-1 pl-[18px] text-caption text-text-quaternary">
          {showRepo && (
            <span className="truncate">
              {shortRepo(item.repository, compact)}
              <span className="text-text-quaternary">#{item.number}</span>
            </span>
          )}
          {!showRepo && <span>#{item.number}</span>}

          <ReviewBadge item={item} />
          <CiBadge item={item} />
          <SizeBadge item={item} />

          {item.comments > 0 && (
            <>
              <Dot />
              <span className="flex shrink-0 items-center gap-0.5">
                <MessageSquare size={9} aria-hidden="true" />
                {item.comments}
              </span>
            </>
          )}

          <Dot />
          <span className="shrink-0 tabular-nums">
            {relativeTime(item.updatedAt, new Date(now))}
          </span>
        </span>
      </button>
    </li>
  )
}

function Dot() {
  return (
    <span aria-hidden="true" className="shrink-0">
      ·
    </span>
  )
}

/**
 * 종류(PR/Issue)와 상태를 아이콘 하나로 표현한다.
 *
 * 둘을 따로 그리면 좁은 폭에서 자리를 두 배로 먹는다. GitHub 자체가 쓰는
 * 관례라 학습 비용도 없다.
 */
function StateIcon({ item }: { item: GithubItem }) {
  const size = 12
  const cls = 'mt-0.5 shrink-0'

  if (item.isPullRequest) {
    switch (item.state) {
      case 'merged':
        return <GitMerge size={size} className={`${cls} text-merged`} aria-label="머지됨" />
      case 'draft':
        return (
          <GitPullRequestDraft
            size={size}
            className={`${cls} text-text-quaternary`}
            aria-label="초안"
          />
        )
      case 'closed':
        return <CircleSlash size={size} className={`${cls} text-danger`} aria-label="닫힘" />
      default:
        return <GitPullRequest size={size} className={`${cls} text-success`} aria-label="열린 PR" />
    }
  }

  return item.state === 'closed' ? (
    <CircleCheck size={size} className={`${cls} text-merged`} aria-label="닫힌 이슈" />
  ) : (
    <CircleDot size={size} className={`${cls} text-success`} aria-label="열린 이슈" />
  )
}

/** 리뷰 상태. 리뷰어가 지정되지 않았으면 아무것도 그리지 않는다(실측: null). */
function ReviewBadge({ item }: { item: GithubItem }) {
  if (!item.review) return null

  const [label, tone, text] =
    item.review === 'approved'
      ? ['승인됨', 'text-success', '승인']
      : item.review === 'changesRequested'
        ? ['변경 요청됨', 'text-danger', '변경요청']
        : ['리뷰 대기', 'text-text-tertiary', '리뷰대기']

  return (
    <>
      <Dot />
      <span className={`shrink-0 ${tone}`} title={label}>
        {text}
      </span>
    </>
  )
}

/** CI. 안 돌리는 저장소면 `null`이라 그리지 않는다. */
function CiBadge({ item }: { item: GithubItem }) {
  if (!item.ci) return null

  const [label, tone] =
    item.ci === 'success'
      ? ['CI 성공', 'text-success']
      : item.ci === 'failure'
        ? ['CI 실패', 'text-danger']
        : item.ci === 'pending'
          ? ['CI 진행 중', 'text-warning']
          : ['CI 상태 불명', 'text-text-quaternary']

  return (
    <>
      <Dot />
      <span className={`shrink-0 ${tone}`} title={label}>
        CI
      </span>
    </>
  )
}

/** 변경 규모. PR만 있다. */
function SizeBadge({ item }: { item: GithubItem }) {
  if (item.additions === null || item.deletions === null) return null
  return (
    <>
      <Dot />
      <span className="shrink-0 tabular-nums" title="변경 규모">
        <span className="text-success">+{item.additions}</span>{' '}
        <span className="text-danger">−{item.deletions}</span>
      </span>
    </>
  )
}
