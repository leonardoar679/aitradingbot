// V10-DAILY-SIZE (V10 Stage 4, 19 November 2026): does the daily rule know how far a coin moves over one, three and
// seven days? Every month's universe coins on V10's daily archive, the non-overlapping call days of V10-TSMOM, the rule of
// shared/forecast/daily/dailySize.ts with its ranges' widths read each month from the thousand days of moves before it
// (only moves whose horizon had ended by the month's start), and each call's five levels, size and outcome scored:
// the 80% range's coverage and tails, the 50% range's coverage, the real moves' sizes over the expected. Per horizon,
// held out (calls from 2024 whose horizon ends by 31 October 2026) and year by year; Bitcoin's rising and falling months
// apart; and, for Bitcoin alone, the spread from Deribit's DVOL beside the rule's.
//
//   npx esbuild research/v10DailySize.ts --bundle --platform=node --format=esm --outfile=research/.v10DailySize.mjs
//   DAILY=<archive-daily> EXTRAS=<daily-extras> node --max-old-space-size=8192 research/.v10DailySize.mjs
//
// Writes research/v10-daily-size.json.
import { readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { DAILY_HORIZONS, DAILY_HORIZON_DAYS, bandFactors, dailyQuantilesPct, dailySigma, logMove, type DayBar } from '../shared/forecast/daily/dailySize'
import { expectedMove } from '../shared/forecast/size'

const DAILY = process.env.DAILY ?? ''
const EXTRAS = process.env.EXTRAS ?? ''
if (DAILY === '' || EXTRAS === '') throw new Error('DAILY and EXTRAS are needed')
const DAY = 86_400
const at = (y: number, m: number, d: number): number => Date.UTC(y, m - 1, d) / 1000
const HELD = [at(2024, 1, 1), at(2026, 11, 1)] as const
const FIRST = at(2018, 1, 1)
const DRAWS = 10_000
const SEED = 20261119
const FIT_DAYS = 1000

// The bars by pair and day.
const dir = join(DAILY, 'daily')
const bars = new Map<string, Map<number, DayBar>>()
for (const name of readdirSync(dir).filter((file) => /^[A-Z0-9]+-\d{4}-\d{2}\.jsonl$/.test(file))) {
  const pair = name.replace(/-\d{4}-\d{2}\.jsonl$/, '')
  let mine = bars.get(pair)
  if (mine === undefined) bars.set(pair, (mine = new Map()))
  for (const line of readFileSync(join(dir, name), 'utf-8').split('\n')) {
    if (line.trim() === '') continue
    const row = JSON.parse(line) as number[]
    const time = Math.floor(row[0] / DAY) * DAY
    mine.set(time, { time, open: row[1], high: row[2], low: row[3], close: row[4] })
  }
}
const universe = (JSON.parse(readFileSync(join(DAILY, 'universe.json'), 'utf-8')) as { months: Record<string, { pairs: string[] }> }).months
const monthOf = (sec: number): string => new Date(sec * 1000).toISOString().slice(0, 7)
const monthStart = (sec: number): number => {
  const d = new Date(sec * 1000)
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1) / 1000
}
const btc = bars.get('BTCUSDT')!
const MONTH_RISING = new Map<string, boolean>()
for (const month of new Set([...btc.keys()].map(monthOf))) {
  const days = [...btc.values()].filter((bar) => monthOf(bar.time) === month).sort((a, b) => a.time - b.time)
  if (days.length > 0) MONTH_RISING.set(month, days[days.length - 1].close > days[0].open)
}
const MONDAY0 = at(2017, 12, 4)
const weekOf = (day: number): number => Math.floor((day - MONDAY0) / (7 * DAY))
console.log(`${bars.size} pairs, ${Object.keys(universe).length} universe months`)

function callDays(h: number, from: number, to: number): number[] {
  const out: number[] = []
  for (let day = from; day + h * DAY <= to; day += DAY) {
    if (h === 3 && (day / DAY) % 3 !== 0) continue
    if (h === 7 && new Date(day * 1000).getUTCDay() !== 1) continue
    out.push(day)
  }
  return out
}

interface Call {
  pair: string
  day: number
  sigma: number
  z: number
  movePct: number
}

