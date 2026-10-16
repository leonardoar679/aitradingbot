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
// SINCE V7.1 STAGE 11 (16 October 2026) a record keeps the market's shock state at each hour (shared/forecast/
// marketShock.ts, forecast-oos-v5), and this prints, per horizon, the same figures by state: how the hours in
// each state held as forecast, each state's rule as the app fits it (cross-fitted), V6.1's one rule against
// the states' rules on every hour either would widen, and which the app's calibration would choose. With
// RUN_BEFORE naming an older run (features-v1, before the market's fifteen minutes were in the rows), the
// three ways are set beside each other on the hours both runs tested: V6.1 (the old run's ranges and its
// line rule), shock-aware (the new run's ranges alone) and hybrid (the new run's ranges with its chosen
// rules).
//
//   npx esbuild research/rangeLag.ts --bundle --platform=node --format=esm --outfile=research/.rangeLag.mjs
//   PROFILE=<a scratch profile with a walk forward> [RUN_BEFORE=<an older run>] node research/.rangeLag.mjs
//
// It reads the profile's forecastModels/<run>/oos-*.bin and calibration.json and forecastData/; it writes
// nothing and asks nothing.
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { MACRO_EVENTS } from '../shared/calendar/macro'
import { eventReplayOf } from '../shared/forecast/eventReplay'
import { HORIZON_BARS, type Horizon } from '../shared/forecast/features'
import { WIDENED_STATES, marketShockRulesOf, marketWidening, type MarketShockRow } from '../shared/forecast/marketShock'
import { meanPinball } from '../shared/forecast/ml/quantile'
import type { ForecastModelId } from '../shared/forecast/models'
import { decodeOos, oosState, type OosRecord } from '../shared/forecast/oosRecord'
import { rowsOf, scoreOutOfSample, type ScoredRow } from '../shared/forecast/runCalibration'
import { pastShockLine, scoreShock, shockRuleOf, stretchShock, type ShockRule } from '../shared/forecast/shock'

const PROFILE = process.env.PROFILE ?? ''
if (PROFILE === '') throw new Error('PROFILE is the scratch profile to read')
const MODELS = join(PROFILE, 'forecastModels')
const RUN = process.env.RUN ?? (JSON.parse(readFileSync(join(MODELS, 'current.json'), 'utf-8')) as { runId: string }).runId
const RUN_BEFORE = process.env.RUN_BEFORE ?? ''
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

/** A run's record at a horizon, or null. */
function recordOf(run: string, horizon: Horizon): OosRecord | null {
  let bytes: Buffer
  try {
    bytes = readFileSync(join(MODELS, run, `oos-${horizon}.bin`))
  } catch {
    return null
  }
  return decodeOos(new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength))
}

/** A run's forecast shown (V2), scored out of sample, with the promoted models its calibration names. */
function shownOf(run: string, record: OosRecord): ScoredRow[] {
  const file = JSON.parse(readFileSync(join(MODELS, run, 'calibration.json'), 'utf-8')) as typeof calibration
  const promoted = new Set((file.horizons[record.horizon]?.variants.v2.weights.pooled ?? []).filter((entry) => entry.weight > 0).map((entry) => entry.model))
  return scoreOutOfSample(rowsOf(record), 'v2', promoted)
}

/** The rows as the app's rules read them: V6.1's row with the market's state (forecast-oos-v5). */
function stateRowsOf(record: OosRecord, scored: readonly ScoredRow[]): MarketShockRow[] {
  const out: MarketShockRow[] = []
  if (record.btc15 === undefined) return out
  for (const row of scored) {
    const state = oosState(record, row.at!)
    if (state !== undefined) out.push({ z: row.z, q: row.quantiles, week: row.week, t: record.time[row.at!], btc15: record.btc15[row.at!], state })
  }
  return out
}

/** Each row widened as the app would widen it live with these rules at its moment: by its state's rule
 * where the states' were chosen, by the line's where the line was, as forecast otherwise. Fitted on every
 * week, not cross-fitted: what the app would do, not an honest score. */
function widenedBy(rows: readonly MarketShockRow[], line: ShockRule, rules: ReturnType<typeof marketShockRulesOf>): { z: number; q: readonly number[] }[] {
  return rows.map((row) => {
    const widening = marketWidening({ shock: line, marketShock: rules }, row.btc15, row.state)
    return widening === null ? row : { z: row.z, q: stretchShock(row.q, widening.k80, widening.k50) }
  })
}

