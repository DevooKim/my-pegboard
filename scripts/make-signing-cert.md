# 개발용 서명 인증서 만들기

`run.sh`가 빌드 결과물에 붙이는 self-signed 인증서를 만든다. **한 번만 하면 된다.**

## 왜 필요한가

서명이 없으면 macOS가 빌드할 때마다 앱을 '다른 앱'으로 보고 **키체인 접근을 다시
묻는다.** 안정된 신원을 붙이면 그 질문이 사라진다.

Apple Developer 계정은 필요 없다. 이건 배포용이 아니라 **이 기기에서 나 자신을
알아보게 하는 용도**다. 남에게 배포하려면 notarization이 필요하고 그건 별개 문제다.

## 만드는 법 (GUI, 2분)

`certtool`로는 코드 서명용 인증서를 만들 수 없어서 GUI를 써야 한다.

1. **키체인 접근.app** 실행
2. 메뉴 → **인증서 지원** → **인증서 생성…**
3. 입력:
   - **이름**: `my-pegboard Dev`  ← `run.sh`의 `IDENTITY`와 정확히 같아야 한다
   - **신원 유형**: 자체 서명 루트
   - **인증서 유형**: **코드 서명**
   - "기본값 무시"는 체크하지 않아도 된다
4. 계속 → 생성 → 완료

## 확인

```bash
security find-identity -v -p codesigning
```

`"my-pegboard Dev"`가 목록에 나오면 된다. 그 다음 `./run.sh --build`를 하면
`서명 완료 (my-pegboard Dev)`가 찍힌다.

## 다른 이름을 쓰고 싶다면

`run.sh`를 고치지 말고 환경변수로 넘긴다:

```bash
export PEGBOARD_SIGN_IDENTITY="내가 만든 이름"
```

## 인증서를 바꾸면 키체인을 한 번 다시 묻는다

서명이 바뀌면 코드 서명 해시(cdhash)가 달라지고, macOS는 그걸 새 앱으로 본다.
**처음 한 번만** 묻고 그 뒤로는 조용하다.

계속 묻는다면 `scripts/fix-keychain-prompt.sh`를 실행한다 — 키체인 항목의
partition list(cdhash allowlist)를 비워 해시 의존을 없앤다.

## 옛 인증서 정리 (선택)

이 프로젝트는 예전에 다른 앱용 인증서(`My AltTab Dev`)를 빌려 썼다. 그 인증서를
쓰는 다른 프로젝트가 없다면 키체인 접근.app에서 지워도 되지만, **AltTab을 직접
빌드해 쓰고 있다면 지우지 말 것.**
