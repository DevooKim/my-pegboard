import { Check, GripVertical, Search, X } from 'lucide-react'
import { useEffect, useId, useMemo, useRef, useState } from 'react'
import type { GithubRepo } from '#/ipc/bindings'

/**
 * 저장소·조직 범위 선택.
 *
 * # 왜 칩 나열이 아니라 드롭다운인가
 *
 * 저장소가 70개가 넘는다(실측 72). 전부 칩으로 늘어놓으면 설정창이 그것으로
 * 가득 차고, 원하는 것을 눈으로 찾아야 한다. 검색이 있어야 쓸 만하다.
 *
 * # 조직과 저장소는 함께 쓰면 안 된다
 *
 * GitHub 검색에서 `org:x repo:o/a`는 **합집합**이다(실측 2026-08-05).
 * "x 조직 안에서 o/a만"이 아니라 "x 조직 전체 **또는** o/a"가 된다.
 * 서로 다른 한정자끼리 AND일 거라 기대하기 쉬워서, 둘 다 고르면 경고를 띄운다.
 *
 * 막지는 않는다 — 의도적으로 합집합을 원할 수도 있고, 우리가 사용자를
 * 대신 판단하지 않는다. 다만 놀라지 않게 알려준다.
 */
export function ScopePicker({
  repos,
  selectedRepos,
  selectedOrgs,
  onChangeRepos,
  onChangeOrgs,
}: {
  repos: GithubRepo[]
  selectedRepos: string[]
  selectedOrgs: string[]
  onChangeRepos: (next: string[]) => void
  onChangeOrgs: (next: string[]) => void
}) {
  const [query, setQuery] = useState('')
  const [open, setOpen] = useState(false)
  const [cursor, setCursor] = useState(0)
  /** 지금 끌고 있는 항목. 종류가 다르면 서로 못 섞인다. */
  const [drag, setDrag] = useState<{ kind: 'org' | 'repo'; id: string } | null>(null)
  const boxRef = useRef<HTMLDivElement | null>(null)
  const listId = useId()

  // 목록에서 조직을 뽑는다. 저장소 소유자 중 조직인 것들.
  const orgs = useMemo(() => {
    const seen = new Map<string, number>()
    for (const r of repos) {
      // owner는 serde(default)라 생성 타입에서 optional이다. 이 필드가 생기기
      // 전의 캐시에는 값이 없으므로, 없으면 이름에서 잘라 쓴다.
      if (!r.isOrganization) continue
      const login = r.owner || r.nameWithOwner.split('/')[0]
      if (login) seen.set(login, (seen.get(login) ?? 0) + 1)
    }
    return [...seen.entries()]
      .map(([login, count]) => ({ login, count }))
      .sort((a, b) => b.count - a.count)
  }, [repos])

  /**
   * 검색 결과. 조직을 먼저, 저장소를 뒤에 둔다.
   *
   * 이미 고른 것은 목록에서 빼지 않는다 — 다시 눌러 해제할 수 있어야 하고,
   * 항목이 사라졌다 나타나면 목록이 출렁인다.
   */
  const matches = useMemo(() => {
    const q = query.trim().toLowerCase()
    const orgRows = orgs
      .filter((o) => !q || o.login.toLowerCase().includes(q))
      .map((o) => ({
        kind: 'org' as const,
        id: o.login,
        label: o.login,
        meta: `저장소 ${o.count}`,
      }))
    const repoRows = repos
      .filter((r) => !q || r.nameWithOwner.toLowerCase().includes(q))
      .map((r) => ({
        kind: 'repo' as const,
        id: r.nameWithOwner,
        label: r.nameWithOwner,
        meta: r.isPrivate ? '비공개' : '',
      }))
    return [...orgRows, ...repoRows]
  }, [orgs, repos, query])

  // 검색어가 바뀌면 커서를 맨 위로. 안 그러면 없는 항목을 가리킨다.
  useEffect(() => setCursor(0), [])

  // 바깥을 누르면 닫는다.
  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [open])

  const isSelected = (kind: 'org' | 'repo', id: string) =>
    kind === 'org' ? selectedOrgs.includes(id) : selectedRepos.includes(id)

  const toggle = (kind: 'org' | 'repo', id: string) => {
    if (kind === 'org') {
      onChangeOrgs(
        selectedOrgs.includes(id) ? selectedOrgs.filter((o) => o !== id) : [...selectedOrgs, id],
      )
    } else {
      onChangeRepos(
        selectedRepos.includes(id) ? selectedRepos.filter((r) => r !== id) : [...selectedRepos, id],
      )
    }
  }

  const bothUsed = selectedOrgs.length > 0 && selectedRepos.length > 0
  const totalSelected = selectedOrgs.length + selectedRepos.length

  /**
   * 같은 종류 안에서만 옮긴다.
   *
   * 조직과 저장소를 섞어 정렬하지 않는 이유: `apply_scope`가 `org:`를 먼저
   * 내보내므로 검색 문자열 순서와 화면 순서가 어긋난다. 종류별로 묶어두면
   * 화면에 보이는 순서가 곧 실제 순서다.
   */
  const moveWithin = (kind: 'org' | 'repo', toIndex: number) => {
    if (!drag || drag.kind !== kind) return
    const list = kind === 'org' ? selectedOrgs : selectedRepos
    const next = list.filter((x) => x !== drag.id)
    next.splice(toIndex, 0, drag.id)
    if (kind === 'org') onChangeOrgs(next)
    else onChangeRepos(next)
  }

  return (
    <div className="flex flex-col gap-1.5" ref={boxRef}>
      {/* 고른 것들 — **이 순서가 곧 그룹 순서다.** 끌어서 바꾼다.
          조직을 저장소보다 위에 두는 것은 강제다(넓은 범위가 먼저 읽힌다). */}
      {totalSelected > 0 && (
        <ul className="flex flex-col">
          {selectedOrgs.map((o, i) => (
            <SelectedRow
              key={`org:${o}`}
              label={`org:${o}`}
              isOrg
              dragging={drag?.kind === 'org' && drag.id === o}
              onDragStart={() => setDrag({ kind: 'org', id: o })}
              onDragEnd={() => setDrag(null)}
              onDropHere={() => moveWithin('org', i)}
              onRemove={() => toggle('org', o)}
            />
          ))}
          {selectedRepos.map((r, i) => (
            <SelectedRow
              key={`repo:${r}`}
              label={r}
              isOrg={false}
              dragging={drag?.kind === 'repo' && drag.id === r}
              onDragStart={() => setDrag({ kind: 'repo', id: r })}
              onDragEnd={() => setDrag(null)}
              onDropHere={() => moveWithin('repo', i)}
              onRemove={() => toggle('repo', r)}
            />
          ))}
        </ul>
      )}

      {/* 검색 입력 */}
      <div className="relative">
        <Search
          size={12}
          aria-hidden="true"
          className="-translate-y-1/2 pointer-events-none absolute top-1/2 left-2 text-text-quaternary"
        />
        <input
          data-selectable
          value={query}
          onChange={(e) => {
            setQuery(e.target.value)
            setCursor(0)
            setOpen(true)
          }}
          onFocus={() => setOpen(true)}
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown') {
              e.preventDefault()
              setOpen(true)
              setCursor((c) => Math.min(c + 1, matches.length - 1))
            } else if (e.key === 'ArrowUp') {
              e.preventDefault()
              setCursor((c) => Math.max(c - 1, 0))
            } else if (e.key === 'Enter') {
              e.preventDefault()
              const row = matches[cursor]
              if (row) toggle(row.kind, row.id)
            } else if (e.key === 'Escape') {
              // 목록만 닫는다. 모달까지 닫히면 고르던 것을 잃는다.
              if (open) {
                e.stopPropagation()
                setOpen(false)
              }
            }
          }}
          role="combobox"
          aria-expanded={open}
          aria-controls={listId}
          placeholder="저장소·조직 검색"
          className="w-full rounded border border-border-subtle bg-surface-inset py-1.5 pr-2 pl-7
                     text-body text-text-primary placeholder:text-text-quaternary
                     focus-visible:outline-2 focus-visible:outline-accent"
        />
      </div>

      {open && (
        <ul
          id={listId}
          className="max-h-56 overflow-y-auto rounded border border-border-subtle bg-surface-overlay py-0.5"
        >
          {matches.length === 0 ? (
            <li className="px-2 py-1.5 text-caption text-text-tertiary">
              {repos.length === 0 ? '저장소 목록이 비어 있습니다' : '일치하는 항목이 없습니다'}
            </li>
          ) : (
            matches.map((row, i) => {
              const on = isSelected(row.kind, row.id)
              return (
                <li key={`${row.kind}:${row.id}`}>
                  <button
                    type="button"
                    onClick={() => toggle(row.kind, row.id)}
                    onMouseEnter={() => setCursor(i)}
                    className={`flex w-full items-center gap-1.5 px-2 py-1 text-left text-caption
                                ${i === cursor ? 'bg-surface-hover' : ''}
                                ${on ? 'text-text-primary' : 'text-text-secondary'}`}
                  >
                    <span className="w-3 shrink-0">
                      {on && <Check size={11} className="text-accent" />}
                    </span>
                    {row.kind === 'org' && (
                      <span className="shrink-0 rounded bg-accent-subtle px-1 text-accent">
                        조직
                      </span>
                    )}
                    <span className="min-w-0 flex-1 truncate">{row.label}</span>
                    {row.meta && <span className="shrink-0 text-text-quaternary">{row.meta}</span>}
                  </button>
                </li>
              )
            })
          )}
        </ul>
      )}

      {/* 합집합 경고. 막지는 않되 놀라지 않게 한다. */}
      {bothUsed && (
        <p className="rounded bg-warning-muted px-2 py-1 text-caption text-warning leading-relaxed-ko">
          조직과 저장소를 함께 고르면 <b>둘 중 하나라도 해당</b>하는 항목이 모두 나옵니다 (교집합이
          아닙니다). 범위를 좁히려면 한쪽만 쓰세요.
        </p>
      )}

      <span className="text-caption text-text-tertiary">
        {totalSelected === 0
          ? '전체 저장소'
          : `조직 ${selectedOrgs.length} · 저장소 ${selectedRepos.length}`}
      </span>
    </div>
  )
}

