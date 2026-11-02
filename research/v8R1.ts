// V8-R1-SIZE AND V8-R1-EITHER, MEASURED (V8 Stage 11, 2 November 2026; registered 26 October 2026,
// research/preregistered.jsonl; the arithmetic is shared/forecast/r1.ts, the records' reading research/v8Records.ts).
// On the long walk forward's saved records of its expanding mode (March to September 2026), at an hour, four hours and
// a day:
//   SIZE    each ranker of a close at least 1% / 2% / 5% away either way -- the shown P10-P90 width, then the shown
//           either-way odds -- mapped to a probability on the months before, against the coin's trailing ninety-day
//           rate of it: the Brier skill with its interval, the tenths, the top decile against the base's own; beside
//           them, mapped the same way and judging nothing, the comparators the registration names;
//   EITHER  at an hour and four hours, of 1% and 2%: the stated either-way chance's tenths and its Brier score against
//           the ninety-day rate's.
// Also the year's descriptive base rates of such moves over the scored coin-hours (shared/forecast/
// move-base-rates-2026.json with OUT_RATES).
//
//   npx esbuild research/v8R1.ts --bundle --platform=node --format=esm --outfile=research/.v8R1.mjs
//   ARCHIVE=<scratch>/archive-profile [NEWS=.candles/news] [OUT=<figures.json>] [OUT_RATES=<rates.json>]
//     node --max-old-space-size=8192 research/.v8R1.mjs
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { closeOdds } from '../shared/forecast/moveOdds'
import { R1_LINES, isotonicByMonth, r1EitherVerdictOf, r1SizeVerdictOf, type R1Row } from '../shared/forecast/r1'
import type { OosRecord } from '../shared/forecast/oosRecord'
import { HORIZON_SEC, V8_HORIZONS, barAt, checkTrailingRates, loadBars, monthOf, promotionsFrom, readRecord, shownRowsOf, trailingRatesOf, type ShownRow, type V8Horizon } from './v8Records'

const ARCHIVE = process.env.ARCHIVE ?? ''
if (ARCHIVE === '') throw new Error('ARCHIVE is the folder the year was fetched and walked forward in')
const NEWS = process.env.NEWS ?? '.candles/news'
const OUT = process.env.OUT ?? ''
const OUT_RATES = process.env.OUT_RATES ?? ''
const started = Date.now()
const elapsed = (): string => `${((Date.now() - started) / 60_000).toFixed(1)} min`

const records = new Map<V8Horizon, OosRecord>()
for (const horizon of V8_HORIZONS) {
  const record = readRecord(ARCHIVE, horizon)
  if (record === null) throw new Error(`no record at ${horizon} in ${ARCHIVE}`)
  records.set(horizon, record)
}
const promotions = promotionsFrom(records)
const shown = new Map<V8Horizon, ShownRow[]>()
for (const horizon of V8_HORIZONS) shown.set(horizon, shownRowsOf(records.get(horizon)!, promotions))
console.log(`records read and scored (${elapsed()}): ${V8_HORIZONS.map((h) => `${h} ${shown.get(h)!.length} rows`).join(', ')}`)

// Binance's announcements naming each coin, by the app's own reading of their titles (research/NEWS.md's pairs.json).
const announced = new Map<string, number[]>()
const pairsFile = join(NEWS, 'pairs.json')
let announcementsNote = `none read: ${pairsFile} is not on file`
if (existsSync(pairsFile)) {
  const planned = JSON.parse(readFileSync(pairsFile, 'utf-8')) as { ticker: string; releaseSec: number }[]
  for (const entry of planned) {
    const pair = `${entry.ticker}USDT`
    const list = announced.get(pair) ?? []
    list.push(entry.releaseSec)
    announced.set(pair, list)
  }
  announcementsNote = `${planned.length} announcements naming a coin (${pairsFile})`
}

/** Each scored row's figures at a horizon, filled pair by pair from the bars. */
interface Filled {
  base: Map<number, number | null>
  comparators: Record<Comparator, number>
}
const COMPARATORS = ['rv24h', 'volume expansion', '24 h momentum', '7 d momentum', '15-minute move in usual moves', 'an announcement in the 24 h before', "Bitcoin's 15 minutes"] as const
type Comparator = (typeof COMPARATORS)[number]
const filled = new Map<V8Horizon, Filled[]>()
for (const horizon of V8_HORIZONS) filled.set(horizon, new Array(shown.get(horizon)!.length))

