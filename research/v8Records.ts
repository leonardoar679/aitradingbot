// A WALK FORWARD'S SAVED RECORDS AS V8'S RESEARCH READS THEM (V8 Stage 11, 2 November 2026; research/v8R1.ts and
// research/v8R2.ts). Each horizon's record of the long walk forward's expanding mode (research/longWalkForward.ts,
// <ARCHIVE>/longWalkForward/long-expanding/oos-<horizon>.bin), its shown forecast scored out of sample as the
// calibration scores it -- the levels and P(up) a person would have been shown, weights and mappings from the folds
// before -- and each pair's five-minute bars from the archive, with the coin's trailing ninety-day rate of a move read
// from them as shared/forecast/moveRates.ts reads it, by running sums, and checked against it.
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { barsOfText, mergeBars, type ForecastBar } from '../shared/forecast/bars'
import { PAIR_CLASSES, type Horizon, type PairClass } from '../shared/forecast/features'
import { MOVE_RATES_LINES, moveRatesOf, ratesAt } from '../shared/forecast/moveRates'
import { decodeOos, oosQuantiles, type OosRecord } from '../shared/forecast/oosRecord'
import { rowsOf, scoreOutOfSample } from '../shared/forecast/runCalibration'
import { promotionsOf, type Promotion } from '../shared/forecast/training'
import { scoreRows, type ModelScore } from '../shared/forecast/walkForward'

export const V8_HORIZONS = ['hour1', 'hours4', 'hours24'] as const
export type V8Horizon = (typeof V8_HORIZONS)[number]
export const HORIZON_SEC: Record<V8Horizon, number> = { hour1: 3600, hours4: 4 * 3600, hours24: 86_400 }
const SPAN_BARS: Record<V8Horizon, number> = { hour1: 12, hours4: 48, hours24: 288 }

export const pctOf = (logMove: number): number => (Math.exp(logMove) - 1) * 100
export const monthOf = (t: number): string => new Date(t * 1000).toISOString().slice(0, 7)

/** A horizon's record of the expanding mode, or null where none was written. */
export function readRecord(archive: string, horizon: Horizon, folder = 'long-expanding'): OosRecord | null {
  const file = join(archive, 'longWalkForward', folder, `oos-${horizon}.bin`)
  if (!existsSync(file)) return null
  const bytes = readFileSync(file)
  return decodeOos(new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength))
}

/** The records' promotions, from each model's score over its tested rows (research/blockAblation.ts's promotionsFrom,
 * as the worker's promotionsOf reads them). */
export function promotionsFrom(records: ReadonlyMap<Horizon, OosRecord>): Promotion[] {
  return promotionsOf(
    [...records].map(([horizon, record]) => ({
      horizon,
      scores: record.models.map((model) => {
        const quantiles = Array.from({ length: record.rows }, (_, row) => oosQuantiles(record, row, model))
        const z = Array.from(record.z)
        const byClass: Partial<Record<PairClass, ModelScore>> = {}
        for (const [index, cls] of PAIR_CLASSES.entries()) {
          const mine = [...Array(record.rows).keys()].filter((row) => record.cls[row] === index)
          if (mine.length > 0) byClass[cls] = scoreRows(mine.map((row) => quantiles[row]), mine.map((row) => z[row]))
        }
        return { model, overall: scoreRows(quantiles, z), byClass }
      })
    }))
  )
}

/** A scored coin-hour: its record row, moment, pair and fold; the outcome in usual moves and in percent; the shown
 * levels in usual moves and in percent, and the shown P(up) (null before it is mapped). */
export interface ShownRow {
  at: number
  t: number
  pair: string
  fold: number
  usual: number
  z: number
  movePct: number
  shownZ: number[]
  shownPct: number[]
  pUp: number | null
}

/** A record's shown forecast, scored out of sample from its second fold on. */
export function shownRowsOf(record: OosRecord, promotions: readonly Promotion[]): ShownRow[] {
  const promoted = new Set(promotions.filter((entry) => entry.horizon === record.horizon && entry.promoted).map((entry) => entry.model))
  return scoreOutOfSample(rowsOf(record), 'v2', promoted).map((entry) => {
    const usual = entry.usual!
    return {
      at: entry.at!,
      t: entry.t!,
      pair: entry.pair!,
      fold: entry.week,
      usual,
      z: entry.z,
      movePct: pctOf(entry.z * usual),
      shownZ: [...entry.quantiles],
      shownPct: entry.quantiles.map((q) => pctOf(q * usual)),
      pUp: entry.pUp
    }
  })
}

