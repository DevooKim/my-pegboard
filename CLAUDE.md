# my-pegboard

페그보드처럼 위젯을 배치하는 **개인용 데스크톱 대시보드**. Tauri 2 + React 19.
사용자 1명이 자기 맥북에서 매일 사용. 배포·공유 없음.

**설계 결정의 근거는 `docs/DECISIONS.md`에 있다. 기존 결정을 뒤집기 전에 반드시 읽을 것.**

---

## 이 프로젝트의 두 가지 대전제

### 1. 속도가 기능보다 우선한다

이 앱이 존재하는 이유는 사용자의 이 말이다:
> "Jira 웹이 너무 느리고 버그가 많아서"

**이 앱이 Jira 웹만큼 느리면 존재 이유가 없다.** 기능을 추가할 때 속도를 해치면 그 기능은 틀렸다.

핵심 약속: **앱을 켜면 즉시 지난 데이터가 보이고, 그 뒤에 조용히 갱신된다.**
빈 화면 + 스피너로 시작하지 않는다. 디스크 캐시를 먼저 그린다.

### 2. 사용자는 코드를 읽지 않는다

동작만 본다. 필요하면 view 계층(React 컴포넌트) 정도는 읽을 수 있다.

여기서 파생되는 규칙:
- **조용한 실패 금지.** 실패는 반드시 화면에 드러나야 한다. 콘솔 로그는 사용자에게 없는 것과 같다.
- **미지원/미구현도 드러낸다.** ADF 렌더러가 모르는 노드를 만나면 회색 플레이스홀더를 그린다. 건너뛰지 않는다.
- **React 컴포넌트는 평범하고 읽기 쉽게.** 영리한 추상화 금지. 위젯 하나 = 파일 하나.
  사용자가 열어서 "여기 색 바꿔줘", "이 필드 빼줘"라고 말할 수 있어야 한다.
- **Rust와 상태 관리는 테스트로 보장.** 사용자가 안 보는 영역이므로 조용히 깨지면 안 된다.
- **"만들기 어렵다"는 결정 근거가 아니다.** 사용자가 타이핑하지 않으므로 구현 비용은 사용자 비용이 아니다.
  유효한 근거는 "쓸 때 나쁘다" 또는 "나중에 발목 잡는다"뿐.

---

## 아키텍처 한 줄 요약

**Rust가 데이터의 주인이고, React는 표시만 한다.**

```
[WebView: React]  ←IPC(specta)→  [Rust]  ←HTTPS→  [Jira / GitHub]
 배치·UI 상태만                  캐시·폴링·rate limit·재시도·키체인
 (zustand)
```

- 모든 외부 API 호출은 `#[tauri::command]`. 프론트에서 `fetch()` 금지.
- 토큰은 **절대 WebView로 내려보내지 않는다.**
- Rust가 응답을 파싱하고 **필요한 필드만 남겨서** IPC로 전달한다 (페이로드 1/10).
- Rust가 이벤트를 push → 해당 위젯만 리렌더.
- **TanStack Query/DB를 쓰지 않는다.** 캐시를 두 군데 두지 않는다.

---

## 스택

**bun 1.3.14** (패키지 매니저 + 스크립트 러너)

```
bun install
bun run dev      # tauri dev
bun run build
bun run test     # vitest (bun test 아님 — Vite 설정을 공유해야 함)
bun run lint     # biome
```

| 영역 | 선택 |
|---|---|
| React 19 + TypeScript + Vite 8 | |
| Tailwind 4 (`@tailwindcss/vite`) | 런타임 없음 |
| zustand | UI 상태만 (배치, 모달, 선택) |
| react-grid-layout v2 | 12열 그리드 |
| lucide-react / zod / biome / vitest | |
| Rust | `reqwest`(rustls) `serde` `tokio` `keyring` `tracing` `chrono` `thiserror` `specta`+`tauri-specta` |

