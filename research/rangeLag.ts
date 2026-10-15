// WHY THE FORECAST'S RANGES WERE TOO NARROW WHEN THE WHOLE MARKET MOVED (after V6, 15 October 2026).
//
// The 12-hour run's 4-hour range held 51% after the U.S. inflation report, and the check run's hour range
// 45% in a broad sell-off the next night: the ranges widen with the volatility the bars show, so after a
// move has begun. This reads the walk forward a profile keeps -- every tested hour of every pair, each
// forecast by models and a calibration fitted on the weeks before it alone (shared/forecast/runCalibration
// .ts, scoreOutOfSample, the forecast shown: V2) -- and sets each hour's range beside what the market was
// doing at its moment, from the bars on file, all of it known then:
//   btc15, btc60  Bitcoin's last 15 and 60 minutes, in its usual moves (its 5-minute moves of the day before);
//   mkt15         the mean of every pair's last 15 minutes in its own usual moves: a move of the whole market;
// and, as a diagnosis only (not known at the moment), Bitcoin's move over the horizon itself.
//
// Then one rule, fixed here before it is scored: where |mkt15| reaches a line, the range is widened about
// its median by a factor fitted on the weeks before each week alone, so that those weeks' such hours held
// 80%; scored on the week itself. Calm hours are left as they are.
//
//   npx esbuild research/rangeLag.ts --bundle --platform=node --format=esm --outfile=research/.rangeLag.mjs
//   PROFILE=<a scratch profile with a walk forward> node research/.rangeLag.mjs
//
// It reads the profile's forecastModels/<run>/oos-*.bin and calibration.json and forecastData/; it writes
// nothing and asks nothing.
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { HORIZON_BARS, type Horizon } from '../shared/forecast/features'
import { meanPinball } from '../shared/forecast/ml/quantile'
import type { ForecastModelId } from '../shared/forecast/models'
import { decodeOos } from '../shared/forecast/oosRecord'
import { rowsOf, scoreOutOfSample, type ScoredRow } from '../shared/forecast/runCalibration'

const PROFILE = process.env.PROFILE ?? ''
if (PROFILE === '') throw new Error('PROFILE is the scratch profile to read')
const MODELS = join(PROFILE, 'forecastModels')
const RUN = process.env.RUN ?? (JSON.parse(readFileSync(join(MODELS, 'current.json'), 'utf-8')) as { runId: string }).runId
const HORIZONS: Horizon[] = ['minutes5', 'minutes15', 'hour1', 'hours4']
const BAR = 300
const DAY_BARS = 288

/** The rule's line on |mkt15|, and the fewest such hours before a week that a factor is fitted from. */
const SHOCK_LINE = Number(process.env.SHOCK_LINE ?? 2)
const MIN_FIT_ROWS = 50

// The bars on file: every pair's closes by the close time (a bar's open time and five minutes).
const closes = new Map<string, Map<number, number>>()
function closesOf(pair: string): Map<number, number> {
  const held = closes.get(pair)
  if (held !== undefined) return held
  const out = new Map<number, number>()
  const dir = join(PROFILE, 'forecastData')
  for (const name of readdirSync(dir).filter((entry) => entry.startsWith(`${pair}-`) && entry.endsWith('.jsonl')).sort()) {
    for (const line of readFileSync(join(dir, name), 'utf-8').split('\n')) {
      if (line.trim() === '') continue
      try {
        const bar = JSON.parse(line) as number[]
        out.set(bar[0] + BAR, bar[4])
      } catch {
        // a torn line
      }
    }
  }
  closes.set(pair, out)
  return out
}

