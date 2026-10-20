import { EXCURSION_LEVELS } from './models'
import { QUANTILE_LEVELS } from './ml/quantile'

// THE ODDS OF A MOVE THAT CLEARS ITS COSTS (V7.2-R Stage 3, 20 October 2026). A round trip costs a person
// 0.2% on Binance's spot book and up to 1% on a DEX, and the user's question is not where the median lies --
// it lies near the price when no way is known -- but how likely a move of 1%, 2% or 5% is within a horizon,
// and when. Two readings of a forecast already made, with no model asked:
//
// THE CLOSE: the chance a horizon's close is at least t% above the price and at least t% below, read off the
// five shown levels (P10, P25, P50, P75, P90; the calibrated, widened levels the card shows) by straight lines
// between them, and past P10 and P90 by an exponential tail whose scale the outer two levels on that side set:
// the share beyond a level falls by the same factor per point as from P75 to P90 (from P25 to P10 below). A
// chance read in a tail -- under one in ten -- is marked as such: the levels were calibrated at P10 and P90, not
// beyond them, and a coin's tails are fatter than any exponential.
//
// THE PATH: the chance the price touches t% above and t% below within the horizon, read off the path's likely
// high and low (the excursion levels the highest high stays under and the lowest low above at EXCURSION_LEVELS,
// half the time, eight in ten and nine in ten) the same way: from no move, which the path always reaches, to
// the median level by a straight line, between the levels by straight lines, past the 90% level by an
// exponential tail; marked where read in the tail. And the typical time to such a touch, from the first-touch
// table, only where the move lies within the table's levels: a move further out has no time said.
//
// Whether these chances are honest is measured on the records before anything shows them
// (research/moveOdds.ts; V72R-S3-ODDS in research/preregistered.jsonl). Arithmetic: no key, no model, no order.

export const MOVE_ODDS_VERSION = 'move-odds-v1'

export const MOVE_ODDS_LINES = {
  /** The moves a horizon's close is asked about, in percent either way. */
  closeMovesPct: [1, 2, 5] as readonly number[],
  /** The moves the path is asked about touching, in percent either way. */
  touchMovesPct: [1, 2] as readonly number[]
} as const

/** The chance of a move of `pct` either way, and whether each was read past the outermost level. */
export interface SideOdds {
  pct: number
  up: number
  down: number
  upTail: boolean
  downTail: boolean
}

const P10 = QUANTILE_LEVELS.indexOf(0.1)
const P25 = QUANTILE_LEVELS.indexOf(0.25)
const P75 = QUANTILE_LEVELS.indexOf(0.75)
const P90 = QUANTILE_LEVELS.indexOf(0.9)

/** The chance a value past the last of two levels is reached, where the share beyond them is `inner` and
 * `outer` (outer < inner) at `innerAt` and `outerAt`: exponential, `outer` at `outerAt`. A degenerate pair (no
 * spacing) leaves nothing past the outer level. */
function tailBeyond(distance: number, innerAt: number, outerAt: number, inner: number, outer: number): number {
  const spacing = outerAt - innerAt
  if (!(spacing > 0)) return distance > outerAt ? 0 : outer
  return outer * Math.exp((-Math.log(inner / outer) * (distance - outerAt)) / spacing)
}

/** The share of outcomes at or below `x` (percent), from the five shown levels. */
function cdfOf(q: readonly number[], x: number): { p: number; tail: boolean } {
  // Below P10, the mirror of the upper tail: the share at or below falls from P25's to P10's and on.
  if (x < q[P10]) return { p: tailBeyond(-x, -q[P25], -q[P10], 0.25, 0.1), tail: true }
  if (x > q[P90]) return { p: 1 - tailBeyond(x, q[P75], q[P90], 0.25, 0.1), tail: true }
  for (let at = 0; at < QUANTILE_LEVELS.length - 1; at++) {
    if (x <= q[at + 1]) {
      const span = q[at + 1] - q[at]
      const share = span > 0 ? (x - q[at]) / span : 1
      return { p: QUANTILE_LEVELS[at] + share * (QUANTILE_LEVELS[at + 1] - QUANTILE_LEVELS[at]), tail: false }
    }
  }
  return { p: 0.9, tail: false }
}

/** Whether five levels can be read: finite and in order. */
export function levelsReadable(q: readonly number[]): boolean {
  return q.length === QUANTILE_LEVELS.length && q.every(Number.isFinite) && q.every((value, at) => at === 0 || value >= q[at - 1])
}

/** The chance a horizon's close is at least `pct` percent up, and at least `pct` percent down, from the five
 * shown levels in percent; null where the levels cannot be read. */
