# 등록 7곳

새 위젯 타입을 `foo`라고 하자. 아래 7곳을 **전부** 고쳐야 한다.
각 항목에 **빠뜨렸을 때 실제로 무슨 일이 일어나는지**를 적었다 — 증상을 알아야
디버깅에 시간을 안 뺏긴다.

---

## 1. Rust `WidgetType` enum ⚠️ 가장 위험

`src-tauri/src/storage/board.rs`

```rust
pub enum WidgetType {
    Jira,
    Github,
    Todo,
    Web,
    Foo,   // ← 추가
}
```

**빠뜨리면:** serde가 `"foo"`를 역직렬화하지 못해 **`board.json` 전체를 거부한다.**
프론트만 고친 상태로 개발하면 잘 도는 것처럼 보이고, **앱을 껐다 켜면 위젯이
통째로 사라진다.** 다른 위젯까지 같이 날아간다.

실제로 web 위젯 spike에서 겪은 사고다. 커밋 `1e937f7`의 메시지에 기록돼 있다:

> Rust enum에 변형이 없으면 board_save가 보드 파일 전체를 거부해
> 위젯이 재시작 때 사라진다.

**검증:** 위젯을 추가하고 앱을 재시작한다. 살아 있어야 한다.

---

## 2. `instance_limit()`

같은 파일.

```rust
pub const fn instance_limit(self) -> usize {
    match self {
        WidgetType::Jira => 4,
        WidgetType::Github => 4,
        WidgetType::Todo => 1,
        WidgetType::Web => 4,
        WidgetType::Foo => 4,   // ← 추가
    }
}
```

**빠뜨리면:** 컴파일 실패(match 비포괄). 이건 안전한 실패다 — `match`에
`_ =>` 와일드카드를 쓰지 않는 이유가 이것이다. 컴파일러가 빠뜨림을 잡아준다.

**숫자를 정하는 기준은 부담이 아니라 의미다.** "여러 개 놓을 이유가 실제로
있나"를 묻는다. 모든 인스턴스가 같은 데이터를 본다면 1이다(Todo 사례).

`src-tauri/src/storage/tests/board_tests.rs`의 `instance_limits_match_decisions`도
같이 고친다.

---

## 3. `as_str()`

같은 파일. 프론트의 문자열 리터럴과 **정확히 일치**해야 한다.

```rust
pub const fn as_str(self) -> &'static str {
    match self {
        // ...
        WidgetType::Foo => "foo",   // ← 추가
    }
}
```

**빠뜨리면:** 컴파일 실패.

---

## 4. 프론트 `WidgetType`

`src/widgets/types.ts`

```ts
export type WidgetType = 'jira' | 'github' | 'todo' | 'web' | 'foo'
```

**빠뜨리면:** `registerWidget()`에서 타입 에러. 역시 안전한 실패다.

---

## 5. `WidgetDefinition` + `registerWidget()`

`src/widgets/foo/index.ts`

```ts
import { SomeIcon } from 'lucide-react'
import { registerWidget } from '#/widgets/registry'
import type { WidgetDefinition } from '#/widgets/types'
import { FooConfigForm } from './ConfigForm'
import { FooView } from './View'

export interface FooWidgetConfig {
  title: string | null
  // ...
}

export const fooWidget: WidgetDefinition<FooWidgetConfig> = {
  type: 'foo',
  label: '이름',                    // 추가 메뉴에 뜨는 이름
  description: '한 줄 설명',        // 추가 메뉴의 설명
  icon: SomeIcon,
  maxInstances: 4,                  // Rust instance_limit과 같은 값

  defaultConfig: { title: null },
  defaultLayout: { w: 4, h: 10 },   // 12열 기준
  minLayout: { w: 3, h: 5 },        // 이보다 작으면 안 읽히는 크기

  pollable: true,                   // false면 새로고침 버튼이 숨는다
  View: FooView,
  ConfigForm: FooConfigForm,

  deriveTitle: (config) => config.title?.trim() || '이름',
}

registerWidget(fooWidget)
```

**빠뜨리면:** 위젯 추가 메뉴에 나타나지 않는다.

**`maxInstances`가 Rust `instance_limit`과 다르면** 프론트에서는 추가되는데
Rust가 거부하는 상태가 된다. 두 숫자는 반드시 같아야 한다.

---

## 6. `main.tsx` import ⚠️ 잊기 쉽다

`src/main.tsx`

