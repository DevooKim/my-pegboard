#!/usr/bin/env bash
# 배포 직전 dmg를 검사한다. **릴리즈 전에 반드시 통과시킬 것.**
#
# ## 왜 이 스크립트가 있나
#
# v0.3.0-alpha가 **서명되지 않은 채로 배포됐다.** 다른 맥에서 받으면
# "손상되었기 때문에 열 수 없습니다"가 뜨고 우클릭→열기로도 안 뚫렸다.
#
# 원인은 tauri.conf.json에 서명 ID가 없어 Tauri가 번들 서명을 통째로
# 건너뛴 것이었다(지금은 `signingIdentity: "-"`로 고쳤다). 그런데 **빌드한
# 기기에서는 멀쩡해 보였다** — 직접 만든 파일에는 quarantine이 없어
# Gatekeeper가 검사를 안 하기 때문이다. run.sh가 개발 빌드를 따로 서명해주는
# 것도 착시에 한몫했다.
#
# 즉 **로컬에서 실행되는 것은 배포 가능하다는 증거가 아니다.** 이 스크립트가
# 그 간극을 메운다. `codesign --verify` 한 번이면 그때 잡혔을 일이다.
#
# ## 쓰는 법
#
#   bun run tauri build
#   ./scripts/verify-release.sh
#
# 인자로 dmg 경로를 주면 그것을, 안 주면 target에서 가장 최근 것을 검사한다.

# `-e`를 안 켜는 이유: 검사 하나가 실패해도 **나머지를 끝까지 돌려야 한다.**
# 첫 실패에서 멈추면 고치고 다시 돌리기를 반복하게 되고, 문제가 몇 개인지
# 알 수 없다. 실패는 `fail` 플래그로 모아 마지막에 판정한다.
set -uo pipefail

