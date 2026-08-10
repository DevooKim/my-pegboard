# Linear Creation, Custom Query, Sorting, and Ticket Copy Implementation Plan

**Goal:** Jira와 Linear 상세에서 티켓 ID를 복사하고, Linear 이슈 생성, 타입 기반 AND 필터, 생성일/수정일 양방향 서버 정렬을 기존 캐시 우선 및 오류 노출 원칙을 지키며 제공한다.

**Architecture:** React는 타입화된 폼 상태와 화면 피드백만 소유하고 모든 Linear GraphQL 조립, 검증, 인증, 메타데이터 캐시, 생성 결과 판정은 Rust가 소유한다. `LinearQuery::Custom`은 외부 JSON 대신 명시적 조건을 `board.json`에 저장하고, `linear_meta.json` v2는 전역 및 팀별 선택지를 원자적으로 보존한다. 생성과 상태 변경은 낙관적으로 목록을 수정하지 않으며 성공 뒤 Linear 전용 이벤트로 재조회한다.

**Tech Stack:** React 19, TypeScript 7, Vitest, Testing Library, Tauri 2 IPC, Rust, serde/serde_json, reqwest, chrono, specta/tauri-specta

---

## File Structure Map

### New files

- `src/widgets/jira/TicketIdCopyButton.tsx`: Jira 상세 헤더 전용 ID 복사 상태와 타이머 수명주기.
- `src/widgets/jira/TicketIdCopyButton.test.tsx`: Jira ID 복사 성공, 실패, 1.5초 복구, 키보드 접근성.
- `src/widgets/linear/TicketIdCopyButton.tsx`: Linear 폴더 안에 완결된 동일 계약의 ID 복사 버튼.
- `src/widgets/linear/TicketIdCopyButton.test.tsx`: Linear ID 복사 성공, 실패, 1.5초 복구, 키보드 접근성.
- `src/widgets/linear/customQuery.ts`: 로컬 날짜 입력과 저장용 ISO 8601 경계 사이 변환, 빈 필터 판정.
- `src/widgets/linear/customQuery.test.ts`: 날짜 시작/종료 경계와 빈 필터 판정.
- `src/widgets/linear/CustomQueryFields.tsx`: AND 전용 팀, 담당 관계, 상태 유형, 프로젝트, 라벨, 우선순위, 날짜 조건 UI.
- `src/widgets/linear/ConfigForm.test.tsx`: 프리셋/직접 구성 전환, 메타데이터 오류/절단 표시, 필터 유효성, 정렬 방향 저장.
- `src/widgets/linear/CreateIssueModal.tsx`: Linear 기본 필드 생성 폼과 성공/불확정 실패 화면.
- `src/widgets/linear/CreateIssueModal.test.tsx`: 필수값, 팀 종속 선택 초기화, 선택 필드 전송, 성공, 불확정 실패.
- `src-tauri/src/providers/linear/tests/fixtures/metadata.json`: 공개 스키마 기준 전역 및 팀 메타데이터 응답 fixture.
- `src-tauri/src/providers/linear/tests/fixtures/issue_create.json`: 생성 성공 응답 fixture.

### Modified files

- `src/widgets/jira/IssueDetailModal.tsx`: 헤더 키 `<span>`을 Jira 전용 복사 버튼으로 교체.
- `src/widgets/linear/IssueDetailModal.tsx`: 헤더 식별자를 Linear 전용 복사 버튼으로 교체하고 기존 브랜치 복사의 타이머 정리/실패 노출도 같은 기준으로 보강.
- `src/widgets/linear/ConfigForm.tsx`: 직접 구성 조건과 정렬 필드/방향을 편집하고 통합 메타데이터 응답을 표시.
- `src/widgets/linear/index.ts`: 기본 `sortDirection`, 커스텀 제목 파생, 설명 문구 갱신.
- `src/widgets/linear/useLinearData.ts`: 생성 성공 이벤트를 상태 변경 이벤트와 같은 강제 재조회 경로로 연결.
- `src/widgets/linear/linear.test.tsx`: 생성 이벤트 재조회 회귀 테스트와 새 config 필드 반영.
- `src/board/WidgetHost.tsx`: 연결된 Linear 위젯 헤더 생성 버튼, 생성 모달, 생성된 이슈 상세 골격 연결.
- `src/board/WidgetHost.test.tsx`: Linear 연결 여부에 따른 생성 버튼과 생성 결과 상세 연결.
- `src/widgets/types.ts`: 설정 폼이 적용 버튼에 유효성을 전달하는 선택적 콜백 추가.
- `src/widgets/shell/WidgetConfigModal.tsx`: draft별 유효성 상태와 적용 버튼 비활성화.
- `src/widgets/shell/WidgetConfigModal.test.tsx`: 유효하지 않은 커스텀 필터 저장 차단.
- `src-tauri/src/providers/linear/presets.rs`: `LinearQuery::Custom`, 필터 타입, 정렬 방향, 검증된 `IssueFilter` 생성.
- `src-tauri/src/providers/linear/types.rs`: 양방향 `PageInfo`, 메타데이터 선택지/응답, 생성 입력/응답 파싱 타입.
- `src-tauri/src/providers/linear/client.rs`: 커스텀 최상위 조회, 양방향 페이지 변수, 메타데이터 쿼리, `issueCreate` mutation.
- `src-tauri/src/providers/linear/error.rs`: 생성 실패의 생성 여부 확정 가능성을 기존 오류 종류로 판정하는 헬퍼.
- `src-tauri/src/providers/linear/mod.rs`: 새 공개 타입과 enum 재노출.
- `src-tauri/src/providers/linear/tests/mod.rs`: 필터 변환/검증, 양방향 정렬, 메타데이터 파싱, 생성 판정 테스트.
- `src-tauri/src/storage/linear_meta.rs`: v1 팀 목록을 v2 전역/팀별 메타데이터 캐시로 마이그레이션.
- `src-tauri/src/storage/tests/linear_meta_tests.rs`: v1 마이그레이션, 디스크 왕복, 갱신 실패 시 기존 값 보존.
- `src-tauri/src/commands/linear.rs`: config 방향 기본값, 메타데이터 IPC, 커스텀 검증 경계, 생성 IPC와 실패 타입.
- `src-tauri/src/lib.rs`: 새 Linear 메타데이터/생성 커맨드 등록.
- `src-tauri/src/bindings_export.rs`: 같은 커맨드를 바인딩 생성 목록에 등록.
- `src/ipc/bindings.ts`: `cargo test`로 재생성되는 specta 산출물이며 수동 편집 금지.
- `docs/DECISIONS.md`: 25장의 생성 없음, 직접 입력 없음, 정렬 방향 결정을 승인된 설계로 개정.
- `CLAUDE.md`: Linear 조작 범위와 핵심 필터 UI, 생성, 정렬 방향, 미검증 체크리스트 갱신.
- `src-tauri/src/storage/board.rs`: import 후보 검증, 병합, 저장 성공 후 메모리 교체.
- `src-tauri/src/storage/tests/board_tests.rs`: import 불변식, 병합 ID·이름, 저장 실패 보존.
- `src-tauri/src/commands/board.rs`: Rust 파일 다이얼로그 기반 export, import preview/apply IPC.
- `src/settings/SettingsModal.tsx`: `보드` 탭과 export/import 미리보기·확인 UI.
- `src/settings/SettingsModal.test.tsx`: 보드 탭의 취소·미리보기·교체/병합·오류 노출.

---

### Task 1: Jira Detail Ticket ID Copy

**Files:**
- Create: `src/widgets/jira/TicketIdCopyButton.tsx`
- Create: `src/widgets/jira/TicketIdCopyButton.test.tsx`
- Modify: `src/widgets/jira/IssueDetailModal.tsx:1-3,155-183`

- [ ] **Step 1: Add failing copy contract tests**