/** [calls, in 80%, under P10, over P90, in 50%, expected size, real size] */
const WIDTH = 7
type Vector = Float64Array

function rngOf(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let x = state
    x = Math.imul(x ^ (x >>> 15), x | 1)
    x ^= x + Math.imul(x ^ (x >>> 7), x | 61)
    return ((x ^ (x >>> 14)) >>> 0) / 4_294_967_296
  }
}

const STATISTICS: Record<string, (s: Float64Array) => number> = {
  in80: (s) => s[1] / s[0],
  underP10: (s) => s[2] / s[0],
  overP90: (s) => s[3] / s[0],
  in50: (s) => s[4] / s[0],
  sizeRatio: (s) => s[6] / s[5]
}
const round = (value: number): number => Math.round(value * 1e4) / 1e4

function figuresOf(scored: readonly { week: number; vector: Vector }[], blockWeeks: number): Record<string, unknown> {
  if (scored.length === 0) return { calls: 0 }
  // Folded, not spread: a spread of a hundred thousand calls overflows the stack.
  const first = scored.reduce((least, entry) => Math.min(least, entry.week), Infinity)
  const last = scored.reduce((most, entry) => Math.max(most, entry.week), -Infinity)
  const weeks = Array.from({ length: last - first + 1 }, () => new Float64Array(WIDTH))
  const total = new Float64Array(WIDTH)
  for (const entry of scored) {
    for (let k = 0; k < WIDTH; k++) {
      weeks[entry.week - first][k] += entry.vector[k]
      total[k] += entry.vector[k]
    }
  }
  const names = Object.keys(STATISTICS)
  const draws: Record<string, number[]> = Object.fromEntries(names.map((name) => [name, []]))
  const random = rngOf(SEED)
  const sums = new Float64Array(WIDTH)
  for (let draw = 0; draw < DRAWS; draw++) {
    sums.fill(0)
    for (let taken = 0; taken < weeks.length; ) {
      const start = Math.floor(random() * weeks.length)
      for (let j = 0; j < blockWeeks && taken < weeks.length; j++, taken++) {
        const week = weeks[(start + j) % weeks.length]
        for (let k = 0; k < WIDTH; k++) sums[k] += week[k]
      }
    }
    for (const name of names) {
      const value = STATISTICS[name](sums)
      if (Number.isFinite(value)) draws[name].push(value)
    }
  }
  const out: Record<string, unknown> = { calls: total[0], weeks: weeks.length }
  for (const name of names) {
    const sorted = draws[name].sort((a, b) => a - b)
    const pick = (p: number): number => round(sorted[Math.min(sorted.length - 1, Math.max(0, Math.floor(p * (sorted.length - 1))))])
    out[name] = { value: round(STATISTICS[name](total)), low: pick(0.025), high: pick(0.975) }
  }
  return out
}

function vectorOf(q: readonly number[], movePct: number): Vector {
  return Float64Array.from([1, movePct >= q[0] && movePct <= q[4] ? 1 : 0, movePct < q[0] ? 1 : 0, movePct > q[4] ? 1 : 0, movePct >= q[1] && movePct <= q[3] ? 1 : 0, expectedMove(q), Math.abs(movePct)])
}