/** A pair's usual 5-minute move at t: the standard deviation of its 5-minute log moves over the day before. */
const sigmaCache = new Map<string, number | null>()
function sigma5(pair: string, t: number): number | null {
  const key = `${pair}|${t}`
  if (sigmaCache.has(key)) return sigmaCache.get(key)!
  const c = closesOf(pair)
  const moves: number[] = []
  for (let k = 0; k < DAY_BARS; k++) {
    const to = c.get(t - k * BAR)
    const from = c.get(t - (k + 1) * BAR)
    if (to !== undefined && from !== undefined && to > 0 && from > 0) moves.push(Math.log(to / from))
  }
  let out: number | null = null
  if (moves.length >= DAY_BARS / 2) {
    const mean = moves.reduce((sum, value) => sum + value, 0) / moves.length
    const variance = moves.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (moves.length - 1)
    out = variance > 0 ? Math.sqrt(variance) : null
  }
  sigmaCache.set(key, out)
  return out
}

/** A pair's move from t - span to t (or t to t + span, ahead), in its usual moves over that span. */
function zMove(pair: string, t: number, span: number, ahead = false): number | null {
  const c = closesOf(pair)
  const from = c.get(ahead ? t : t - span)
  const to = c.get(ahead ? t + span : t)
  const s = sigma5(pair, t)
  if (from === undefined || to === undefined || s === null || !(from > 0) || !(to > 0)) return null
  return Math.log(to / from) / (s * Math.sqrt(span / BAR))
}

interface Scored {
  row: ScoredRow
  t: number
  week: number
  btc15: number | null
  btc60: number | null
  mkt15: number | null
  btcAhead: number | null
}

const P10 = 0
const P25 = 1
const P50 = 2
const P75 = 3
const P90 = 4
const pct = (value: number): string => `${(value * 100).toFixed(1)}%`

function coverage(rows: readonly { z: number; q: readonly number[] }[]): { n: number; in80: number; in50: number; pinball: number } {
  let in80 = 0
  let in50 = 0
  let loss = 0
  for (const { z, q } of rows) {
    if (z >= q[P10] && z <= q[P90]) in80++
    if (z >= q[P25] && z <= q[P75]) in50++
    loss += meanPinball(z, q)
  }
  const n = rows.length
  return { n, in80: n > 0 ? in80 / n : Number.NaN, in50: n > 0 ? in50 / n : Number.NaN, pinball: n > 0 ? loss / n : Number.NaN }
}

const widen = (q: readonly number[], k: number): number[] => q.map((value) => q[P50] + k * (value - q[P50]))

/** The factor that has the rows' 80% range hold 80%: the 80th percentile of |z - median| over the half
 * widths, as the rows' own P10 and P90 sit (the larger side's). */
function factorFor(rows: readonly { z: number; q: readonly number[] }[]): number {
  const needed = rows
    .map(({ z, q }) => {
      const half = z >= q[P50] ? q[P90] - q[P50] : q[P50] - q[P10]
      return half > 0 ? Math.abs(z - q[P50]) / half : Number.NaN
    })
    .filter(Number.isFinite)
    .sort((a, b) => a - b)
  if (needed.length === 0) return 1
  return Math.max(1, needed[Math.min(needed.length - 1, Math.floor(0.8 * needed.length))])
}

/** The same for the 50% range: the 50th percentile of |z - median| over the inner half widths. */
function factorFor50(rows: readonly { z: number; q: readonly number[] }[]): number {
  const needed = rows
    .map(({ z, q }) => {
      const half = z >= q[P50] ? q[P75] - q[P50] : q[P50] - q[P25]
      return half > 0 ? Math.abs(z - q[P50]) / half : Number.NaN
    })
    .filter(Number.isFinite)
    .sort((a, b) => a - b)
  if (needed.length === 0) return 1
  return Math.max(1, needed[Math.min(needed.length - 1, Math.floor(0.5 * needed.length))])
}

/** The outer pair widened by k80 and the inner pair by k50 about the median, kept in order. */
function widenSplit(q: readonly number[], k80: number, k50: number): number[] {
  const out = [q[P50] + k80 * (q[P10] - q[P50]), q[P50] + k50 * (q[P25] - q[P50]), q[P50], q[P50] + k50 * (q[P75] - q[P50]), q[P50] + k80 * (q[P90] - q[P50])]
  out[P10] = Math.min(out[P10], out[P25])
  out[P90] = Math.max(out[P90], out[P75])
  return out
}

