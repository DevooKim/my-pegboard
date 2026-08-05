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

echo
if [[ $fail -eq 0 ]]; then
  echo "통과. 배포해도 됩니다."
  echo "받는 사람에게 **첫 실행은 우클릭 → 열기**라고 알려주세요 (자체 서명)."
else
  echo "실패. 위 항목을 고치기 전에 배포하지 마세요." >&2
  exit 1
fi
