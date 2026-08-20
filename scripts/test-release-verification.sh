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

for required in "$SOURCE_DMG" \
  "$SOURCE_BUNDLE/my-pegboard.app.tar.gz" \
  "$SOURCE_BUNDLE/my-pegboard.app.tar.gz.sig" \
  "$SOURCE_BUNDLE/$ASSET" "$SOURCE_BUNDLE/$ASSET.sig" \
  "$SOURCE_BUNDLE/latest.json"; do
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
cp "$SOURCE_DMG" "$TEST_DIR/dmg/"
cp "$SOURCE_BUNDLE/my-pegboard.app.tar.gz" "$TEST_DIR/macos/"
cp "$SOURCE_BUNDLE/my-pegboard.app.tar.gz.sig" "$TEST_DIR/macos/"
cp "$SOURCE_BUNDLE/$ASSET" "$TEST_DIR/macos/"
cp "$SOURCE_BUNDLE/$ASSET.sig" "$TEST_DIR/macos/"
cp "$SOURCE_BUNDLE/latest.json" "$TEST_DIR/macos/"
SIGNED_DMG="$TEST_DIR/dmg/my-pegboard_${VERSION}_aarch64.dmg"

expect_rejected() {
  local description="$1"
  local expected_message="$2"
  local dmg="$3"
  local log="$TEST_DIR/${description}.log"
  if "$ROOT/scripts/verify-release.sh" "$dmg" >"$log" 2>&1; then
    echo "FAIL: $description passed release verification" >&2
    exit 1
  fi
  if ! grep -Fq "$expected_message" "$log"; then
    echo "FAIL: $description was rejected for the wrong reason" >&2
    cat "$log" >&2
    exit 1
  fi
  echo "PASS: $description rejected"
}

if ! "$ROOT/scripts/verify-release.sh" "$SIGNED_DMG" >/dev/null 2>&1; then
  echo "FAIL: untouched release fixture did not pass verification" >&2
  exit 1
fi
echo "PASS: untouched release fixture accepted"

# 내부 앱은 그대로지만 바깥 DMG에는 코드 서명이 없는 복사본을 만든다.
hdiutil attach -nobrowse -quiet -mountpoint "$MOUNT_DIR" "$SOURCE_DMG"
cp -R "$MOUNT_DIR/my-pegboard.app" "$TEST_DIR/source/"
hdiutil detach "$MOUNT_DIR" -quiet
hdiutil create -quiet -volname my-pegboard -srcfolder "$TEST_DIR/source" \
  -format UDZO "$TEST_DIR/dmg/unsigned-my-pegboard_${VERSION}_aarch64.dmg"

expect_rejected "unsigned DMG" \
  "DMG가 기대한 my-pegboard Dev 인증서로 서명되지 않았습니다" \
  "$TEST_DIR/dmg/unsigned-my-pegboard_${VERSION}_aarch64.dmg"

# canonical payload 바이트만 바꾸면 암호학적 서명 검증이 실패해야 한다.
printf x >> "$TEST_DIR/macos/my-pegboard.app.tar.gz"
expect_rejected "tampered canonical updater" \
  "updater payload가 앱에 박힌 공개키로 검증되지 않습니다" "$SIGNED_DMG"
cp "$SOURCE_BUNDLE/my-pegboard.app.tar.gz" "$TEST_DIR/macos/"

# 업로드할 버전 복사본이 canonical payload와 달라져도 거부해야 한다.
printf x >> "$TEST_DIR/macos/$ASSET"
expect_rejected "tampered updater upload copy" \
  "latest.json URL이 가리키는 파일이 번들에 없습니다" "$SIGNED_DMG"
cp "$SOURCE_BUNDLE/$ASSET" "$TEST_DIR/macos/"

# 클라이언트가 실제 쓰는 latest.json signature만 달라져도 거부해야 한다.
/usr/bin/python3 - "$TEST_DIR/macos/latest.json" <<'PY'
import json, sys
path = sys.argv[1]
with open(path) as f:
    doc = json.load(f)
doc["platforms"]["darwin-aarch64"]["signature"] = "tampered"
with open(path, "w") as f:
    json.dump(doc, f, indent=2)
    f.write("\n")
PY
expect_rejected "tampered latest.json signature" \
  "latest.json signature가 canonical updater 서명과 다릅니다" "$SIGNED_DMG"