const pairs = [...new Set(V8_HORIZONS.flatMap((horizon) => shown.get(horizon)!.map((row) => row.pair)))].sort()
const PCTS = [1, 2, 5]
let checked = 0
let worstCheck = 0
let noBase = 0
for (const [index, pair] of pairs.entries()) {
  const bars = loadBars(ARCHIVE, pair)
  const rateOf = trailingRatesOf(bars, PCTS)
  const closeAt = (sec: number): number | null => barAt(bars, sec - 300)?.close ?? null
  // The volume of the bars opening in [fromSec, toSec), by running sums; null where one of them is not on file.
  const times = Float64Array.from(bars, (bar) => bar.time)
  const volumes = new Float64Array(bars.length + 1)
  bars.forEach((bar, k) => {
    volumes[k + 1] = volumes[k] + bar.volume
  })
  const firstAtOrAfter = (sec: number): number => {
    let low = 0
    let high = times.length
    while (low < high) {
      const middle = (low + high) >> 1
      if (times[middle] < sec) low = middle + 1
      else high = middle
    }
    return low
  }
  const volumeOver = (fromSec: number, toSec: number): number | null => {
    const from = firstAtOrAfter(fromSec)
    const to = firstAtOrAfter(toSec)
    return to - from === (toSec - fromSec) / 300 ? volumes[to] - volumes[from] : null
  }
  // The running sums checked against moveRatesOf at a few of the pair's moments.
  const moments = shown.get('hour1')!.filter((row) => row.pair === pair).map((row) => row.t)
  const sample = moments.filter((_, k) => k % Math.max(1, Math.floor(moments.length / 3)) === 0).slice(0, 3)
  const check = checkTrailingRates(bars, rateOf, sample, PCTS)
  checked += sample.length
  worstCheck = Number.isNaN(check) || Number.isNaN(worstCheck) ? Number.NaN : Math.max(worstCheck, check)
  for (const horizon of V8_HORIZONS) {
    const record = records.get(horizon)!
    const rows = shown.get(horizon)!
    rows.forEach((row, at) => {
      if (row.pair !== pair) return
      const base = new Map<number, number | null>()
      for (const pct of PCTS) base.set(pct, rateOf(row.t, horizon, pct))
      if (base.get(R1_LINES.targetsPct[horizon]) === null) noBase++
      const close = closeAt(row.t)
      const ratio = (earlier: number | null): number => (close !== null && earlier !== null && earlier > 0 ? Math.abs(close / earlier - 1) * 100 : Number.NaN)
      const lastHour = volumeOver(row.t - 3600, row.t)
      const dayBefore = volumeOver(row.t - 25 * 3600, row.t - 3600)
      const usual15 = record.rv24h[row.at] * Math.sqrt(3 / 288)
      const before15 = closeAt(row.t - 900)
      const releases = announced.get(pair) ?? []
      filled.get(horizon)![at] = {
        base,
        comparators: {
          rv24h: record.rv24h[row.at],
          'volume expansion': lastHour !== null && dayBefore !== null && dayBefore > 0 ? lastHour / (dayBefore / 24) : Number.NaN,
          '24 h momentum': ratio(closeAt(row.t - 86_400)),
          '7 d momentum': ratio(closeAt(row.t - 7 * 86_400)),
          '15-minute move in usual moves': close !== null && before15 !== null && before15 > 0 && usual15 > 0 ? Math.abs(Math.log(close / before15)) / usual15 : Number.NaN,
          'an announcement in the 24 h before': releases.some((sec) => sec >= row.t - 86_400 && sec < row.t) ? 1 : 0,
          "Bitcoin's 15 minutes": Math.abs(record.btc15?.[row.at] ?? Number.NaN)
        }
      }
    })
  }
  if ((index + 1) % 20 === 0) console.log(`  ${index + 1} of ${pairs.length} pairs read (${elapsed()})`)
}
console.log(`the running sums against moveRatesOf at ${checked} moments: the largest difference ${worstCheck}`)
if (!(worstCheck < 1e-12)) throw new Error('the running sums do not read moveRatesOf\'s rates: stopped')

const blockOf = (horizon: V8Horizon, t: number): number => (horizon === 'hours24' ? Math.floor(t / 86_400) : Math.floor(t / 3600))
const blockHours = (horizon: V8Horizon): number => (horizon === 'hours4' ? 4 : 1)
const pct = (value: number | null | undefined, digits = 1): string => (value === null || value === undefined || !Number.isFinite(value) ? '-' : `${(value * 100).toFixed(digits)}%`)

