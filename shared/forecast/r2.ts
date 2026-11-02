import type { ForecastBar } from './bars'
import { ROUND_TRIP_PCT } from './edge'
import { PAIR_CLASSES } from './features'
import { MARKET_SHOCK_STATES } from './marketShock'
import type { CheckLine } from './promotion'
import { pairHalfOf } from './runCalibration'
import { UNCERTAINTY_LINES, bootstrapOverHours, detectableSkill, type Figure } from './uncertainty'

// V8 R2 -- A DIRECTION WHERE BIG MOVES HAPPEN (V8 Stage 11, 2 November 2026). The three hypotheses registered on 26
// October 2026 before any of them was measured (research/preregistered.jsonl V8-R2-WIDTH, V8-R2-ANALOG, V8-R2-TAIL):
// each a call rule over a walk forward's scored record, judged by the direction bar's lines (DIRECTION_PROMOTION_LINES:
// 200 calls, a skill of a point over the base rate, the precision's lower bound above an even chance, all four halves
// above zero, the calls' mean move in the way called less the round trip above zero with its lower bound), intervals by
// whole UTC days. A cell that passes on the current year (March to September 2026) is a candidate; it passes only on
// the second year (October 2024 to September 2025, a walk forward of its own), with the precision's lower bound read at
// 1 - 0.05/m, m = 12. TAIL's REVERSAL is judged on the second year alone.
//
// What the registrations leave to the code, fixed here before the first measurement:
// - The base rate of a call is the share of the record's rows of the folds before the call's that went the way called
//   at its horizon (scoreOutOfSample's base: nothing after the call is read).
// - "One call a coin a horizon": a coin called is not called again until the horizon has passed.
// - WIDTH: the month's widest tenth is the tenth of that UTC month's coin-hours with the widest shown P10-P90, in
//   percent (the ceil(n/10) widest, ties kept); a call up needs the shown median above zero and P(up) at 0.58 or more,
//   a call down the median below zero and P(up) at 0.42 or less. P(up) is mapped from the record's third fold on, so
//   no call is made before.
// - ANALOG: the registration's "z" is the record's move over the horizon in usual moves, the row's own outcome, which
//   cannot be read at the row; it is read at the coin's row one horizon earlier, its move up to the moment. The numeric
//   fields -- that move, rv24h, btc15 (none read as the scale's mean) and the five shown levels in usual moves -- are
//   scaled by their mean and spread over the first scored fold's rows; the pair's class and the market's state (one
//   more for unknown) are indicators. The 50 nearest by squared distance among the rows of every coin whose moment is
//   at least seven days before; a coin goes "one way" where its outcome is above or below zero.
// - TAIL: the move over the last hour is the hour's close against the close an hour before, from the coin's five-minute
//   bars; the call is entered at the open of the five-minute bar that starts at the hour and held to the close a
//   horizon on; a call whose bars are not all there is not made, and counted. One call a coin in 24 hours, in each cell.
// - Its intervals are read twice -- by t on the hours' means and by whole-day blocks -- and a line holds only where it
//   holds under both: "the stricter read".
// - The halves of the year: March to May and June to September on the current year, October to March and April to
//   September on the second; the pairs' halves by pairHalfOf.
// - The smallest effect a year could detect: 2.8 times the skill's resampled spread (detectableSkill).

export const R2_LINES = {
  version: 'r2-v1',
  /** WIDTH: the month's widest tenth, called at a shown P(up) of at least 0.58 (up) or at most 0.42 (down). */
  widthShare: 0.1,
  pUpUp: 0.58,
  pUpDown: 0.42,
  /** ANALOG: the 50 nearest rows at least seven days earlier, called where 60% went one way. */
  analogNeighbours: 50,
  analogGapSec: 7 * 86_400,
  analogMajority: 0.6,
  /** TAIL: a close-to-close move over the last hour of at least these, one call a coin in 24 hours. */
  tailMovesPct: [5, 10] as readonly number[],
  tailGapSec: 86_400,
  /** The confirmatory cells together (WIDTH and ANALOG at hour1 and hours4, TAIL's eight). */
  m: 12,
  /** The direction bar's lines, as research/hypotheses.ts holds them. */
  bar: { minCalls: 200, precisionLowerBound: 0.5, minSkill: 0.01, halvesAbove: 0, edgeAbovePct: 0, roundTripPct: ROUND_TRIP_PCT },
  /** Draws of the whole-day resampling: enough for a 99.6% interval's tail. */
  draws: 10_000
} as const