```tsx
it('copies the visible Jira key and exposes success for 1.5 seconds', async () => {
  vi.useFakeTimers()
  const writeText = vi.fn().mockResolvedValue(undefined)
  Object.assign(navigator, { clipboard: { writeText } })
  render(<TicketIdCopyButton identifier="EDU-60" />)

  fireEvent.click(screen.getByRole('button', { name: 'EDU-60 복사' }))
  await waitFor(() => expect(writeText).toHaveBeenCalledWith('EDU-60'))
  expect(screen.getByRole('button', { name: 'EDU-60 복사됨' })).toBeInTheDocument()

  await act(async () => vi.advanceTimersByTimeAsync(1_500))
  expect(screen.getByRole('button', { name: 'EDU-60 복사' })).toBeInTheDocument()
})

it('leaves clipboard failure visible in the header', async () => {
  Object.assign(navigator, { clipboard: { writeText: vi.fn().mockRejectedValue(new Error('denied')) } })
  render(<TicketIdCopyButton identifier="EDU-60" />)
  fireEvent.click(screen.getByRole('button', { name: 'EDU-60 복사' }))
  expect(await screen.findByText('복사하지 못했습니다')).toBeInTheDocument()
})
```

- [ ] **Step 2: Run the focused test and confirm RED**

Run: `bun run test -- src/widgets/jira/TicketIdCopyButton.test.tsx`

Expected: FAIL because `./TicketIdCopyButton` does not exist.

- [ ] **Step 3: Implement the Jira-local button and replace the header span**

```tsx
export function TicketIdCopyButton({ identifier }: { identifier: string }) {
  const [status, setStatus] = useState<'idle' | 'copied' | 'error'>('idle')
  const resetTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => () => {
    if (resetTimer.current) clearTimeout(resetTimer.current)
  }, [])

  const copy = async () => {
    if (resetTimer.current) clearTimeout(resetTimer.current)
    try {
      await navigator.clipboard.writeText(identifier)
      setStatus('copied')
      resetTimer.current = setTimeout(() => setStatus('idle'), 1_500)
    } catch {
      setStatus('error')
    }
  }

  return (
    <button type="button" onClick={() => void copy()}
      aria-label={`${identifier} ${status === 'copied' ? '복사됨' : '복사'}`}
      className="ticket-key flex items-center gap-1 rounded text-text-secondary hover:text-accent focus-visible:outline-2 focus-visible:outline-accent">
      {status === 'copied' ? <Check size={11} aria-hidden="true" /> : <Copy size={11} aria-hidden="true" />}
      <span>{identifier}</span>
      {status === 'copied' && <span className="text-caption">복사됨</span>}
      {status === 'error' && <span className="text-caption text-danger">복사하지 못했습니다</span>}
    </button>
  )
}
```

In `IssueDetailModal`, render `<TicketIdCopyButton identifier={current} />` where the `ticket-key` span currently sits. A native `button` supplies Enter and Space behavior without custom key handlers.

- [ ] **Step 4: Re-run Jira copy tests and existing detail tests**

Run: `bun run test -- src/widgets/jira/TicketIdCopyButton.test.tsx src/widgets/jira/detailMeta.test.tsx`

Expected: PASS; no open timer warning after unmount.

---

### Task 2: Linear Detail Ticket ID Copy

**Files:**
- Create: `src/widgets/linear/TicketIdCopyButton.tsx`
- Create: `src/widgets/linear/TicketIdCopyButton.test.tsx`
- Modify: `src/widgets/linear/IssueDetailModal.tsx:1-13,104-136,313-335`

- [ ] **Step 1: Add failing Linear-local copy tests**

Use the same behavioral assertions as Task 1 with `ENG-142`, plus an unmount test that advances fake timers after `unmount()` and expects no React state-update warning. Do not import the Jira component; the Linear widget remains complete inside `widgets/linear/`.

```tsx
it('copies ENG-142 and clears its timer on unmount', async () => {
  vi.useFakeTimers()
  const writeText = vi.fn().mockResolvedValue(undefined)
  Object.assign(navigator, { clipboard: { writeText } })
  const view = render(<TicketIdCopyButton identifier="ENG-142" />)
  fireEvent.click(screen.getByRole('button', { name: 'ENG-142 복사' }))
  await waitFor(() => expect(writeText).toHaveBeenCalledWith('ENG-142'))
  view.unmount()
  await act(async () => vi.advanceTimersByTimeAsync(1_500))
})
```

- [ ] **Step 2: Verify RED**

Run: `bun run test -- src/widgets/linear/TicketIdCopyButton.test.tsx`

Expected: FAIL because the Linear-local component does not exist.

- [ ] **Step 3: Add the component and use it in the Linear detail header**

Implement the same explicit state machine from Task 1 in `src/widgets/linear/TicketIdCopyButton.tsx`, then replace line 107's span with:

```tsx
<TicketIdCopyButton identifier={issue.identifier} />
```

Also change `CopyBranch` to catch clipboard rejection, display `복사하지 못했습니다`, store its timer in a ref, and clear it on unmount. This prevents the newly enforced copy failure rule from leaving the pre-existing branch copy as a silent failure.

- [ ] **Step 4: Verify the Linear detail surface**

Run: `bun run test -- src/widgets/linear/TicketIdCopyButton.test.tsx src/widgets/linear/linear.test.tsx`

Expected: PASS, including the existing immediate detail skeleton tests.

---

### Task 3: Typed Linear Custom Filter and Rust Validation

**Files:**
- Modify: `src-tauri/src/providers/linear/presets.rs`
- Modify: `src-tauri/src/providers/linear/mod.rs`
- Modify: `src-tauri/src/providers/linear/tests/mod.rs`

- [ ] **Step 1: Add failing filter conversion and rejection tests**

Add focused tests named `custom_filter_combines_conditions_with_and_semantics`, `custom_filter_uses_viewer_id_for_assigned_to_me`, `custom_filter_rejects_empty_filter`, `custom_filter_rejects_unknown_ids`, `custom_filter_rejects_reversed_dates`, and `custom_filter_rejects_priority_outside_zero_to_four`.

```rust
let filter = LinearCustomFilter {
    team_ids: vec!["team-eng".into(), "team-design".into()],
    assignee: LinearAssigneeFilter::Viewer,
    state_types: vec!["started".into(), "unstarted".into()],
    project_ids: vec!["project-auth".into()],
    label_ids: vec!["label-bug".into()],
    priorities: vec![1, 2],
    created_from: Some("2026-08-01T00:00:00.000Z".into()),
    created_to: Some("2026-08-10T14:59:59.999Z".into()),
    updated_from: None,
    updated_to: None,
};
let known = LinearKnownIds::new(
    ["team-eng", "team-design"], ["project-auth"], ["label-bug"],
    ["started", "unstarted"]
);
assert_eq!(
    filter.to_issue_filter(Some("viewer-1"), &known).unwrap(),
    json!({
        "team": { "id": { "in": ["team-eng", "team-design"] } },
        "assignee": { "id": { "eq": "viewer-1" } },
        "state": { "type": { "in": ["started", "unstarted"] } },
        "project": { "id": { "in": ["project-auth"] } },
        "labels": { "id": { "in": ["label-bug"] } },
        "priority": { "in": [1, 2] },
        "createdAt": { "gte": "2026-08-01T00:00:00.000Z", "lte": "2026-08-10T14:59:59.999Z" }
    })
);
```

For `Unassigned`, assert `"assignee": { "null": true }`. For `Any`, assert that no `assignee` key exists.

- [ ] **Step 2: Verify RED**

Run: `cargo test providers::linear::tests::custom_filter -- --nocapture`

Expected: compile failure because the custom filter types do not exist.

- [ ] **Step 3: Add exact serializable types and conversion**

```rust
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct LinearCustomFilter {
    #[serde(default)] pub team_ids: Vec<String>,
    #[serde(default)] pub assignee: LinearAssigneeFilter,
    #[serde(default)] pub state_types: Vec<String>,
    #[serde(default)] pub project_ids: Vec<String>,
    #[serde(default)] pub label_ids: Vec<String>,
    #[serde(default)] pub priorities: Vec<u8>,
    #[serde(default)] pub created_from: Option<String>,
    #[serde(default)] pub created_to: Option<String>,
    #[serde(default)] pub updated_from: Option<String>,
    #[serde(default)] pub updated_to: Option<String>,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub enum LinearAssigneeFilter { #[default] Any, Viewer, Unassigned }

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, specta::Type)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum LinearQuery {
    Preset { id: String },
    Custom { filter: LinearCustomFilter },
}
```