const result: Record<string, unknown> = { version: R1_LINES.version, archive: ARCHIVE, announcements: announcementsNote, check: { moments: checked, worst: worstCheck }, horizons: {} }
const baseRates: Record<string, Record<string, number>> = {}
console.log('\nV8-R1-SIZE')
for (const horizon of V8_HORIZONS) {
  const rows = shown.get(horizon)!
  const fills = filled.get(horizon)!
  const target = R1_LINES.targetsPct[horizon]
  const y = rows.map((row) => (Math.abs(row.movePct) >= target ? 1 : 0) as 0 | 1)
  baseRates[horizon] = Object.fromEntries(PCTS.map((p) => [`${p}`, rows.filter((row) => Math.abs(row.movePct) >= p).length / rows.length]))
  const rankers: { name: string; value: (row: ShownRow, at: number) => number; judged: boolean }[] = [
    { name: 'P10-P90 width', value: (row) => row.shownPct[4] - row.shownPct[0], judged: true },
    { name: 'either-way odds', value: (row) => Math.min(1, (closeOdds(row.shownPct, target)?.up ?? Number.NaN) + (closeOdds(row.shownPct, target)?.down ?? Number.NaN)), judged: true },
    ...COMPARATORS.map((name) => ({ name, value: (_: ShownRow, at: number) => fills[at]?.comparators[name] ?? Number.NaN, judged: false }))
  ]
  const verdicts: Record<string, unknown>[] = []
  console.log(`  ${horizon}: a close at least ${target}% away either way in ${pct(baseRates[horizon][`${target}`])} of ${rows.length} scored coin-hours`)
  for (const ranker of rankers) {
    const mapped = isotonicByMonth(rows.map((row, at) => ({ month: monthOf(row.t), x: ranker.value(row, at), y: y[at] })))
    const scored: R1Row[] = []
    rows.forEach((row, at) => {
      const p = mapped[at]
      const base = fills[at]?.base.get(target) ?? null
      if (p === null || base === null) return
      scored.push({ block: blockOf(horizon, row.t), p, base, y: y[at] })
    })
    const verdict = r1SizeVerdictOf(scored, blockHours(horizon))
    verdicts.push({ ranker: ranker.name, judged: ranker.judged, ...verdict })
    const skill = verdict.skill
    console.log(
      `    ${(ranker.judged ? '' : '(beside) ') + ranker.name}: ${verdict.rows} rows; Brier skill ${pct(skill?.value, 2)} [${pct(skill?.low, 2)}, ${pct(skill?.high, 2)}]; tenths ${verdict.lines.tenths}; top tenth ${pct(verdict.top.hits?.value)} [${pct(verdict.top.hits?.low)}] against the base's ${pct(verdict.baseTop.hits?.value)}; ${ranker.judged ? (verdict.passed ? 'PASSES' : 'does not pass') : 'judges nothing'}`
    )
  }
  ;(result.horizons as Record<string, unknown>)[horizon] = { target, rows: rows.length, rate: baseRates[horizon][`${target}`], verdicts }
}

console.log('\nV8-R1-EITHER')
const either: Record<string, unknown>[] = []
for (const horizon of R1_LINES.either.horizons) {
  const rows = shown.get(horizon)!
  const fills = filled.get(horizon)!
  for (const move of R1_LINES.either.movesPct) {
    const scored: R1Row[] = []
    rows.forEach((row, at) => {
      const odds = closeOdds(row.shownPct, move)
      const base = fills[at]?.base.get(move) ?? null
      if (odds === null || base === null) return
      scored.push({ block: blockOf(horizon, row.t), p: Math.min(1, odds.up + odds.down), base, y: Math.abs(row.movePct) >= move ? 1 : 0 })
    })
    const verdict = r1EitherVerdictOf(scored, blockHours(horizon))
    either.push({ horizon, move, ...verdict })
    console.log(
      `  ${horizon} ${move}%: ${verdict.rows} rows, ${pct(verdict.rate)} moved; tenths ${verdict.tenths.map((tenth) => `${tenth.tenth}:${pct(tenth.stated)}/${pct(tenth.share)}${tenth.within === null ? '' : tenth.within ? '' : '!'}`).join(' ')}; Brier ${verdict.brier.toFixed(5)} against ${verdict.baseBrier.toFixed(5)}; ${verdict.passed ? 'PASSES' : 'does not pass'}`
    )
  }
}
result.either = either
result.rowsWithoutBase = noBase
result.baseRates = baseRates
console.log(`\n${noBase} scored rows had no ninety-day rate of their target (under thirty days of hours on file); ${elapsed()}`)
if (OUT !== '') writeFileSync(OUT, JSON.stringify(result, null, 1))
if (OUT_RATES !== '') {
  const months = [...new Set(shown.get('hour1')!.map((row) => monthOf(row.t)))].sort()
  writeFileSync(
    OUT_RATES,
    JSON.stringify(
      {
        version: 'move-base-rates-2026',
        what: "The share of the long walk forward's scored coin-hours (its expanding mode) whose close a horizon later was at least 1%, 2% and 5% away, either way: descriptive, from research/v8R1.ts.",
        from: months[0],
        to: months[months.length - 1],
        horizons: Object.fromEntries(V8_HORIZONS.map((horizon) => [horizon, { rows: shown.get(horizon)!.length, close: baseRates[horizon], seconds: HORIZON_SEC[horizon] }]))
      },
      null,
      1
    ) + '\n'
  )
}