/** The level the second year's precision is read at: 1 - 0.05/m. */
export const R2_CONFIRM_LEVEL = 1 - 0.05 / R2_LINES.m

/** A coin-hour of a scored walk forward record, as the rules read it. */
export interface R2Row {
  /** Unix seconds: the hour forecast at. */
  t: number
  pair: string
  fold: number
  /** The close's move over the horizon: in the coin's usual moves (the record's z) and in percent. */
  z: number
  movePct: number
  /** The coin's z at its row one horizon earlier: its move up to the moment; null where that row is not held. */
  prevZ: number | null
  rv24h: number
  /** Bitcoin's last 15 minutes in its usual moves; NaN where none was read. */
  btc15: number
  /** The market's state and the pair's class, as the record's indices (255 an unknown state). */
  state: number
  cls: number
  /** The shown levels P10 to P90, in usual moves and in percent, and the shown P(up); null where not scored. */
  shownZ: readonly number[] | null
  shownPct: readonly number[] | null
  pUp: number | null
  /** The share of the record's rows of the folds before this one that went up at the horizon; null in the first. */
  baseUp: number | null
}

/** A call: its moment, coin, way, the move that followed in percent, and the base rate of its way. */
export interface R2Call {
  t: number
  pair: string
  way: 1 | -1
  movePct: number
  base: number
}

const monthOf = (t: number): string => new Date(t * 1000).toISOString().slice(0, 7)
const byTime = (a: { t: number; pair: string }, b: { t: number; pair: string }): number => a.t - b.t || (a.pair < b.pair ? -1 : a.pair > b.pair ? 1 : 0)

/** WIDTH's calls: in each month's widest tenth of the shown width, the way of the shown median where P(up) agrees. */
export function widthCallsOf(rows: readonly R2Row[], horizonSec: number, lines = R2_LINES): R2Call[] {
  const widths = new Map<string, number[]>()
  for (const row of rows) {
    if (row.shownPct === null) continue
    const month = monthOf(row.t)
    const list = widths.get(month) ?? []
    list.push(row.shownPct[4] - row.shownPct[0])
    widths.set(month, list)
  }
  const floors = new Map<string, number>()
  for (const [month, list] of widths) {
    list.sort((a, b) => b - a)
    floors.set(month, list[Math.max(0, Math.ceil(list.length * lines.widthShare) - 1)])
  }
  const out: R2Call[] = []
  const freeAt = new Map<string, number>()
  for (const row of [...rows].sort(byTime)) {
    if (row.shownPct === null || row.pUp === null || row.baseUp === null) continue
    if (row.shownPct[4] - row.shownPct[0] < floors.get(monthOf(row.t))!) continue
    const median = row.shownPct[2]
    const way = median > 0 && row.pUp >= lines.pUpUp ? 1 : median < 0 && row.pUp <= lines.pUpDown ? -1 : 0
    if (way === 0 || row.t < (freeAt.get(row.pair) ?? Number.NEGATIVE_INFINITY)) continue
    out.push({ t: row.t, pair: row.pair, way, movePct: row.movePct, base: way === 1 ? row.baseUp : 1 - row.baseUp })
    freeAt.set(row.pair, row.t + horizonSec)
  }
  return out
}

