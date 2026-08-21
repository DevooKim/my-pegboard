# mediaremote-adapter (vendored)

- 출처: https://github.com/ungive/mediaremote-adapter
- 커밋: `3ac3d4bdf862c7b5399b4fba4df5689f5c38609a` (2026-08 시점 main)
- 라이선스: BSD 3-Clause (`LICENSE` 동봉)

## 왜 이게 필요한가

macOS 15.4부터 Apple이 MediaRemote(시스템 "지금 재생 중")를 엔타이틀먼트로
막았다. 이 프로젝트는 엔타이틀먼트가 있는 시스템 바이너리(`/usr/bin/perl`)로
헬퍼 프레임워크를 로드해 그 제한을 우회한다. "지금 재생 중" 위젯의 데이터
원천 전부가 이것이다.

## 무엇을 가져왔나

- `bin/mediaremote-adapter.pl` — 앱이 서브프로세스로 실행하는 CLI
- `include/`, `src/{adapter,private,utility}` — 프레임워크 소스
- `src/test`(테스트 클라이언트)는 **가져오지 않았다** — 어댑터 생존 여부는
  스트림의 첫 페이로드 수신으로 판정한다 (`providers/nowplaying` 주석 참조)

## 빌드

`build.rs`가 cargo 빌드마다 clang으로 `build/MediaRemoteAdapter.framework`를
만든다 (소스가 안 바뀌면 건너뜀). **cmake가 필요 없다** — 업스트림 CMakeLists의
컴파일 옵션(`-fobjc-arc -fvisibility=default`, Foundation·AppKit·
UniformTypeIdentifiers 링크)을 그대로 옮겼다. `build/`는 git에 넣지 않는다.

## 업데이트 방법

업스트림을 clone해서 위 파일들을 통째로 덮어쓰고 이 파일의 커밋 해시를 갱신한다.
업스트림 README의 CLI 계약(payload 키·send 명령 ID)이 바뀌었는지
`providers/nowplaying/adapter.rs`의 파싱과 대조할 것.
