# my-pegboard

페그보드처럼 위젯을 배치하는 **개인용 데스크톱 대시보드**. Tauri 2 + React 19.
macOS 데스크톱 앱. 각자 자기 기기에서 자기 계정으로 쓰는 단일 사용자 도구다.

**설계 결정의 근거는 `docs/DECISIONS.md`에 있다. 기존 결정을 뒤집기 전에 반드시 읽을 것.**

---

## 이 프로젝트의 두 가지 대전제

### 1. 속도가 기능보다 우선한다

이 앱의 목표는 **여러 도구에 흩어진 내 작업을 한 화면에서 즉시 보는 것**이다.
각 서비스의 웹 UI를 열어 기다리는 것보다 빨라야 존재 이유가 있다.
기능을 추가할 때 속도를 해치면 그 기능은 틀렸다.

핵심 약속: **앱을 켜면 즉시 지난 데이터가 보이고, 그 뒤에 조용히 갱신된다.**
빈 화면 + 스피너로 시작하지 않는다. 디스크 캐시를 먼저 그린다.

### 2. 실패는 화면에 드러나야 한다

이 앱은 백그라운드에서 API를 호출한다. 무언가 잘못됐을 때 콘솔에만 남으면
사용자는 "왜 안 뜨지?"만 겪는다.

여기서 파생되는 규칙:
- **조용한 실패 금지.** 실패는 반드시 화면에 드러나야 한다. 무엇을 해야 하는지까지 적는다.
- **미지원/미구현도 드러낸다.** ADF 렌더러가 모르는 노드를 만나면 회색 플레이스홀더를 그린다.
  건너뛰면 "안 그려진 줄도 모르는" 상태가 된다.
- **React 컴포넌트는 평범하고 읽기 쉽게.** 영리한 추상화 금지. 위젯 하나 = 파일 하나.
  화면을 보고 "여기 색 바꾸고 싶다"고 생각했을 때 어느 파일인지 바로 짚을 수 있어야 한다.
- **Rust와 상태 관리는 테스트로 보장.** 화면에 드러나지 않는 영역이므로 조용히 깨지면 안 된다.

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
│  ├─ todo/
│  ├─ web/
│  └─ album/
├─ settings/       통합 설정 모달
├─ ipc/            Rust 커맨드 래퍼 (specta 생성물 포함)
├─ store/          zustand
└─ ui/             공용 컴포넌트

src-tauri/src/
├─ commands/       IPC 커맨드
├─ providers/      jira/ github/ album/ — API 클라이언트·타입·캐시 (album은 로컬 스캔)
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

**조작 범위: 읽기 + 생성 + 상태 변경.** 담당자 변경·필드 편집·코멘트 작성은 브라우저에서.
(이유: 앱의 역할은 "빠르게 보는 것". 편집은 빈도가 낮다. 생성과 상태 변경만
빈도가 높아서 예외다 — DECISIONS 11.5)

**상태 변경(transition)은 배지를 눌러 팝오버로.** 지켜야 할 것 네 가지:
- 전이 목록은 **조회한다.** 워크플로우가 프로젝트마다 다르다 (실측: EDU 5개 / DTH 7개)
- **필수 필드가 걸린 전이는 실행하지 않는다.** 폼을 만들지 않고 "입력 필요" +
  브라우저 링크로 바꾼다. 숨기면 "왜 완료 버튼이 없지"라는 조용한 실패가 된다.
  판정 규칙은 생성 폼과 같다 — `required && !hasDefaultValue`
- **자동 재시도 금지.** 전이는 멱등이 아니다. 두 번 나가면 워크플로우가 두 칸 움직인다
- 성공 응답은 **204 No Content**. 본문을 파싱하면 성공을 실패로 보고한다

---

## GitHub

- **GraphQL API만.** github.com 전용 (Enterprise 미지원).
- REST 검색은 **분당 30회** 제한 → PR별 리뷰 상태를 개별 조회하면 즉시 초과.
- GraphQL 한 요청으로 목록 + `reviewDecision` + `statusCheckRollup` + 변경 규모를 받는다.
  검색 1회 = **1점** / 시간당 5000점 (실측). rate limit은 제약이 아니다.