/** ANALOG's calls: the way 60% or more of the 50 nearest rows at least seven days earlier went. */
export function analogCallsOf(rows: readonly R2Row[], horizonSec: number, lines = R2_LINES): { calls: R2Call[]; asked: number } {
  const usable = rows.filter((row) => row.shownZ !== null && row.prevZ !== null && row.baseUp !== null).sort(byTime)
  if (usable.length === 0) return { calls: [], asked: 0 }
  const numeric = (row: R2Row): number[] => [row.prevZ!, row.rv24h, row.btc15, ...row.shownZ!]
  const width = numeric(usable[0]).length
  // The scale: each numeric field's mean and spread over the first scored fold's rows, a missing value left out.
  const firstFold = usable[0].fold
  const mean = new Float64Array(width)
  const spread = new Float64Array(width)
  const counts = new Float64Array(width)
  for (const row of usable) {
    if (row.fold !== firstFold) continue
    numeric(row).forEach((value, k) => {
      if (!Number.isFinite(value)) return
      mean[k] += value
      counts[k]++
    })
  }
  for (let k = 0; k < width; k++) mean[k] = counts[k] > 0 ? mean[k] / counts[k] : 0
  for (const row of usable) {
    if (row.fold !== firstFold) continue
    numeric(row).forEach((value, k) => {
      if (Number.isFinite(value)) spread[k] += (value - mean[k]) ** 2
    })
  }
  for (let k = 0; k < width; k++) spread[k] = counts[k] > 1 && spread[k] > 0 ? Math.sqrt(spread[k] / (counts[k] - 1)) : 1
  const states = MARKET_SHOCK_STATES.length + 1
  const dims = width + PAIR_CLASSES.length + states
  const points = new Float64Array(usable.length * dims)
  usable.forEach((row, at) => {
    const base = at * dims
    numeric(row).forEach((value, k) => {
      points[base + k] = Number.isFinite(value) ? (value - mean[k]) / spread[k] : 0
    })
    if (row.cls >= 0 && row.cls < PAIR_CLASSES.length) points[base + width + row.cls] = 1
    points[base + width + PAIR_CLASSES.length + (row.state < MARKET_SHOCK_STATES.length ? row.state : MARKET_SHOCK_STATES.length)] = 1
  })
  const K = lines.analogNeighbours
  const best = new Float64Array(K)
  const bestAt = new Int32Array(K)
  const calls: R2Call[] = []
  const freeAt = new Map<string, number>()
  let asked = 0
  let pool = 0
  for (let q = 0; q < usable.length; q++) {
    const row = usable[q]
    while (pool < usable.length && usable[pool].t <= row.t - lines.analogGapSec) pool++
    if (pool < K || row.t < (freeAt.get(row.pair) ?? Number.NEGATIVE_INFINITY)) continue
    asked++
    // The K nearest of the pool: an unordered list, its worst replaced while a nearer one is found.
    let filled = 0
    let worst = 0
    const qBase = q * dims
    for (let p = 0; p < pool; p++) {
      const pBase = p * dims
      let distance = 0
      const limit = filled < K ? Number.POSITIVE_INFINITY : best[worst]
      for (let k = 0; k < dims && distance < limit; k++) {
        const d = points[qBase + k] - points[pBase + k]
        distance += d * d
      }
      if (filled < K) {
        best[filled] = distance
        bestAt[filled] = p
        filled++
        if (filled === K) for (let k = 1; k < K; k++) if (best[k] > best[worst]) worst = k
      } else if (distance < best[worst]) {
        best[worst] = distance
        bestAt[worst] = p
        worst = 0
        for (let k = 1; k < K; k++) if (best[k] > best[worst]) worst = k
      }
    }
    let up = 0
    let down = 0
    for (let k = 0; k < K; k++) {
      const z = usable[bestAt[k]].z
      if (z > 0) up++
      else if (z < 0) down++
    }
    const way = up / K >= lines.analogMajority ? 1 : down / K >= lines.analogMajority ? -1 : 0
    if (way === 0) continue
    calls.push({ t: row.t, pair: row.pair, way, movePct: row.movePct, base: way === 1 ? row.baseUp! : 1 - row.baseUp! })
    freeAt.set(row.pair, row.t + horizonSec)
  }
  return { calls, asked }
}

