/**
 * 셔플 재생 순서.
 *
 * ## 왜 "매번 무작위로 한 장"이 아닌가
 *
 * `photos[Math.floor(Math.random() * n)]`은 짧지만 **같은 사진이 연달아 나온다.**
 * 사진이 10장이면 두 번 연속 같은 장이 나올 확률이 10%다. 배경으로 놔두고
 * 곁눈으로 보는 위젯에서 그건 "안 바뀌었다 = 고장났다"로 읽힌다.
 *
 * 그래서 음악 플레이어의 셔플과 같은 방식을 쓴다: **목록을 한 번 섞어 고정
 * 순서를 만들고 그 순서로 돈다.** 한 바퀴를 다 돌면 다시 섞는다. 전체를 다
 * 보기 전에는 같은 사진이 두 번 나오지 않는다.
 *
 * ## 순서를 디스크에 저장하지 않는다
 *
 * 셔플 순서는 세션 동안만 유지된다. 재시작하면 새로 섞인다 — 그게 기분 전환용
 * 배경에 맞고, 저장하면 board.json에 사진 1000개의 순열이 들어간다.
 */

/**
 * Fisher-Yates. 원본 배열을 건드리지 않는다.
 *
 * `rng`를 인자로 받는 이유는 테스트다. `Math.random()`을 직접 부르면
 * "전체를 다 돌고 나서 반복하는지"를 확인할 방법이 없다.
 */
export function shuffled<T>(items: readonly T[], rng: () => number = Math.random): T[] {
  const out = [...items]
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1))
    // biome-ignore lint/style/noNonNullAssertion: i, j 모두 배열 범위 안이다
    const tmp = out[i]!
    // biome-ignore lint/style/noNonNullAssertion: 위와 같음
    out[i] = out[j]!
    out[j] = tmp
  }
  return out
}

/**
 * 재생 순서를 들고 있는 상태.
 *
 * `order`는 `photos`의 **인덱스** 배열이다. 경로 문자열을 복사하지 않으므로
 * 사진 1000장이어도 배열 하나가 늘 뿐이다.
 */
export interface Playback {
  order: number[]
  /** `order`에서 지금 보고 있는 위치 */
  cursor: number
}

/** 사진 개수만큼의 새 순서를 만든다. */
export function newPlayback(count: number, rng: () => number = Math.random): Playback {
  const indices = Array.from({ length: count }, (_, i) => i)
  return { order: shuffled(indices, rng), cursor: 0 }
}

/**
 * 다음 장으로.
 *
 * 끝에 닿으면 **다시 섞어서** 처음으로 돌아간다. 같은 순서를 반복하면
 * 두 바퀴째부터는 "다음에 뭐 나올지 아는" 상태가 된다.
 */
export function advance(
  playback: Playback,
  count: number,
  rng: () => number = Math.random,
): Playback {
  if (count <= 0) return { order: [], cursor: 0 }

  // 사진 개수가 바뀌었다(재스캔). 순서를 다시 만든다.
  if (playback.order.length !== count) return newPlayback(count, rng)

  const next = playback.cursor + 1
  if (next >= playback.order.length) return newPlayback(count, rng)
  return { order: playback.order, cursor: next }
}

/** 지금 보여줄 사진의 인덱스. 사진이 없으면 null. */
export function currentIndex(playback: Playback): number | null {
  return playback.order[playback.cursor] ?? null
}
