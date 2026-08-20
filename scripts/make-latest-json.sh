#!/usr/bin/env bash
# updater가 읽을 latest.json을 만든다.
#
# ## 왜 스크립트인가
#
# 이 파일은 손으로 만들면 반드시 틀린다. 서명 문자열이 수백 자이고, 버전·URL·
# 파일명이 세 군데서 일치해야 하며, 틀려도 **빌드는 성공한다.** 사용자가
# "업데이트 없음"을 겪을 때까지 아무도 모른다.
#
# ## 쓰는 법
#
#   bun run tauri build
#   ./scripts/make-latest-json.sh
#
# 결과: src-tauri/target/release/bundle/macos/latest.json
# 이 파일을 dmg와 **함께** 릴리즈 에셋으로 올린다.

set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BUNDLE="$ROOT/src-tauri/target/release/bundle/macos"
CONF="$ROOT/src-tauri/tauri.conf.json"

VERSION=$(/usr/bin/python3 -c "import json,sys; print(json.load(open(sys.argv[1]))['version'])" "$CONF")
if [[ -z "$VERSION" ]]; then
  echo "✗ tauri.conf.json에서 버전을 읽지 못했습니다" >&2
  exit 1
fi

# updater 번들은 .app.tar.gz다. 없으면 서명 키가 없는 채로 빌드한 것이다 —
# 이 경우 tauri가 **에러 없이 번들만 만들지 않는다.** 그 침묵을 여기서 깬다.
TARBALL="$BUNDLE/my-pegboard.app.tar.gz"
SIGFILE="${TARBALL}.sig"

if [[ ! -f "$TARBALL" ]]; then
  cat >&2 <<'MSG'
✗ updater 번들(.app.tar.gz)이 없습니다.

  개인키 없이 빌드하면 tauri는 updater 번들을 조용히 만들지 않습니다.
  릴리즈하려면 이 맥에 키가 있어야 합니다:

    export TAURI_SIGNING_PRIVATE_KEY="$(cat ~/.tauri/my-pegboard.key)"
    export TAURI_SIGNING_PRIVATE_KEY_PASSWORD='<비밀번호 관리자에 있음>'
    bun run tauri build

  키를 잃으면 이미 배포된 앱은 영구히 업데이트를 받지 못합니다.
MSG
  exit 1
fi

INFO_PATH=$(tar -tzf "$TARBALL" 2>/dev/null \
  | awk '/^[^\/]+[.]app\/Contents\/Info[.]plist$/ { print }')
if [[ -z "$INFO_PATH" || "$INFO_PATH" == *$'\n'* ]]; then
  echo "✗ updater 번들에 Info.plist가 하나만 있지 않습니다" >&2
  exit 1
fi
TARBALL_VERSION=$(tar -xOf "$TARBALL" "$INFO_PATH" 2>/dev/null \
  | plutil -extract CFBundleShortVersionString raw -o - - 2>/dev/null || true)
TARBALL_IDENTIFIER=$(tar -xOf "$TARBALL" "$INFO_PATH" 2>/dev/null \
  | plutil -extract CFBundleIdentifier raw -o - - 2>/dev/null || true)
EXPECTED_IDENTIFIER=$(/usr/bin/python3 -c \
  "import json,sys; print(json.load(open(sys.argv[1]))['identifier'])" "$CONF")
if [[ "$TARBALL_VERSION" != "$VERSION" || "$TARBALL_IDENTIFIER" != "$EXPECTED_IDENTIFIER" ]]; then
  echo "✗ updater payload과 설정의 버전·식별자가 다릅니다" >&2
  echo "    payload: $TARBALL_VERSION / $TARBALL_IDENTIFIER" >&2
  echo "    config:  $VERSION / $EXPECTED_IDENTIFIER" >&2
  exit 1
fi

if [[ ! -f "$SIGFILE" ]]; then
  echo "✗ 서명 파일이 없습니다: $SIGFILE" >&2
  exit 1
fi

SIG=$(cat "$SIGFILE")

# tauri가 만드는 이름은 `my-pegboard.app.tar.gz` — **버전이 없다.**
# 그대로 올리면 릴리즈 페이지마다 같은 이름의 에셋이 쌓여 어느 버전인지
# 구분되지 않는다. dmg처럼 버전을 넣어 사본을 만든다.
ASSET="my-pegboard_${VERSION}_aarch64.app.tar.gz"
cp -f "$TARBALL" "$BUNDLE/$ASSET"
cp -f "$SIGFILE" "$BUNDLE/${ASSET}.sig"

URL="https://github.com/DevooKim/my-pegboard/releases/download/v${VERSION}/${ASSET}"

# pub_date는 RFC 3339. updater는 표시에만 쓰고 비교에는 version을 쓴다.
PUB_DATE=$(date -u +"%Y-%m-%dT%H:%M:%SZ")

OUT="$BUNDLE/latest.json"
/usr/bin/python3 - "$OUT" "$VERSION" "$PUB_DATE" "$SIG" "$URL" <<'PY'
import json, sys
out, version, pub_date, sig, url = sys.argv[1:6]
# 타깃 키는 아키텍처별로 갈린다. 이 앱은 Apple Silicon 전용 빌드다.
doc = {
    "version": version,
    "pub_date": pub_date,
    "platforms": {
        "darwin-aarch64": {"signature": sig, "url": url},
    },
}
with open(out, "w") as f:
    json.dump(doc, f, indent=2)
    f.write("\n")
PY

echo "✓ $OUT"
echo "    버전   $VERSION"
echo "    에셋   $ASSET"
echo
echo "릴리즈에 **dmg + $ASSET + latest.json 셋 다** 올리세요."
echo "latest.json이 빠지면 기존 사용자는 새 버전을 영원히 보지 못합니다."
