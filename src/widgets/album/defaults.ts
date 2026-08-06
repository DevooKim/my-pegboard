/**
 * 앨범 위젯 설정의 기본값.
 *
 * `index.ts`가 아니라 별도 파일에 있는 이유: `View`와 `ConfigForm`이 이걸
 * 필요로 하는데, 둘은 `index.ts`가 import하는 쪽이다. 거기서 다시
 * `index.ts`를 가져오면 순환 import가 된다.
 */

/**
 * 순환 주기 기본값(초).
 *
 * `defaultConfig`에 이미 들어가지만 View·ConfigForm도 이 값을 안다. board.json은
 * 손으로 고칠 수 있고(DECISIONS 10), `intervalSecs`가 없는 파일에서 `?? 0`으로
 * 떨어지면 자동 순환이 **조용히 꺼진다.** 값이 없다는 것은 "안 넘김"이 아니라
 * "정하지 않았음"이다. (GitHub 위젯의 `groupByRepo ?? true`와 같은 처리)
 */
export const DEFAULT_INTERVAL_SECS = 10

/**
 * 자동 순환을 켠 경우의 하한(초).
 *
 * 크로스페이드가 0.3초라 1초 주기면 계속 페이드 중인 상태가 된다.
 * 0은 '자동 순환 안 함'이므로 하한을 적용하지 않는다.
 */
export const MIN_INTERVAL_SECS = 3