Implement `LinearCustomFilter::is_empty()` and:

```rust
pub fn to_issue_filter(
    &self,
    viewer_id: Option<&str>,
    known: &LinearKnownIds,
) -> Result<Value, LinearFilterError>
```

`LinearFilterError` has concrete variants `Empty`, `UnknownPreset(String)`, `ViewerUnavailable`, `UnknownTeam(String)`, `UnknownProject(String)`, `UnknownLabel(String)`, `UnknownStateType(String)`, `InvalidPriority(u8)`, `InvalidDate { field: &'static str, value: String }`, and `ReversedRange { field: &'static str }`; implement `Display` with Korean actionable messages. Parse timestamps with `DateTime::parse_from_rfc3339`, validate all IDs before building JSON, and insert each non-empty top-level field exactly once. Replace the old optional query conversion with `LinearQuery::to_filter(&self, viewer_id: Option<&str>, known: &LinearKnownIds) -> Result<Value, LinearFilterError>`: presets return their static filter or `UnknownPreset`, custom delegates to `LinearCustomFilter::to_issue_filter`. `LinearQuery::scope()` returns `AllIssues` for `Custom`; `default_title()` returns `직접 구성한 이슈`.

Define the validation snapshot used by that signature rather than letting the provider depend on storage:

```rust
pub struct LinearKnownIds {
    pub team_ids: HashSet<String>,
    pub project_ids: HashSet<String>,
    pub label_ids: HashSet<String>,
    pub state_types: HashSet<String>,
}

impl LinearKnownIds {
    pub fn new<T, P, L, S>(teams: T, projects: P, labels: L, state_types: S) -> Self
    where
        T: IntoIterator, T::Item: Into<String>,
        P: IntoIterator, P::Item: Into<String>,
        L: IntoIterator, L::Item: Into<String>,
        S: IntoIterator, S::Item: Into<String>,
    {
        Self {
            team_ids: teams.into_iter().map(Into::into).collect(),
            project_ids: projects.into_iter().map(Into::into).collect(),
            label_ids: labels.into_iter().map(Into::into).collect(),
            state_types: state_types.into_iter().map(Into::into).collect(),
        }
    }
}
```

Reject a `state_types` value not present in the snapshot with `UnknownStateType(String)`.

- [ ] **Step 4: Verify GREEN and preset compatibility**

Run: `cargo test providers::linear::tests -- --nocapture`

Expected: PASS; all four stable preset IDs remain unchanged.

---

### Task 4: Server-Accurate Sort Direction and Bidirectional Pagination

**Files:**
- Modify: `src-tauri/src/providers/linear/presets.rs`
- Modify: `src-tauri/src/providers/linear/types.rs`
- Modify: `src-tauri/src/providers/linear/client.rs`
- Modify: `src-tauri/src/providers/linear/tests/mod.rs`
- Modify: `src-tauri/src/commands/linear.rs`

- [ ] **Step 1: Add failing direction tests**

```rust
#[test]
fn descending_uses_first_after_and_next_page() {
    assert_eq!(
        pagination_args(LinearSortDirection::Descending, 30),
        json!({ "first": 30, "after": null, "last": null, "before": null })
    );
    let page = finish_page(
        Vec::new(),
        Some(PageInfo {
            has_next_page: true,
            end_cursor: Some("next".into()),
            has_previous_page: false,
            start_cursor: None,
        }),
        LinearSortDirection::Descending,
    );
    assert_eq!(page.next_cursor.as_deref(), Some("next"));
}

#[test]
fn ascending_uses_last_before_previous_page_and_reverses_nodes() {
    assert_eq!(
        pagination_args(LinearSortDirection::Ascending, 30),
        json!({ "first": null, "after": null, "last": 30, "before": null })
    );
    let (mut issues, _) = parse_issues(ISSUES_FIXTURE);
    issues.truncate(3);
    let server_order = issues.iter().map(|issue| issue.identifier.clone()).collect::<Vec<_>>();
    let page = finish_page(
        issues,
        Some(PageInfo {
            has_next_page: false,
            end_cursor: None,
            has_previous_page: true,
            start_cursor: Some("previous".into()),
        }),
        LinearSortDirection::Ascending,
    );
    assert_eq!(
        page.issues.iter().map(|issue| issue.identifier.as_str()).collect::<Vec<_>>(),
        server_order.iter().rev().map(String::as_str).collect::<Vec<_>>()
    );
    assert_eq!(page.next_cursor.as_deref(), Some("previous"));
}

#[test]
fn config_without_direction_defaults_to_descending() {
    let config: LinearWidgetConfig = serde_json::from_value(json!({
        "query": { "kind": "preset", "id": "assigned-to-me" },
        "maxResults": 30
    })).unwrap();
    assert_eq!(config.sort_direction, LinearSortDirection::Descending);
}
```

Expose pure `pagination_args(direction, limit) -> Value` and `finish_page(issues, page_info, direction) -> LinearIssuePage` helpers through the test-only `query_exports` module. `finish_page` is also the single production path that reverses ascending issues and chooses the direction-specific cursor.

- [ ] **Step 2: Verify RED**

Run: `cargo test ascending -- --nocapture`

Run: `cargo test config_without_direction -- --nocapture`

Expected: compile failure because direction and reverse page fields are absent.

- [ ] **Step 3: Implement direction without client-side subset sorting**

```rust
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub enum LinearSortDirection { #[default] Descending, Ascending }
```

Extend `PageInfo` with defaulted `has_previous_page` and `start_cursor`. Change both issue query builders to declare all four variables and request all four page fields:

```graphql
query($filter: IssueFilter, $first: Int, $after: String, $last: Int, $before: String) {
  issues(filter: $filter, first: $first, after: $after, last: $last, before: $before, orderBy: updatedAt) {
    nodes {
      id identifier title url priority priorityLabel estimate dueDate updatedAt createdAt
      state { id name color type }
      assignee { id name displayName avatarUrl }
      team { id key name }
      project { name }
      labels(first: 10) { nodes { name } }
    }
    pageInfo { hasNextPage endCursor hasPreviousPage startCursor }
  }
}
```

Change the client signature to:

```rust
pub async fn issues(
    &self,
    scope: PresetScope,
    filter: &Value,
    team_ids: &[String],
    sort: LinearSort,
    direction: LinearSortDirection,
    limit: u32,
) -> LinearResult<LinearIssuePage>
```

For ascending, call the reverse end with `last`, reverse the returned node vector once in Rust, and derive `next_cursor` from `has_previous_page/start_cursor`. For descending, preserve `first` and `has_next_page/end_cursor`. Add `#[serde(default)] pub sort_direction` to `LinearWidgetConfig` and pass it from `linear_fetch`.

```rust
fn pagination_args(direction: LinearSortDirection, limit: u32) -> Value {
    match direction {
        LinearSortDirection::Descending => json!({
            "first": limit.clamp(1, MAX_FIRST), "after": null,
            "last": null, "before": null,
        }),
        LinearSortDirection::Ascending => json!({
            "first": null, "after": null,
            "last": limit.clamp(1, MAX_FIRST), "before": null,
        }),
    }
}

fn finish_page(
    mut issues: Vec<LinearIssue>,
    page_info: Option<PageInfo>,
    direction: LinearSortDirection,
) -> LinearIssuePage {
    if direction == LinearSortDirection::Ascending { issues.reverse(); }
    let next_cursor = match direction {
        LinearSortDirection::Descending => page_info
            .filter(|page| page.has_next_page)
            .and_then(|page| page.end_cursor),
        LinearSortDirection::Ascending => page_info
            .filter(|page| page.has_previous_page)
            .and_then(|page| page.start_cursor),
    };
    LinearIssuePage { issues, next_cursor }
}
```