/** A coin's five-minute bar opening at a moment, by binary search over bars in time order. */
function barAt(bars: readonly ForecastBar[], openSec: number): ForecastBar | null {
  let low = 0
  let high = bars.length - 1
  while (low <= high) {
    const middle = (low + high) >> 1
    const time = bars[middle].time
    if (time === openSec) return bars[middle]
    if (time < openSec) low = middle + 1
    else high = middle - 1
  }
  return null
}

export type TailKind = 'continuation' | 'reversal'

/** TAIL's calls in one cell: after a close-to-close move of at least `movePct` over the last hour, the way it went
 * (CONTINUATION) or the other (REVERSAL), entered at the next bar's open and held a horizon; one call a coin in 24
 * hours. Rows are the record's coin-hours; a call whose bars are not all there is not made, and counted. */
export function tailCallsOf(
  rows: readonly Pick<R2Row, 't' | 'pair' | 'baseUp'>[],
  barsOf: (pair: string) => readonly ForecastBar[] | null,
  horizonSec: number,
  movePct: number,
  kind: TailKind,
  lines = R2_LINES
): { calls: R2Call[]; missing: number } {
  const calls: R2Call[] = []
  const freeAt = new Map<string, number>()
  let missing = 0
  for (const row of [...rows].sort(byTime)) {
    if (row.baseUp === null || row.t < (freeAt.get(row.pair) ?? Number.NEGATIVE_INFINITY)) continue
    const bars = barsOf(row.pair)
    if (bars === null) continue
    const closing = barAt(bars, row.t - 300)
    const hourBefore = barAt(bars, row.t - 3600 - 300)
    if (closing === null || hourBefore === null || !(closing.close > 0) || !(hourBefore.close > 0)) continue
    const last = (closing.close / hourBefore.close - 1) * 100
    if (Math.abs(last) < movePct) continue
    const entry = barAt(bars, row.t)
    const exit = barAt(bars, row.t + horizonSec - 300)
    if (entry === null || exit === null || !(entry.open > 0) || !(exit.close > 0)) {
      missing++
      continue
    }
    const moved: 1 | -1 = last > 0 ? 1 : -1
    const way: 1 | -1 = kind === 'continuation' ? moved : moved === 1 ? -1 : 1
    calls.push({ t: row.t, pair: row.pair, way, movePct: (exit.close / entry.open - 1) * 100, base: way === 1 ? row.baseUp : 1 - row.baseUp })
    freeAt.set(row.pair, row.t + lines.tailGapSec)
  }
  return { calls, missing }
}