**쓰지 않는 것:** TanStack Query/Router/Virtual, sonner, framer-motion
(각각의 이유는 DECISIONS.md 18장)

---

## 디렉토리 구조

```
src/
├─ board/          그리드, 보드 셸
├─ widgets/
│  ├─ registry.ts  위젯 타입 등록
│  ├─ shell/       WidgetShell — 헤더·새로고침·상태·에러·설정·삭제 공통 처리
│  ├─ jira/        ← 위젯 하나 = 폴더 하나
│  ├─ github/
│  └─ todo/
├─ settings/       통합 설정 모달
├─ ipc/            Rust 커맨드 래퍼 (specta 생성물 포함)
├─ store/          zustand
└─ ui/             공용 컴포넌트

src-tauri/src/
├─ commands/       IPC 커맨드
├─ providers/      jira/ github/ — API 클라이언트·타입·캐시
├─ scheduler/      위젯별 폴링 타이머
├─ storage/        파일 IO, 원자적 쓰기, 마이그레이션
├─ secrets/        키체인
└─ cache/          디스크 캐시
```

**철칙: 위젯 하나가 프론트 폴더 하나 + Rust provider 하나에 완결된다.**
새 위젯 추가 시 건드리는 곳은 `widgets/<name>/`, `providers/<name>/`, `registry.ts` 한 줄.
다른 위젯 코드를 열지 않는다.

---

## 절대 빼먹으면 안 되는 것들

### 파일 저장
- **원자적 쓰기** — 임시 파일 → `rename`. 안 하면 앱이 죽을 때 배치가 통째로 날아간다.
- **디바운스** — 드래그 중 레이아웃 이벤트가 초당 수십 회. 500ms 또는 드래그 종료 시 저장.
- **스키마 버전** — `{ "version": 1, ... }`. 없으면 나중에 구파일을 읽을 방법이 없다.
- **Todo 백업** — `todos.json.bak` 1세대. Todo는 원본이 딴 데 없는 유일본 데이터.

저장 위치: `~/Library/Application Support/io.mypegboard.app/`

### 비밀
- 토큰·이메일은 **Keychain** (`keyring` crate). 키 네임스페이스 `jira.default.token`.
- **평문 파일 금지, 폴백 금지.** 키체인이 실패하면 실패했다고 말한다.
- 로그에 토큰을 찍지 않는다. **마스킹 필수.**

### 에러
- **일시적**(429/네트워크/5xx): 지수 백오프 3회. 재시도 중 **직전 성공 데이터를 계속 표시** +
  "N분 전 데이터" 흐린 표시. 목록이 사라지면 안 된다.
- **영구적**(401/403/400): 재시도 없음. 위젯 본문을 에러 상태로 + **무엇을 해야 하는지** + 행동 버튼.
- **인증 실패는 전역 배너 한 번만.** 위젯 4개에 같은 에러 4번은 소음.
- 로그: `~/Library/Logs/io.mypegboard.app/` 회전 로그 (Tauri는 productName이 아니라 identifier를 쓴다).

---

## 성능 목표 (측정 가능해야 함)

| 항목 | 목표 |
|---|---|
| 앱 시작 → 보드 표시 | 1초 |
| **캐시 데이터 표시** | **0ms (즉시)** |
| 위젯 새로고침 체감 | 1초 |
| 유휴 메모리 | 150MB 이하 (실측 100~120 예상) |
| 드래그 | 60fps |
| 모달 열기 | 100ms |

설정창 "정보"에 **현재 메모리 + 마지막 폴링 소요 시간**을 노출한다.
"최적화했다"는 주장은 이 숫자로 증명한다.

---

## Jira (확인된 사실)

- **Atlassian Cloud** `https://your-team.atlassian.net`
- cloudId `00000000-0000-0000-0000-000000000000`
- REST **v3**, description은 **ADF JSON**, 사용자 식별자는 `accountId`
- 인증: API 토큰 + Basic (`email:token` Base64)

