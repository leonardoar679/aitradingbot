// V9-HACK-2, MEASURED (V9 Stage 5; registered 6 November 2026 before anything was read). Does a hacked protocol's or
// exchange's own token keep falling after the hack? For each event of research/v9-hack-events.json (a hack of $5M or
// more, its victim's own token, a USDT perpetual on Binance or Bitget listed before the hack's day):
//   a short from the open of the SECOND UTC day after the hack's date (DefiLlama dates a hack by its day, which can come
//   before the public report), held 1, 3 or 7 days, out at the open that many days on; a token delisted during the hold
//   out at its last close; net of a 0.24% round trip and funding at 0.01% a period against the short (three a day).
//   The first day after is reported beside, judging nothing.
// Events of one ISO week are one cluster, their nets averaged. The hold is chosen on the DISCOVERY half (hack dates 2020
// to 2023) alone, by the highest t on cluster means; then the HELD-OUT half (2024 to 31 October 2026) is read once: its
// mean net over clusters, t, and the 90% interval by resampling clusters (10,000 draws, seeded). Passes where the
// interval's lower end is above 0, the mean is at least +1% and t at least 2; under 15 held-out clusters, not measured.
// Beside, exploratory, judging nothing: Bitcoin over 1 and 3 days from the second day's open after the exchange, bridge
// and chain hacks of $100M or more in DefiLlama's list.
//
//   PHASE=discovery node research/v9Hack.mjs     the discovery half: writes research/v9-hack-discovery.json
//   PHASE=heldout node research/v9Hack.mjs       the held-out half, once, with the hold the discovery file names
//
// Daily bars are read from Binance's USD-M futures (fapi/v1/klines) and Bitget's (mix/market/history-candles), keyless,
// and kept in BARS (a cache folder, not committed). It reads public data; it places nothing.

import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const PHASE = process.env.PHASE ?? ''
if (PHASE !== 'discovery' && PHASE !== 'heldout') throw new Error('PHASE is discovery or heldout')
const BARS = process.env.BARS ?? join(process.env.TEMP ?? '.', 'v9-hack-bars')
const EVENTS_FILE = 'research/v9-hack-events.json'
const DISCOVERY_FILE = 'research/v9-hack-discovery.json'
const HELDOUT_FILE = process.env.OUT ?? 'research/v9-hack-heldout.json'
const LINES = { roundTripPct: 0.24, fundingPctPerDay: 0.03, holds: [1, 3, 7], heldOutFrom: Date.UTC(2024, 0, 1) / 1000, minClusters: 15, draws: 10_000, minMeanPct: 1, minT: 2, ciLevel: 0.9 }
const DAY = 86_400

mkdirSync(BARS, { recursive: true })
const eventsText = readFileSync(EVENTS_FILE, 'utf-8')
const eventsSha = createHash('sha256').update(eventsText).digest('hex')
const { events } = JSON.parse(eventsText)

/** A perpetual's daily bars by their UTC day, read once and kept. */
async function barsOf(venue, symbol) {
  const file = join(BARS, `${venue}-${symbol}-1d.json`)
  if (existsSync(file)) return new Map(JSON.parse(readFileSync(file, 'utf-8')))
  const out = new Map()
  if (venue === 'binance') {
    let start = Date.UTC(2019, 8, 1)
    for (let page = 0; page < 10; page++) {
      const response = await fetch(`https://fapi.binance.com/fapi/v1/klines?symbol=${symbol}&interval=1d&limit=1500&startTime=${start}`, { signal: AbortSignal.timeout(30_000) })
      if (!response.ok) throw new Error(`Binance answered ${response.status} for ${symbol}`)
      const rows = await response.json()
      for (const row of rows) out.set(Math.floor(row[0] / 1000), { open: Number(row[1]), close: Number(row[4]) })
      if (rows.length < 1500) break
      start = rows[rows.length - 1][0] + 86_400_000
      await new Promise((resolve) => setTimeout(resolve, 300))
    }
  } else {
    let end = Date.now()
    for (let page = 0; page < 40; page++) {
      const response = await fetch(`https://api.bitget.com/api/v2/mix/market/history-candles?symbol=${symbol}&productType=USDT-FUTURES&granularity=1D&limit=200&endTime=${end}`, { signal: AbortSignal.timeout(30_000) })
      const body = await response.json()
      const rows = Array.isArray(body.data) ? body.data : []
      for (const row of rows) out.set(Math.floor(Number(row[0]) / 1000), { open: Number(row[1]), close: Number(row[4]) })
      if (rows.length === 0) break
      end = Math.min(...rows.map((row) => Number(row[0]))) - 1
      await new Promise((resolve) => setTimeout(resolve, 300))
    }
  }
  writeFileSync(file, JSON.stringify([...out.entries()]))
  return out
}

