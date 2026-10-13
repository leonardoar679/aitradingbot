import { HORIZON_BARS, type Horizon } from './features'
import { QUANTILE_LEVELS, meanPinball } from './ml/quantile'
import { outcomeKnownAt, type Panel } from './panel'

// THE WALK FORWARD (the V6 document, §51-53; V6 Stage 5, 13 October 2026). A model is judged only on
// weeks it was not fitted on, and fitted only on rows whose outcomes were known before its week began:
// a row read at T with a four-hour horizon is not learned from by a model tested from T + 2h, because
// its outcome lies in the test week (purging), and the hour before the week is left out too (an
// embargo), so that nothing about the week leaks in through rows next to it.
//
// THE FOLDS: the last FOLDS.folds weeks of the rows, each tested on its own, each fitted on every row
// before it (an expanding window of at least FOLDS.minTrainDays). The final fit, the one the live
// forecast uses, is made on every row, its boosting stopped on the last week, purged the same way.

export const FOLDS = { folds: 4, foldDays: 7, minTrainDays: 30, validationDays: 7, embargoSec: 3600 } as const

/** The grid each horizon learns from: every quarter-hour for the short ones, every hour for the long. */
export const HORIZON_STEP_SEC: Record<Horizon, number> = { minutes5: 900, minutes15: 900, hour1: 900, hours4: 3600, hours24: 3600 }

/** A horizon's rows: on its grid, with an outcome, read at or after `fromSec` and before `toSec`. */
export function rowsFor(panel: Panel, horizon: Horizon, fromSec = 0, toSec = Number.POSITIVE_INFINITY): Uint32Array {
  const out: number[] = []
  const step = HORIZON_STEP_SEC[horizon]
  for (let row = 0; row < panel.rows; row++) {
    const t = panel.time[row]
    if (t % step !== 0 || t < fromSec || t >= toSec || Number.isNaN(panel.y[horizon][row])) continue
    out.push(row)
  }
  return Uint32Array.from(out)
}

/** Of `rows`, those whose outcome at the horizon was known `embargoSec` before `cutoff`. */
export function knownBefore(panel: Panel, rows: Uint32Array, horizon: Horizon, cutoff: number, embargoSec: number = FOLDS.embargoSec): Uint32Array {
  return rows.filter((row) => outcomeKnownAt(panel.time[row], horizon) <= cutoff - embargoSec)
}

export interface Fold {
  index: number
  /** The week tested: rows read at or after `from` and before `to`. */
  from: number
  to: number
}

/** The folds over rows read from `first` to `last`: the last weeks, each with at least the least
 * training span before it; oldest first. */
export function planFolds(first: number, last: number, plan: { folds: number; foldDays: number; minTrainDays: number } = FOLDS): Fold[] {
  const week = plan.foldDays * 86_400
  const out: Fold[] = []
  for (let k = plan.folds; k >= 1; k--) {
    const from = last + 1 - k * week
    if (from - first < plan.minTrainDays * 86_400) continue
    out.push({ index: out.length, from, to: from + week })
  }
  return out
}

/** On a short history the stretch held back is at most this share of the rows' span, so that it never
 * leaves the boosting more rows to stop on than to learn from. */
export const MAX_VALIDATION_SHARE = 0.2

/** The final fit's split: the last `validationDays` of the rows (at most MAX_VALIDATION_SHARE of their
 * span) to stop the boosting on, and the rows before them, purged of any whose outcome reaches into
 * them. */
export function finalSplit(panel: Panel, rows: Uint32Array, horizon: Horizon, validationDays: number = FOLDS.validationDays): { train: Uint32Array; valid: Uint32Array } {
  if (rows.length === 0) return { train: rows, valid: rows }
  const first = panel.time[rows[0]]
  const last = panel.time[rows[rows.length - 1]]
  const held = Math.min(validationDays * 86_400, Math.floor((last - first) * MAX_VALIDATION_SHARE))
  const cutoff = last + 1 - held
  return { train: knownBefore(panel, rows.filter((row) => panel.time[row] < cutoff), horizon, cutoff), valid: rows.filter((row) => panel.time[row] >= cutoff) }
}

