#!/usr/bin/env bash
# ⚠️ 레거시 비상 우회 스크립트다. 기본 해결책으로 실행하지 않는다.
# `-A`는 Jira 비밀을 모든 앱에 공개하며 GitHub·Linear 키도 처리하지 못한다.
# 업데이트 간 키체인 승인은 `my-pegboard Dev` 코드 서명 신원을 유지해 해결한다.
# 빌드할 때마다 키체인 비밀번호를 묻는 문제를 없앤다.
#
# ## 왜 "모두 허용"을 눌러도 계속 묻나
#
# 키체인 항목의 접근 제어는 두 갈래다:
#
#   1. applications 목록 — 키체인 접근.app의 "모두 허용"이 비우는 것
#   2. **partition list** — cdhash(코드 서명 해시)의 allowlist. GUI가 안 건드린다
#
# 과거 ad-hoc 앱은 재빌드하면 바이너리가 바뀌고 cdhash도 바뀐다. 새 해시는 partition list에
# 없으므로 macOS가 다시 묻는다. "항상 허용"을 눌러도 **그 해시에만** 적용되므로
# 다음 빌드에서 또 묻는다. (실측: 목록에 죽은 해시가 24개까지 쌓였다)
#
# ## 이 스크립트가 하는 일
#
# 항목을 `-A`(any application, partition list 없음)로 다시 만든다.
# 해시에 의존하지 않으므로 재빌드해도 묻지 않는다.
#
# ## 안전한가
#
# 이 기기의 로그인 키체인에 있는 **개발용 항목 2개**에만 적용된다.
# `-A`는 이 기기에서 실행되는 모든 프로그램이 이 두 값을 읽을 수 있다는 뜻이다.
# 개인 기기라도 일반적인 해결책으로 받아들일 위험은 아니다. 명시적으로 이 위험을
# 감수하는 비상 상황에서만 실행할 것.
#
# 현재 해결책은 `my-pegboard Dev` 코드 서명 신원을 업데이트마다 유지하는 것이다.
# 공용 배포에서는 Developer ID Application 인증서와 공증을 사용한다.
set -euo pipefail

SERVICE="io.mypegboard.app"
ACCOUNTS=("jira.default.email" "jira.default.token")

if [[ "${PEGBOARD_ALLOW_UNSAFE_KEYCHAIN_BYPASS:-}" != "I_UNDERSTAND" ]]; then
  echo "중단: 이 스크립트는 Jira 비밀을 이 기기의 모든 앱에 공개합니다."
  echo "비상 우회를 명시적으로 감수하려면 다음 값을 설정한 뒤 다시 실행하세요:"
  echo "  PEGBOARD_ALLOW_UNSAFE_KEYCHAIN_BYPASS=I_UNDERSTAND"
  exit 1
fi

echo "키체인 항목을 재작성합니다 — $SERVICE"
echo "재빌드할 때마다 묻는 것을 없애기 위해서입니다."
echo

for acct in "${ACCOUNTS[@]}"; do
  # 기존 값을 먼저 읽는다. 못 읽으면 그 항목은 건너뛴다 —
  # 값을 잃는 것이 프롬프트보다 훨씬 나쁘다.
  if ! value=$(security find-generic-password -s "$SERVICE" -a "$acct" -w 2>/dev/null); then
    echo "  건너뜀: $acct (저장된 값이 없거나 읽지 못함)"
    continue
  fi

  if [[ -z "$value" ]]; then
    echo "  건너뜀: $acct (값이 비어 있음)"
    continue
  fi

  # -U(update)로 같은 항목을 덮어쓰면서 -A를 준다.
  # 지우고 다시 넣지 않는 이유: 그 사이에 스크립트가 죽으면 값이 사라진다.
  security add-generic-password \
    -s "$SERVICE" -a "$acct" -w "$value" -A -U

  echo "  완료: $acct"
done

echo
echo "확인 — partition list가 비어 있어야 합니다:"
security dump-keychain -a ~/Library/Keychains/login.keychain-db 2>/dev/null \
  | grep -A 40 "\"svce\"<blob>=\"$SERVICE\"" \
  | grep -c "cdhash:" \
  | sed 's/^/  남은 cdhash 항목 수: /' || echo "  0"

echo
echo "이제 ./run.sh --build 를 해도 비밀번호를 묻지 않아야 합니다."
