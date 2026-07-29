/**
 * "3분 전", "2시간 전". 절대 시각보다 짧고, 대시보드에서는 더 유용하다.
 *
 * Intl.RelativeTimeFormat을 쓰지 않는 이유: "3분 전"이 필요한데 그쪽은
 * 로케일에 따라 "3분 전에"처럼 조사가 붙는 형태를 내기도 한다. 이 앱은
 * 한국어 단일이므로 직접 만드는 편이 짧고 예측 가능하다.
 */
export function relativeTime(iso: string, now: Date = new Date()): string {
  const then = new Date(iso)
  const ms = now.getTime() - then.getTime()
  if (Number.isNaN(ms)) return ''

  // 시계 오차나 서버 시각 차이로 미래가 될 수 있다. "-3분 전"을 보여주진 않는다.
  if (ms < 0) return '방금'

  const sec = Math.floor(ms / 1000)
  if (sec < 60) return '방금'

  const min = Math.floor(sec / 60)
  if (min < 60) return `${min}분 전`

  const hour = Math.floor(min / 60)
  if (hour < 24) return `${hour}시간 전`

  const day = Math.floor(hour / 24)
  if (day < 7) return `${day}일 전`
  if (day < 30) return `${Math.floor(day / 7)}주 전`
  if (day < 365) return `${Math.floor(day / 30)}개월 전`
  return `${Math.floor(day / 365)}년 전`
}