- [ ] **Step 4: Verify both directions and old config behavior**

Run: `cargo test providers::linear::tests -- --nocapture`

Run: `cargo test commands::linear::tests::config_defaults -- --nocapture`

Expected: PASS; an old config still deserializes to `updatedAt` plus `descending`.

---

### Task 5: Linear Metadata Provider and Flattened Types

**Files:**
- Create: `src-tauri/src/providers/linear/tests/fixtures/metadata.json`
- Modify: `src-tauri/src/providers/linear/types.rs`
- Modify: `src-tauri/src/providers/linear/client.rs`
- Modify: `src-tauri/src/providers/linear/mod.rs`
- Modify: `src-tauri/src/providers/linear/tests/mod.rs`

- [ ] **Step 1: Add fixture-driven failing tests**

The fixture contains `viewer`, 100-bound teams and labels with `pageInfo.hasNextPage`, and one team's states, members, and projects. Tests assert only form fields survive flattening and all truncation flags are visible.

```rust
assert_eq!(global.viewer.as_ref().unwrap().id, "viewer-1");
assert_eq!(global.teams.items[0].key, "ENG");
assert!(global.labels.truncated);
assert_eq!(team.members.items[0].name, "Sammy");
assert_eq!(team.projects.items[0].id, "project-auth");
assert_eq!(team.states.items[0].type_name, "unstarted");
```

- [ ] **Step 2: Verify RED**

Run: `cargo test providers::linear::tests::metadata -- --nocapture`

Expected: compile failure because metadata response types and queries are missing.

- [ ] **Step 3: Add the flattened public types**

```rust
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct LinearMetadataList<T> {
    pub items: Vec<T>,
    pub fetched_at: Option<DateTime<Utc>>,
    pub truncated: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct LinearUserOption { pub id: String, pub name: String, pub avatar_url: Option<String> }
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct LinearProjectOption { pub id: String, pub name: String, pub team_id: String }
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct LinearLabelOption { pub id: String, pub name: String, pub color: String }
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct LinearGlobalMetadata {
    pub teams: LinearMetadataList<LinearTeam>,
    pub viewer: Option<LinearUserOption>,
    pub labels: LinearMetadataList<LinearLabelOption>,
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct LinearTeamMetadata {
    pub team_id: String,
    pub states: LinearMetadataList<LinearWorkflowState>,
    pub members: LinearMetadataList<LinearUserOption>,
    pub projects: LinearMetadataList<LinearProjectOption>,
}
```

Every network parsing field remains `#[serde(default)]`. Missing connections return `LinearError::Decode` rather than a misleading empty list.

- [ ] **Step 4: Implement global and team metadata queries**

```rust
pub async fn global_metadata(&self) -> LinearResult<LinearGlobalMetadata>
pub async fn team_metadata(&self, team_id: &str) -> LinearResult<LinearTeamMetadata>
```

Use `viewer { id name displayName avatarUrl }`, `teams(first: 100)`, `issueLabels(first: 100)`, and `team(id:) { states(first: 50), members(first: 100), projects(first: 100) }`. Request `pageInfo { hasNextPage }` on every bounded connection and set `truncated` from it. Sort states by `position`; sort members and projects by case-insensitive display name in Rust so React does not reinterpret server data.

- [ ] **Step 5: Verify metadata parsing**

Run: `cargo test providers::linear::tests::metadata -- --nocapture`

Expected: PASS, including missing-connection and truncation visibility cases.

---

### Task 6: Migrate and Preserve `linear_meta.json`

**Files:**
- Modify: `src-tauri/src/storage/linear_meta.rs`
- Modify: `src-tauri/src/storage/tests/linear_meta_tests.rs`

- [ ] **Step 1: Add failing v1 migration and preservation tests**

```rust
#[test]
fn migrates_v1_team_list_into_v2_global_metadata() {
    fs::write(dir.path().join(LINEAR_META_FILE), r#"{
      "version":1,
      "teamsFetchedAt":"2026-08-07T12:00:00Z",
      "teams":[{"id":"t1","key":"ENG","name":"Engineering"}]
    }"#).unwrap();
    let (store, outcome) = LinearMetaStore::load(dir.path()).unwrap();
    assert_eq!(outcome, LoadOutcome::Migrated { from: 1, to: 2 });
    assert_eq!(store.global().teams.items[0].id, "t1");
}

#[test]
fn replacing_one_team_preserves_global_and_other_teams() {
    let dir = TempDir::new().unwrap();
    let (mut store, _) = LinearMetaStore::load(dir.path()).unwrap();
    store.set_global(global_metadata(vec![team("team-eng", "ENG"), team("team-design", "DES")]));
    store.set_team(team_metadata("team-design", "Design Todo"));
    let global_before = store.global().clone();
    let other_before = store.team("team-design").cloned();
    store.set_team(team_metadata("team-eng", "Engineering Todo"));
    assert_eq!(store.global(), &global_before);
    assert_eq!(store.team("team-design"), other_before.as_ref());
}
```

Use these compile-checked test helpers:

```rust
fn list<T>(items: Vec<T>) -> LinearMetadataList<T> {
    LinearMetadataList {
        items,
        fetched_at: Some(Utc.with_ymd_and_hms(2026, 8, 10, 12, 0, 0).unwrap()),
        truncated: false,
    }
}

fn global_metadata(teams: Vec<LinearTeam>) -> LinearGlobalMetadata {
    LinearGlobalMetadata { teams: list(teams), viewer: None, labels: list(Vec::new()) }
}

fn team_metadata(team_id: &str, state_name: &str) -> LinearTeamMetadata {
    LinearTeamMetadata {
        team_id: team_id.into(),
        states: list(vec![LinearWorkflowState {
            id: format!("state-{team_id}"), name: state_name.into(), color: "#8a8f98".into(),
            type_name: "unstarted".into(), position: 0.0,
        }]),
        members: list(Vec::new()),
        projects: list(Vec::new()),
    }
}
```

- [ ] **Step 2: Verify RED**

Run: `cargo test storage::linear_meta::linear_meta_tests -- --nocapture`

Expected: FAIL because schema v2 and global/team accessors are absent.

- [ ] **Step 3: Implement schema v2 and migration**

```rust
pub const LINEAR_META_SCHEMA_VERSION: u32 = 2;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LinearMetaFile {
    pub version: u32,
    #[serde(default)] pub global: LinearGlobalMetadata,
    #[serde(default)] pub teams: BTreeMap<String, LinearTeamMetadata>,
}

impl Default for LinearMetaFile {
    fn default() -> Self {
        Self {
            version: LINEAR_META_SCHEMA_VERSION,
            global: LinearGlobalMetadata::default(),
            teams: BTreeMap::new(),
        }
    }
}
```

Register `Migration { from: 1, to: 2, apply: migrate_v1_to_v2 }`. The migration moves `teams` and `teamsFetchedAt` into `global.teams.items` and `global.teams.fetchedAt`, initializes viewer/labels/team maps empty, and never drops the old team list. Add `global()`, `team(id)`, `known_ids()`, `set_global()`, `set_viewer()`, `set_team()`, and `save()`; callers invoke `set_*` only after a successful network result. `known_ids()` unions project and state choices from all cached team entries. Keep `write_json_atomic` unchanged.

- [ ] **Step 4: Verify migration, round trip, corruption recovery, and replacement**

Run: `cargo test storage::linear_meta::linear_meta_tests -- --nocapture`

Expected: PASS for v1 migration, v2 disk round trip, missing file, corrupt file quarantine, and per-team replacement.

---

### Task 7: Metadata IPC and Generated Bindings

**Files:**
- Modify: `src-tauri/src/commands/linear.rs`
- Modify: `src-tauri/src/lib.rs`
- Modify: `src-tauri/src/bindings_export.rs`
- Generated: `src/ipc/bindings.ts`

- [ ] **Step 1: Add failing command-level cache/error tests**