- 위젯 타입은 **하나**. PR/Issue는 쿼리로 구분 (`is:pr` / `is:issue`).
- **읽기 전용.** 상세 모달 없음 — 누르면 브라우저로 나간다.
  (Jira에 상세를 만든 건 회사 Jira 웹이 느려서다. GitHub 웹은 그 전제가 없다)

**실측으로 알아낸 함정 (2026-08-02):**
- `statusCheckRollup`은 **최상위 필드가 아니다** — `commits(last:1).nodes[0].commit` 아래.
  경로가 틀리면 조용히 `None`이 된다
- `reviewDecision`은 리뷰어 미지정 시 `null`
- **GraphQL은 실패해도 200을 준다.** 본문 `errors`를 봐야 한다
- **403이 rate limit일 수 있다.** `x-ratelimit-remaining: 0`이 유일한 단서 —
  안 보면 SSO 미인증을 재시도하며 시간을 버린다
- 검색이 **총 건수를 준다**(`issueCount`). Jira 신규 검색과 다르다

**인증:** 토큰을 키체인에 저장한다. 설정창의 "gh CLI에서 가져오기"가
`gh auth token`을 한 번 실행해 **복사**한다 — gh에 런타임 의존하지 않는다.
조직 저장소가 안 보이면 대개 **SSO 미인증**이다 (DECISIONS 12.4).

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
- 자동 이월은 위젯 설정에서 끌 수 있다. 끄면 헤더의 `↓` 버튼으로 필요할 때만 가져온다.
- **순서 변경은 드래그.** 미완료 항목만, 같은 날짜 안에서만.
  끄는 주체는 **손잡이**다 — 행에 `draggable`을 걸면 React 재조정과 싸우게 된다
  (DECISIONS 13에 실패 두 번의 기록이 있다).

---

## 앨범

**기분 전환용 배경이다. 사진 뷰어가 아니다.**
파일명·촬영일·EXIF·썸네일 그리드·확대보기를 **만들지 않는다** — 사진을 제대로
보려면 미리보기 앱이 낫다 (GitHub 상세를 안 만든 것과 같은 논리, DECISIONS 24.1).

- 소스는 **폴더 하나 또는 파일 목록** 둘뿐. 파일 하나만 고르면 자연히 "고정 배경"
- 스캔은 **비재귀 · 상한 1000장 · 확장자만 본다**(jpg jpeg png gif webp heic, 대소문자 무시)
- 상한 초과분은 **"N장은 표시하지 않음"으로 화면에 드러낸다.** 조용한 절단 금지
- **셔플 재생** — 목록을 한 번 섞어 그 순서로 돌고, 끝에 닿으면 다시 섞는다.
  매번 독립 무작위 추출이 아니다(같은 사진이 연달아 나와 고장난 것처럼 느껴진다).
  셔플은 **React가** 한다. Rust에 `rand`를 넣지 않는다
- 기본 순환 주기 10초, **0이면 자동 순환 없음**. **`prefers-reduced-motion`이면
  즉시 교체 + 자동 순환 정지**
- **위젯 면적 전체 클릭 = 다음 장.** `object-fit: cover`
- 폴링 없음. 새로고침 버튼은 재스캔

### ⚠️ `asset:` 프로토콜 — 조용히 깨지는 곳

이미지는 `convertFileSrc()`로 `asset://localhost/...`를 만들어 넣는다
(네이티브 스트리밍, IPC 페이로드 0, 원본 화질). **base64로 내리지 않는다** —
"필요한 필드만 남긴다"는 원칙 위반이다.

**CSP만 보고 판단하면 틀린다.** CSP에 `img-src ... asset:`이 있어도
`app.security.assetProtocol.enable`이 꺼져 있으면 `convertFileSrc()`는
**에러 없이** URL을 만들고 `<img>`는 **에러 없이** 깨진다. 셋이 다 필요하다:

1. `Cargo.toml`의 `tauri`에 **`protocol-asset` feature** (`tauri-plugin-fs`는 불필요 — 코어다)
2. `tauri.conf.json`의 `assetProtocol = { enable: true, scope: [] }` —
   **정적 scope는 빈 배열.** `$HOME/**` 같은 걸 넣지 마라
3. 사용자가 고른 경로만 런타임 허용 (`allow_directory(path, false)` / `allow_file`)

