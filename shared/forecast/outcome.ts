import type { Direction } from './direction'
import { HORIZON_BARS, type Horizon } from './features'
import { QUANTILE_LEVELS } from './ml/quantile'

// WHAT HAPPENED AFTER A FORECAST (the V6 document, §26-28, §42-43 and §56; V6 Stage 7, 13 October 2026).
// When a recorded forecast's horizon is reached -- the bar closing at its moment plus the horizon has
// closed, never before -- its outcome is written once: the close then, the path's best and worst on
// the way, where the outcome fell against each forecast level, and the kinds of error it made.
//
// THE KINDS OF ERROR (§43), as far as the horizon's close can tell them:
// - CORRECT_DIRECTION and WRONG_DIRECTION, for a forecast that called a way (a NEUTRAL one called none);
// - RIGHT_RANGE when the close fell inside P10-P90, TOO_NARROW when it fell outside;
// - TOO_WIDE when it fell inside the likely range (P25-P75) of a range over twice its class's usual
//   width: it said far more could happen than did;
// - LATE when a call's move came and went on the way -- the path reached the median it forecast, and
//   the close was on the other side of where it started: the move had been caught at its end.
// EARLY (the move came after the horizon) needs the path beyond it and is read on the Lab (V6 Stage
// 11), with the drift between a forecast and its refreshes (§42); NEWS_MISREAD and MARKET_MISREAD
// with the news adjustment (V6 Stage 8).

export const OUTCOME_VERSION = 'forecast-outcome-v1'

export const OUTCOME_LINES = {
  /** A range more than this many times its class's usual width that held the close inside its
   * likely range was TOO_WIDE. */
  tooWide: 2
} as const

export type ErrorKind = 'CORRECT_DIRECTION' | 'WRONG_DIRECTION' | 'RIGHT_RANGE' | 'TOO_NARROW' | 'TOO_WIDE' | 'LATE'

/** What an outcome is judged against: one horizon of a recorded forecast. */
export interface ForecastedHorizon {
  horizon: Horizon
  /** The five quantiles of the move in percent, as forecast. */
  quantilesPct: readonly number[]
  pUp: number
  direction: Direction
  width80Pct: number
  usualWidth80Pct: number
}

export interface ForecastOutcome {
  /** Unix seconds: the close the forecast was read at, and the one its horizon reached. */
  barTime: number
  dueAt: number
  /** The move to that close, and the path's best and worst on the way, in percent. */
  movePct: number
  bestPct: number
  worstPct: number
  /** Whether the move fell at or below each forecast level; inside P10-P90 and P25-P75. */
  below: boolean[]
  inside80: boolean
  inside50: boolean
  wentUp: boolean
  errors: ErrorKind[]
}

/** When a forecast read at `barTime` reaches its horizon, in Unix seconds. */
export function dueAt(barTime: number, horizon: Horizon): number {
  return barTime + HORIZON_BARS[horizon] * 300
}

const P10 = QUANTILE_LEVELS.indexOf(0.1)
const P25 = QUANTILE_LEVELS.indexOf(0.25)
const P50 = QUANTILE_LEVELS.indexOf(0.5)
const P75 = QUANTILE_LEVELS.indexOf(0.75)
const P90 = QUANTILE_LEVELS.indexOf(0.9)

/** Whether a move fell inside P10-P90 and inside P25-P75, their ends included. */
export function insideOf(quantilesPct: readonly number[], movePct: number): { inside80: boolean; inside50: boolean } {
  return { inside80: movePct >= quantilesPct[P10] && movePct <= quantilesPct[P90], inside50: movePct >= quantilesPct[P25] && movePct <= quantilesPct[P75] }
}

/** The kinds of error a forecast made, from its horizon and what happened. A call's median is on
 * its side of zero (shared/forecast/direction.ts), so a bull's path reaching it went up. */
export function errorsOf(forecast: ForecastedHorizon, movePct: number, bestPct: number, worstPct: number): ErrorKind[] {
  const q = forecast.quantilesPct
  const out: ErrorKind[] = []
  if (forecast.direction === 'BULLISH' && movePct !== 0) out.push(movePct > 0 ? 'CORRECT_DIRECTION' : 'WRONG_DIRECTION')
  if (forecast.direction === 'BEARISH' && movePct !== 0) out.push(movePct < 0 ? 'CORRECT_DIRECTION' : 'WRONG_DIRECTION')
  const { inside80, inside50 } = insideOf(q, movePct)
  out.push(inside80 ? 'RIGHT_RANGE' : 'TOO_NARROW')
  if (inside50 && forecast.usualWidth80Pct > 0 && forecast.width80Pct > OUTCOME_LINES.tooWide * forecast.usualWidth80Pct) out.push('TOO_WIDE')
  const late = forecast.direction === 'BULLISH' ? bestPct >= q[P50] && movePct < 0 : forecast.direction === 'BEARISH' ? worstPct <= q[P50] && movePct > 0 : false
  if (late) out.push('LATE')
  return out
}

/** The outcome of one horizon of a forecast, from the close it was read at, the close its horizon
 * reached and the closes, highs and lows on the way. */
export function outcomeOf(forecast: ForecastedHorizon, barTime: number, price: number, path: readonly { high: number; low: number; close: number }[]): ForecastOutcome | null {
  if (path.length !== HORIZON_BARS[forecast.horizon] || !(price > 0)) return null
  const pct = (value: number): number => (value / price - 1) * 100
  const movePct = pct(path[path.length - 1].close)
  const bestPct = pct(Math.max(...path.map((bar) => bar.high)))
  const worstPct = pct(Math.min(...path.map((bar) => bar.low)))
  return {
    barTime,
    dueAt: dueAt(barTime, forecast.horizon),
    movePct,
    bestPct,
    worstPct,
    below: forecast.quantilesPct.map((level) => movePct <= level),
    ...insideOf(forecast.quantilesPct, movePct),
    wentUp: movePct > 0,
    errors: errorsOf(forecast, movePct, bestPct, worstPct)
  }
}
