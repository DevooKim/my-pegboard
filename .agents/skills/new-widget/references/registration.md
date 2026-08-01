# 등록 6곳

새 위젯 타입을 `foo`라고 하자. 아래 6곳을 **전부** 고쳐야 한다.
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
        WidgetType::Todo => 8,
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

## 7. (조건부) `WidgetHost` 분기

`src/board/WidgetHost.tsx`

데이터 수명주기가 기존과 다르면 분기를 추가한다.

```tsx
) : widget.type === 'foo' ? (
  <FooHost widget={widget} width={width} ... />
) : (
```

**필요한 경우:**
- 외부 API → `useFooData` 훅을 만들어 envelope을 채운다 (Jira 참고)
- 공유 스토어 → 훅 없이 View가 직접 구독 (Todo 참고)
- 자체 로드 → envelope은 껍데기 (Web 참고)

**빠뜨리면:** 기본 분기로 떨어져 `status="idle"` 껍데기만 그려진다.
에러는 안 나고 그냥 비어 보인다 — 조용한 실패라 알아채기 어렵다.

---

## 검증 순서

```bash
cd src-tauri && cargo test      # 2·3번을 컴파일러가 잡는다 + 바인딩 재생성
cd .. && bun run typecheck      # 4번
bun run test
./run.sh --build
```

앱에서:
1. 추가 메뉴에 뜨나? → 5·6번
2. 추가하고 **재시작** → 살아 있나? → **1번**
3. 상한까지 추가 → 막히나? → 2번과 `maxInstances` 일치