export function closeOdds(q: readonly number[], pct: number): SideOdds | null {
  if (!levelsReadable(q) || !(pct > 0)) return null
  const above = cdfOf(q, pct)
  const below = cdfOf(q, -pct)
  return { pct, up: clamp01(1 - above.p), down: clamp01(below.p), upTail: above.tail, downTail: below.tail }
}

/** The chance the path's extreme on one side reaches `distance` (a positive percent), from its levels at
 * EXCURSION_LEVELS (positive percents, in order): 1 at no move, straight lines to the median level and between
 * the levels, an exponential tail past the last. */
function reachOf(levels: readonly number[], distance: number): { p: number; tail: boolean } {
  const shares = EXCURSION_LEVELS.map((level) => 1 - level)
  if (distance <= 0) return { p: 1, tail: false }
  if (distance <= levels[0]) return { p: levels[0] > 0 ? 1 - (distance / levels[0]) * (1 - shares[0]) : shares[0], tail: false }
  for (let at = 0; at < levels.length - 1; at++) {
    if (distance <= levels[at + 1]) {
      const span = levels[at + 1] - levels[at]
      const share = span > 0 ? (distance - levels[at]) / span : 1
      return { p: shares[at] + share * (shares[at + 1] - shares[at]), tail: false }
    }
  }
  const last = levels.length - 1
  return { p: tailBeyond(distance, levels[last - 1], levels[last], shares[last - 1], shares[last]), tail: true }
}

/** The chance the path touches `pct` percent above the price, and `pct` below, within the horizon, from the
 * likely highs (positive) and lows (negative) at EXCURSION_LEVELS in percent; null where they cannot be read. */
export function touchOdds(highs: readonly number[], lows: readonly number[], pct: number): SideOdds | null {
  const up = highs.map((value) => Math.max(0, value))
  const down = lows.map((value) => Math.max(0, -value))
  const ordered = (levels: number[]): boolean => levels.length === EXCURSION_LEVELS.length && levels.every(Number.isFinite) && levels.every((value, at) => at === 0 || value >= levels[at - 1])
  if (!ordered(up) || !ordered(down) || !(pct > 0)) return null
  const above = reachOf(up, pct)
  const below = reachOf(down, pct)
  return { pct, up: clamp01(above.p), down: clamp01(below.p), upTail: above.tail, downTail: below.tail }
}

/** A horizon's odds as the card reads them and the record keeps them: the close at each of closeMovesPct, the
 * path at each of touchMovesPct (null where the forecast carries no path), and the typical minutes to each
 * touch where the first-touch table holds the move (null otherwise, and where none is said). */
export interface MoveOdds {
  version: string
  close: SideOdds[]
  touch: SideOdds[] | null
  touchMinutes: { pct: number; up: number | null; down: number | null }[] | null
}

/** A horizon's odds from its shown levels, its path, and a reader of the typical minutes to a touch (the first-
 * touch table's, or null where there is none). */
export function moveOddsOf(q: readonly number[], excursion: { highPct: readonly number[]; lowPct: readonly number[] } | undefined, minutesTo: ((pct: number, side: 'up' | 'down') => number | null) | null): MoveOdds | null {
  const close = MOVE_ODDS_LINES.closeMovesPct.map((pct) => closeOdds(q, pct))
  if (close.some((odds) => odds === null)) return null
  const touch = excursion === undefined ? null : MOVE_ODDS_LINES.touchMovesPct.map((pct) => touchOdds(excursion.highPct, excursion.lowPct, pct))
  const touchKept = touch === null || touch.some((odds) => odds === null) ? null : (touch as SideOdds[])
  const touchMinutes = minutesTo === null ? null : MOVE_ODDS_LINES.touchMovesPct.map((pct) => ({ pct, up: minutesTo(pct, 'up'), down: minutesTo(pct, 'down') }))
  return { version: MOVE_ODDS_VERSION, close: close as SideOdds[], touch: touchKept, touchMinutes }
}

const clamp01 = (value: number): number => (value < 0 ? 0 : value > 1 ? 1 : value)

/** For the record: a horizon's odds as one list of chances to three decimals -- the close's up and down at each
 * of closeMovesPct, then the path's up and down at each of touchMovesPct where it carries a path. */
export function oddsLine(odds: MoveOdds): number[] {
  const round = (value: number): number => Math.round(value * 1000) / 1000
  return [...odds.close.flatMap((side) => [round(side.up), round(side.down)]), ...(odds.touch ?? []).flatMap((side) => [round(side.up), round(side.down)])]
}

/** The levels of P25 and P75, and of P10 and P90, the tails are scaled from: exported for the tests. */
export const ODDS_LEVELS = { P10, P25, P75, P90 } as const