Extract response assembly into a pure helper and test these cases: cached response without network, successful refresh replaces only requested scope, failed refresh returns cached values plus visible `refresh_error`, and auth failure sets `is_auth_failure`.

```rust
#[derive(Debug, Clone, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct LinearMetadataResponse {
    pub global: LinearGlobalMetadata,
    pub team: Option<LinearTeamMetadata>,
    pub refresh_error: Option<LinearCallError>,
}
```

- [ ] **Step 2: Verify RED**

Run: `cargo test commands::linear::tests::metadata_response -- --nocapture`

Expected: compile failure because the response and command do not exist.

- [ ] **Step 3: Implement one cache-first metadata command**

```rust
#[tauri::command]
#[specta::specta]
pub async fn linear_metadata(
    state: State<'_, AppState>,
    team_id: Option<String>,
    refresh: bool,
) -> Result<LinearMetadataResponse, String>
```

Behavior is exact:

- `refresh == false`: return disk cache immediately, including an optional cached team.
- `refresh == true && team_id == None`: call `global_metadata`, persist only on success, and return old cache plus `refresh_error` on failure.
- `refresh == true && team_id == Some(id)`: reject IDs not present in cached global teams, call `team_metadata(id)`, persist only that team on success, and preserve old team data on failure.
- No automatic background refresh occurs when opening either form.

Keep `linear_teams` until `ConfigForm` switches in Task 8, then remove it from the command lists in that same task to avoid an unused duplicate API.

- [ ] **Step 4: Route preset and custom configs correctly in `linear_fetch`**

Add command tests that a custom query ignores legacy `config.teams`, always uses `PresetScope::AllIssues`, and maps `LinearFilterError` to a permanent `LinearWidgetError` without calling the API. Resolve the filter as follows:

```rust
let (known, cached_viewer_id) = {
    let meta = state.linear_meta.lock().map_err(|_| permanent_error("상태 잠금 실패", None))?;
    (meta.known_ids(), meta.global().viewer.as_ref().map(|viewer| viewer.id.clone()))
};

let viewer_id = if config.query.needs_viewer() && cached_viewer_id.is_none() {
    let viewer = client.viewer().await.map_err(|error| to_widget_error(&state, &widget_id, error))?;
    let id = viewer.id.clone();
    if let Ok(mut meta) = state.linear_meta.lock() {
        meta.set_viewer(LinearUserOption { id: viewer.id, name: viewer.name, avatar_url: None });
        let _ = meta.save();
    }
    Some(id)
} else {
    cached_viewer_id
};

let filter = config.query.to_filter(viewer_id.as_deref(), &known)
    .map_err(|error| permanent_error(&error.to_string(), None))?;
let scope = config.query.scope()
    .ok_or_else(|| permanent_error("알 수 없는 Linear 쿼리입니다", None))?;
let team_scope: &[String] = match &config.query {
    LinearQuery::Preset { .. } => &config.teams,
    LinearQuery::Custom { .. } => &[],
};
```

Add `LinearQuery::needs_viewer() -> bool`, true only for custom `assignee == Viewer`. The one viewer lookup occurs in Rust and never exposes credentials. If that lookup fails, use the existing widget error path and stale issue cache.

- [ ] **Step 5: Register the command in both specta lists**

Add `commands::linear::linear_metadata` to the Linear block in both `src-tauri/src/lib.rs` and `src-tauri/src/bindings_export.rs`. The two lists must remain identical.

- [ ] **Step 6: Generate bindings through the repository's test**

Run from `src-tauri`: `cargo test bindings_export::tests::typescript_bindings_are_up_to_date -- --nocapture`

Expected: PASS and `src/ipc/bindings.ts` regenerated with `linearMetadata`, `LinearMetadataResponse`, and all nested public types. Do not edit `src/ipc/bindings.ts` by hand.

- [ ] **Step 7: Verify TypeScript sees the generated API**

Run: `bun run typecheck`

Expected: PASS before frontend consumers are changed.

---

### Task 8: Custom Query and Sort Direction Settings UI

**Files:**
- Create: `src/widgets/linear/customQuery.ts`
- Create: `src/widgets/linear/customQuery.test.ts`
- Create: `src/widgets/linear/CustomQueryFields.tsx`
- Create: `src/widgets/linear/ConfigForm.test.tsx`
- Modify: `src/widgets/linear/ConfigForm.tsx`
- Modify: `src/widgets/linear/index.ts`
- Modify: `src/widgets/types.ts`
- Modify: `src/widgets/shell/WidgetConfigModal.tsx`
- Modify: `src/widgets/shell/WidgetConfigModal.test.tsx`
- Modify: `src-tauri/src/lib.rs`
- Modify: `src-tauri/src/bindings_export.rs`
- Generated: `src/ipc/bindings.ts`

- [ ] **Step 1: Add failing local date conversion tests**

```ts
expect(localDateStartIso('2026-08-10')).toBe(new Date(2026, 7, 10, 0, 0, 0, 0).toISOString())
expect(localDateEndIso('2026-08-10')).toBe(new Date(2026, 7, 10, 23, 59, 59, 999).toISOString())
expect(isoToLocalDate(localDateEndIso('2026-08-10'))).toBe('2026-08-10')
expect(isEmptyCustomFilter(emptyCustomFilter())).toBe(true)
```

- [ ] **Step 2: Add failing form behavior tests**

Mock `commands.linearPresets` and `commands.linearMetadata`. Assert:

- `직접 구성` copies current `config.teams` into `filter.teamIds` once and stops applying `config.teams` afterward.
- All displayed conditions say `모든 조건을 동시에 만족하는 이슈만 표시합니다`.
- Empty custom conditions call `onValidityChange(false)` and show `조건을 하나 이상 선택하세요`.
- Team, project, label, state type, priority, assignee relation, and date edits produce the exact `LinearCustomFilter` shape.
- Reversed local date ranges are visible and invalid before Rust receives them.
- `최근 수정/최근 생성` and `최신순/오래된순` update `sort` and `sortDirection` independently.
- Cached metadata remains visible with `refreshError`; every `truncated` list shows `API 상한으로 일부만 표시됩니다`.

- [ ] **Step 3: Verify RED**

Run: `bun run test -- src/widgets/linear/customQuery.test.ts src/widgets/linear/ConfigForm.test.tsx src/widgets/shell/WidgetConfigModal.test.tsx`

Expected: FAIL because date helpers, custom fields, and validity plumbing are absent.

- [ ] **Step 4: Add validity plumbing without changing existing forms**

```ts
export interface WidgetConfigFormProps<TConfig> {
  config: TConfig
  onChange: (next: TConfig) => void
  onValidityChange?: (valid: boolean) => void
}
```

`WidgetConfigModal` stores `const [valid, setValid] = useState(true)`, resets it to true whenever `widget` changes, passes `onValidityChange={setValid}`, and renders the apply button as `disabled={!valid}` with `disabled:opacity-40`. Existing config forms need no edits because the prop is optional.

- [ ] **Step 5: Implement date helpers and the explicit custom form**

```ts
export const emptyCustomFilter = (): LinearCustomFilter => ({
  teamIds: [], assignee: 'any', stateTypes: [], projectIds: [], labelIds: [], priorities: [],
  createdFrom: null, createdTo: null, updatedFrom: null, updatedTo: null,
})

export function localDateStartIso(value: string): string {
  const [year, month, day] = value.split('-').map(Number)
  return new Date(year, month - 1, day, 0, 0, 0, 0).toISOString()
}

export function localDateEndIso(value: string): string {
  const [year, month, day] = value.split('-').map(Number)
  return new Date(year, month - 1, day, 23, 59, 59, 999).toISOString()
}
```

`CustomQueryFields` renders ordinary checkbox lists/selects/date inputs. `ConfigForm` keeps `const [teamMetadata, setTeamMetadata] = useState<Record<string, LinearTeamMetadata>>({})`; selecting a custom team calls `linearMetadata(teamId, false)` and stores `response.team` by ID, while the adjacent explicit refresh calls the same command with `true`. State choices are the deduplicated `typeName` values from those selected teams' cached `states`; project choices are from selected teams only; labels come from global metadata; priorities are explicit values `0,1,2,3,4` with labels `No priority, Urgent, High, Normal, Low` and remain marked for live API verification because current code intentionally does not interpret list priority numbers. Selecting a different team set removes project IDs no longer offered.

