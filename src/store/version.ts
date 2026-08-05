/**
 * 버전 비교.
 *
 * 이 앱의 버전은 `0.3.1-alpha` 형태다 — semver의 pre-release 접미사가 늘 붙어
 * 있고, 접미사끼리의 우열은 이 앱에서 의미가 없다(alpha만 쓴다). 그래서
 * **숫자 세 자리만 비교하고 접미사는 무시한다.**
 *
 * updater 플러그인도 자체적으로 버전을 비교하지만, 여기 함수는 화면에 무엇을
 * 보여줄지(배지·"최신입니다") 결정하는 데 쓴다. 플러그인이 "업데이트 있음"으로
 * 준 것을 그대로 믿는 것이 원칙이고, 이 함수는 그 판단을 **표시용으로 재현**한다.
 */

/** `0.3.1-alpha` → `[0, 3, 1]`. 숫자가 아닌 부분은 버린다. */
export function parseVersion(v: string): [number, number, number] {
  const core = v.trim().replace(/^v/, '').split(/[-+]/)[0] ?? ''
  const parts = core.split('.')
  const n = (i: number) => {
    const raw = Number.parseInt(parts[i] ?? '0', 10)
    return Number.isFinite(raw) ? raw : 0
  }
  return [n(0), n(1), n(2)]
}

/** a가 b보다 높으면 양수, 낮으면 음수, 같으면 0. */
export function compareVersions(a: string, b: string): number {
  const pa = parseVersion(a)
  const pb = parseVersion(b)
  for (let i = 0; i < 3; i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0)
    if (d !== 0) return d
  }
  return 0
}

/** latest가 current보다 높은가. */
export function isNewer(latest: string, current: string): boolean {
  return compareVersions(latest, current) > 0
}