/**
 * 고른 항목 한 줄. **이 목록의 순서가 곧 그룹 순서다.**
 *
 * 끄는 주체는 **손잡이**다. 행에 `draggable`을 걸고 켰다 껐다 하면 React
 * 재조정과 싸우게 된다 — Todo 위젯에서 두 번 실패한 기록이 DECISIONS 13에 있다.
 * 손잡이를 항상 draggable로 두면 켜고 끌 일이 없다.
 */
function SelectedRow({
  label,
  isOrg,
  dragging,
  onDragStart,
  onDragEnd,
  onDropHere,
  onRemove,
}: {
  label: string
  isOrg: boolean
  dragging: boolean
  onDragStart: () => void
  onDragEnd: () => void
  onDropHere: () => void
  onRemove: () => void
}) {
  return (
    <li
      onDragOver={(e) => {
        e.preventDefault()
        e.dataTransfer.dropEffect = 'move'
      }}
      onDrop={(e) => {
        e.preventDefault()
        onDropHere()
      }}
      className={`group flex items-center gap-1.5 rounded px-1 py-0.5
                  ${dragging ? 'bg-surface-inset opacity-25' : 'hover:bg-surface-inset'}`}
    >
      <span
        draggable
        onDragStart={(e) => {
          e.dataTransfer.setData('text/plain', label)
          e.dataTransfer.effectAllowed = 'move'
          // 한 프레임 미룬다 — dragstart 중에 모양을 바꾸면 캡처가 어긋난다.
          requestAnimationFrame(onDragStart)
        }}
        onDragEnd={onDragEnd}
        title="끌어서 순서 변경"
        aria-hidden="true"
        className="shrink-0 cursor-grab rounded p-0.5 text-text-quaternary opacity-0
                   transition-opacity duration-fast active:cursor-grabbing
                   group-hover:opacity-100"
      >
        <GripVertical size={11} />
      </span>

      {isOrg && (
        <span className="shrink-0 rounded bg-accent-subtle px-1 text-caption text-accent">
          조직
        </span>
      )}
      <span className="min-w-0 flex-1 truncate text-caption text-text-primary">{label}</span>

      <button
        type="button"
        onClick={onRemove}
        aria-label={`${label} 제거`}
        title="범위에서 빼기"
        className="shrink-0 rounded p-0.5 text-text-quaternary opacity-0 transition-opacity
                   duration-fast hover:text-danger focus-visible:opacity-100
                   group-hover:opacity-100"
      >
        <X size={11} />
      </button>
    </li>
  )
}
