// V9-PREMIUM, MEASURED (registered 10 November 2026 before anything was read). Does Coinbase's price of Bitcoin over
// Binance's, turning unusual, tell the way of the next 4 hours or day?
// Each hour from 2018: the premium, Coinbase's BTC-USD hourly close over Binance's BTCUSDT hourly close of the same hour,
// less 1, in percent, and its z against the 720 hours before (at least 600 read). A call where z crosses +2 from below
// or -2 from above, none after it until its horizon has passed; its trade from the open of Binance's next hourly bar,
// held 4 or 24 hours, out at that hour's open, net of a 0.24% round trip, with the premium (up when it is high) or
// against it. The horizon and the side are chosen on the DISCOVERY half (2018 to 2022) alone, by the highest t of the
// mean net; then the HELD-OUT half (2023 to the end of the bars) is read once on that choice: the share right with its
// one-sided 95% Wilson lower bound, and the mean net with its one-sided 95% lower bound by resampling calls (10,000
// draws, seeded). It holds where both are above 50% and 0 on 30 calls or more.
//
//   PHASE=discovery node research/v9Premium.mjs     writes research/v9-premium-discovery.json
//   PHASE=heldout node research/v9Premium.mjs       the held-out half, once, on the choice the discovery file names
//
// Coinbase's candles: research/fetch-coinbase-premium.mjs; Binance's: E:/Code/newtradingbot/.candles/BTCUSDT-1h.json
// ([open time s, open, high, low, close, volume]). It reads files; it places nothing.

import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'

const PHASE = process.env.PHASE ?? ''
if (PHASE !== 'discovery' && PHASE !== 'heldout') throw new Error('PHASE is discovery or heldout')
const COINBASE = process.env.COINBASE ?? 'E:/Code/newtradingbot/.candles/COINBASE-BTCUSD-1h.json'
const BINANCE = process.env.BINANCE ?? 'E:/Code/newtradingbot/.candles/BTCUSDT-1h.json'
const DISCOVERY_FILE = 'research/v9-premium-discovery.json'
const HELDOUT_FILE = process.env.OUT ?? 'research/v9-premium-heldout.json'
const LINES = {
  fromSec: Date.UTC(2018, 0, 1) / 1000,
  heldOutFrom: Date.UTC(2023, 0, 1) / 1000,
  windowHours: 720,
  minWindowHours: 600,
  zLine: 2,
  horizonsH: [4, 24],
  sides: ['with', 'against'],
  roundTripPct: 0.24,
  minCalls: 30,
  draws: 10_000,
  z: 1.6448536269514722
}
const H = 3600

const textOf = (path) => readFileSync(path, 'utf-8')
const sha = (text) => createHash('sha256').update(text).digest('hex')
const coinbaseText = textOf(COINBASE)
const binanceText = textOf(BINANCE)
const coinbase = new Map(JSON.parse(coinbaseText).map((row) => [row[0], row[4]]))
const binance = new Map(JSON.parse(binanceText).map((row) => [row[0], { open: row[1], close: row[4] }]))

// The premium of each hour both venues closed, in time order, and its z against the window before it.
const hours = [...coinbase.keys()].filter((time) => time >= LINES.fromSec && binance.has(time)).sort((a, b) => a - b)
const premium = new Map(hours.map((time) => [time, (coinbase.get(time) / binance.get(time).close - 1) * 100]))
const zOf = new Map()
{
  // A running window of the 720 hours before each hour: sums over the premiums inside it.
  let sum = 0
  let sumSq = 0
  let count = 0
  const inside = []
  let head = 0
  for (const time of hours) {
    while (head < inside.length && inside[head] < time - LINES.windowHours * H) {
      const old = premium.get(inside[head])
      sum -= old
      sumSq -= old * old
      count--
      head++
    }
    if (count >= LINES.minWindowHours) {
      const mean = sum / count
      const sd = Math.sqrt(Math.max(0, sumSq / count - mean * mean) * (count / (count - 1)))
      if (sd > 0) zOf.set(time, (premium.get(time) - mean) / sd)
    }
    const value = premium.get(time)
    inside.push(time)
    sum += value
    sumSq += value * value
    count++
  }
}

/** The calls of one horizon: z crossing the line from inside, none until the horizon after a call has passed; each with
 * its way (+1 where the premium is high) and its gross move from the next hour's open to the open the horizon on. */
function callsOf(horizonH) {
  const out = []
  let quietUntil = -Infinity
  for (const time of hours) {
    const z = zOf.get(time)
    const before = zOf.get(time - H)
    if (z === undefined || before === undefined || time < quietUntil) continue
    const way = z >= LINES.zLine && before < LINES.zLine ? 1 : z <= -LINES.zLine && before > -LINES.zLine ? -1 : 0
    if (way === 0) continue
    const entry = binance.get(time + H)
    const exit = binance.get(time + H + horizonH * H)
    if (entry === undefined || exit === undefined || !(entry.open > 0) || !(exit.open > 0)) continue
    out.push({ at: time, way, z, premiumPct: premium.get(time), movePct: (exit.open / entry.open - 1) * 100 })
    quietUntil = time + horizonH * H
  }
  return out
}

