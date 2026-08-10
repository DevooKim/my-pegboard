import { RefreshCw } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
import {
  commands,
  type LinearPreset,
  type LinearSort,
  type LinearTeam,
  type LinearWidgetConfig,
} from '#/ipc/bindings'
import { relativeTime, useNow } from '#/ui/relativeTime'
import type { WidgetConfigFormProps } from '#/widgets/types'

/**
 * Linear 위젯 설정 (DECISIONS 25.3).
 *
 * Jira·GitHub 설정 폼과 같은 구조지만 **없는 것이 둘 있다:**
 *
 * 1. **직접 입력(탈출구)이 없다.** Linear의 필터는 문자열이 아니라 `IssueFilter`
 *    JSON 객체다. 사용자에게 GraphQL 필터 JSON을 쓰게 하는 것은 탈출구가 아니라
 *    함정이다 — 우리가 검증할 수 없고, 에러도 JQL만큼 친절하지 않다.
 *    프리셋 × 팀 범위의 조합으로 커버한다
 * 2. **열 설정이 없다.** Jira의 10열은 필드 채움률 실측(라벨 0/22 등)을 근거로
 *    골랐는데, Linear는 실측이 없다. GitHub처럼 고정 2행으로 둔다
 *
 * 정렬은 **두 종뿐이다.** `PaginationOrderBy`가 그것만 준다 — 없는 정렬을
 * 드롭다운에 넣으면 설정 UI가 거짓말을 한다.
 */