/** A fold's rows: those tested (read inside its week), and those its models are fitted on -- every row
 * whose outcome was known an embargo before the week began, split as the final fit's are, so that the
 * boosting is stopped on the stretch just before the week, itself purged. */
export function foldRows(panel: Panel, rows: Uint32Array, horizon: Horizon, fold: Fold): { train: Uint32Array; valid: Uint32Array; test: Uint32Array } {
  const before = knownBefore(panel, rows.filter((row) => panel.time[row] < fold.from), horizon, fold.from)
  const { train, valid } = finalSplit(panel, before, horizon)
  return { train, valid, test: rows.filter((row) => panel.time[row] >= fold.from && panel.time[row] < fold.to) }
}

/** How a model did on outcomes it was not fitted to, each figure in units of the usual move. */
export interface ModelScore {
  n: number
  /** Mean pinball loss over the five levels. */
  pinball: number
  /** Share of outcomes inside P10-P90, and inside P25-P75. */
  coverage80: number
  coverage50: number
  /** Share whose sign the median called, of the outcomes that moved where the median called a way:
   * a median of exactly zero -- persistence's, often, at five minutes, where many coins' closes do not
   * move a tick -- calls none. */
  direction: number
  /** Mean of the outcome less the median. */
  bias: number
  /** Mean width of P10-P90. */
  width80: number
}

/** Scores quantiles (five a row, in order) against outcomes. */
export function scoreRows(quantiles: readonly (readonly number[])[], outcomes: readonly number[]): ModelScore {
  const n = Math.min(quantiles.length, outcomes.length)
  let pinball = 0
  let inside80 = 0
  let inside50 = 0
  let called = 0
  let calls = 0
  let bias = 0
  let width = 0
  const p10 = QUANTILE_LEVELS.indexOf(0.1)
  const p25 = QUANTILE_LEVELS.indexOf(0.25)
  const p50 = QUANTILE_LEVELS.indexOf(0.5)
  const p75 = QUANTILE_LEVELS.indexOf(0.75)
  const p90 = QUANTILE_LEVELS.indexOf(0.9)
  for (let row = 0; row < n; row++) {
    const q = quantiles[row]
    const y = outcomes[row]
    pinball += meanPinball(y, q)
    if (y >= q[p10] && y <= q[p90]) inside80++
    if (y >= q[p25] && y <= q[p75]) inside50++
    if (y !== 0 && q[p50] !== 0) {
      calls++
      if (Math.sign(q[p50]) === Math.sign(y)) called++
    }
    bias += y - q[p50]
    width += q[p90] - q[p10]
  }
  const per = (value: number, over: number): number => (over > 0 ? value / over : Number.NaN)
  return { n, pinball: per(pinball, n), coverage80: per(inside80, n), coverage50: per(inside50, n), direction: per(called, calls), bias: per(bias, n), width80: per(width, n) }
}

/** Each model's score over the last week a walk forward tested, alone: what a model's degradation is
 * read from (§105; V6 Stage 10). `z` is the outcome of each tested row, in its order. */
export function lastFoldScores<M extends string>(tested: readonly { fold: number; quantiles: Record<M, number[]> }[], z: readonly number[], models: readonly M[]): { model: M; score: ModelScore }[] {
  const lastFold = tested.reduce((latest, entry) => Math.max(latest, entry.fold), -1)
  const rows = tested.map((entry, at) => ({ entry, at })).filter(({ entry }) => entry.fold === lastFold)
  return models.map((model) => ({ model, score: scoreRows(rows.map(({ entry }) => entry.quantiles[model]), rows.map(({ at }) => z[at])) }))
}

/** The horizon's bars, for a reader that wants it in time. */
export function horizonSeconds(horizon: Horizon): number {
  return HORIZON_BARS[horizon] * 300
}