console.log(`walk forward ${RUN} in ${PROFILE}; the rule's line |mkt15| >= ${SHOCK_LINE}`)
for (const horizon of HORIZONS) {
  const record = recordOf(RUN, horizon)
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

  // THE CALENDAR'S RELEASES REPLAYED (V7.1 Stage 12; shared/forecast/eventReplay.ts): each release inside the
  // tested weeks at the record's hour before it and the first hour at or after it, as the Lab shows them;
  // with the states where the record keeps them, without otherwise.
  const replayed = eventReplayOf(
    scored.map((row) => {
      const state = oosState(record, row.at!)
      return { t: record.time[row.at!], pair: record.symbols[record.pair[row.at!]], z: row.z, q: row.quantiles, week: row.week, btc15: record.btc15?.[row.at!] ?? Number.NaN, pUp: row.pUp, ...(state === undefined ? {} : { state }) }
    }),
    MACRO_EVENTS
  )
  for (const row of replayed) {
    const score = (value: { in80: number; pinball: number } | null): string => (value === null ? '-' : `${pct(value.in80)} / ${value.pinball.toFixed(4)}`)
    console.log(`  ${row.kind} ${new Date(row.at * 1000).toISOString().slice(0, 16)} ${row.hour.padEnd(6)} ${new Date(row.t * 1000).toISOString().slice(11, 16)} n ${row.n} state ${row.state ?? '-'} btc15 ${row.btc15 === null ? '-' : row.btc15.toFixed(1)}: 80% held / pinball as forecast ${score(row.asForecast)}; by the line ${score(row.byLine)}; by the states ${score(row.byStates)}; calls ${row.calls} right ${row.callsRight}`)
  }

  // THE MARKET'S SHOCK STATES (V7.1 Stage 11): the hours in each state as forecast, each state's rule as the
  // app fits it, and V6.1's rule against the states' on every hour either would widen -- the app's own
  // arithmetic (shared/forecast/marketShock.ts), so that calibration.json can be set against it.
  const stateRows = stateRowsOf(record, scored)
  if (stateRows.length === 0) {
    console.log('  states: none on record (a walk forward from before V7.1 Stage 11)')
    continue
  }
  const lineRule = shockRuleOf(stateRows)
  const rules = marketShockRulesOf(stateRows, lineRule)
  const inState = (state: string): MarketShockRow[] => stateRows.filter((row) => row.state === state)
  console.log(`  by state: ${['NORMAL', ...WIDENED_STATES].map((state) => `${state} n ${inState(state).length}${inState(state).length > 0 ? ` 80% ${pct(coverage(inState(state)).in80)}` : ''}`).join(' | ')}`)
  for (const state of WIDENED_STATES) {
    const rule = rules.byState[state]
    if (rule === undefined) continue
    const verdict = rule.adopted ? 'adopted' : `refused: ${rule.refusal}`
    console.log(`  rule for ${state} (${rule.moments} moments, ${rule.rows} hours): ${rule.before === null ? 'not fitted' : `80% held ${pct(rule.before.in80)} -> ${pct(rule.after!.in80)}, pinball ${rule.before.pinball.toFixed(4)} -> ${rule.after!.pinball.toFixed(4)}, x${rule.k80.toFixed(2)} / x${rule.k50.toFixed(2)}`}; ${verdict}`)
  }
  console.log(`  V6.1's line rule on the same rows: ${lineRule.adopted ? 'adopted' : `refused: ${lineRule.refusal}`} (${lineRule.rows} hours, x${lineRule.k80.toFixed(2)} / x${lineRule.k50.toFixed(2)})`)
  if (rules.compared !== null) {
    const c = rules.compared
    console.log(`  on the ${c.rows} hours either would widen, cross-fitted: as forecast 80% ${pct(c.before.in80)} pinball ${c.before.pinball.toFixed(4)}; by the line ${pct(c.line.in80)} ${c.line.pinball.toFixed(4)}; by the states ${pct(c.states.in80)} ${c.states.pinball.toFixed(4)} -> chosen: ${rules.chosen}`)
  }

  // V6.1 vs SHOCK-AWARE vs HYBRID: an older run's ranges with its line rule, this run's ranges alone, and
  // this run's with its chosen rules, on the hours both runs tested.
  if (RUN_BEFORE === '') continue
  const older = recordOf(RUN_BEFORE, horizon)
  if (older === null) {
    console.log(`  ${RUN_BEFORE}: no record at ${horizon}`)
    continue
  }
  const olderShown = shownOf(RUN_BEFORE, older)
  const olderRows = new Map<string, ScoredRow & { btc15: number }>()
  for (const row of olderShown) if (older.btc15 !== undefined) olderRows.set(`${older.time[row.at!]}|${older.symbols[older.pair[row.at!]]}`, { ...row, btc15: older.btc15[row.at!] })
  const both = stateRows.map((row) => ({ now: row, before: olderRows.get(`${row.t}|${record.symbols[record.pair[scored.find((entry) => entry.at !== undefined && record.time[entry.at] === row.t && entry.z === row.z)?.at ?? 0]]}`) })).filter((pair): pair is { now: MarketShockRow; before: ScoredRow & { btc15: number } } => pair.before !== undefined)
  if (both.length === 0) {
    console.log(`  ${RUN_BEFORE}: no hour in common at ${horizon}`)
    continue
  }
  const olderLine = shockRuleOf(both.map((pair) => ({ z: pair.before.z, q: pair.before.quantiles, week: pair.before.week, t: pair.now.t, btc15: pair.before.btc15 })))
  const v61 = both.map((pair) => {
    const widening = marketWidening({ shock: olderLine }, pair.before.btc15, null)
    return widening === null ? { z: pair.before.z, q: pair.before.quantiles } : { z: pair.before.z, q: stretchShock(pair.before.quantiles, widening.k80, widening.k50) }
  })
  const aware = both.map((pair) => ({ z: pair.now.z, q: pair.now.q }))
  const hybrid = widenedBy(both.map((pair) => pair.now), lineRule, rules)
  const touched = both.map((_, index) => index).filter((index) => pastShockLine(both[index].now) || both[index].now.state !== 'NORMAL')
  const on = (rows: { z: number; q: readonly number[] }[], indices: number[]): string => {
    const score = scoreShock(indices.map((index) => rows[index]))
    return `80% ${pct(score.in80)} pinball ${score.pinball.toFixed(4)}`
  }
  const every = both.map((_, index) => index)
  console.log(`  against ${RUN_BEFORE} on ${both.length} hours in common (${touched.length} in a state or past the line), fitted on every week:`)
  console.log(`    V6.1 (old ranges + its line rule):      all ${on(v61, every)}; shock hours ${on(v61, touched)}`)
  console.log(`    shock-aware (new ranges alone):         all ${on(aware, every)}; shock hours ${on(aware, touched)}`)
  console.log(`    hybrid (new ranges + chosen rules):     all ${on(hybrid, every)}; shock hours ${on(hybrid, touched)}`)
}