/** A short's net from a day's open, held `hold` days: out at the open `hold` days on, or at the last close where the
 * bars end first (a delisting); null where the entry's bar is missing. */
function shortNet(bars, entryDay, hold) {
  const entry = bars.get(entryDay)
  if (entry === undefined || !(entry.open > 0)) return null
  let exit = null
  const exitBar = bars.get(entryDay + hold * DAY)
  if (exitBar !== undefined && exitBar.open > 0) exit = exitBar.open
  else {
    // The bars end within the hold: out at the last close on file.
    let last = null
    for (let day = entryDay; day < entryDay + hold * DAY; day += DAY) if (bars.has(day)) last = bars.get(day).close
    if (last === null || [...bars.keys()].some((day) => day >= entryDay + hold * DAY)) return null
    exit = last
  }
  const gross = (entry.open / exit - 1) * 100
  return gross - LINES.roundTripPct - LINES.fundingPctPerDay * hold
}

const isoWeek = (sec) => {
  const date = new Date(sec * 1000)
  const day = (date.getUTCDay() + 6) % 7
  const thursday = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate() - day + 3))
  const firstThursday = new Date(Date.UTC(thursday.getUTCFullYear(), 0, 4))
  return `${thursday.getUTCFullYear()}-W${String(1 + Math.round(((thursday - firstThursday) / 86_400_000 - 3 + ((firstThursday.getUTCDay() + 6) % 7)) / 7)).padStart(2, '0')}`
}

/** Events' nets at a hold, as clusters of their ISO week: each cluster's mean. */
function clustersOf(rows, key) {
  const byWeek = new Map()
  for (const row of rows) {
    const value = row[key]
    if (value === null || value === undefined) continue
    const week = isoWeek(row.day)
    byWeek.set(week, [...(byWeek.get(week) ?? []), value])
  }
  return [...byWeek.entries()].map(([week, values]) => ({ week, mean: values.reduce((a, b) => a + b, 0) / values.length, events: values.length }))
}

const stats = (values) => {
  const n = values.length
  const mean = values.reduce((a, b) => a + b, 0) / Math.max(1, n)
  const sd = n > 1 ? Math.sqrt(values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (n - 1)) : Number.NaN
  return { n, mean, sd, t: n > 1 && sd > 0 ? mean / (sd / Math.sqrt(n)) : Number.NaN }
}

/** A seeded generator (mulberry32), so that the interval is the same each time it is read. */
function rng(seed) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296
  }
}

function bootstrap(values, draws, level, seed = 20261106) {
  const next = rng(seed)
  const means = []
  for (let k = 0; k < draws; k++) {
    let sum = 0
    for (let i = 0; i < values.length; i++) sum += values[Math.floor(next() * values.length)]
    means.push(sum / values.length)
  }
  means.sort((a, b) => a - b)
  const tail = (1 - level) / 2
  return { low: means[Math.floor(tail * draws)], high: means[Math.ceil((1 - tail) * draws) - 1] }
}

const half = (event) => (event.day < LINES.heldOutFrom ? 'discovery' : 'heldout')
const wanted = events.filter((event) => half(event) === PHASE)
const rows = []
for (const event of wanted) {
  const bars = await barsOf(event.venue, event.symbol)
  const row = { date: event.date, day: event.day, name: event.name, token: event.token, symbol: event.symbol, amountUsd: event.amountUsd }
  for (const hold of LINES.holds) {
    row[`net${hold}`] = shortNet(bars, event.day + 2 * DAY, hold)
    row[`firstDay${hold}`] = shortNet(bars, event.day + DAY, hold)
  }
  rows.push(row)
}