const result: Record<string, unknown> = { at: new Date().toISOString(), held: HELD.map((sec) => new Date(sec * 1000).toISOString().slice(0, 10)), horizons: {} }
for (const horizon of DAILY_HORIZONS) {
  const h = DAILY_HORIZON_DAYS[horizon]
  // Every universe coin's call with its spread, its move in that unit and in percent.
  const calls: Call[] = []
  for (const day of callDays(h, FIRST - FIT_DAYS * DAY, HELD[1])) {
    const pairs = universe[monthOf(day)]?.pairs ?? universe[monthOf(Math.max(day, FIRST))]?.pairs ?? []
    for (const pair of pairs) {
      const byDay = bars.get(pair)
      if (byDay === undefined) continue
      const sigma = dailySigma(byDay, day)
      const move = logMove(byDay, day, h)
      if (sigma === null || move === null) continue
      calls.push({ pair, day, sigma, z: move / (sigma * Math.sqrt(h)), movePct: (Math.exp(move) - 1) * 100 })
    }
  }
  calls.sort((a, b) => a.day - b.day)
  // The widths of each month: from the moves whose horizon ended by its start, over the thousand days before.
  const factorsByMonth = new Map<number, [number, number] | null>()
  const factorsOf = (start: number): [number, number] | null => {
    if (!factorsByMonth.has(start)) factorsByMonth.set(start, bandFactors(calls.filter((call) => call.day >= start - FIT_DAYS * DAY && call.day + h * DAY <= start).map((call) => call.z)))
    return factorsByMonth.get(start)!
  }
  const scored: { day: number; week: number; rising: boolean | undefined; vector: Vector }[] = []
  for (const call of calls) {
    if (call.day < FIRST) continue
    const factors = factorsOf(monthStart(call.day))
    if (factors === null) continue
    scored.push({ day: call.day, week: weekOf(call.day), rising: MONTH_RISING.get(monthOf(call.day)), vector: vectorOf(dailyQuantilesPct(call.sigma, h, factors), call.movePct) })
  }
  const block = h === 7 ? 2 : 1
  const held = scored.filter((entry) => entry.day >= HELD[0] && entry.day + h * DAY <= HELD[1])
  const years: Record<string, unknown> = {}
  for (const year of [...new Set(scored.map((entry) => new Date(entry.day * 1000).getUTCFullYear()))].sort()) years[year] = figuresOf(scored.filter((entry) => new Date(entry.day * 1000).getUTCFullYear() === year), block)
  const heldFigures = figuresOf(held, block) as Record<string, { value: number }>
  const lines = {
    coverage: heldFigures.in80.value >= 0.775 && heldFigures.in80.value <= 0.825,
    under: heldFigures.underP10.value >= 0.07 && heldFigures.underP10.value <= 0.13,
    over: heldFigures.overP90.value >= 0.07 && heldFigures.overP90.value <= 0.13,
    size: heldFigures.sizeRatio.value >= 0.9 && heldFigures.sizeRatio.value <= 1.1
  }
  // Bitcoin alone: the rule's spread and DVOL's, each with normal widths, over the held-out calls.
  const dvol = new Map((JSON.parse(readFileSync(join(EXTRAS, 'dvol-btc.json'), 'utf-8')) as number[][]).map((row) => [row[0], row[1]]))
  const NORMAL: [number, number] = [0.6745, 1.2816]
  const btcCalls = calls.filter((call) => call.pair === 'BTCUSDT' && call.day >= HELD[0] && call.day + h * DAY <= HELD[1])
  const btcRule = figuresOf(btcCalls.map((call) => ({ week: weekOf(call.day), vector: vectorOf(dailyQuantilesPct(call.sigma, h, factorsOf(monthStart(call.day)) ?? NORMAL), call.movePct) })), block)
  const btcDvol = figuresOf(
    btcCalls
      .filter((call) => dvol.has(call.day - DAY))
      .map((call) => ({ week: weekOf(call.day), vector: vectorOf(dailyQuantilesPct(dvol.get(call.day - DAY)! / 100 / Math.sqrt(365), h, NORMAL), call.movePct) })),
    block
  )
  ;(result.horizons as Record<string, unknown>)[horizon] = {
    heldOut: heldFigures,
    lines,
    verdict: heldFigures.calls === 0 ? 'not measured' : Object.values(lines).every(Boolean) ? 'held' : 'failed',
    rising: figuresOf(held.filter((entry) => entry.rising === true), block),
    falling: figuresOf(held.filter((entry) => entry.rising === false), block),
    years,
    bitcoin: { rule: btcRule, dvol: btcDvol }
  }
  const f = heldFigures as unknown as Record<string, { value: number; low: number; high: number }>
  console.log(`${horizon}: held out ${(heldFigures as { calls: number }).calls} calls; 80% ${f.in80.value} [${f.in80.low}, ${f.in80.high}], under ${f.underP10.value}, over ${f.overP90.value}, 50% ${f.in50.value}, size ${f.sizeRatio.value} [${f.sizeRatio.low}, ${f.sizeRatio.high}] -> ${(result.horizons as Record<string, { verdict: string }>)[horizon].verdict}`)
}
writeFileSync('research/v10-daily-size.json', JSON.stringify(result, null, 1))
console.log('-> research/v10-daily-size.json')
