# Widget Visibility And Board Lock Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 앨범·웹 헤더 표시를 바로잡고 보드별로 위젯 이동과 크기 변경을 잠근다.

**Architecture:** 기존 `WidgetShell`의 named group을 앨범 장수 badge가 그대로 사용한다. 잠금은 `Board`의 영속 필드로 두고 Zustand가 토글하며 `Board` 컴포넌트가 react-grid-layout의 drag/resize `enabled` 설정으로 반영한다. Rust 저장 모델은 누락 필드를 `false`로 읽어 v1 파일을 유지한다.

**Tech Stack:** React 19, TypeScript, Zustand, react-grid-layout v2, Vitest, Rust, serde, Tauri 2

---

### Task 1: 위젯 표시 동작

**Files:**
- Modify: `src/widgets/album/View.tsx`
- Test: `src/widgets/album/album.test.tsx`
- Modify: `src/board/WidgetHost.tsx`
- Test: `src/board/WidgetHost.test.tsx`

- [ ] **Step 1: 실패 테스트 작성**

앨범 테스트는 hover 설정에서 badge가 `opacity-0`, `group-hover/widget:opacity-100`,
`group-focus-within/widget:opacity-100`을 갖고 always 설정에서는 `opacity-0`을 갖지
않는지 검사한다. WidgetHost 테스트의 웹 제목 기대값은 `운영 화면`으로 바꾸고 제목이
없을 때 `example.com` fallback도 검사한다.

- [ ] **Step 2: 실패 확인**

Run: `bun run test -- src/widgets/album/album.test.tsx src/board/WidgetHost.test.tsx`
Expected: 앨범 badge class와 웹 사용자 제목 기대가 실패한다.

- [ ] **Step 3: 최소 구현**

`AlbumView`의 장수 badge class를 다음 조건으로 만든다.

```tsx
const countVisibility =
  (config.headerMode ?? 'hover') === 'hover'
    ? 'opacity-0 transition-opacity duration-fast group-hover/widget:opacity-100 group-focus-within/widget:opacity-100'
    : ''
```

`WebHost` 제목은 URL 대신 기존 제목 파생 함수를 사용한다.

```tsx
title={definition.deriveTitle(widget.config)}
```

- [ ] **Step 4: 대상 테스트 통과 확인**

Run: `bun run test -- src/widgets/album/album.test.tsx src/board/WidgetHost.test.tsx`
Expected: PASS.

### Task 2: 보드 저장 모델

**Files:**
- Modify: `src/store/board.ts`
- Test: `src/store/board.test.ts`
- Modify: `src-tauri/src/storage/board.rs`
- Test: `src-tauri/src/storage/tests/board_tests.rs`
- Regenerate: `src/ipc/bindings.ts`

- [ ] **Step 1: 실패 테스트 작성**

TypeScript 테스트는 기본 보드·새 보드가 `locked: false`이고 `toggleBoardLock(id)`가 한
보드만 바꾸며 `serializeBoard`가 값을 보존하는지 검사한다. Rust 테스트는 `locked`
필드가 없는 v1 JSON이 `false`로 파싱되고 export round trip이 `true`를 보존하는지 검사한다.

- [ ] **Step 2: 실패 확인**

Run: `bun run test -- src/store/board.test.ts`

Run: `cargo test storage::tests::board_tests --manifest-path src-tauri/Cargo.toml`

Expected: `locked`와 `toggleBoardLock` 부재로 FAIL.

- [ ] **Step 3: 최소 구현**

TypeScript `Board`와 Rust `Board`에 필드를 추가한다.

```ts
locked: boolean
```

```rust
#[serde(default)]
pub locked: bool,
```

`emptyBoard`, `addBoard`, Rust 기본값과 merge 생성부는 `locked: false` 또는 원본
`source_board.locked`를 명시한다. Zustand action은 다음 형태로 한 보드만 토글한다.

