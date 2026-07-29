import { useEffect, useState } from 'react'

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

/**
 * 툴팁용 절대 시각. `2026년 7월 29일 (수) 오후 11:03`
 *
 * `toLocaleString()` 기본값은 초까지 넣어 지저분하다. 요일을 넣는 이유는
 * "2주 전"을 보고 실제 날짜를 확인할 때 무슨 요일이었는지가 대개 궁금해서다.
 */
export function absoluteTime(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  return d.toLocaleString('ko-KR', {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    weekday: 'short',
    hour: 'numeric',
    minute: '2-digit',
  })
}

/** 날짜만 있는 값(마감일 등). 시각이 없으므로 시분을 붙이지 않는다. */
export function absoluteDate(ymd: string): string {
  const d = new Date(`${ymd}T00:00:00`)
  if (Number.isNaN(d.getTime())) return ymd
  return d.toLocaleDateString('ko-KR', {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    weekday: 'short',
  })
}

/**
 * 1분마다 리렌더를 유발하는 훅.
 *
 * 상대 시간("방금", "15분 전")은 **데이터가 바뀌지 않아도 시간이 흐르면
 * 틀린 값이 된다.** 자동 새로고침을 꺼두면 리렌더가 아예 일어나지 않아
 * "방금"이 영원히 남는다 — 실제로 겪은 문제다.
 *
 * 1분 간격인 이유: relativeTime의 최소 단위가 분이라 그보다 잦게 돌 이유가 없다.
 */
export function useNow(intervalMs = 60_000): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), intervalMs)
    return () => clearInterval(id)
  }, [intervalMs])
  return now
}