```ts
// 위젯 레지스트리 등록 — import 자체가 부수효과다
import '#/widgets/jira'
import '#/widgets/foo'    // ← 추가
import '#/widgets/web'
```

**빠뜨리면:** `index.ts`를 아무도 import하지 않으므로 `registerWidget()`이
실행되지 않는다. 추가 메뉴에 안 뜨고, board.json에 이미 있으면
"알 수 없는 위젯 타입"이 뜬다.

번들러가 사용되지 않는 모듈로 보고 떨어뜨리지 않도록 **부수효과 import**를 쓴다.

---

## 7. `WidgetHost` 렌더링 분기 ⚠️ 필수

`src/board/WidgetHost.tsx`

새 위젯의 `View`를 실제로 렌더링하는 분기를 추가한다. 현재 기본
분기는 레지스트리의 `definition.View`를 그리지 않는다.

```tsx
) : widget.type === 'foo' ? (
  <FooHost widget={widget} width={width} ... />
) : (
```

**분기의 형태:**
- 외부 API → `useFooData` 훅을 만들어 envelope을 채운다 (Jira 참고)
- 공유 스토어 → 훅 없이 View가 직접 구독 (Todo 참고)
- 자체 로드 → envelope은 껍데기 (Web 참고)
- 정적·로컬 데이터 → `ready` envelope을 넘겨 `View`를 그린다

**빠뜨리면:** 기본 분기로 떨어져 `status="idle"` 껍데기만 그려진다.
에러는 안 나고 그냥 비어 보인다 — 조용한 실패라 알아채기 어렵다.

---

## 8. IPC 커맨드를 만들었다면 — 등록처가 **두 곳**이다

> GitHub 위젯(2026-08-02)에서 실제로 걸린 함정이다. 위 7곳에는 없었다.

`#[tauri::command]`를 새로 만들면 **같은 목록을 두 파일에 적어야 한다.**

| 파일 | 역할 | 빠뜨리면 |
|---|---|---|
| `src-tauri/src/lib.rs` | 런타임 등록 | 프론트에서 부르면 "command not found" |
| `src-tauri/src/bindings_export.rs` | **TS 바인딩 생성** | `commands.foo()`가 생성물에 없다 |

후자는 `cargo test` 안에서 도는 테스트다. 컴파일도 통과하고 테스트도 초록인데
**`bindings.ts`에 함수가 안 생긴다** — 프론트를 쓸 때가 되어서야 안다.
커맨드를 추가한 뒤에는 생성물을 직접 확인하는 편이 빠르다:

```bash
cd src-tauri && cargo test && cd ..
grep -c "async fooCommand" src/ipc/bindings.ts   # 0이면 빠뜨린 것
```

## 9. Rust 타입 이름이 곧 TS 타입 이름이다

> 같은 작업에서 걸린 두 번째 함정.

specta는 모듈 경로를 버리고 **struct 이름만** 가져간다. 그래서 다른 provider가
같은 이름을 export하면 생성물에 `export type Preset`이 **두 번** 나오고,
그건 유효하지 않은 TypeScript다.

실제로 `providers/jira/presets.rs`와 `providers/github/presets.rs`가 둘 다
`Preset`을 내보내 충돌했다. GitHub 쪽을 `GithubPreset`으로 바꿔 해결했다.

**IPC 경계로 나가는 타입에는 provider 이름을 접두사로 붙인다** —
`GithubPreset`, `JiraIssue`처럼. 내부 전용 타입(`SearchNode` 등)은
`pub(crate)`로 두면 생성물에 안 나가므로 이름이 자유롭다.

생성물은 손으로 못 고친다. 이름 충돌은 **Rust에서** 풀어야 한다.

---

## 검증 순서

```bash
cd src-tauri && cargo test      # 2·3번을 컴파일러가 잡는다 + 바인딩 재생성
cd .. && bun run typecheck      # 4번
bun run test
```

`./run.sh --build`는 실제 `io.devookim.MyPegboard` 데이터를 사용하므로,
`SKILL.md` 5장의 백업·복원 절차를 준비한 뒤 실행한다.

앱에서:
1. 추가 메뉴에 뜨나? → 5·6번
2. 추가한 위젯의 본문이 실제로 뜨나? → **7번**
3. 추가하고 **재시작** → 살아 있나? → **1번**
4. 상한까지 추가 → 막히나? → 2번과 `maxInstances` 일치
