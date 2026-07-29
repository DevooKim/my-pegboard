#!/usr/bin/env bash
# my-pegboard 실행. 이미 떠 있으면 기존 창을 앞으로 가져온다.
set -euo pipefail
cd "$(dirname "$0")"
export PATH="$HOME/.cargo/bin:$PATH"

BIN=src-tauri/target/debug/my-pegboard

if [[ "${1:-}" == "--build" || ! -x "$BIN" ]]; then
  echo "빌드 중…"
  bun run build >/dev/null
  bun run tauri build --debug --no-bundle 2>&1 | tail -1
fi

pkill -f "target/debug/my-pegboard" 2>/dev/null || true
sleep 0.5
open "$PWD/$BIN"
echo "실행됨 — 창이 안 보이면 ⌘Tab 으로 my-pegboard 선택"
