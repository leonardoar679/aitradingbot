import { FORECAST_BAR_SECONDS, type ForecastBar } from './bars'

// WHAT HAPPENED AFTER A MOMENT (the V6 document, §26, §43 and §52; V6 Stage 3, 13 October 2026): the
// move from the close at T to the close a horizon later, in log return, and the best and the worst the
// path reached on the way, from the bars' highs and lows. What the forecast learns to predict, and
// what every forecast is scored against once its horizon has passed.
//
// A WHOLE PATH OR NONE. A horizon whose bars the exchange did not all print (a gap) has no outcome:
// a close a horizon later that is not there is not guessed from the bar beside it.

export interface Outcome {
  /** ln(close at T + horizon / close at T). */
  r: number
  /** ln(highest high on the way / close at T): zero or more. */
  best: number
  /** ln(lowest low on the way / close at T): zero or less. */
  worst: number
}

/** The outcome after the bar at `index` closed, `bars` five-minute bars on, from bars oldest first;
 * null when any bar on the way is missing or not yet there. */
export function outcomeAt(m5: readonly ForecastBar[], index: number, bars: number): Outcome | null {
  const end = index + bars
  if (index < 0 || end >= m5.length) return null
  const start = m5[index]
  if (m5[end].time !== start.time + bars * FORECAST_BAR_SECONDS || !(start.close > 0)) return null
  let high = -Infinity
  let low = Infinity
  for (let at = index + 1; at <= end; at++) {
    high = Math.max(high, m5[at].high)
    low = Math.min(low, m5[at].low)
  }
  return { r: Math.log(m5[end].close / start.close), best: Math.max(0, Math.log(high / start.close)), worst: Math.min(0, Math.log(low / start.close)) }
}

/** A horizon's usual move, from the day's realized volatility: what a move at that horizon is
 * measured against, here and in the features (the square root of time). */
export function usualMove(rv24h: number, bars: number): number {
  return rv24h * Math.sqrt(bars / 288)
}