- [ ] **Step 6: Split sort field and direction and preserve old config**

```tsx
<select aria-label="정렬 필드" value={config.sort ?? 'updatedAt'}>
  <option value="updatedAt">최근 수정</option>
  <option value="createdAt">최근 생성</option>
</select>
<select aria-label="정렬 방향" value={config.sortDirection ?? 'descending'}>
  <option value="descending">최신순</option>
  <option value="ascending">오래된순</option>
</select>
```

Add `sortDirection: 'descending'` to `linearWidget.defaultConfig`. Guard `deriveTitle` on `config.query.kind`: presets use `PRESET_TITLES`, custom returns `직접 구성한 이슈`. Change the widget description to `이슈를 필터로 가져오고 생성·상태 변경을 합니다` only after Task 12 enables creation.

- [ ] **Step 7: Remove the superseded `linear_teams` IPC and regenerate**

After `ConfigForm` calls only `linearMetadata`, remove `linear_teams` and `LinearTeamList` from `commands/linear.rs`, `lib.rs`, and `bindings_export.rs`. Run from `src-tauri`: `cargo test bindings_export::tests::typescript_bindings_are_up_to_date -- --nocapture`.

Expected: PASS; generated bindings no longer expose `linearTeams`.

- [ ] **Step 8: Verify settings behavior and types**

Run: `bun run test -- src/widgets/linear/customQuery.test.ts src/widgets/linear/ConfigForm.test.tsx src/widgets/shell/WidgetConfigModal.test.tsx && bun run typecheck`

Expected: PASS; invalid empty filters cannot be applied.

---

### Task 9: Linear `issueCreate` Provider

**Files:**
- Create: `src-tauri/src/providers/linear/tests/fixtures/issue_create.json`
- Modify: `src-tauri/src/providers/linear/types.rs`
- Modify: `src-tauri/src/providers/linear/client.rs`
- Modify: `src-tauri/src/providers/linear/error.rs`
- Modify: `src-tauri/src/providers/linear/mod.rs`
- Modify: `src-tauri/src/providers/linear/tests/mod.rs`

- [ ] **Step 1: Add failing mutation and result tests**

Cover success, `success: false`, missing issue, GraphQL `errors`, 401, explicit rate limit, network, and 5xx. Assert only network and 5xx are `possibly_created`; rate limit is an explicit rejection and is not possibly created.

```rust
let input = LinearCreateIssueInput {
    team_id: "team-eng".into(), title: "로그인 수정".into(),
    description: Some("재현 절차".into()), state_id: Some("state-todo".into()),
    assignee_id: Some("viewer-1".into()), priority: Some(2),
    project_id: Some("project-auth".into()),
};
assert_eq!(input.to_graphql_input(), json!({
    "teamId":"team-eng", "title":"로그인 수정", "description":"재현 절차",
    "stateId":"state-todo", "assigneeId":"viewer-1", "priority":2,
    "projectId":"project-auth"
}));
```

- [ ] **Step 2: Verify RED**

Run: `cargo test providers::linear::tests::issue_create -- --nocapture`

Expected: compile failure because creation input and mutation are absent.

- [ ] **Step 3: Add validated input and mutation payload types**

```rust
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct LinearCreateIssueInput {
    pub team_id: String,
    pub title: String,
    pub description: Option<String>,
    pub state_id: Option<String>,
    pub assignee_id: Option<String>,
    pub priority: Option<u8>,
    pub project_id: Option<String>,
}
```

Add `IssueCreateData` with `#[serde(rename = "issueCreate")]`, and `IssueCreatePayload { success: Option<bool>, issue: Option<IssueNode> }`. Reuse `ISSUE_FIELDS` in:

```graphql
mutation($input: IssueCreateInput!) {
  issueCreate(input: $input) {
    success
    issue { id identifier title url priority priorityLabel estimate dueDate updatedAt createdAt state { id name color type } assignee { id name displayName avatarUrl } team { id key name } project { name } labels(first: 10) { nodes { name } } }
  }
}
```

- [ ] **Step 4: Implement a no-retry provider method**

```rust
pub async fn create_issue(&self, input: &LinearCreateIssueInput) -> LinearResult<LinearIssue>
```

Trim and reject an empty team or title before transport, reject priority above 4, send exactly once through `graphql`, require `success == Some(true)`, require `issue`, and flatten it. Return `BadRequest` for `success: false`, `Decode` for missing success/issue/unflattenable issue. Do not add retry loops to `LinearClient`.

- [ ] **Step 5: Verify creation parsing and uncertainty classification**

Run: `cargo test providers::linear::tests::issue_create -- --nocapture`

Expected: PASS and `query_exports::ISSUE_CREATE` contains both `success` and all detail-skeleton fields.

---

### Task 10: Creation IPC, Validation Boundary, and Bindings

**Files:**
- Modify: `src-tauri/src/commands/linear.rs`
- Modify: `src-tauri/src/lib.rs`
- Modify: `src-tauri/src/bindings_export.rs`
- Generated: `src/ipc/bindings.ts`

- [ ] **Step 1: Add failing command failure-mapping tests**

```rust
#[derive(Debug, Clone, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct LinearCreateFailure {
    pub kind: String,
    pub message: String,
    pub is_auth_failure: bool,
    pub possibly_created: bool,
    pub check_url: String,
}
```

Assert `Network` and `ServerError` map to `possibly_created: true`; `RateLimited`, `BadRequest`, `GraphqlErrors`, `Unauthorized`, and `Forbidden` map to false. Assert `check_url == "https://linear.app"`.

- [ ] **Step 2: Verify RED**

Run: `cargo test commands::linear::tests::create_failure -- --nocapture`

Expected: compile failure because `LinearCreateFailure` is absent.

- [ ] **Step 3: Implement the command with cached-ID validation**

```rust
#[tauri::command]
#[specta::specta]
pub async fn linear_create_issue(
    state: State<'_, AppState>,
    input: LinearCreateIssueInput,
) -> Result<LinearIssue, LinearCreateFailure>
```

Before transport, validate team, optional state, member, and project against `LinearMetaStore`; validate title and priority. Return a permanent non-auth failure for stale/unknown IDs with a message naming the field and instructing the user to refresh metadata. Then call `client.create_issue(&input)` exactly once. Set `possibly_created` only for `Network` and `ServerError`; rate limit reached the server as an explicit rejection and remains safe to retry manually, but the command still performs no automatic retry. Log the created identifier, never the input description or token.

- [ ] **Step 4: Register and regenerate specta bindings**

Add `commands::linear::linear_create_issue` to both command lists. Run from `src-tauri`: `cargo test bindings_export::tests::typescript_bindings_are_up_to_date -- --nocapture`.

Expected: PASS and generated `commands.linearCreateIssue(input)` returns `Result<LinearIssue, LinearCreateFailure>`.

- [ ] **Step 5: Verify Rust and TypeScript boundaries**

Run: `cargo test commands::linear::tests::create_failure -- --nocapture` from `src-tauri`, then `bun run typecheck` from the repository root.

Expected: PASS.

---

### Task 11: Linear Creation Modal

**Files:**
- Create: `src/widgets/linear/CreateIssueModal.tsx`
- Create: `src/widgets/linear/CreateIssueModal.test.tsx`

- [ ] **Step 1: Add failing form tests**

Mock `linearMetadata` and `linearCreateIssue`. Assert:

- Team and trimmed title are required.
- Description, state, assignee, priority, and project are omitted as `null` when unselected.
- Selecting every optional field sends the exact generated `LinearCreateIssueInput`.
- Changing team clears state, assignee, and project IDs that are not in the next team's metadata.
- Metadata cache is shown immediately; refresh failure and truncation remain visible inside the modal.
- Success calls `onCreated(result.data)` and closes the input form.
- `possiblyCreated: true` retains entered values, disables `생성`, shows the raw error and a `Linear에서 확인` action.
- Permanent/rejected failure retains values but permits a deliberate second submit.
- Auth failure calls `setLinearAuthFailed(true)`.