// Beside, exploratory: Bitcoin after the largest hacks of exchanges, bridges and chains.
async function bitcoinBeside() {
  const hacks = await (await fetch('https://api.llama.fi/hacks', { signal: AbortSignal.timeout(60_000) })).json()
  const btc = await barsOf('binance', 'BTCUSDT')
  const large = hacks.filter((hack) => hack.amount >= 100_000_000 && hack.date >= Date.UTC(2020, 0, 1) / 1000 && hack.date < Date.UTC(2026, 10, 1) / 1000 && (hack.targetType === 'CEX' || hack.targetType === 'Chain' || hack.bridgeHack === true))
  return large
    .map((hack) => {
      const day = Math.floor(hack.date / DAY) * DAY
      const at = (offset) => btc.get(day + offset * DAY)?.open ?? null
      const entry = at(2)
      const change = (to) => (entry === null || to === null ? null : (to / entry - 1) * 100)
      return { date: new Date(day * 1000).toISOString().slice(0, 10), name: hack.name, amountUsd: hack.amount, btc1dPct: change(at(3)), btc3dPct: change(at(5)) }
    })
    .sort((a, b) => a.date.localeCompare(b.date))
}

if (PHASE === 'discovery') {
  const byHold = LINES.holds.map((hold) => {
    const clusters = clustersOf(rows, `net${hold}`)
    const s = stats(clusters.map((cluster) => cluster.mean))
    return { hold, clusters: clusters.length, mean: s.mean, sd: s.sd, t: s.t }
  })
  const chosen = [...byHold].sort((a, b) => (Number.isNaN(b.t) ? -Infinity : b.t) - (Number.isNaN(a.t) ? -Infinity : a.t))[0]
  const firstDay = LINES.holds.map((hold) => ({ hold, ...stats(clustersOf(rows, `firstDay${hold}`).map((cluster) => cluster.mean)) }))
  const out = { version: 'v9-hack-discovery-v1', phase: PHASE, eventsSha256: eventsSha, lines: LINES, events: rows.length, byHold, chosenHold: chosen.hold, firstDayBeside: firstDay, rows }
  writeFileSync(DISCOVERY_FILE, `${JSON.stringify(out, null, 1)}\n`)
  console.log(`discovery: ${rows.length} events; ${byHold.map((entry) => `${entry.hold}d: ${entry.clusters} clusters, mean ${entry.mean.toFixed(2)}%, t ${entry.t.toFixed(2)}`).join('; ')}; the hold chosen: ${chosen.hold} days`)
} else {
  const discovery = JSON.parse(readFileSync(DISCOVERY_FILE, 'utf-8'))
  if (discovery.eventsSha256 !== eventsSha) throw new Error('the events file is not the one the discovery half read')
  const hold = discovery.chosenHold
  const clusters = clustersOf(rows, `net${hold}`)
  const values = clusters.map((cluster) => cluster.mean)
  const s = stats(values)
  const measured = clusters.length >= LINES.minClusters
  const ci = measured ? bootstrap(values, LINES.draws, LINES.ciLevel) : null
  const passed = measured && ci.low > 0 && s.mean >= LINES.minMeanPct && s.t >= LINES.minT
  const firstDay = stats(clustersOf(rows, `firstDay${hold}`).map((cluster) => cluster.mean))
  const out = {
    version: 'v9-hack-heldout-v1',
    phase: PHASE,
    eventsSha256: eventsSha,
    hold,
    events: rows.length,
    clusters: clusters.length,
    mean: s.mean,
    t: s.t,
    ci90: ci,
    verdict: !measured ? 'not measured' : passed ? 'held' : 'failed',
    firstDayBeside: firstDay,
    bitcoinBeside: await bitcoinBeside(),
    rows
  }
  writeFileSync(HELDOUT_FILE, `${JSON.stringify(out, null, 1)}\n`)
  console.log(`held out at ${hold}d: ${rows.length} events in ${clusters.length} clusters; mean ${s.mean.toFixed(2)}%, t ${s.t.toFixed(2)}, 90% [${ci ? `${ci.low.toFixed(2)}%, ${ci.high.toFixed(2)}%` : '-'}]; ${out.verdict}`)
}