```ts
toggleBoardLock: (id) =>
  set((state) => ({
    boards: state.boards.map((board) =>
      board.id === id ? { ...board, locked: !board.locked } : board,
    ),
  }))
```

- [ ] **Step 4: bindings 재생성과 테스트**

Run: `cargo test bindings_export::tests::generated_bindings_are_up_to_date --manifest-path src-tauri/Cargo.toml`

필요하면 프로젝트의 specta export 테스트가 생성한 `src/ipc/bindings.ts`를 반영한다.

Run: `bun run test -- src/store/board.test.ts && cargo test storage::tests::board_tests --manifest-path src-tauri/Cargo.toml`
Expected: PASS.

### Task 3: 활성 보드 잠금 UI와 grid 제어

**Files:**
- Modify: `src/App.tsx`
- Modify: `src/board/Board.tsx`
- Test: `src/board/Board.test.tsx`
- Test: `src/App.test.tsx`

- [ ] **Step 1: 실패 테스트 작성**

Board 테스트는 잠긴 활성 보드에서 `dragConfig.enabled`와 `resizeConfig.enabled`가
`false`, 잠금 해제 보드에서 `true`인지 mock GridLayout으로 검사한다. App 테스트는
버튼 클릭이 활성 보드 id로 `toggleBoardLock`을 호출하고 aria-label이 `보드 잠금`과
`보드 잠금 해제`로 바뀌는지 검사한다.

- [ ] **Step 2: 실패 확인**

Run: `bun run test -- src/board/Board.test.tsx src/App.test.tsx`
Expected: 잠금 버튼과 grid enabled 설정 부재로 FAIL.

- [ ] **Step 3: 최소 구현**

`Board.tsx`는 `useActiveBoard()`에서 `locked`를 읽고 설정 객체를 만든다.

```tsx
dragConfig={{ ...DRAG_CONFIG, enabled: !locked }}
resizeConfig={{ ...RESIZE_CONFIG, enabled: !locked }}
```

`App.tsx` 타이틀바에는 `Lock`/`LockOpen` 아이콘 버튼을 추가한다. 클릭은 현재
`activeBoardId`를 `toggleBoardLock`에 전달한다. 아이콘만으로 상태를 숨기지 않도록
title과 aria-label을 각각 `보드 잠금`, `보드 잠금 해제`로 제공한다.

- [ ] **Step 4: 대상 테스트 통과 확인**

Run: `bun run test -- src/board/Board.test.tsx src/App.test.tsx`
Expected: PASS.

### Task 4: 버전, 전체 검증, 배포

**Files:**
- Modify: `package.json`
- Modify: `src-tauri/Cargo.toml`
- Modify: `src-tauri/Cargo.lock`
- Modify: `src-tauri/tauri.conf.json`

- [ ] **Step 1: 버전을 `0.7.2-beta`로 동기화**

네 파일의 앱 패키지 버전을 `0.7.2-beta`로 바꾸고 `cargo check`로 lockfile을 확인한다.

- [ ] **Step 2: 전체 검증**

Run: `bun run typecheck && bun run lint && bun run test`

Run: `cargo test --manifest-path src-tauri/Cargo.toml`

Expected: 모든 검사 PASS.

- [ ] **Step 3: 서명 빌드와 배포 검사**

updater 개인키와 키체인 비밀번호를 환경 변수로만 주입해 `bun run tauri build`를
실행한다. 이어서 `./scripts/make-latest-json.sh`와 `./scripts/verify-release.sh`를
실행하고 10개 검사가 모두 통과해야 한다.

- [ ] **Step 4: 커밋, push, release**

구현과 버전 변경을 커밋해 `main`에 push한다. `v0.7.2-beta` annotated tag를 push하고
DMG, versioned app tarball, `.sig`, `latest.json` 네 파일로 GitHub Release를 만든다.
`--prerelease`는 사용하지 않는다. `/releases/latest`와 네 asset 상태를 다시 조회한다.