- [ ] **Step 2: Verify RED**

Run: `bun run test -- src/widgets/linear/CreateIssueModal.test.tsx`

Expected: FAIL because the modal does not exist.

- [ ] **Step 3: Implement exact props and state**

```tsx
export function LinearCreateIssueModal({
  open, onClose, onCreated,
}: {
  open: boolean
  onClose: () => void
  onCreated: (issue: LinearIssue) => void
})
```

On open, call `linearMetadata(null, false)`. When a team is selected, call `linearMetadata(teamId, false)` and derive state/member/project options from `response.team`; a refresh button calls `linearMetadata(teamIdOrNull, true)`. Keep title input focused. Submit:

```ts
const result = await commands.linearCreateIssue({
  teamId,
  title: title.trim(),
  description: description.trim() || null,
  stateId: stateId || null,
  assigneeId: assigneeId || null,
  priority: priority === '' ? null : Number(priority),
  projectId: projectId || null,
})
```

On success call `onCreated(result.data)` immediately. On failure render `result.error.message`; if `possiblyCreated`, render a `Linear에서 확인` button using `openUrl(result.error.checkUrl)` and include `이미 생성됐을 수 있어 중복 생성을 막았습니다`. No timer or automatic retry is added.

- [ ] **Step 4: Verify the modal contract**

Run: `bun run test -- src/widgets/linear/CreateIssueModal.test.tsx && bun run typecheck`

Expected: PASS with no act warnings and no duplicate submit during pending or uncertain states.

---

### Task 12: Linear Header Entry, Created Detail Skeleton, and Refetch Event

**Files:**
- Modify: `src/board/WidgetHost.tsx`
- Modify: `src/board/WidgetHost.test.tsx`
- Modify: `src/widgets/linear/useLinearData.ts`
- Modify: `src/widgets/linear/linear.test.tsx`
- Modify: `src/widgets/linear/index.ts`

- [ ] **Step 1: Add failing host and event tests**

In `WidgetHost.test.tsx`, set `linearConfigured: true`, render a Linear host, click `티켓 생성`, resolve creation with a `LinearIssue`, and assert the create modal closes and a detail dialog immediately shows its identifier/title without waiting for a list fetch. With `linearConfigured: false`, assert the button is absent.

In `linear.test.tsx`, add:

```tsx
it('creation event refetches the Linear widget', async () => {
  render(<HookProbe />)
  await waitFor(() => expect(linearFetch).toHaveBeenCalledTimes(1))
  window.dispatchEvent(new CustomEvent('pegboard:linear-created'))
  await waitFor(() => expect(linearFetch).toHaveBeenCalledTimes(2))
})
```

- [ ] **Step 2: Verify RED**

Run: `bun run test -- src/board/WidgetHost.test.tsx src/widgets/linear/linear.test.tsx`

Expected: FAIL because the host has no Linear action/modal and the hook does not listen for creation.

- [ ] **Step 3: Add the connected-only header action and created detail state**

In `LinearHost`:

```tsx
const linearConfigured = useConnectionStore((s) => s.linearConfigured)
const [creating, setCreating] = useState(false)
const [createdIssue, setCreatedIssue] = useState<LinearIssue | null>(null)
```

Pass this action to `WidgetShell`:

```tsx
actions={linearConfigured ? (
  <IconButton label="Linear 티켓 생성" onClick={() => setCreating(true)}>
    <SquarePen size={13} />
  </IconButton>
) : undefined}
```

Render the modal and immediate detail skeleton after the shell:

```tsx
<LinearCreateIssueModal open={creating} onClose={() => setCreating(false)} onCreated={(issue) => {
  setCreating(false)
  setCreatedIssue(issue)
  window.dispatchEvent(new CustomEvent('pegboard:linear-created'))
}} />
<LinearIssueDetailModal issue={createdIssue} onClose={() => setCreatedIssue(null)} />
```

Do not add a global shortcut or detail-modal child creation entry.

- [ ] **Step 4: Reuse the existing forced-refetch queue**

Change `FetchReason` to `'regular' | 'retry' | 'mutation'`; use the existing `pendingStateRefresh` ref renamed to `pendingMutationRefresh`. Subscribe both `LINEAR_STATE_CHANGED_EVENT` and `pegboard:linear-created` to `fetchNow('mutation')`. This preserves the current behavior where a mutation event arriving during an in-flight request triggers one follow-up fetch and a rate-limit wait is not bypassed.

- [ ] **Step 5: Verify host, immediate detail, and refetch**

Run: `bun run test -- src/board/WidgetHost.test.tsx src/widgets/linear/CreateIssueModal.test.tsx src/widgets/linear/linear.test.tsx`

Expected: PASS; no optimistic insertion assertion exists because the created issue may not match the active filter.

---

### Task 13: Update Approved Decisions and Repository Guidance

**Files:**
- Modify: `docs/DECISIONS.md:1794-2049`
- Modify: `CLAUDE.md:215-269,341-357`

- [ ] **Step 1: Update `docs/DECISIONS.md` Linear scope**

Change section 25's summary and 25.1 table to `읽기 + 생성 + 상태 변경 + 상세`. Replace the old “생성은 넣지 않았다” rationale with the approved rationale: creation is frequent enough to belong in the fast-view workflow, is exposed only from each Linear widget header, uses the seven fixed fields, performs no optimistic insertion, and treats network/timeout/5xx as possibly created with duplicate prevention.

- [ ] **Step 2: Record typed filters without reopening raw input**

Revise 25.2 to state:

```markdown
Linear에는 생 GraphQL/`IssueFilter` JSON 입력이 없다. 대신 앱이 검증할 수 있는 핵심
조건을 명시 타입으로 제공하고 모든 조건을 AND로 결합한다. 한 필드의 다중 선택만
`in` 비교로 OR 의미를 가진다. AND/OR 중첩 그룹과 JSON 직접 입력은 계속 제외한다.
```

Document that preset `config.teams` remains for persisted compatibility, custom team IDs live only inside `LinearCustomFilter`, and empty filters are rejected to prevent organization-wide accidental fetches.

- [ ] **Step 3: Record bidirectional server sorting and metadata cache v2**

Extend 25.3 with descending `first/after`, ascending `last/before`, four `pageInfo` fields, Rust-side reverse for display order, and direction defaulting to descending for old config. Add a metadata subsection describing `linear_meta.json` v2 global/team-keyed cache, explicit refresh only, truncation flags, atomic writes, and preservation of stale cache on refresh failure.

- [ ] **Step 4: Update the unverified-live-response checklist**

Add metadata connection names/shapes, `issueCreate` payload, priority input mapping, custom `IssueFilter` operators, ascending connection order, and mutation uncertainty behavior to 25.7. Keep the warning that fixture tests prove parser behavior, not live API shape.

- [ ] **Step 5: Make `CLAUDE.md` consistent**

Update the Linear section and constraints table so they no longer say `생성은 없다`, `이슈 생성 안 만든다`, or `직접 입력 없음` without qualification. State `타입 기반 핵심 필터 UI만 허용, 생 JSON/중첩 AND·OR 없음`; include the creation field list, no-retry/possibly-created rule, and ascending pagination rule. Preserve the actual-response verification warning.

- [ ] **Step 6: Check for contradictory old statements**

Run: `rg -n "Linear.*생성은 없다|Linear 이슈 생성.*안 만든다|프리셋 4종뿐|Linear 생 필터 입력" CLAUDE.md docs/DECISIONS.md`

Expected: no stale contradiction. Historical text explicitly marked as superseded may remain only when followed by the date and replacement decision.

---

### Task 14: Board Import/Export Domain and Transactional Storage

