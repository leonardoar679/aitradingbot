import { useEffect, useState } from 'react'

/** The time in Unix seconds, kept current while `active`.
 *
 * For things that expire on the clock rather than on new data: an offer that lasts until a candle
 * closes has to disappear when it does, not at whatever later moment the next poll redraws the
 * card. Idle when inactive, so a card with nothing on offer runs no timer. */
export function useNowSec(active: boolean, everyMs = 15_000): number {
  const [nowSec, setNowSec] = useState(() => Math.floor(Date.now() / 1000))
  useEffect(() => {
    if (!active) return
    setNowSec(Math.floor(Date.now() / 1000))
    const timer = setInterval(() => setNowSec(Math.floor(Date.now() / 1000)), everyMs)
    return (): void => clearInterval(timer)
  }, [active, everyMs])
  return nowSec
}