export function LinearConfigForm({ config, onChange }: WidgetConfigFormProps<LinearWidgetConfig>) {
  const [presets, setPresets] = useState<LinearPreset[]>([])
  const [teams, setTeams] = useState<LinearTeam[]>([])
  const [fetchedAt, setFetchedAt] = useState<string | null>(null)
  const [refreshing, setRefreshing] = useState(false)
  const [teamsError, setTeamsError] = useState<string | null>(null)
  const now = useNow()

  const loadTeams = useCallback(async (force: boolean) => {
    if (force) setRefreshing(true)
    const r = await commands.linearTeams(force)
    if (r.status === 'ok') {
      setTeams(r.data.teams)
      setFetchedAt(r.data.fetchedAt)
      setTeamsError(null)
    } else {
      // 조용히 빈 목록을 두지 않는다. 왜 비었는지 말한다.
      setTeamsError(r.error)
    }
    setRefreshing(false)
  }, [])

  useEffect(() => {
    void commands.linearPresets().then(setPresets)
    void loadTeams(false)
  }, [loadTeams])

  const selectedTeams = config.teams ?? []
  const preset = presets.find((p) => p.id === config.query.id)
  const defaultTitle = preset?.name ?? 'Linear'

  const toggleTeam = (id: string) => {
    const next = selectedTeams.includes(id)
      ? selectedTeams.filter((t) => t !== id)
      : [...selectedTeams, id]
    onChange({ ...config, teams: next })
  }

  return (
    <div className="flex flex-col">
      <Section>
        <label className="flex flex-col gap-1">
          <span className="text-caption text-text-secondary">위젯 이름</span>
          <input
            data-selectable
            value={config.title ?? ''}
            onChange={(e) => onChange({ ...config, title: e.target.value })}
            placeholder={defaultTitle}
            className="rounded border border-border-subtle bg-surface-inset px-2 py-1.5
                       text-body text-text-primary placeholder:text-text-quaternary"
          />
        </label>

        <label className="flex flex-col gap-1">
          <span className="text-caption text-text-secondary">쿼리</span>
          <select
            value={config.query.id}
            onChange={(e) => onChange({ ...config, query: { kind: 'preset', id: e.target.value } })}
            className="rounded border border-border-subtle bg-surface-inset px-2 py-2.5
                       text-body text-text-primary"
          >
            {/* 프리셋을 아직 못 불러왔으면 현재 값으로 임시 옵션을 넣는다.
                안 그러면 select가 첫 항목을 고른 것처럼 보인다. */}
            {presets.length === 0 && <option value={config.query.id}>불러오는 중…</option>}
            {presets.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
          {preset && <span className="text-caption text-text-tertiary">{preset.description}</span>}
        </label>

        <label className="flex flex-col gap-1">
          <span className="text-caption text-text-secondary">정렬</span>
          <select
            value={config.sort ?? 'updatedAt'}
            onChange={(e) => onChange({ ...config, sort: e.target.value as LinearSort })}
            className="rounded border border-border-subtle bg-surface-inset px-2 py-2.5
                       text-body text-text-primary"
          >
            <option value="updatedAt">최근 업데이트순</option>
            <option value="createdAt">최근 생성순</option>
          </select>
          {/* **없는 선택지를 왜 안 만들었는지 적는다.** 우선순위·마감일 정렬을
              찾다가 없어서 "빠뜨렸나" 하는 것을 막는다. */}
          <span className="text-caption text-text-tertiary leading-relaxed-ko">
            Linear API가 제공하는 정렬은 이 둘뿐입니다. 우선순위·마감일 정렬은 Linear 웹에서 보세요.
          </span>
        </label>
      </Section>

      {/* 범위 — 프리셋 전부에 적용된다. */}
      <Section>
        <div className="flex flex-col gap-1.5">
          <span className="flex items-center gap-2">
            <span className="text-caption text-text-secondary">팀 범위</span>
            <button
              type="button"
              onClick={() => void loadTeams(true)}
              disabled={refreshing}
              title="팀 목록 새로고침"
              className="rounded p-0.5 text-text-quaternary hover:text-text-secondary
                         disabled:opacity-40 focus-visible:outline-2 focus-visible:outline-accent"
            >
              <RefreshCw size={11} className={refreshing ? 'animate-spin' : ''} />
            </button>
            {fetchedAt && (
              <span className="text-caption text-text-quaternary">
                {relativeTime(fetchedAt, new Date(now))}
              </span>
            )}
          </span>

          {teamsError && (
            <p className="rounded bg-danger-muted px-2 py-1 text-caption text-danger">
              {teamsError}
            </p>
          )}

          {!teamsError && teams.length === 0 && (
            <p className="text-caption text-text-tertiary leading-relaxed-ko">
              팀이 없습니다. 설정에서 Linear API 키를 먼저 저장한 뒤 ↻를 누르세요.
            </p>
          )}

          {teams.length > 0 && (
            <>
              <ul className="max-h-40 space-y-0.5 overflow-y-auto rounded border border-border-subtle bg-surface-inset p-1.5">
                {teams.map((team) => (
                  <li key={team.id}>
                    <label className="flex cursor-pointer items-center gap-2 rounded px-1 py-0.5 hover:bg-surface-raised">
                      <input
                        type="checkbox"
                        checked={selectedTeams.includes(team.id)}
                        onChange={() => toggleTeam(team.id)}
                        className="accent-accent"
                      />
                      <span className="min-w-0 flex-1 truncate text-body text-text-primary">
                        {team.name}
                      </span>
                      <span className="ticket-key shrink-0 text-text-quaternary">{team.key}</span>
                    </label>
                  </li>
                ))}
              </ul>
              <span className="text-caption text-text-tertiary leading-relaxed-ko">
                아무것도 고르지 않으면 전체 팀입니다. 고른 순서가 아래 <b>팀별 묶기</b>의 그룹
                순서가 됩니다.
              </span>
            </>
          )}
        </div>
      </Section>

      <Section>
        <label className="flex items-center gap-2">
          <input
            type="checkbox"
            checked={config.groupByTeam ?? true}
            onChange={(e) => onChange({ ...config, groupByTeam: e.target.checked })}
            className="accent-accent"
          />
          <span className="text-body text-text-primary">팀별로 묶어서 보기</span>
        </label>
        {(config.groupByTeam ?? true) && (
          <span className="text-caption text-text-tertiary">
            그룹 순서는 위 <b>팀 범위</b>에서 고른 순서를 따릅니다. 범위를 지정하지 않으면 최근
            갱신순입니다.
          </span>
        )}
      </Section>

      <Section last>
        <NumberField
          label="최대 건수"
          value={config.maxResults}
          min={5}
          max={100}
          onChange={(v) => onChange({ ...config, maxResults: v })}
        />
        <NumberField
          label="새로고침 주기 (초)"
          value={config.refreshSecs ?? 300}
          min={0}
          max={3600}
          hint="0이면 자동 갱신하지 않습니다"
          onChange={(v) => onChange({ ...config, refreshSecs: v })}
        />
      </Section>
    </div>
  )
}

function Section({ last, children }: { last?: boolean; children: React.ReactNode }) {
  return (
    <div className={`flex flex-col gap-3 px-3 py-3 ${last ? '' : 'border-border-subtle border-b'}`}>
      {children}
    </div>
  )
}

function NumberField({
  label,
  value,
  min,
  max,
  hint,
  onChange,
}: {
  label: string
  value: number
  min: number
  max: number
  hint?: string
  onChange: (v: number) => void
}) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-caption text-text-secondary">{label}</span>
      <input
        type="number"
        data-selectable
        value={value}
        min={min}
        max={max}
        onChange={(e) => {
          const n = Number.parseInt(e.target.value, 10)
          if (!Number.isNaN(n)) onChange(Math.min(Math.max(n, min), max))
        }}
        className="w-28 rounded border border-border-subtle bg-surface-inset px-2 py-1.5
                   text-body text-text-primary"
      />
      {hint && <span className="text-caption text-text-tertiary">{hint}</span>}
    </label>
  )
}
