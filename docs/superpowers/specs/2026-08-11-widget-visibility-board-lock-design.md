# 위젯 표시와 보드 잠금 설계

## 목표

- 앨범의 hover 헤더와 사진 장수 표시가 함께 나타나고 사라진다.
- 웹 위젯 헤더가 URL 대신 사용자가 지정한 이름을 우선 표시한다.
- 활성 보드의 위젯 위치와 크기를 보드별로 잠글 수 있다.

## 앨범 표시

앨범 `headerMode`가 `hover`이면 장수 표시도 `WidgetShell`의 `group/widget` hover와
focus-within 상태를 따른다. `always`이면 헤더와 장수 표시를 모두 계속 보여준다.
폭 240px 미만에서 장수 표시를 생략하는 기존 규칙은 유지한다.

## 웹 위젯 헤더

`WebHost`는 `definition.deriveTitle(widget.config)`를 헤더 제목으로 사용한다. 따라서
사용자가 지정한 이름을 우선하고, 이름이 없으면 URL 호스트명을 사용한다. 전체 URL은
iframe 주소와 `브라우저에서 열기` 동작에만 사용한다.

## 보드별 잠금

각 `Board`에 `locked: boolean`을 저장한다. 기존 v1 파일과 import 파일은 필드가 없으면
`false`로 읽으므로 스키마 버전은 유지한다. 새 보드도 잠금 해제 상태로 시작한다.

타이틀바 공통 액션에 활성 보드용 잠금 버튼을 둔다. 탭을 바꾸면 버튼의 아이콘과
접근성 이름이 해당 보드 상태로 바뀐다. 잠금은 react-grid-layout의 drag와 resize만
비활성화한다. 위젯 추가, 설정, 새로고침, 삭제와 보드 탭 순서 변경은 계속 허용한다.

잠금 상태는 board.json 저장, export, replace import, merge import에 포함된다. merge는
가져온 각 보드의 잠금 상태를 그대로 보존한다.

## 검증

- 앨범 hover/always 모드와 좁은 폭의 장수 표시를 컴포넌트 테스트로 검증한다.
- 웹 위젯의 사용자 지정 이름, 호스트명 fallback, 외부 열기를 검증한다.
- Zustand에서 기본값, 보드별 토글, 직렬화를 검증한다.
- Rust에서 필드 누락 기본값과 import/export round trip을 검증한다.
- Board에서 잠금 상태가 drag/resize 설정을 끄는지 검증한다.

## 배포

버전을 `0.7.2-beta`로 올리고 전체 TypeScript, Biome, Vitest, Rust 테스트를 통과시킨다.
고정 코드 서명 인증서와 updater 키로 빌드한 뒤 `verify-release.sh`를 통과한 네 에셋을
GitHub Release에 게시한다. prerelease 플래그는 사용하지 않는다.
