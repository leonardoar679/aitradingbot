import { FEATURE_NAMES } from './features'
import { QUANTILE_LEVELS, meanPinball } from './ml/quantile'
import type { Panel } from './panel'
import { usualMove } from './targets'

// AFTER A SHARP MOVE OF BITCOIN'S (V6.1, 15 October 2026; measured in research/rangeLag.ts). V6's runs found
// the forecast's ranges too narrow when the whole market moved at once: after the U.S. inflation report the
// 4-hour range held 51%, in a sell-off the next night the hour's 45%. The ranges widen with the volatility the
// bars show, so after a move has begun. Most of their misses come from moves that begin after the forecast is
// made, which no range set then can know. What is known at its moment: Bitcoin's last fifteen minutes, in its
// usual moves (its own z_15m figure, shared/forecast/features.ts). On the walk forward of 15 October, past
// 2.5 of them (14 moments in three weeks) the 80% range held 72.5% at 5 minutes, 71.8% at 15, 63.3% at an
// hour and 79.9% at four.
//
// THE RULE, fixed here before it is fitted again at each refit: past the line, a horizon's outer pair of
// levels is stretched about its median by k80 and its inner pair by k50 -- the factors that would have had
// the walk forward's rows past the line hold 80% and 50% -- at a horizon where, CROSS-FITTED (each week's
// rows widened by factors fitted on the other weeks' alone), the 80% range of those rows comes nearer 80%
// and their pinball loss is no worse, with at least eight moments and 150 rows past the line to fit from.
// A horizon that fails keeps its ranges as they are, and calm moments are never touched. On the first walk
// forward of 15 October that adopted 15 minutes and an hour (71.8% -> 80.7% and 63.3% -> 79.3%, their
// pinball loss a little lower); on a fit six hours later, an hour and a day, 15 minutes refused by 0.0002 of
// loss. At 5 minutes the loss rose both times, and at four hours there was nothing to mend.

export const SHOCK_VERSION = 'shock-v1'

export const SHOCK_LINES = {
  /** |btc15| -- Bitcoin's last fifteen minutes in its usual moves -- at or past which a range is widened. */
  line: 2.5,
  /** The fewest moments, and rows, past the line that a rule is fitted from. */
  minMoments: 8,
  minRows: 150,
  /** The fewest rows the other weeks must hold for a week to be cross-fitted; below, it is scored as it was. */
  minFitRows: 50,
  /** The shares the outer and the inner ranges are meant to hold. */
  outer: 0.8,
  inner: 0.5
} as const

const P10 = QUANTILE_LEVELS.indexOf(0.1)
const P25 = QUANTILE_LEVELS.indexOf(0.25)
const P50 = QUANTILE_LEVELS.indexOf(0.5)
const P75 = QUANTILE_LEVELS.indexOf(0.75)
const P90 = QUANTILE_LEVELS.indexOf(0.9)
const Z15 = FEATURE_NAMES.indexOf('z_15m')

/** Why a rule is not adopted: no record of Bitcoin's moves (a walk forward from before V6.1), too few
 * moments past the line, the 80% range not brought nearer 80%, or the pinball loss made worse. */
export type ShockRefusal = 'no_record' | 'too_few' | 'coverage' | 'pinball'

export interface ShockScore {
  in80: number
  in50: number
  pinball: number
}

export interface ShockRule {
  version: string
  line: number
  /** The factors fitted on every week's rows past the line, each at least 1. */
  k80: number
  k50: number
  moments: number
  rows: number
  /** Cross-fitted on the walk forward: the rows past the line as forecast, and widened. */
  before: ShockScore | null
  after: ShockScore | null
  adopted: boolean
  refusal: ShockRefusal | null
}

/** A walk forward's row as the rule reads it: its outcome and levels in usual moves, its week, its moment
 * and Bitcoin's last fifteen minutes then. */
export interface ShockRow {
  z: number
  q: readonly number[]
  week: number
  t: number
  btc15: number
}

/** Bitcoin's own z_15m at each moment of a panel; a moment without Bitcoin's row is not in it. */
export function btc15ByTime(panel: Pick<Panel, 'rows' | 'cols' | 'x' | 'time' | 'pair' | 'symbols'>): Map<number, number> {
  const out = new Map<number, number>()
  const btc = panel.symbols.indexOf('BTCUSDT')
  if (btc < 0) return out
  for (let row = 0; row < panel.rows; row++) if (panel.pair[row] === btc) out.set(panel.time[row], panel.x[row * panel.cols + Z15])
  return out
}

/** The factor that has `share` of the rows held: the share's quantile of each row's distance from its
 * median over the half width on the side it fell, outer or inner; at least 1. */
function factorAt(rows: readonly { z: number; q: readonly number[] }[], share: number, outer: boolean): number {
  const needed = rows
    .map(({ z, q }) => {
      const half = z >= q[P50] ? q[outer ? P90 : P75] - q[P50] : q[P50] - q[outer ? P10 : P25]
      return half > 0 ? Math.abs(z - q[P50]) / half : Number.NaN
    })
    .filter(Number.isFinite)
    .sort((a, b) => a - b)
  if (needed.length === 0) return 1
  return Math.max(1, needed[Math.min(needed.length - 1, Math.floor(share * needed.length))])
}

export function shockFactors(rows: readonly { z: number; q: readonly number[] }[]): { k80: number; k50: number } {
  return { k80: factorAt(rows, SHOCK_LINES.outer, true), k50: factorAt(rows, SHOCK_LINES.inner, false) }
}

