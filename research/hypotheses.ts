// THE USER'S DIRECTION HYPOTHESES ON A YEAR OF BARS (V7.2-R Stage 6, 22 October 2026; shared/forecast/hypotheses.ts).
// Each rule's calls at every hour's close of the year archive (research/fetch-forecast-archive.mjs: each month's pairs
// read from the archive itself), judged at an hour, four hours and a day by the direction bar's lines, against the
// month's base rate of the way called; the CATALYST rule on Binance's own announcements of the year and the one-minute
// candles around them (research/fetch-announcements.mjs, research/fetch-news-candles.mjs). Registered before it was
// run: V72R-S6-GAINERS, -LEADERS, -CATALYST, -BREAKOUT, -RECOVERY.
//
//   npx esbuild research/hypotheses.ts --bundle --platform=node --format=esm --outfile=research/.hypotheses.mjs
//   ARCHIVE=<scratch>/archive-profile [NEWS=.candles/news] [OUT=<figures.json>] node research/.hypotheses.mjs
//
// It reads and writes nothing else.
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { barFromLine, mergeBars, type ForecastBar } from '../shared/forecast/bars'
import {
  HYPOTHESES,
  HYPOTHESIS_HORIZONS,
  HYPOTHESIS_HOURS,
  HYPOTHESES_VERSION,
  breakoutAt,
  catalystCall,
  gainersAt,
  hourIndex,
  hourlyOf,
  hypothesisFiguresOf,
  leadersAt,
  monthOf,
  moveAfterPct,
  recoveryAt,
  type HourlySeries,
  type HypothesisCall,
  type HypothesisFigures,
  type HypothesisHorizon,
  type HypothesisId,
  type JudgedCall,
  type MonthBase
} from '../shared/forecast/hypotheses'
import { classifyTitle } from '../shared/newsTitles'

const ARCHIVE = process.env.ARCHIVE ?? ''
if (ARCHIVE === '') throw new Error('ARCHIVE is the folder research/fetch-forecast-archive.mjs wrote into')
const NEWS = process.env.NEWS ?? '.candles/news'
const OUT = process.env.OUT

const universe = JSON.parse(readFileSync(join(ARCHIVE, 'universe.json'), 'utf-8')) as { months: Record<string, { pairs: string[] }> }
const months = Object.keys(universe.months).sort()
const spanFrom = Date.parse(`${months[0]}-01T00:00:00Z`) / 1000
const lastMonth = months[months.length - 1]
const [ly, lm] = lastMonth.split('-').map(Number)
const spanTo = Date.UTC(lm === 12 ? ly + 1 : ly, lm === 12 ? 0 : lm, 1) / 1000
// The year's halves: its first six months and its last six.
const split = Date.parse(`${months[Math.floor(months.length / 2)]}-01T00:00:00Z`) / 1000
console.log(`the archive: ${months.length} months, ${months[0]} to ${lastMonth}; the year halved at ${new Date(split * 1000).toISOString().slice(0, 10)}`)

// Every pair's hours, from its five-minute bars on file.
const dir = join(ARCHIVE, 'forecastArchive')
const barsOf = new Map<string, ForecastBar[]>()
for (const name of readdirSync(dir).sort()) {
  const pair = /^([A-Z0-9]+)-\d{4}-\d{2}\.jsonl$/.exec(name)?.[1]
  if (pair === undefined) continue
  const read: ForecastBar[] = []
  for (const line of readFileSync(join(dir, name), 'utf-8').split('\n')) {
    if (line.trim() === '') continue
    const bar = barFromLine(JSON.parse(line))
    if (bar !== null) read.push(bar)
  }
  barsOf.set(pair, mergeBars(barsOf.get(pair) ?? [], read))
}
const hourly = new Map<string, HourlySeries>()
for (const [pair, bars] of barsOf) {
  const series = hourlyOf(pair, bars)
  if (series !== null) hourly.set(pair, series)
}
console.log(`${hourly.size} pairs' hours built from the archive's bars`)

const universeAt = (t: number): HourlySeries[] => (universe.months[monthOf(t - 1)]?.pairs ?? []).map((pair) => hourly.get(pair)).filter((series): series is HourlySeries => series !== undefined)