DMG="${1:-}"
if [[ -z "$DMG" ]]; then
  DMG=$(ls -t src-tauri/target/release/bundle/dmg/*.dmg 2>/dev/null | head -1 || true)
fi

if [[ -z "$DMG" || ! -f "$DMG" ]]; then
  echo "✗ dmg를 찾을 수 없습니다. 먼저 'bun run tauri build'를 실행하세요." >&2
  exit 1
fi

echo "검사 대상: $DMG"
echo

MOUNT=$(mktemp -d)
cleanup() { hdiutil detach "$MOUNT" -quiet 2>/dev/null || true; rmdir "$MOUNT" 2>/dev/null || true; }
trap cleanup EXIT

hdiutil attach -nobrowse -quiet -mountpoint "$MOUNT" "$DMG"

APP=$(ls -d "$MOUNT"/*.app 2>/dev/null | head -1 || true)
if [[ -z "$APP" ]]; then
  echo "✗ dmg 안에 .app이 없습니다" >&2
  exit 1
fi

fail=0

# ── 1. 번들 서명이 유효한가 ────────────────────────────────────────────
# v0.3.0을 무너뜨린 바로 그 검사다.
if codesign --verify --deep --strict "$APP" 2>/dev/null; then
  echo "✓ 서명 유효"
else
  echo "✗ 서명이 깨졌습니다 — 다른 맥에서 '손상됨'으로 열리지 않습니다"
  codesign --verify --deep --strict "$APP" 2>&1 | sed 's/^/    /'
  fail=1
fi

# ── 2. 리소스 봉인이 있는가 ────────────────────────────────────────────
# 없으면 1번이 실패한다. 원인을 바로 짚어주려고 따로 본다.
if [[ -f "$APP/Contents/_CodeSignature/CodeResources" ]]; then
  echo "✓ 리소스 봉인 있음"
else
  echo "✗ _CodeSignature/CodeResources 없음 — 번들 서명이 건너뛰어졌습니다"
  echo "    tauri.conf.json의 bundle.macOS.signingIdentity를 확인하세요"
  fail=1
fi

# ── 3. quarantine 상태에서도 서명이 버티는가 ───────────────────────────
# 다운로드한 파일을 흉내낸다. 실제 사용자가 겪는 조건이다.
QT=$(mktemp -d)
cp -R "$APP" "$QT/"
QAPP="$QT/$(basename "$APP")"
xattr -w com.apple.quarantine "0083;00000000;Safari;" "$QAPP"
if codesign --verify --deep --strict "$QAPP" 2>/dev/null; then
  echo "✓ quarantine 상태에서도 서명 유효"
else
  echo "✗ quarantine이 붙으면 서명 검증이 실패합니다"
  fail=1
fi
rm -rf "$QT"

# ── 4. Gatekeeper 판정 ─────────────────────────────────────────────────
# adhoc 서명이라 rejected가 정상이다. **거부 사유**가 중요하다:
#   - "손상됨"류  → 못 뚫는다. 실패다
#   - 미공증      → 우클릭→열기로 통과된다. 예상된 결과다
GK=$(spctl -a -vvv -t exec "$APP" 2>&1 || true)
if grep -q "no resources\|invalid\|corrupt" <<<"$GK"; then
  echo "✗ Gatekeeper: 손상 판정 — 우클릭→열기로도 못 엽니다"
  echo "$GK" | sed 's/^/    /'
  fail=1
else
  echo "✓ Gatekeeper: 미공증 거부(정상) — 우클릭→열기로 실행됩니다"
fi

# ── 5. 버전이 태그와 맞는가 ────────────────────────────────────────────
# dmg 파일명과 Info.plist가 어긋나면 엉뚱한 빌드를 올리는 것이다.
PLIST_VER=$(defaults read "$APP/Contents/Info.plist" CFBundleShortVersionString 2>/dev/null || echo "?")
if [[ "$DMG" == *"$PLIST_VER"* ]]; then
  echo "✓ 버전 일치: $PLIST_VER"
else
  echo "✗ 버전 불일치 — dmg 이름과 Info.plist($PLIST_VER)가 다릅니다"
  fail=1
fi

# ══════════════════════════════════════════════════════════════════════
# updater 검사 (6~9)
# ──────────────────────────────────────────────────────────────────────
# 이 네 검사가 있는 이유는 v0.3.0 서명 사고와 **구조가 같은** 실패가
# updater에도 있기 때문이다: 개인키가 없는 맥에서 빌드하면 tauri는 에러 없이
# updater 번들을 만들지 않는다. dmg는 정상이라 로컬에서는 아무 이상이 없고,
# 기존 사용자만 "새 버전이 안 뜬다"를 겪는다. 조용한 실패를 여기서 깬다.
# ══════════════════════════════════════════════════════════════════════

BUNDLE_DIR="$(dirname "$DMG")/../macos"
CONF="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/src-tauri/tauri.conf.json"

# ── 6. updater 번들과 서명이 있는가 ────────────────────────────────────
TARBALL=$(ls -t "$BUNDLE_DIR"/*.app.tar.gz 2>/dev/null | head -1 || true)
if [[ -n "$TARBALL" && -f "$TARBALL" && -f "${TARBALL}.sig" ]]; then
  echo "✓ updater 번들 + 서명 있음 ($(basename "$TARBALL"))"
else
  echo "✗ updater 번들(.app.tar.gz)이나 .sig가 없습니다"
  echo "    개인키 없이 빌드했을 때 tauri는 **조용히** 만들지 않습니다."
  echo "    TAURI_SIGNING_PRIVATE_KEY(+PASSWORD)를 설정하고 다시 빌드하세요."
  fail=1
fi

# ── 7. 서명이 앱에 박힌 공개키로 검증되는가 ────────────────────────────
# 키를 새로 만들어 빌드하면 6번은 통과한다. 그런데 공개키가 달라서 기존
# 사용자는 설치 단계에서 검증 실패를 본다 — 그건 **복구 불가**다.
if [[ -n "$TARBALL" && -f "${TARBALL}.sig" ]]; then
  PUBKEY=$(/usr/bin/python3 -c \
    "import json,sys; print(json.load(open(sys.argv[1]))['plugins']['updater']['pubkey'])" \
    "$CONF" 2>/dev/null || true)
  if [[ -z "$PUBKEY" ]]; then
    echo "✗ tauri.conf.json에서 updater pubkey를 읽지 못했습니다"
    fail=1
  else
    # minisign 형식: 공개키/서명 모두 base64로 한 겹 싸여 있다. 벗겨서
    # keynum(8바이트 = base64 앞부분)이 같은지 본다. 다르면 다른 키다.
    KEY_ID=$(/usr/bin/python3 -c "
import base64,sys
raw = base64.b64decode(sys.argv[1]).decode().splitlines()
print(base64.b64decode(raw[1])[2:10].hex())
" "$PUBKEY" 2>/dev/null || true)
    SIG_ID=$(/usr/bin/python3 -c "
import base64,sys
raw = base64.b64decode(open(sys.argv[1]).read()).decode().splitlines()
print(base64.b64decode(raw[1])[2:10].hex())
" "${TARBALL}.sig" 2>/dev/null || true)
    if [[ -n "$KEY_ID" && "$KEY_ID" == "$SIG_ID" ]]; then
      echo "✓ 서명이 앱의 공개키와 같은 키로 만들어졌습니다"
    else
      echo "✗ 서명 키가 앱에 박힌 공개키와 다릅니다 (key=$KEY_ID sig=$SIG_ID)"
      echo "    이대로 배포하면 기존 사용자는 설치 단계에서 검증 실패를 봅니다."
      echo "    원래 개인키(~/.tauri/my-pegboard.key)로 다시 빌드하세요."
      fail=1
    fi
  fi
fi

# ── 8. latest.json 버전이 tauri.conf.json과 맞는가 ─────────────────────
LATEST="$BUNDLE_DIR/latest.json"
CONF_VER=$(/usr/bin/python3 -c \
  "import json,sys; print(json.load(open(sys.argv[1]))['version'])" "$CONF" 2>/dev/null || true)
if [[ ! -f "$LATEST" ]]; then
  echo "✗ latest.json이 없습니다 — ./scripts/make-latest-json.sh를 실행하세요"
  echo "    이 파일이 릴리즈에 없으면 기존 사용자는 새 버전을 영원히 못 봅니다."
  fail=1
else
  JSON_VER=$(/usr/bin/python3 -c \
    "import json,sys; print(json.load(open(sys.argv[1]))['version'])" "$LATEST" 2>/dev/null || true)
  if [[ -n "$JSON_VER" && "$JSON_VER" == "$CONF_VER" ]]; then
    echo "✓ latest.json 버전 일치: $JSON_VER"
  else
    echo "✗ latest.json 버전($JSON_VER)이 tauri.conf.json($CONF_VER)과 다릅니다"
    fail=1
  fi

  # ── 9. latest.json의 URL이 올릴 파일과 정확히 맞는가 ─────────────────
  # 파일명이 어긋나면 updater가 404를 받는다. 앱은 "업데이트 없음"처럼 조용하다.
  # URL이 가리키는 이름의 파일이 **실제로 번들 디렉토리에 있는지**까지 본다 —
  # 이름만 맞춰봐야 올릴 파일이 없으면 릴리즈에서 빠진다.
  JSON_URL=$(/usr/bin/python3 -c "
import json,sys
d = json.load(open(sys.argv[1]))
print(d['platforms']['darwin-aarch64']['url'])
" "$LATEST" 2>/dev/null || true)
  URL_ASSET="${JSON_URL##*/}"
  if [[ -n "$URL_ASSET" && -f "$BUNDLE_DIR/$URL_ASSET" && -f "$BUNDLE_DIR/${URL_ASSET}.sig" ]]; then
    echo "✓ latest.json URL이 올릴 파일과 일치: $URL_ASSET"
    UPLOAD_ASSET="$URL_ASSET"
  else
    echo "✗ latest.json URL이 가리키는 파일이 번들에 없습니다"
    echo "    url:    $JSON_URL"
    echo "    찾은 곳: $BUNDLE_DIR/$URL_ASSET"
    echo "    ./scripts/make-latest-json.sh를 다시 실행하세요."
    fail=1
  fi

  # URL에 태그 버전이 들어 있는가. v를 빼먹으면 404다.
  if [[ -n "$CONF_VER" && "$JSON_URL" != *"/v${CONF_VER}/"* ]]; then
    echo "✗ latest.json URL의 태그가 v${CONF_VER}가 아닙니다 — 릴리즈 태그와 어긋납니다"
    fail=1
  fi
fi

echo
if [[ $fail -eq 0 ]]; then
  echo "통과. 배포해도 됩니다."
  echo "받는 사람에게 **첫 실행은 우클릭 → 열기**라고 알려주세요 (자체 서명)."
  echo
  echo "릴리즈 에셋 넷을 모두 올리세요 (경로는 $BUNDLE_DIR):"
  echo "  - $(basename "$DMG")"
  if [[ -n "${UPLOAD_ASSET:-}" ]]; then
    echo "  - $UPLOAD_ASSET"
    echo "  - ${UPLOAD_ASSET}.sig"
  fi
  echo "  - latest.json"
  echo "**--prerelease를 붙이지 마세요.** GitHub의 /releases/latest가 건너뜁니다."
else
  echo "실패. 위 항목을 고치기 전에 배포하지 마세요." >&2
  exit 1
fi
