# 개발·릴리스용 서명 인증서 만들기

`run.sh`와 `tauri build`가 함께 쓰는 self-signed 인증서를 만든다.
**한 번만 만들고, 같은 인증서와 개인 키를 계속 보존한다.**

## 왜 필요한가

ad-hoc 서명은 macOS가 빌드할 때마다 앱을 '다른 앱'으로 보므로 **업데이트 뒤
키체인 접근을 다시 묻는다.** 같은 인증서와 `io.mypegboard.app` 식별자를 유지하면
첫 전환 뒤의 업데이트들은 같은 앱으로 인식된다.

Apple Developer 계정은 필요 없다. 이 인증서는 개인·내부 배포에서 버전 사이의
코드 신원을 유지할 뿐, Apple이 개발자를 확인했다는 뜻은 아니다. 공용 배포에서
첫 실행 경고까지 없애려면 Developer ID Application 인증서와 공증이 필요하다.

## 만드는 법 (GUI, 2분)

`certtool`로는 코드 서명용 인증서를 만들 수 없어서 GUI를 써야 한다.

1. **키체인 접근.app** 실행
2. 메뉴 → **인증서 지원** → **인증서 생성…**
3. 입력:
   - **이름**: `my-pegboard Dev`
   - **신원 유형**: 자체 서명 루트
   - **인증서 유형**: **코드 서명**
   - **기본값 무시**: 체크
4. 유효기간을 10년(3650일)으로 설정한다
5. 나머지는 기본값으로 계속 → 로그인 키체인에 생성 → 완료

## 확인

```bash
security find-identity -p codesigning
```

`"my-pegboard Dev"`가 목록에 나오면 된다. 개발 빌드는 `./run.sh --build`,
릴리스 빌드는 `bun run tauri build`에서 이 신원을 사용한다.

현재 인증서의 SHA-1 지문은 `run.sh`와 `tauri.conf.json`에 고정한다. 같은 이름으로
인증서를 다시 만들어도 지문이 달라 자동으로 사용되지 않는다. 인증서를 의도적으로
교체할 때만 아래 출력의 SHA-1 값을 두 파일에 함께 반영한다.

```bash
security find-certificate -c "my-pegboard Dev" -Z | grep "SHA-1 hash"
```

## 개인 키 백업

키체인 접근의 **내 인증서**에서 `my-pegboard Dev`를 펼쳐 개인 키를 선택하고,
암호를 건 `.p12`로 내보내 안전한 비밀 저장소에 둔다.

- `.p12`, 개인 키, 내보내기 암호, base64 본문은 Git에 커밋하지 않는다
- 인증서를 잃거나 새로 만들면 코드 신원이 바뀌어 키체인을 다시 묻는다
- `My AltTab Dev`처럼 다른 앱의 인증서를 재사용하지 않는다

## 개발 빌드에서만 다른 신원을 쓰고 싶다면

`PEGBOARD_SIGN_IDENTITY`는 `run.sh`만 덮어쓴다. 릴리스는 연속성을 위해
`tauri.conf.json`에 고정한 지문을 그대로 사용한다.

```bash
export PEGBOARD_SIGN_IDENTITY="내가 만든 이름"
```

## 인증서를 바꾸면 키체인을 한 번 다시 묻는다

서명이 바뀌면 코드 서명 해시(cdhash)가 달라지고, macOS는 그걸 새 앱으로 본다.
**처음 한 번만** 묻고 그 뒤로는 조용하다.

`scripts/fix-keychain-prompt.sh`는 모든 앱에 Jira 비밀 접근을 허용하는 `-A` 우회라
자동으로 실행하지 않는다. GitHub·Linear 키도 처리하지 못한다. 같은 인증서로 만든
두 릴리스 사이에서도 계속 묻는다면 인증서 이름과 Designated Requirement부터 확인한다.

## 옛 인증서 정리 (선택)

이 프로젝트는 예전에 다른 앱용 인증서(`My AltTab Dev`)를 빌려 썼다. 그 인증서를
쓰는 다른 프로젝트가 없다면 키체인 접근.app에서 지워도 되지만, **AltTab을 직접
빌드해 쓰고 있다면 지우지 말 것.**