**★ 런타임 스코프는 메모리에만 있다. 재시작하면 사라진다.**
`lib.rs` setup의 `restore_scopes()`가 board.json의 **모든** 앨범 위젯을 훑어
다시 허용한다. `Files` 위젯은 **파일을 하나도 빠뜨리면 안 된다.**
개발 중에는 런타임 허용이 살아 있어 **절대 재현되지 않는다** —
"어제는 됐는데 오늘 아침에 안 된다"로만 나타난다.
`providers/album/tests/mod.rs`의 `restore_covers_every_path…`가 이걸 막는다.

**앨범을 만진 뒤에는 반드시 앱을 껐다 켜서 사진이 여전히 뜨는지 본다.**
브라우저 dev 서버에는 `asset:`이 없어 원리적으로 확인할 수 없다.

**폴더 선택은 Rust 커맨드가 한다** (`tauri-plugin-dialog`, npm 패키지 없음).
커맨드 하나가 다이얼로그 → 스코프 허용 → 스캔 → 캐시를 전부 한다.
프론트에 JS 플러그인을 붙이면 "경로는 골랐는데 스코프가 아직 없는" 상태가 생긴다.

---

## 제약 (지금은 하지 않는 것)

의도적으로 뺀 것들이다. 추가하려면 DECISIONS.md의 근거를 먼저 확인할 것.

| 항목 | 상태 |
|---|---|
| 다중 보드 | 데이터 구조는 준비됨, **UI만 없음** |
| 다중 연결 | 구조 준비됨 (`connectionId: "default"`), UI 없음 |
| 트레이 상주·백그라운드 폴링·알림 | 4차 |
| 설정창 `일반` 탭 | 넣을 앱 전역 설정이 0개 (DECISIONS 15) |
| 정보 탭의 메모리·폴링 소요 시간 | 성능 계측은 별개 작업. `app_info`가 자리만 잡아둠 |
| Jira 상태 변경(transition) | **있음** — 배지 → 팝오버. 필수 필드가 걸린 전이만 브라우저로 (DECISIONS 11.5 개정) |
| Jira 전이의 필수 필드 폼 | **안 만든다.** 필드 타입별 렌더러가 다시 필요해진다 → 브라우저 링크로 대체 |
| 이미지 첨부 렌더링 | 인증 URL 재요청 필요, 보류 |
| 앨범 재귀 스캔·EXIF·썸네일 | **의도적으로 없음** (DECISIONS 24.1 / 24.5) |
| PWA | **폐기됨** (Tauri로 대체) |
| i18n | 한국어 단일 |
| 자동 업데이트 | **있음** — GitHub Release 기반 (DECISIONS 23) |

**위젯 개수 제한:** Jira 4 / GitHub 4 / **Todo 1** / Web 4 / **앨범 4** (타입별)
Todo가 1개인 이유: 모든 Todo 위젯이 같은 `todos.json`을 읽는다. 두 번째는
같은 목록을 한 번 더 그릴 뿐이면서 위젯 간 동기화 비용만 만든다.
앨범이 4개인 이유: 폴더가 다르면 다른 내용이다. 같은 기준을 반대로 적용한 것.

---

## 작업 방식

- 구현 순서: 1차 Jira 목록 → 2차 상세·생성 → 3차 GitHub·Todo → 4차 트레이·알림
  (상세는 DECISIONS.md 20장)
  **진행:** 1차·2차·3차 완료. 다음은 **4차(트레이·백그라운드 폴링·알림)**.
- 1차의 목표는 **뼈대 검증** — IPC·키체인·폴링·캐시·그리드·에러 처리가 실제로 도는지.
- **사실은 추측하지 말고 조회한다.** Jira API 응답 구조는 문서와 다를 때가 있다.
  실제 응답을 받아 확인한 뒤 코드를 쓴다.
- **웹뷰 밖을 먼저 의심한다.** 웹 코드가 멀쩡한데 동작이 없으면 Tauri 설정·OS 레벨을
  본다. 드래그가 안 되던 원인은 `dragDropEnabled`였고, 코드만 읽다 네 번 헛짚었다.
- 새 위젯을 추가할 때는 **`new-widget` 스킬**을 쓴다 (`.agents/skills/new-widget/`).
  등록 지점이 7곳이라 하나만 빠뜨려도 위젯이 재시작 때 조용히 사라진다.
