#!/usr/bin/env bash
# 릴리스 산출물 검증기가 서명 제거와 payload 변조를 실제로 차단하는지 검사한다.
# 먼저 `bun run tauri build && ./scripts/make-latest-json.sh`를 실행해야 한다.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
VERSION=$(/usr/bin/python3 -c \
  "import json,sys; print(json.load(open(sys.argv[1]))['version'])" \
  "$ROOT/src-tauri/tauri.conf.json")
SOURCE_DMG="$ROOT/src-tauri/target/release/bundle/dmg/my-pegboard_${VERSION}_aarch64.dmg"
SOURCE_BUNDLE="$ROOT/src-tauri/target/release/bundle/macos"
ASSET="my-pegboard_${VERSION}_aarch64.app.tar.gz"

for required in "$SOURCE_DMG" "$SOURCE_BUNDLE/$ASSET" \
  "$SOURCE_BUNDLE/$ASSET.sig" "$SOURCE_BUNDLE/latest.json"; do
  if [[ ! -f "$required" ]]; then
    echo "missing release fixture: $required" >&2
    exit 1
  fi
done

TEST_DIR=$(mktemp -d)
MOUNT_DIR=$(mktemp -d)
cleanup() {
  hdiutil detach "$MOUNT_DIR" -quiet 2>/dev/null || true
  rm -rf "$TEST_DIR" "$MOUNT_DIR"
}
trap cleanup EXIT

mkdir -p "$TEST_DIR/dmg" "$TEST_DIR/macos" "$TEST_DIR/source"
cp "$SOURCE_BUNDLE/$ASSET" "$TEST_DIR/macos/"
cp "$SOURCE_BUNDLE/$ASSET.sig" "$TEST_DIR/macos/"
cp "$SOURCE_BUNDLE/latest.json" "$TEST_DIR/macos/"

# 내부 앱은 그대로지만 바깥 DMG에는 코드 서명이 없는 복사본을 만든다.
hdiutil attach -nobrowse -quiet -mountpoint "$MOUNT_DIR" "$SOURCE_DMG"
cp -R "$MOUNT_DIR/my-pegboard.app" "$TEST_DIR/source/"
hdiutil detach "$MOUNT_DIR" -quiet
hdiutil create -quiet -volname my-pegboard -srcfolder "$TEST_DIR/source" \
  -format UDZO "$TEST_DIR/dmg/my-pegboard_${VERSION}_aarch64.dmg"

if "$ROOT/scripts/verify-release.sh" \
  "$TEST_DIR/dmg/my-pegboard_${VERSION}_aarch64.dmg" >/dev/null 2>&1; then
  echo "FAIL: unsigned DMG passed release verification" >&2
  exit 1
fi
echo "PASS: unsigned DMG rejected"

# 정상 DMG로 복원한 뒤 updater payload만 바꾼다. 기존 .sig는 그대로라야 한다.
cp "$SOURCE_DMG" "$TEST_DIR/dmg/my-pegboard_${VERSION}_aarch64.dmg"
printf x >> "$TEST_DIR/macos/$ASSET"

if "$ROOT/scripts/verify-release.sh" \
  "$TEST_DIR/dmg/my-pegboard_${VERSION}_aarch64.dmg" >/dev/null 2>&1; then
  echo "FAIL: tampered updater passed release verification" >&2
  exit 1
fi
echo "PASS: tampered updater rejected"
