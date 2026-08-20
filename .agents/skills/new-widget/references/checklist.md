# 작업 순서 체크리스트

권장 순서는 **Rust → 등록 → View → 문서**다. 등록을 먼저 해두면 화면을 만드는
동안 실제 앱에서 확인할 수 있고, 마지막에 몰아서 하다 빠뜨리는 일이 없다.

---

## 0. 결정

- [ ] 데이터 경로: 외부 API / 로컬 파일 / 자체 로드
- [ ] 인스턴스 개수 — "여러 개 놓을 이유가 실제로 있나"
- [ ] 쓰기 있나 → 있으면 멱등성·되돌리기·낙관적 업데이트 여부
- [ ] `pollable` — 새로고침 버튼이 할 일이 있나
- [ ] `defaultLayout` / `minLayout`
- [ ] **기존 결정을 뒤집는가** → 사용자 확인 + DECISIONS 21장

---

## 1. Rust (외부 API·로컬 파일인 경우)

- [ ] `providers/<name>/` 또는 `storage/<name>.rs`
- [ ] `providers/mod.rs` 또는 `storage/mod.rs`에 새 모듈 노출
- [ ] 순수 함수는 `State`를 안 받게 뽑아서 테스트
- [ ] 에러를 일시적/영구적으로 분류 (`kind()`)
- [ ] `commands/<name>.rs` — IPC 커맨드
- [ ] `commands/mod.rs`에 새 커맨드 모듈 노출
- [ ] `state.rs`에 스토어 추가 (필요시)
- [ ] `lib.rs`와 `bindings_export.rs` **양쪽**에 커맨드 등록 — 어긋나면 바인딩과
      핸들러가 달라진다
- [ ] `cargo test` — 바인딩이 재생성된다

⚠️ 위젯별 디스크 캐시를 `storage/cache.rs`에 두면 `board_save`의
`evict_orphans`가 위젯 id 없는 파일을 **전부 지운다.** 위젯에 속하지 않는
데이터는 별도 파일로 만든다 (`jira_meta.rs` 사례).

---

## 2. 등록 7곳

`references/registration.md` 참조. 증상까지 거기 있다.

- [ ] `board.rs` `WidgetType` ⚠️ **빠뜨리면 재시작 때 위젯이 사라진다**
- [ ] `board.rs` `instance_limit()` (+ `board_tests.rs`)
- [ ] `board.rs` `as_str()`
- [ ] `types.ts` `WidgetType`
- [ ] `widgets/<name>/index.ts` + `registerWidget()`
- [ ] `main.tsx` import ⚠️ **잊기 쉽다**
- [ ] `WidgetHost.tsx` 렌더링 분기 ⚠️ **필수 — 기본 분기는 View를 그리지 않음**

여기서 등록 코드와 자동 테스트를 완료한다. 실제 앱 확인은 4장의
데이터 보호 절차를 준비한 뒤에만 한다.

---

## 3. 프론트

- [ ] `View.tsx` — 상태 7종을 어떻게 그릴지
- [ ] `ConfigForm.tsx`
- [ ] 순수 로직을 별도 파일로 (테스트하고 싶은 것)
- [ ] 밀도 전환 (폭이 좁아질 수 있으면)
- [ ] 빈 상태·에러 상태 문구 — **무엇을 해야 하는지**까지 적는다
- [ ] 테스트

---

## 4. 검증

```bash
cd src-tauri && cargo test
cd .. && bun run typecheck
bun run test
bun run lint
```

### 실제 앱 검증 전

- [ ] `./run.sh --build`가 배포판과 같은 `io.devookim.MyPegboard` 데이터를
      쓴다는 점을 사용자에게 알림
- [ ] 사용자 확인을 받음
- [ ] `board.json`을 작업 디렉터리 밖에 백업하고 경로를 기록
- [ ] 백업 후 `./run.sh --build` 실행
- [ ] 검증 후 앱 종료 → `board.json` 복원 → 구버전 앱 실행

앱에서 손으로:
- [ ] 추가 메뉴에 뜨나
- [ ] **추가 → 앱 재시작 → 살아 있나** (등록 1번)
- [ ] 상한까지 추가 → 막히나
- [ ] `minLayout`까지 줄여도 읽히나
- [ ] 데이터·연결이 없는 상태에서 안내가 뜨나 (빈 화면이 아니라)
- [ ] 실패를 일부러 만들어본다 (네트워크 끊기, 잘못된 설정) → 화면에 드러나나

---

## 5. 문서

- [ ] `docs/DECISIONS.md` — 위젯 장 또는 3장 개수표
- [ ] `docs/DESIGN.md` — 배치도 + 상태별 표현
- [ ] `CLAUDE.md` — 개수 제한 표, 디렉토리 구조
- [ ] 뒤집은 결정 → **21장에 근거와 함께**

---

## 커밋

논리 단위로 쪼갠다. 기존 이력의 결을 따르면:

```
feat(<name>): Rust 커맨드 …
feat(<name>): 위젯 프론트 …
docs: <name> 위젯 반영 …
```

커밋 메시지에 **왜 그렇게 했는지**를 적는다. 특히 뒤집은 결정과 실측으로 알아낸
사실은 반드시 남긴다 — 이 저장소의 이력이 그렇게 쓰여 있다.

git 신원은 전역 설정을 그대로 쓴다. `-c` 플래그로 덮어쓰지 않는다.