**Files:**
- Modify: `src-tauri/src/storage/board.rs`
- Modify: `src-tauri/src/storage/error.rs`
- Modify: `src-tauri/src/storage/tests/board_tests.rs`

- [ ] **Step 1: Add failing tests for export shape and import validation**

Define tests proving `BoardExportFile { format_version, exported_at, board }` serializes only those three keys and cannot contain secrets, Todo data, or caches. Add rejection tests for export format versions above 1, board schema versions above `BOARD_SCHEMA_VERSION`, empty boards, duplicate board IDs, duplicate widget IDs across boards, unknown widget types, and per-board widget caps.

```rust
let exported = BoardExportFile::new(BoardFile::default(), fixed_time());
let value = serde_json::to_value(exported).unwrap();
assert_eq!(value.as_object().unwrap().keys().cloned().collect::<Vec<_>>(),
           vec!["board", "exportedAt", "formatVersion"]);
assert!(validate_import(&candidate).is_err());
```

- [ ] **Step 2: Run the focused storage tests and confirm RED**

Run from `src-tauri`: `cargo test storage::tests::board_tests::import -- --nocapture`

Expected: compile failure because export/import domain types and validation do not exist.

- [ ] **Step 3: Add typed export, preview, mode, and validation contracts**

Add `BOARD_EXPORT_FORMAT_VERSION: u32 = 1`, `BoardExportFile`, `BoardImportMode::{Replace, Merge}`, `BoardImportPreview`, `AlbumPathWarning`, and `validate_import(&BoardExportFile) -> StorageResult<()>`. Keep all board validation in storage rather than React or command code.

```rust
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct BoardExportFile {
    pub format_version: u32,
    pub exported_at: String,
    pub board: BoardFile,
}

#[derive(Debug, Clone, Copy, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum BoardImportMode { Replace, Merge }
```

- [ ] **Step 4: Add failing merge and transactional replacement tests**

Test that merge regenerates every imported board/widget UUID, resolves repeated names as `업무 (가져옴 2)` then `업무 (가져옴 3)`, activates the first imported board, and leaves existing boards unchanged. Inject an atomic writer that returns an error and assert both `store.data()` and the prior `board.json` remain byte-for-byte unchanged.

- [ ] **Step 5: Implement pure merge and save-before-swap replacement**

Add `build_import_result(current, imported, mode, new_id) -> StorageResult<BoardFile>` as a pure function. Add `BoardStore::replace_atomically(next)` that validates and writes `next` before assigning `self.data = next`; do not reuse the current `board_save` assignment-before-save order.

- [ ] **Step 6: Add album path preview without rejecting imports**

Walk album widget config values for folder and files sources, use `Path::exists`, and return one warning per missing path. Keep this parser in the album provider/storage boundary already used by `restore_scopes`; do not reject the candidate.

- [ ] **Step 7: Re-run board storage tests**

Run from `src-tauri`: `cargo test storage::tests::board_tests -- --nocapture`

Expected: PASS, including existing board round-trip and widget limit tests.

---

### Task 15: Board Import/Export IPC and Generated Bindings

**Files:**
- Modify: `src-tauri/src/commands/board.rs`
- Modify: `src-tauri/src/lib.rs`
- Modify: `src-tauri/src/bindings_export.rs`
- Modify generated: `src/ipc/bindings.ts`
- Test: `src-tauri/src/storage/tests/board_tests.rs`

- [ ] **Step 1: Add failing command-helper tests**

Extract non-dialog helpers and test default export filename format `my-pegboard-board-settings-YYYY-MM-DD.json`, cancelled operations returning `None`, preview summaries, and apply returning the exact persisted `BoardFile`.

- [ ] **Step 2: Verify RED**

Run from `src-tauri`: `cargo test commands::board::tests -- --nocapture`

Expected: compile failure because import/export command helpers do not exist.

- [ ] **Step 3: Implement Rust-owned dialog commands**

Add async commands with these contracts:

```rust
pub async fn board_export(app: AppHandle, state: State<'_, AppState>) -> Result<Option<String>, String>;
pub async fn board_import_preview(app: AppHandle) -> Result<Option<BoardImportCandidate>, String>;
pub fn board_import_apply(app: AppHandle, state: State<'_, AppState>, candidate: BoardExportFile,
                          mode: BoardImportMode) -> Result<BoardFile, String>;
```

Use `tauri_plugin_dialog::DialogExt` in Rust only. Export writes through an atomic helper to the selected path. Preview re-parses and validates untrusted JSON. Apply revalidates the candidate, builds the complete result, calls `replace_atomically`, restores all album runtime scopes, and evicts orphan caches only after save succeeds.

- [ ] **Step 4: Register commands and regenerate bindings**

Register all three commands in `lib.rs` and `bindings_export.rs`. Run from `src-tauri`: `cargo test bindings_export::tests::typescript_bindings_are_up_to_date -- --nocapture` to regenerate/verify `src/ipc/bindings.ts`; never hand-edit generated bindings.

- [ ] **Step 5: Run focused Rust verification**

Run from `src-tauri`: `cargo test commands::board storage::tests::board_tests -- --nocapture`

Expected: PASS without launching Tauri or opening a real OS dialog.

---

### Task 16: Board Settings Import/Export UI

**Files:**
- Modify: `src/settings/SettingsModal.tsx`
- Create: `src/settings/SettingsModal.test.tsx`
- Modify: `src/store/board.ts`
- Modify: `docs/DECISIONS.md`
- Modify: `CLAUDE.md`

- [ ] **Step 1: Add failing settings UI tests**

Mock generated IPC commands and test the `보드` tab, export success/cancel/error, import cancel, preview summary, album warnings, replace warning, merge selection, apply confirmation, and visible apply errors. Assert a successful apply calls a dedicated store action with the returned `BoardFile` exactly once.

- [ ] **Step 2: Verify RED**

Run: `bun run test -- src/settings/SettingsModal.test.tsx`

Expected: FAIL because the `board` settings tab and IPC calls do not exist.

- [ ] **Step 3: Add an explicit imported-board store action**

Extend `BoardState` with `replaceFromImport(file: BoardFile): void`. It must set version, activeBoardId, boards, and hydrated in one Zustand update. Do not call the debounced `boardSave`: Rust has already persisted the exact returned file, and a second write creates a race.

- [ ] **Step 4: Implement the `보드` tab and preview confirmation**

Extend `SettingsTab` with `board`. Add separate `내보내기` and `가져오기` sections. Keep preview state inside the modal, show counts and every missing album path, provide `교체`/`병합` radios, require an explicit final button, and keep all errors inline. On successful apply, call `replaceFromImport(result.data)` and clear the preview.

- [ ] **Step 5: Document the decision**

Add a decision section stating board-only export, secret/Todo/cache exclusion, Rust-owned dialogs and transactions, replace/merge behavior, full ID regeneration on merge, retained album paths with visible warnings, and no actual-app verification in this change.

- [ ] **Step 6: Verify UI and store behavior**

Run: `bun run test -- src/settings/SettingsModal.test.tsx src/store/board.test.ts`

Expected: PASS with no actual Tauri app launch.

---

## Full Verification

- [ ] Run generated-binding test from `src-tauri`: `cargo test bindings_export::tests::typescript_bindings_are_up_to_date -- --nocapture`
- [ ] Run all Rust tests from `src-tauri`: `cargo test`
- [ ] Run TypeScript checking from the repository root: `bun run typecheck`
- [ ] Run Biome from the repository root: `bun run lint`
- [ ] Run all Vitest tests from the repository root: `bun run test`
- [ ] Run the production frontend build: `bun run build`
- [ ] Inspect `git diff -- src/ipc/bindings.ts` and confirm all changes are generator output tied to registered Rust commands and types.
- [ ] Inspect `git diff -- docs/DECISIONS.md CLAUDE.md` and confirm the previous Linear exclusions are explicitly revised rather than silently deleted.
- [ ] Inspect `git status --short` and confirm no unrelated dirty-worktree file was modified.
- [ ] Confirm no command in this plan launches the Tauri application, calls a live Linear API, or opens an OS dialog during verification.