/** At each fold, the share of the record's rows of the folds before it that went up at its horizon. */
export function baseUpByFold(record: OosRecord): Map<number, number> {
  const counts = new Map<number, { up: number; n: number }>()
  for (let row = 0; row < record.rows; row++) {
    if (!Number.isFinite(record.z[row])) continue
    const fold = record.fold[row]
    const mine = counts.get(fold) ?? { up: 0, n: 0 }
    mine.n++
    if (record.z[row] > 0) mine.up++
    counts.set(fold, mine)
  }
  const out = new Map<number, number>()
  let up = 0
  let n = 0
  for (const fold of [...counts.keys()].sort((a, b) => a - b)) {
    if (n > 0) out.set(fold, up / n)
    up += counts.get(fold)!.up
    n += counts.get(fold)!.n
  }
  return out
}

/** A pair's five-minute bars from the archive, oldest first, each time once. */
export function loadBars(archive: string, pair: string): ForecastBar[] {
  const folder = join(archive, 'forecastArchive')
  let bars: ForecastBar[] = []
  for (const name of readdirSync(folder)
    .filter((entry) => entry.startsWith(`${pair}-`) && entry.endsWith('.jsonl'))
    .sort())
    bars = mergeBars(bars, barsOfText(readFileSync(join(folder, name), 'utf-8')))
  return bars
}

/** A pair's bar opening at a moment, or null. */
export function barAt(bars: readonly ForecastBar[], openSec: number): ForecastBar | null {
  let low = 0
  let high = bars.length - 1
  while (low <= high) {
    const middle = (low + high) >> 1
    if (bars[middle].time === openSec) return bars[middle]
    if (bars[middle].time < openSec) low = middle + 1
    else high = middle - 1
  }
  return null
}

/** The first index whose bar's time is above `sec` (bars in time order). */
function firstAbove(times: Float64Array, sec: number): number {
  let low = 0
  let high = times.length
  while (low < high) {
    const middle = (low + high) >> 1
    if (times[middle] <= sec) low = middle + 1
    else high = middle
  }
  return low
}

/** A coin's trailing ninety-day rate of a close at least `pct` away, either way, at a horizon, at a moment: the share of
 * its hour closes in the ninety days before the moment whose close a horizon on had come by the moment, the bars
 * between all on file -- moveRatesOf's rate (shared/forecast/moveRates.ts), by running sums; null under its thirty days
 * of hours. */
export function trailingRatesOf(bars: readonly ForecastBar[], pcts: readonly number[]): (atSec: number, horizon: V8Horizon, pct: number) => number | null {
  const n = bars.length
  const times = Float64Array.from(bars, (bar) => bar.time)
  const sums = new Map<V8Horizon, { valid: Int32Array; hits: Int32Array[] }>()
  for (const horizon of V8_HORIZONS) {
    const span = SPAN_BARS[horizon]
    const valid = new Int32Array(n + 1)
    const hits = pcts.map(() => new Int32Array(n + 1))
    for (let at = 0; at < n; at++) {
      let ok = 0
      let move = 0
      if ((times[at] + 300) % 3600 === 0 && bars[at].close > 0 && at + span < n && times[at + span] - times[at] === span * 300) {
        ok = 1
        move = (bars[at + span].close / bars[at].close - 1) * 100
      }
      valid[at + 1] = valid[at] + ok
      pcts.forEach((pct, k) => {
        hits[k][at + 1] = hits[k][at] + (ok === 1 && (move >= pct || move <= -pct) ? 1 : 0)
      })
    }
    sums.set(horizon, { valid, hits })
  }
  return (atSec, horizon, pct) => {
    const k = pcts.indexOf(pct)
    if (k < 0) throw new Error(`no running sums at ${pct}%`)
    const start = firstAbove(times, atSec - MOVE_RATES_LINES.days * 86_400 - 300)
    const end = Math.max(start, firstAbove(times, atSec - 300))
    const last = end - SPAN_BARS[horizon]
    if (last <= start) return null
    const { valid, hits } = sums.get(horizon)!
    const moments = valid[last] - valid[start]
    return moments < MOVE_RATES_LINES.minMoments ? null : (hits[k][last] - hits[k][start]) / moments
  }
}

/** The largest difference between the running sums' rates and moveRatesOf's own over some moments of a pair: 0 where
 * they agree (NaN where one reads a rate and the other none). */
export function checkTrailingRates(bars: readonly ForecastBar[], rateOf: ReturnType<typeof trailingRatesOf>, moments: readonly number[], pcts: readonly number[]): number {
  let worst = 0
  for (const atSec of moments) {
    const rates = moveRatesOf(bars, atSec)
    for (const horizon of V8_HORIZONS) {
      for (const pct of pcts) {
        const theirs = ratesAt(rates, horizon)?.close.find((entry) => entry.pct === pct)?.either ?? null
        const mine = rateOf(atSec, horizon, pct)
        if ((theirs === null) !== (mine === null)) return Number.NaN
        if (theirs !== null && mine !== null) worst = Math.max(worst, Math.abs(theirs - mine))
      }
    }
  }
  return worst
}