// The month's base rates at each horizon: the share of every coin-hour of its universe that went up, and down.
const bases = new Map<string, Record<HypothesisHorizon, MonthBase>>()
for (const month of months) {
  const mine = {} as Record<HypothesisHorizon, MonthBase>
  for (const horizon of HYPOTHESIS_HORIZONS) mine[horizon] = { up: 0, down: 0, n: 0 }
  const from = Date.parse(`${month}-01T00:00:00Z`) / 1000
  const [y, m] = month.split('-').map(Number)
  const to = Date.UTC(m === 12 ? y + 1 : y, m === 12 ? 0 : m, 1) / 1000
  for (let t = from + 3600; t <= to; t += 3600) {
    for (const series of universeAt(t)) {
      const at = hourIndex(series, t)
      for (const horizon of HYPOTHESIS_HORIZONS) {
        const move = moveAfterPct(series, at, HYPOTHESIS_HOURS[horizon])
        if (move === null) continue
        mine[horizon].n++
        if (move > 0) mine[horizon].up++
        else if (move < 0) mine[horizon].down++
      }
    }
  }
  for (const horizon of HYPOTHESIS_HORIZONS) {
    const entry = mine[horizon]
    entry.up = entry.n === 0 ? Number.NaN : entry.up / entry.n
    entry.down = entry.n === 0 ? Number.NaN : entry.down / entry.n
  }
  bases.set(month, mine)
}
for (const month of months) console.log(`  ${month}: up at 1h ${(bases.get(month)!.hour1.up * 100).toFixed(1)}%, at 4h ${(bases.get(month)!.hours4.up * 100).toFixed(1)}%, at 24h ${(bases.get(month)!.hours24.up * 100).toFixed(1)}% of ${bases.get(month)!.hour1.n} coin-hours`)

// Each rule's calls at every hour's close of the year.
const calls: Record<HypothesisId, HypothesisCall[]> = { gainers: [], leaders: [], catalyst: [], breakout: [], recovery: [] }
for (let t = spanFrom + 3600; t <= spanTo; t += 3600) {
  const pairs = universeAt(t)
  calls.gainers.push(...gainersAt(pairs, t))
  calls.leaders.push(...leadersAt(pairs, t))
  for (const series of pairs) {
    const breakout = breakoutAt(series, t)
    if (breakout !== null) calls.breakout.push(breakout)
    const recovery = recoveryAt(series, t)
    if (recovery !== null) calls.recovery.push(recovery)
  }
}

// CATALYST: the year's announcements, read with the app's own patterns, each named coin's spot candles around it.
const catalystCloses = new Map<string, Map<number, number>>()
const pairsFile = join(NEWS, 'pairs.json')
const manifestFile = join(NEWS, 'manifest.json')
let catalystNote = 'no news candles on file'
if (existsSync(pairsFile) && existsSync(manifestFile)) {
  const planned = JSON.parse(readFileSync(pairsFile, 'utf-8')) as { key: string; category: string; releaseSec: number; ticker: string; market: string; days: string[] }[]
  const read = JSON.parse(readFileSync(manifestFile, 'utf-8')) as Record<string, { status: string; symbol?: string }>
  // The announcements of the year by their own titles, so that the kinds are the app's.
  const titles = new Map<string, string>()
  for (const catalog of ['48', '161', '49']) {
    const file = join(NEWS, `announcements-${catalog}.json`)
    if (!existsSync(file)) continue
    for (const row of JSON.parse(readFileSync(file, 'utf-8')) as { id: number; title: string; releaseSec: number }[]) titles.set(String(row.id), row.title)
  }
  let considered = 0
  let read1m = 0
  for (const entry of planned) {
    if (entry.releaseSec < spanFrom || entry.releaseSec >= spanTo) continue
    considered++
    const title = titles.get(entry.key.split(':')[0])
    const kind = title === undefined ? entry.category : classifyTitle(title)?.category ?? null
    if (kind === null || kind !== entry.category) continue
    const got = read[entry.key]
    if (got?.status !== 'ok' || got.symbol === undefined || entry.market !== 'spot') continue
    const call = catalystCall(got.symbol, kind, entry.releaseSec)
    if (call === null) continue
    // The closes at each hour's end around it, from its one-minute candles: the minute that ends on the hour.
    let closes = catalystCloses.get(got.symbol)
    if (closes === undefined) catalystCloses.set(got.symbol, (closes = new Map()))
    for (const day of entry.days) {
      const file = join(NEWS, 'klines', 'spot', got.symbol, `${day}.json`)
      if (!existsSync(file)) continue
      for (const candle of JSON.parse(readFileSync(file, 'utf-8')) as number[][]) {
        const end = candle[0] + 60
        if (end % 3600 === 0) closes.set(end, candle[4])
      }
    }
    // The day after the last day planned, for the day's horizon.
    const after = new Date((Date.parse(`${entry.days[entry.days.length - 1]}T00:00:00Z`) + 86_400_000)).toISOString().slice(0, 10)
    const next = join(NEWS, 'klines', 'spot', got.symbol, `${after}.json`)
    if (existsSync(next)) for (const candle of JSON.parse(readFileSync(next, 'utf-8')) as number[][]) if ((candle[0] + 60) % 3600 === 0) closes.set(candle[0] + 60, candle[4])
    read1m++
    calls.catalyst.push({ ...call, pair: got.symbol })
  }
  catalystNote = `${considered} coin-announcements of the year planned, ${read1m} with their spot candles read and a call made`
}
console.log(`catalyst: ${catalystNote}`)