**⚠️ 구 `/rest/api/3/search`는 deprecated → `/rest/api/3/search/jql`.**
신규 엔드포인트는 **total을 주지 않는다** (커서 `nextPageToken`만).
→ "총 42건 중 30건" 같은 UI를 만들지 말 것.

**프로젝트별 필수 필드가 다르다 (실측):**
| 프로젝트 | 필수 |
|---|---|
| ABC | project, issuetype, summary |
| XYZ | project, issuetype, summary, **reporter** |

→ 생성 폼은 `createmeta`로 필수 필드를 조회해 보강한다. `hasDefaultValue: true`는 서버에 맡긴다.

**ADF는 직접 렌더링한다** (`@atlaskit/renderer` 금지 — Atlaskit 전체를 끌고 옴).
미지원 노드는 `[지원하지 않는 요소: X]` 회색 박스로 **반드시 표시**.

**조작 범위: 읽기 + 생성만.** 상태 변경·편집·코멘트 작성은 브라우저에서.
(이유: 앱의 역할은 "빠르게 보는 것". 편집은 빈도가 낮다)

---

## GitHub

- **GraphQL API만.** github.com 전용 (Enterprise 미지원).
- REST 검색은 **분당 30회** 제한 → PR별 리뷰 상태를 개별 조회하면 즉시 초과.
- GraphQL 한 요청으로 목록 + `reviewDecision` + `statusCheckRollup` + 변경 규모를 받는다.
- 위젯 타입은 **하나**. PR/Issue는 쿼리로 구분 (`is:pr` / `is:issue`).

---

## Todo

**단순 체크리스트가 아니다. 날짜 축을 가진 daily todo.**

```ts
{ id, text, done, date, originDate, carriedCount }
```

- **이월:** 앱 시작 시 + 자정 넘김 시. 과거 편집 중에는 실행하지 않는다.
- 과거 **전체**의 미완료 항목을 오늘로 **이동**(복사 아님).
- 이월 항목은 `↻` + `N일째` 배지. 횟수가 늘수록 색이 진해진다 (미루는 걸 시각적으로 압박).
- 과거·미래 모두 **편집 가능**.
- `carriedCount >= 7`이면 "이거 정말 할 건가요?" 힌트. **자동 삭제 절대 금지.**

---

## 제약 (지금은 하지 않는 것)

의도적으로 뺀 것들이다. 추가하려면 DECISIONS.md의 근거를 먼저 확인할 것.

| 항목 | 상태 |
|---|---|
| 다중 보드 | 데이터 구조는 준비됨, **UI만 없음** |
| 다중 연결 | 구조 준비됨 (`connectionId: "default"`), UI 없음 |
| 트레이 상주·백그라운드 폴링·알림 | 4차 |
| Jira 상태 변경(transition) | 워크플로우가 프로젝트마다 달라 보류 |
| 이미지 첨부 렌더링 | 인증 URL 재요청 필요, 보류 |
| PWA | **폐기됨** (Tauri로 대체) |
| i18n | 한국어 단일 |
| 자동 업데이트 | 로컬 빌드, 업데이트 서버 없음 |

**위젯 개수 제한:** Jira 4 / GitHub 4 / Todo 8 (타입별)

---

## 작업 방식

- **UI를 만들거나 고칠 때는 `impeccable` 스킬을 사용한다.** (사용자 지시)
- 구현 순서: 1차 Jira 목록 → 2차 상세·생성 → 3차 GitHub·Todo → 4차 트레이·알림
  (상세는 DECISIONS.md 20장)
- 1차의 목표는 **뼈대 검증** — IPC·키체인·폴링·캐시·그리드·에러 처리가 실제로 도는지.
- 사실은 추측하지 말고 조회한다. Atlassian MCP로 실제 스키마를 확인할 수 있다.
- 단축키: `⌘,` 설정 / `⌘R` 전체 새로고침 / `⌘N` 위젯 추가 / `Esc` 모달 닫기