function bucketOf(value: number | null): string {
  if (value === null) return 'unread'
  const a = Math.abs(value)
  return a < 1 ? '|z| < 1' : a < 2 ? '1-2' : a < 3 ? '2-3' : '>= 3'
}
const BUCKETS = ['|z| < 1', '1-2', '2-3', '>= 3']

const calibration = JSON.parse(readFileSync(join(MODELS, RUN, 'calibration.json'), 'utf-8')) as {
  horizons: Partial<Record<Horizon, { variants: { v2: { weights: { pooled: { model: ForecastModelId; weight: number }[] } } } }>>
}

console.log(`walk forward ${RUN} in ${PROFILE}; the rule's line |mkt15| >= ${SHOCK_LINE}`)
for (const horizon of HORIZONS) {
  const bytes = readFileSync(join(MODELS, RUN, `oos-${horizon}.bin`))
  const record = decodeOos(new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength))
  if (record === null) {
    console.log(`${horizon}: no record`)
    continue
  }
  const promoted = new Set((calibration.horizons[horizon]?.variants.v2.weights.pooled ?? []).filter((entry) => entry.weight > 0).map((entry) => entry.model))
  const scored = scoreOutOfSample(rowsOf(record), 'v2', promoted)
  const span = HORIZON_BARS[horizon] * BAR
  const pairsAt = new Map<number, string[]>()
  const rows: Scored[] = scored.map((row) => {
    const t = record.time[row.at!]
    const pair = record.symbols[record.pair[row.at!]]
    const list = pairsAt.get(t) ?? []
    list.push(pair)
    pairsAt.set(t, list)
    // Bitcoin's last fifteen minutes as the record keeps them (forecast-oos-v2, V6.1: its own z_15m, what the
    // app's rule reads), or as the bars give them on an older record.
    const kept = record.btc15?.[row.at!]
    const btc15 = kept !== undefined && Number.isFinite(kept) ? kept : zMove('BTCUSDT', t, 900)
    return { row, t, week: row.week, btc15, btc60: zMove('BTCUSDT', t, 3600), mkt15: null, btcAhead: zMove('BTCUSDT', t, span, true) }
  })
  const mktAt = new Map<number, number | null>()
  for (const [t, pairs] of pairsAt) {
    const moves = pairs.map((pair) => zMove(pair, t, 900)).filter((value): value is number => value !== null)
    mktAt.set(t, moves.length >= 10 ? moves.reduce((sum, value) => sum + value, 0) / moves.length : null)
  }
  for (const entry of rows) entry.mkt15 = mktAt.get(entry.t) ?? null

  const all = coverage(rows.map((entry) => ({ z: entry.row.z, q: entry.row.quantiles })))
  console.log(`\n${horizon}: ${all.n} tested hours over weeks ${[...new Set(rows.map((entry) => entry.week))].join(', ')}; 80% held ${pct(all.in80)}, 50% held ${pct(all.in50)}`)
  for (const [name, read] of [
    ['btc15', (entry: Scored) => entry.btc15],
    ['btc60', (entry: Scored) => entry.btc60],
    ['mkt15', (entry: Scored) => entry.mkt15],
    ['btc over the horizon (not known then)', (entry: Scored) => entry.btcAhead]
  ] as const) {
    const cells = BUCKETS.map((bucket) => {
      const mine = rows.filter((entry) => bucketOf(read(entry)) === bucket)
      const c = coverage(mine.map((entry) => ({ z: entry.row.z, q: entry.row.quantiles })))
      return `${bucket} n ${c.n} 80% ${c.n > 0 ? pct(c.in80) : '-'} 50% ${c.n > 0 ? pct(c.in50) : '-'}`
    })
    console.log(`  by ${name}: ${cells.join(' | ')}`)
  }

  // The rule, walked forward: a week's shock hours widened by the factor its earlier weeks' needed --
  // one factor for every level, or the outer pair's and the inner pair's each their own -- on the whole
  // market's last 15 minutes or Bitcoin's, at three lines.
  const weeks = [...new Set(rows.map((entry) => entry.week))].sort((a, b) => a - b)
  for (const [signal, read] of [
    ['mkt15', (entry: Scored) => entry.mkt15],
    ['btc15', (entry: Scored) => entry.btc15]
  ] as const) {
    for (const line of [SHOCK_LINE, 2.5, 3]) {
      const shock = (entry: Scored): boolean => {
        const value = read(entry)
        return value !== null && Math.abs(value) >= line
      }
      const moments = new Set(rows.filter(shock).map((entry) => entry.t)).size
      for (const split of [false, true]) {
        const before: { z: number; q: readonly number[] }[] = []
        const after: { z: number; q: readonly number[] }[] = []
        let fitted = ''
        for (const week of weeks) {
          const earlier = rows.filter((entry) => entry.week < week && shock(entry)).map((entry) => ({ z: entry.row.z, q: entry.row.quantiles }))
          const ok = earlier.length >= MIN_FIT_ROWS
          const k80 = ok ? factorFor(earlier) : 1
          const k50 = ok ? factorFor50(earlier) : 1
          if (ok) fitted = `x${k80.toFixed(2)}${split ? ` / x${k50.toFixed(2)} inside` : ''} from ${earlier.length} before week ${week}`
          for (const entry of rows.filter((candidate) => candidate.week === week && shock(candidate))) {
            before.push({ z: entry.row.z, q: entry.row.quantiles })
            after.push({ z: entry.row.z, q: split ? widenSplit(entry.row.quantiles, k80, k50) : widen(entry.row.quantiles, k80) })
          }
        }
        const b = coverage(before)
        const a = coverage(after)
        console.log(
          `  rule |${signal}| >= ${line} (${moments} moments, ${b.n} hours scored)${split ? ', split' : ''}: 80% held ${pct(b.in80)} -> ${pct(a.in80)}, 50% ${pct(b.in50)} -> ${pct(a.in50)}, pinball ${b.pinball.toFixed(4)} -> ${a.pinball.toFixed(4)}; ${fitted || 'never fitted'}`
        )
      }
      // Cross-fitted: each week's shock hours widened by factors fitted on the OTHER weeks' -- every
      // moment scored once, by factors that never saw it. An estimate, not a walk forward: two of the
      // three weeks fitted from come after the week scored.
      const before: { z: number; q: readonly number[] }[] = []
      const after: { z: number; q: readonly number[] }[] = []
      const ks: string[] = []
      for (const week of weeks) {
        const others = rows.filter((entry) => entry.week !== week && shock(entry)).map((entry) => ({ z: entry.row.z, q: entry.row.quantiles }))
        const ok = others.length >= MIN_FIT_ROWS
        const k80 = ok ? factorFor(others) : 1
        const k50 = ok ? factorFor50(others) : 1
        ks.push(ok ? `x${k80.toFixed(2)}/${k50.toFixed(2)}` : 'none')
        for (const entry of rows.filter((candidate) => candidate.week === week && shock(candidate))) {
          before.push({ z: entry.row.z, q: entry.row.quantiles })
          after.push({ z: entry.row.z, q: widenSplit(entry.row.quantiles, k80, k50) })
        }
      }
      const b = coverage(before)
      const a = coverage(after)
      console.log(`  cross-fitted |${signal}| >= ${line}, split: 80% held ${pct(b.in80)} -> ${pct(a.in80)}, 50% ${pct(b.in50)} -> ${pct(a.in50)}, pinball ${b.pinball.toFixed(4)} -> ${a.pinball.toFixed(4)} (factors by week ${ks.join(', ')})`)
    }
  }
}