const catalystMove = (pair: string, t: number, hours: number): number | null => {
  const closes = catalystCloses.get(pair)
  const now = closes?.get(t)
  const then = closes?.get(t + hours * 3600)
  return now === undefined || then === undefined || !(now > 0) ? null : (then / now - 1) * 100
}

const figures: HypothesisFigures[] = []
for (const hypothesis of HYPOTHESES) {
  for (const horizon of HYPOTHESIS_HORIZONS) {
    const judged: JudgedCall[] = []
    for (const call of calls[hypothesis]) {
      const hours = HYPOTHESIS_HOURS[horizon]
      const movePct = hypothesis === 'catalyst' ? catalystMove(call.pair, call.t, hours) : moveAfterPct(hourly.get(call.pair)!, hourIndex(hourly.get(call.pair)!, call.t), hours)
      const base = bases.get(monthOf(call.t - 1))?.[horizon]
      if (movePct === null || base === undefined) continue
      judged.push({ ...call, movePct, base: call.way === 1 ? base.up : base.down })
    }
    figures.push(hypothesisFiguresOf(hypothesis, horizon, judged, split))
  }
}

const fig = (figure: { value: number; low: number; high: number } | null, scale = 100, digits = 2, unit = '%'): string =>
  figure === null ? '-' : `${(figure.value * scale).toFixed(digits)}${unit} [${(figure.low * scale).toFixed(digits)}, ${(figure.high * scale).toFixed(digits)}]`
console.log(`\nthe rules (${HYPOTHESES_VERSION}), each horizon apart:`)
for (const entry of figures) {
  console.log(`  ${entry.hypothesis.padEnd(9)} ${entry.horizon.padEnd(8)} ${String(entry.calls).padStart(7)} calls  right ${fig(entry.precision, 100, 1)}  skill ${fig(entry.skill, 100, 2)}  edge ${fig(entry.edgePct, 1, 3)}  -> ${entry.tradeable ? 'PROMOTED AND TRADEABLE' : entry.promoted ? 'PROMOTED, NOT TRADEABLE' : 'held back'}`)
  for (const line of entry.lines) console.log(`      ${line.ok === true ? 'ok  ' : line.ok === false ? 'NO  ' : 'n/r '} ${line.text}`)
}
console.log('\nby month, the calls and their mean move in the way called (an hour on):')
for (const hypothesis of HYPOTHESES) {
  const entry = figures.find((figure) => figure.hypothesis === hypothesis && figure.horizon === 'hour1')!
  console.log(`  ${hypothesis.padEnd(9)} ${Object.entries(entry.byMonth).map(([month, mine]) => `${month.slice(2)} ${mine.calls}/${mine.meanMovePct >= 0 ? '+' : ''}${mine.meanMovePct.toFixed(2)}%`).join('  ')}`)
}
if (OUT !== undefined) {
  writeFileSync(OUT, JSON.stringify({ version: HYPOTHESES_VERSION, months, split, catalyst: catalystNote, figures }, null, 1))
  console.log(`\nwrote ${OUT}`)
}
