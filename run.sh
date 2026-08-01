#!/usr/bin/env bash
# my-pegboard 실행.
#
#   ./run.sh            이미 빌드된 것을 실행 (가장 빠름)
#   ./run.sh --build    프론트+Rust 빌드 후 실행
#   ./run.sh --bundle   .app 번들까지 만들고 실행 (Dock 아이콘이 제대로 나온다)
#
# 평소에는 --build로 충분하다. 실행 파일만 직접 띄우면 macOS가 아이콘을
# 읽지 못해 Dock에 기본 아이콘이 뜨는데, 개발 중에는 문제가 되지 않는다.
set -euo pipefail
cd "$(dirname "$0")"
export PATH="$HOME/.cargo/bin:$PATH"

BIN=src-tauri/target/debug/my-pegboard
APP=src-tauri/target/debug/bundle/macos/my-pegboard.app
MODE="${1:-}"

# 안정된 서명을 붙인다. 기본 ad-hoc 서명은 빌드할 때마다 바뀌어서
# macOS가 매번 '다른 앱'으로 보고 키체인 접근을 다시 묻는다.
#
# 이 프로젝트 전용 인증서를 쓴다. 없으면 기기에 있는 아무 codesigning 신원으로
# 떨어지는데, 그러면 로그에 엉뚱한 앱 이름이 찍혀 헷갈린다(예전에 AltTab용
# 인증서를 그대로 썼다). 만드는 법은 scripts/make-signing-cert.md 참고.
IDENTITY="${PEGBOARD_SIGN_IDENTITY:-my-pegboard Dev}"

sign() {
  local target="$1"

  if ! security find-identity -v -p codesigning 2>/dev/null | grep -q "$IDENTITY"; then
    echo "서명 건너뜀 — '$IDENTITY' 인증서가 없습니다"
    echo "  만드는 법: scripts/make-signing-cert.md"
    echo "  (서명이 없으면 빌드할 때마다 키체인을 다시 물어봅니다)"
    return
  fi

  if codesign --force --deep --sign "$IDENTITY" "$target" 2>/dev/null; then
    echo "서명 완료 ($IDENTITY)"
  else
    echo "서명 실패 — 키체인을 매번 물을 수 있습니다"
  fi
}

pkill -f "target/debug/my-pegboard" 2>/dev/null || true
sleep 0.5

if [[ "$MODE" == "--bundle" ]]; then
  echo "번들 빌드 중… (dmg까지 만드느라 조금 걸립니다)"
  bun run build >/dev/null
  bun run tauri build --debug 2>&1 | tail -1
  sign "$APP"
  open "$APP"
else
  if [[ "$MODE" == "--build" || ! -x "$BIN" ]]; then
    echo "빌드 중…"
    bun run build >/dev/null
    bun run tauri build --debug --no-bundle 2>&1 | tail -1
  fi
  sign "$BIN"
  # 번들이 이미 있으면 그쪽을 띄운다 — 아이콘이 제대로 나온다.
  if [[ -d "$APP" ]]; then
    cp "$BIN" "$APP/Contents/MacOS/my-pegboard"
    sign "$APP"
    open "$APP"
  else
    open "$PWD/$BIN"
  fi
fi

echo "실행됨 — 창이 안 보이면 ⌘Tab 으로 my-pegboard 선택"