- 단축키: `⌘,` 설정 / `⌘R` 전체 새로고침 / `⌘N` 위젯 추가 / `Esc` 모달 닫기
  / `⌘⇧N` 티켓 생성(첫 Jira 위젯)

---

## 릴리즈

```bash
# 1. 버전을 네 곳에 올린다 (셋을 고치면 Cargo.lock이 따라온다)
#    package.json · src-tauri/tauri.conf.json · src-tauri/Cargo.toml
cd src-tauri && cargo check && cd ..

# 2. 검증
bun run typecheck && bun run lint && bun run test
cd src-tauri && cargo test && cd ..

# 3. ★ 서명 키를 환경변수로 — 없으면 updater 번들이 조용히 안 만들어진다
#    비밀번호는 키체인에서 읽는다. 명령줄에 적으면 셸 히스토리에 남는다.
#    최초 1회 등록:
#      security add-generic-password -a "$USER" -s my-pegboard-updater-key -w '<비밀번호>'
export TAURI_SIGNING_PRIVATE_KEY="$(cat ~/.tauri/my-pegboard.key)"
export TAURI_SIGNING_PRIVATE_KEY_PASSWORD="$(security find-generic-password -s my-pegboard-updater-key -w)"

# 4. 빌드
bun run tauri build

# 5. latest.json 생성 (손으로 만들지 말 것)
./scripts/make-latest-json.sh

# 6. ★ 배포 전 검사 — 건너뛰지 말 것 (검사 9개)
./scripts/verify-release.sh

# 7. 태그 + 릴리즈 — 에셋 4개 전부, --prerelease 없이
git tag -a vX.Y.Z-alpha -m "..." && git push origin vX.Y.Z-alpha
B=src-tauri/target/release/bundle
gh release create vX.Y.Z-alpha --notes-file <notes> \
  $B/dmg/my-pegboard_X.Y.Z-alpha_aarch64.dmg \
  $B/macos/my-pegboard_X.Y.Z-alpha_aarch64.app.tar.gz \
  $B/macos/my-pegboard_X.Y.Z-alpha_aarch64.app.tar.gz.sig \
  $B/macos/latest.json
```

**⚠️ `--prerelease`를 붙이지 말 것.** GitHub의 `/releases/latest`가 prerelease를
건너뛰어서 updater endpoint가 404가 된다. 태그의 `-alpha`는 그대로 두므로
"알파"라는 신호는 유지된다. (DECISIONS 23.5)

**⚠️ `latest.json`이 빠지면 기존 사용자는 새 버전을 영원히 못 본다.** 조용한 실패다.

**3번이 있는 이유:** 개인키 없이 빌드하면 tauri가 updater 번들을 **에러 없이 그냥
만들지 않는다.** dmg는 정상이라 빌드한 기기에서는 아무 이상이 없고, 기존 사용자만
"새 버전이 안 뜬다"를 겪는다. v0.3.0 서명 사고와 구조가 같다. `verify-release.sh`의
검사 6이 이걸 막는다. **키/비밀번호를 잃으면 이미 배포된 앱은 영구히 업데이트를
받지 못한다** (DECISIONS 23.2).

**4번이 있는 이유:** v0.3.0-alpha를 **서명되지 않은 채로 배포했다.** 다른
맥에서 "손상되었기 때문에 열 수 없습니다"가 뜨고 우클릭→열기로도 안 뚫렸다.

무서운 부분은 **빌드한 기기에서는 멀쩡했다는 것**이다. 직접 만든 파일에는
quarantine이 없어 Gatekeeper가 검사를 안 하고, `run.sh`는 개발 빌드를 따로
서명해준다. **로컬에서 실행되는 것은 배포 가능하다는 증거가 아니다.**

`verify-release.sh`가 dmg를 마운트해 서명·리소스 봉인·quarantine 상태·
Gatekeeper 판정·버전 일치를 본다. 실패하면 exit 1이다.

**자체 서명이라 받는 사람은 첫 실행을 우클릭 → 열기로 해야 한다.** 이건
정상이고 릴리즈 노트에 매번 적는다. 경고까지 없애려면 Apple Developer
공증($99/년)이 필요한데, 개인용 앱이라 하지 않는다.