/** The standard normal's quantile (Acklam's rational approximation). */
export function normalQuantile(p: number): number {
  const a = [-39.69683028665376, 220.9460984245205, -275.9285104469687, 138.357751867269, -30.66479806614716, 2.506628277459239]
  const b = [-54.47609879822406, 161.5858368580409, -155.6989798598866, 66.80131188771972, -13.28068155288572]
  const c = [-0.007784894002430293, -0.3223964580411365, -2.400758277161838, -2.549732539343734, 4.374664141464968, 2.938163982698783]
  const d = [0.007784695709041462, 0.3224671290700398, 2.445134137142996, 3.754408661907416]
  const lowTail = 0.02425
  if (p <= 0 || p >= 1) return p <= 0 ? Number.NEGATIVE_INFINITY : Number.POSITIVE_INFINITY
  if (p < lowTail) {
    const q = Math.sqrt(-2 * Math.log(p))
    return (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1)
  }
  if (p > 1 - lowTail) return -normalQuantile(1 - p)
  const q = p - 0.5
  const r = q * q
  return ((((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q) / (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1)
}

/** Student's t quantile with `df` degrees of freedom, by the Cornish-Fisher expansion about the normal's. */
export function tQuantile(p: number, df: number): number {
  const z = normalQuantile(p)
  if (!(df > 0) || !Number.isFinite(z)) return z
  const z3 = z ** 3
  const z5 = z ** 5
  const z7 = z ** 7
  return z + (z3 + z) / (4 * df) + (5 * z5 + 16 * z3 + 3 * z) / (96 * df ** 2) + (3 * z7 + 19 * z5 + 17 * z3 - 15 * z) / (384 * df ** 3)
}

/** A mean's interval by t over the hours' means: each hour holding a call one observation. */
function tOverHours(values: ReadonlyMap<number, { sum: number; n: number }>, level: number): Figure | null {
  const means = [...values.values()].map((hour) => hour.sum / hour.n)
  const count = means.length
  if (count < 2) return null
  const mean = means.reduce((sum, value) => sum + value, 0) / count
  const sd = Math.sqrt(means.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (count - 1))
  const half = tQuantile(1 - (1 - level) / 2, count - 1) * (sd / Math.sqrt(count))
  return { value: mean, low: mean - half, high: mean + half, sd: sd / Math.sqrt(count) }
}

export interface R2Figures {
  calls: number
  /** By whole-day blocks: the precision at the level asked, the skill and the edge at 95%. */
  precision: Figure | null
  skill: Figure | null
  edgePct: Figure | null
  /** By t on the hours' means, where the cell asks for it (TAIL): the same three. */
  byHour: { precision: Figure | null; skill: Figure | null; edgePct: Figure | null } | null
  halves: { year: [number | null, number | null]; pairs: [number | null, number | null] }
  /** The smallest skill the calls could tell from zero (2.8 times its resampled spread). */
  detectable: number | null
  lines: CheckLine[]
  passed: boolean
}

export interface R2ReadOptions {
  /** The moment the year is halved at. */
  split: number
  /** The precision's level: 0.95 on the current year, 1 - 0.05/m on the second. */
  precisionLevel: number
  /** TAIL's cells: intervals by t on the hours' means too, a line holding under both reads. */
  byHour: boolean
}

/** A cell's calls against the direction bar. */
export function r2FiguresOf(calls: readonly R2Call[], options: R2ReadOptions, lines = R2_LINES): R2Figures {
  const L = lines.bar
  const correct = (call: R2Call): number => (call.way * call.movePct > 0 ? 1 : 0)
  const skillOf = (mine: readonly R2Call[]): number | null => (mine.length === 0 ? null : mine.reduce((sum, call) => sum + correct(call) - call.base, 0) / mine.length)
  let precision: Figure | null = null
  let skill: Figure | null = null
  let edgePct: Figure | null = null
  let byHour: R2Figures['byHour'] = null
  if (calls.length > 0) {
    // Whole UTC days as blocks, every day from the first call's to the last's one, a day without a call empty.
    let first = Number.POSITIVE_INFINITY
    let last = Number.NEGATIVE_INFINITY
    const samples: { hour: number; sample: number[] }[] = []
    for (const call of calls) {
      const day = Math.floor(call.t / 86_400)
      first = Math.min(first, day)
      last = Math.max(last, day)
      samples.push({ hour: day, sample: [correct(call), call.base, call.way * call.movePct - L.roundTripPct, 1] })
    }
    for (let day = first; day <= last; day++) samples.push({ hour: day, sample: [0, 0, 0, 0] })
    const of = (k: number, minus?: number) => (sums: Float64Array): number => (sums[3] > 0 ? (sums[k] - (minus === undefined ? 0 : sums[minus])) / sums[3] : Number.NaN)
    const at95 = bootstrapOverHours(samples, [of(0), of(0, 1), of(2)], 1, { ...UNCERTAINTY_LINES, draws: lines.draws, level: 0.95 })
    if (at95 !== null) [precision, skill, edgePct] = at95.figures
    if (at95 !== null && options.precisionLevel !== 0.95) {
      const atLevel = bootstrapOverHours(samples, [of(0)], 1, { ...UNCERTAINTY_LINES, draws: lines.draws, level: options.precisionLevel })
      precision = atLevel === null ? null : atLevel.figures[0]
    }
    if (options.byHour) {
      const hours = (value: (call: R2Call) => number): Map<number, { sum: number; n: number }> => {
        const out = new Map<number, { sum: number; n: number }>()
        for (const call of calls) {
          const hour = Math.floor(call.t / 3600)
          const mine = out.get(hour) ?? { sum: 0, n: 0 }
          mine.sum += value(call)
          mine.n++
          out.set(hour, mine)
        }
        return out
      }
      byHour = {
        precision: tOverHours(hours(correct), options.precisionLevel),
        skill: tOverHours(
          hours((call) => correct(call) - call.base),
          0.95
        ),
        edgePct: tOverHours(
          hours((call) => call.way * call.movePct - L.roundTripPct),
          0.95
        )
      }
    }
  }
  const halves = {
    year: [skillOf(calls.filter((call) => call.t < options.split)), skillOf(calls.filter((call) => call.t >= options.split))] as [number | null, number | null],
    pairs: [skillOf(calls.filter((call) => pairHalfOf(call.pair) === 0)), skillOf(calls.filter((call) => pairHalfOf(call.pair) === 1))] as [number | null, number | null]
  }
  const halvesRead = [...halves.year, ...halves.pairs].every((value) => value !== null)
  const pct = (value: number | null | undefined, digits = 2): string => (value === null || value === undefined || !Number.isFinite(value) ? '-' : `${(value * 100).toFixed(digits)}%`)
  const signed = (value: number): string => `${value >= 0 ? '+' : ''}${value.toFixed(3)}%`
  const level = `${(options.precisionLevel * 100).toFixed(options.precisionLevel === 0.95 ? 0 : 2)}%`
  const precisionOk = precision !== null && precision.low > L.precisionLowerBound && (byHour === null || (byHour.precision !== null && byHour.precision.low > L.precisionLowerBound))
  const edgeOk = edgePct !== null && edgePct.value > L.edgeAbovePct && edgePct.low > L.edgeAbovePct && (byHour === null || (byHour.edgePct !== null && byHour.edgePct.low > L.edgeAbovePct))
  const out: CheckLine[] = [
    { id: 'calls', ok: calls.length >= L.minCalls, text: `${calls.length} calls (${L.minCalls} needed)` },
    precision === null
      ? { id: 'precision', ok: null, text: "the calls' precision has no interval: not read" }
      : {
          id: 'precision',
          ok: precisionOk,
          text: `${pct(precision.value, 1)} of the calls right, at least ${pct(precision.low, 1)} at ${level} by whole days${byHour === null ? '' : ` and ${pct(byHour.precision?.low, 1)} by t on the hours' means`} (above ${pct(L.precisionLowerBound, 0)} needed)`
        },
    skill === null ? { id: 'skill', ok: null, text: 'no skill read' } : { id: 'skill', ok: skill.value >= L.minSkill, text: `a skill of ${pct(skill.value)} over the base rate (${pct(L.minSkill)} needed)` },
    halvesRead
      ? {
          id: 'halves',
          ok: [...halves.year, ...halves.pairs].every((value) => value! > L.halvesAbove),
          text: `skill ${pct(halves.year[0])} and ${pct(halves.year[1])} in the year's two halves, ${pct(halves.pairs[0])} and ${pct(halves.pairs[1])} in the pairs' (each above zero needed)`
        }
      : { id: 'halves', ok: null, text: 'a half of the year or of the pairs holds no call: not read' },
    edgePct === null
      ? { id: 'edge', ok: null, text: "the calls' moves less the round trip have no interval: not read" }
      : {
          id: 'edge',
          ok: edgeOk,
          text: `the calls' mean move in the way called, less the round trip, ${signed(edgePct.value)} [${signed(edgePct.low)}, ${signed(edgePct.high)}]${byHour === null || byHour.edgePct === null ? '' : `, by t on the hours' means at least ${signed(byHour.edgePct.low)}`} (above zero with its lower bound needed)`
        }
  ]
  return { calls: calls.length, precision, skill, edgePct, byHour, halves, detectable: skill === null ? null : (Number.isFinite(detectableSkill(skill.sd)) ? detectableSkill(skill.sd) : null), lines: out, passed: out.every((line) => line.ok === true) }
}