const netOf = (call, side) => (side === 'with' ? call.way : -call.way) * call.movePct - LINES.roundTripPct
const rightOf = (call, side) => (side === 'with' ? call.way : -call.way) * call.movePct > 0

const stats = (values) => {
  const n = values.length
  const mean = values.reduce((a, b) => a + b, 0) / Math.max(1, n)
  const sd = n > 1 ? Math.sqrt(values.reduce((total, value) => total + (value - mean) ** 2, 0) / (n - 1)) : Number.NaN
  return { n, mean, sd, t: n > 1 && sd > 0 ? mean / (sd / Math.sqrt(n)) : Number.NaN }
}

/** The one-sided lower bound of a share by Wilson's interval at z. */
function wilsonLower(hits, n, z = LINES.z) {
  if (n === 0) return Number.NaN
  const p = hits / n
  const centre = p + (z * z) / (2 * n)
  const spread = z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))
  return (centre - spread) / (1 + (z * z) / n)
}

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

/** The one-sided 95% lower bound of a mean, by resampling its values (10,000 draws, seeded). */
function bootstrapLower(values, draws = LINES.draws, seed = 20261110) {
  const next = rng(seed)
  const means = []
  for (let k = 0; k < draws; k++) {
    let total = 0
    for (let i = 0; i < values.length; i++) total += values[Math.floor(next() * values.length)]
    means.push(total / values.length)
  }
  means.sort((a, b) => a - b)
  return means[Math.floor(0.05 * draws)]
}

const inHalf = (call) => (PHASE === 'discovery' ? call.at < LINES.heldOutFrom : call.at >= LINES.heldOutFrom)
const files = { coinbaseSha256: sha(coinbaseText), binanceSha256: sha(binanceText) }
const span = { hours: hours.length, withZ: zOf.size, first: new Date(hours[0] * 1000).toISOString(), last: new Date(hours[hours.length - 1] * 1000).toISOString() }

if (PHASE === 'discovery') {
  const options = []
  for (const horizonH of LINES.horizonsH) {
    const calls = callsOf(horizonH).filter(inHalf)
    for (const side of LINES.sides) {
      const s = stats(calls.map((call) => netOf(call, side)))
      options.push({ horizonH, side, calls: s.n, up: calls.filter((call) => call.way > 0).length, meanNet: s.mean, t: s.t, shareRight: calls.length === 0 ? null : calls.filter((call) => rightOf(call, side)).length / calls.length })
    }
  }
  const chosen = [...options].sort((a, b) => (Number.isNaN(b.t) ? -Infinity : b.t) - (Number.isNaN(a.t) ? -Infinity : a.t))[0]
  writeFileSync(DISCOVERY_FILE, `${JSON.stringify({ version: 'v9-premium-discovery-v1', phase: PHASE, ...files, span, lines: LINES, options, chosen: { horizonH: chosen.horizonH, side: chosen.side } }, null, 1)}\n`)
  for (const option of options) console.log(`${option.horizonH}h ${option.side}: ${option.calls} calls (${option.up} up), mean net ${option.meanNet.toFixed(3)}%, t ${option.t.toFixed(2)}, right ${(option.shareRight * 100).toFixed(1)}%`)
  console.log(`chosen: ${chosen.horizonH}h ${chosen.side}; ${span.hours} hours read, ${span.withZ} with a z`)
} else {
  const discovery = JSON.parse(readFileSync(DISCOVERY_FILE, 'utf-8'))
  if (discovery.coinbaseSha256 !== files.coinbaseSha256 || discovery.binanceSha256 !== files.binanceSha256) throw new Error('the bars are not the ones the discovery half read')
  const { horizonH, side } = discovery.chosen
  const calls = callsOf(horizonH).filter(inHalf)
  const nets = calls.map((call) => netOf(call, side))
  const hits = calls.filter((call) => rightOf(call, side)).length
  const s = stats(nets)
  const shareLower = wilsonLower(hits, calls.length)
  const meanLower = calls.length > 1 ? bootstrapLower(nets) : Number.NaN
  const enough = calls.length >= LINES.minCalls
  const verdict = !enough ? 'not measured' : shareLower > 0.5 && meanLower > 0 ? 'held' : 'failed'
  const out = { version: 'v9-premium-heldout-v1', phase: PHASE, ...files, span, horizonH, side, calls: calls.length, up: calls.filter((call) => call.way > 0).length, shareRight: calls.length === 0 ? null : hits / calls.length, shareLower95: shareLower, meanNet: s.mean, meanLower95: meanLower, t: s.t, verdict, list: calls.map((call) => ({ at: call.at, way: call.way, z: Number(call.z.toFixed(2)), premiumPct: Number(call.premiumPct.toFixed(4)), movePct: Number(call.movePct.toFixed(3)), net: Number(netOf(call, side).toFixed(3)) })) }
  writeFileSync(HELDOUT_FILE, `${JSON.stringify(out, null, 1)}\n`)
  console.log(`held out, ${horizonH}h ${side}: ${calls.length} calls (${out.up} up), right ${(out.shareRight * 100).toFixed(1)}% (lower ${(shareLower * 100).toFixed(1)}%), mean net ${s.mean.toFixed(3)}% (lower ${meanLower.toFixed(3)}%), t ${s.t.toFixed(2)}: ${verdict}`)
}