/** The outer pair stretched by k80 and the inner pair by k50 about the median, kept in order. */
export function stretchShock(q: readonly number[], k80: number, k50: number): number[] {
  const out = [...q]
  out[P10] = q[P50] + k80 * (q[P10] - q[P50])
  out[P90] = q[P50] + k80 * (q[P90] - q[P50])
  out[P25] = q[P50] + k50 * (q[P25] - q[P50])
  out[P75] = q[P50] + k50 * (q[P75] - q[P50])
  out[P10] = Math.min(out[P10], out[P25])
  out[P90] = Math.max(out[P90], out[P75])
  return out
}

/** How a set of rows held: the shares inside the 80% and the 50% ranges, and the mean pinball loss. */
export function scoreShock(rows: readonly { z: number; q: readonly number[] }[]): ShockScore {
  let in80 = 0
  let in50 = 0
  let loss = 0
  for (const { z, q } of rows) {
    if (z >= q[P10] && z <= q[P90]) in80++
    if (z >= q[P25] && z <= q[P75]) in50++
    loss += meanPinball(z, q)
  }
  const n = rows.length
  return { in80: in80 / n, in50: in50 / n, pinball: loss / n }
}

/** Each week's factors fitted on the other weeks' rows alone -- 1 where those hold fewer than minFitRows. */
export function crossFittedFactors(rows: readonly ShockRow[]): Map<number, { k80: number; k50: number }> {
  const out = new Map<number, { k80: number; k50: number }>()
  for (const week of [...new Set(rows.map((row) => row.week))].sort((a, b) => a - b)) {
    const others = rows.filter((row) => row.week !== week)
    out.set(week, others.length >= SHOCK_LINES.minFitRows ? shockFactors(others) : { k80: 1, k50: 1 })
  }
  return out
}

/** Whether a row is past the line: Bitcoin's last fifteen minutes at or past it, either way. */
export const pastShockLine = (row: Pick<ShockRow, 'btc15'>): boolean => Number.isFinite(row.btc15) && Math.abs(row.btc15) >= SHOCK_LINES.line

/** A rule fitted on the rows given -- those past the line, or since V7.1 Stage 11 those in one market state
 * (shared/forecast/marketShock.ts) -- and judged cross-fitted on them. */
export function shockRuleFrom(past: readonly ShockRow[]): ShockRule {
  const moments = new Set(past.map((row) => row.t)).size
  const unfitted = { version: SHOCK_VERSION, line: SHOCK_LINES.line, k80: 1, k50: 1, moments, rows: past.length, before: null, after: null, adopted: false }
  if (moments < SHOCK_LINES.minMoments || past.length < SHOCK_LINES.minRows) return { ...unfitted, refusal: 'too_few' }
  const { k80, k50 } = shockFactors(past)
  const byWeek = crossFittedFactors(past)
  const widened = past.map((row) => {
    const factors = byWeek.get(row.week)!
    return { z: row.z, q: stretchShock(row.q, factors.k80, factors.k50) }
  })
  const before = scoreShock(past)
  const after = scoreShock(widened)
  const nearer = Math.abs(after.in80 - SHOCK_LINES.outer) < Math.abs(before.in80 - SHOCK_LINES.outer)
  const refusal: ShockRefusal | null = !nearer ? 'coverage' : after.pinball > before.pinball ? 'pinball' : null
  return { version: SHOCK_VERSION, line: SHOCK_LINES.line, k80, k50, moments, rows: past.length, before, after, adopted: refusal === null, refusal }
}

/** A horizon's rule from its walk forward's rows (the forecast shown, V2, scored out of sample). */
export function shockRuleOf(rows: readonly ShockRow[]): ShockRule {
  return shockRuleFrom(rows.filter(pastShockLine))
}

/** A walk forward without Bitcoin's moves on record: no rule until the next refit writes them. */
export function noShockRecord(): ShockRule {
  return { version: SHOCK_VERSION, line: SHOCK_LINES.line, k80: 1, k50: 1, moments: 0, rows: 0, before: null, after: null, adopted: false, refusal: 'no_record' }
}

/** The factors a range is widened by: an adopted rule's, with Bitcoin at or past its line; null otherwise. */
export function shockFor(rule: ShockRule | null | undefined, btc15: number | null | undefined): { k80: number; k50: number } | null {
  if (rule === null || rule === undefined || !rule.adopted || btc15 === null || btc15 === undefined || !Number.isFinite(btc15) || Math.abs(btc15) < rule.line) return null
  return { k80: rule.k80, k50: rule.k50 }
}

/** Bitcoin's last `bars` five-minute bars' worth read live from the stream's minutes, in its usual moves (as
 * the close's z figure, by the day's volatility at the last close): the minute forming against the close of
 * the minute that ended that long before it began. Null without both, or without a volatility to measure by. */
export function liveBtcMove(minutes: readonly { time: number; close: number }[], rv24h: number, bars: number): number | null {
  const last = minutes[minutes.length - 1]
  if (last === undefined) return null
  const before = minutes.find((minute) => minute.time === last.time - bars * 300 - 60)
  const usual = usualMove(rv24h, bars)
  if (before === undefined || !(before.close > 0) || !(last.close > 0) || !(usual > 0)) return null
  return Math.log(last.close / before.close) / usual
}

/** Bitcoin's last fifteen minutes read live (V6.1): the minute forming against the close of the minute that
 * ended fifteen minutes before it began. */
export function liveBtc15(minutes: readonly { time: number; close: number }[], rv24h: number): number | null {
  return liveBtcMove(minutes, rv24h, 3)
}
