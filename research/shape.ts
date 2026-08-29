// WHAT THE REGIME GATE ACTUALLY DOES TO THE DISTRIBUTION, rather than to the total.
//
// research/enhance.ts answers "does gating Short-Term Channel on the trend regime raise 36-month
// total profit?" and the answer is yes on 7 of 8 symbols. That is the weaker of the two claims
// available here, and on its own it is close to unfalsifiable: these strategies have a median month
// of zero and a mean carried by a handful of enormous months, so a DOLLAR total across 288
// symbol-months is decided by what happens in about five of them. Checked directly, the net gain is
// $11,436 and the best five months carry 86% of it. A result resting on five observations is the
// exact failure mode the rest of this directory keeps retracting.
//
// So this script asks the falsifiable question instead: sort every month by what the UNGATED
// strategy did, cut into fifths, and see whether the gate's effect varies systematically with how
// bad the month was. If the gate is real, it should help most where the ungated strategy hurt most
// and cost something where the ungated strategy did best. If it is noise, the effect will wander.
//
// It is monotonic across all five buckets, and the helped/hurt counts are lopsided in opposite
// directions at the two ends -- 80 helped against 18 hurt in the bottom two fifths, 11 helped
// against 61 hurt in the top two. That is 288 months voting, not five.
//
// The honest headline is therefore NOT "the gate makes more money". It is that the gate TRADES
// UPSIDE FOR DOWNSIDE at a rate the design predicts: roughly 3.6 points given up in the best fifth
// of months to save roughly 5.8 in the worst fifth. Total profit improves on these particular 36
// months because the bad tail was fatter than the good tail was thin -- which is a fact about
// 2023-2026, while the risk transfer is a fact about the rule.
//
// INPUT is the per-month dump research/monthiv.ts writes, so this re-reads the shipped strategy's
// own results rather than recomputing them:
//
//   npx esbuild research/monthiv.ts --bundle --platform=node --format=esm --outfile=research/.monthiv.mjs
//   CANDLE_DIR=.candles SYMBOLS=BTCUSDT,ETHUSDT,SOLUSDT,ADAUSDT,BNBUSDT,LINKUSDT,LTCUSDT,XRPUSDT \
//     INTERVALS=15m OUT=research/.eight.json node --max-old-space-size=6144 research/.monthiv.mjs
//   npx esbuild research/shape.ts --bundle --platform=node --format=esm --outfile=research/.shape.mjs
//   IN=research/.eight.json node research/.shape.mjs

import { readFileSync } from 'fs'
import { shortTermChannel } from '../src/backtest/strategies/shortTermChannel'
import { shortTermChannelRegime } from '../src/backtest/strategies/shortTermChannelRegime'

const IN = process.env.IN || 'research/.eight.json'
const INTERVAL = process.env.INTERVAL || '15m'
const SYMBOLS = (process.env.SYMBOLS || 'BTCUSDT,ETHUSDT,SOLUSDT,ADAUSDT,BNBUSDT,LINKUSDT,LTCUSDT,XRPUSDT').split(',')
const BUCKETS = 5
/** Below this, a month is "unchanged" rather than helped or hurt. The engine is deterministic, so
 * this is not a tolerance for noise -- it is the line under which a difference is not worth a vote. */
const EPS = 0.05

interface MonthResult {
  month: string
  trades: number
  finalBalance: number
  returnPct: number
  /** Worst peak-to-trough dip WITHIN the month, from the equity curve. Distinct from
   * returnPct: a month can finish flat having been 20% down in the middle of it. */
  maxDrawdownPct: number
}

const dump = JSON.parse(readFileSync(IN, 'utf-8')) as Record<string, MonthResult[]>
const key = (sym: string, id: string): string => sym + '|' + id + '|' + INTERVAL

/** Months BOTH variants ran, matched by label. The gated strategy carries the regime's 80-day
 * warm-up rather than the channel's 8, so it can skip a month the ungated one scores; an unmatched
 * month would otherwise enter the comparison as a one-sided result. */
interface Pair { sym: string; month: string; u: MonthResult; g: MonthResult }
const pairs: Pair[] = []
const missing: string[] = []
for (const sym of SYMBOLS) {
  const u = dump[key(sym, shortTermChannel.id)]
  const g = dump[key(sym, shortTermChannelRegime.id)]
  if (!u || !g) { missing.push(sym); continue }
  const byMonth = new Map(g.map((m) => [m.month, m]))
  for (const m of u) {
    const other = byMonth.get(m.month)
    if (other) pairs.push({ sym, month: m.month, u: m, g: other })
  }
}
if (missing.length) console.log('no data for: ' + missing.join(', ') + '\n')
if (!pairs.length) {
  console.log('nothing to compare -- is ' + IN + ' from a run that included both strategies?')
  process.exit(1)
}

const sum = (v: number[]): number => v.reduce((a, b) => a + b, 0)
const mean = (v: number[]): number => sum(v) / v.length
const median = (v: number[]): number => {
  const s = [...v].sort((a, b) => a - b)
  const m = s.length >> 1
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2
}
const pct = (v: number, d = 1): string => (v >= 0 ? '+' : '') + v.toFixed(d) + '%'
const usd = (v: number): string => (v >= 0 ? '+' : '-') + '$' + Math.abs(Math.round(v)).toLocaleString('en-US')

// ---------------------------------------------------------------- the weak claim, stated as weak
const dollars = pairs.map((p) => p.g.finalBalance - p.u.finalBalance)
const net = sum(dollars)
const ranked = [...dollars].sort((a, b) => b - a)
console.log(pairs.length + ' matched symbol-months at ' + INTERVAL + ', ' + SYMBOLS.length + ' symbols\n')
console.log('TOTAL PROFIT -- the claim that looks strong and is not')
console.log('  net effect of the gate      ' + usd(net))
console.log('  median month                ' + usd(median(dollars)))
for (const n of [1, 3, 5, 10]) {
  if (n > ranked.length) break
  console.log('  best ' + String(n).padStart(2) + ' months carry       ' +
    ((sum(ranked.slice(0, n)) / net) * 100).toFixed(0) + '% of it')
}
console.log('  helped ' + dollars.filter((v) => v > 1).length +
  ', hurt ' + dollars.filter((v) => v < -1).length +
  ', unchanged ' + dollars.filter((v) => Math.abs(v) <= 1).length +
  '   <- a coin flip by count')

// -------------------------------------------------- the falsifiable claim, and the one that holds
console.log('\nBY HOW BAD THE MONTH WAS FOR THE UNGATED STRATEGY -- the claim that survives')
const sorted = [...pairs].sort((a, b) => a.u.returnPct - b.u.returnPct)
const size = Math.floor(sorted.length / BUCKETS)
const labels = ['worst fifth', '2nd', 'middle', '4th', 'best fifth']
console.log('  bucket'.padEnd(16) + 'ungated'.padStart(10) + 'gated'.padStart(10) +
  'effect'.padStart(10) + 'helped'.padStart(9) + 'hurt'.padStart(7))
console.log('  ' + '-'.repeat(60))
const effects: number[] = []
for (let i = 0; i < BUCKETS; i++) {
  const slice = sorted.slice(i * size, i === BUCKETS - 1 ? sorted.length : (i + 1) * size)
  const mu = mean(slice.map((p) => p.u.returnPct))
  const mg = mean(slice.map((p) => p.g.returnPct))
  effects.push(mg - mu)
  console.log('  ' + (labels[i] ?? String(i + 1)).padEnd(14) +
    pct(mu).padStart(10) + pct(mg).padStart(10) + pct(mg - mu).padStart(10) +
    String(slice.filter((p) => p.g.returnPct - p.u.returnPct > EPS).length).padStart(9) +
    String(slice.filter((p) => p.g.returnPct - p.u.returnPct < -EPS).length).padStart(7))
}

// Monotone decreasing means: the worse the month was, the more the gate helped -- with no bucket
// breaking the order. A gate that were noise would have no reason to rank this way.
let monotone = true
for (let i = 1; i < effects.length; i++) if (effects[i] > effects[i - 1]) monotone = false
console.log('\n  effect falls monotonically from worst to best bucket: ' + (monotone ? 'YES' : 'NO'))

const half = Math.floor(sorted.length * 0.4)
const bottom = sorted.slice(0, half)
const top = sorted.slice(sorted.length - half)
const votes = (s: Pair[]): string =>
  s.filter((p) => p.g.returnPct - p.u.returnPct > EPS).length + ' helped / ' +
  s.filter((p) => p.g.returnPct - p.u.returnPct < -EPS).length + ' hurt'
console.log('  bottom two fifths: ' + votes(bottom))
console.log('  top two fifths:    ' + votes(top))
console.log('\n  Read as: the gate gives up ' + pct(-effects[BUCKETS - 1]).replace('+', '') +
  ' in the best fifth of months to save ' + pct(effects[0]).replace('+', '') + ' in the worst fifth.')

// ------------------------------------------------------------------------------------------------
// AND THE COMPARISON THAT ACTUALLY DECIDES WHETHER TO RUN THIS AT ALL.
//
// Everything above measures the gate against the strategy it gates, which is the wrong denominator
// for a user choosing what to put a bot on. The relevant question is whether it beats the OTHER
// intraday strategy already shipped -- and it does not, on money. It wins on risk, loses on return,
// and correlates 0.70-0.97 with it, so the two are an either/or rather than a pair.
import { trendRegimeEnsemble } from '../src/backtest/strategies/trendRegimeEnsemble'

const CAPITAL = 10_000
const sd = (v: number[]): number => Math.sqrt(mean(v.map((x) => (x - mean(v)) ** 2)))

interface Row { name: string; mean: number; sd: number; worst: number; dd: number; profit: number }
const table: Row[] = []
for (const def of [trendRegimeEnsemble, shortTermChannel, shortTermChannelRegime]) {
  let rets: number[] = []
  let dds: number[] = []
  const worsts: number[] = []
  let profit = 0
  for (const sym of SYMBOLS) {
    const r = dump[key(sym, def.id)]
    if (!r) continue
    rets = rets.concat(r.map((m) => m.returnPct))
    dds = dds.concat(r.map((m) => m.maxDrawdownPct))
    worsts.push(Math.min(...r.map((m) => m.returnPct)))
    profit += r.reduce((a, m) => a + m.finalBalance - CAPITAL, 0)
  }
  if (rets.length) table.push({ name: def.name, mean: mean(rets), sd: sd(rets), worst: median(worsts), dd: median(dds), profit })
}

console.log('\n\nWHICH TO RUN -- all three strategies, same months, same symbols')
console.log('  ' + 'strategy'.padEnd(34) + 'mean'.padStart(8) + 'sd'.padStart(8) +
  'mean/sd'.padStart(9) + 'worst mo'.padStart(10) + 'med DD'.padStart(9) + 'profit'.padStart(12))
console.log('  ' + '-'.repeat(90))
for (const r of table) {
  console.log('  ' + r.name.padEnd(34) + pct(r.mean, 2).padStart(8) + (r.sd.toFixed(1) + '%').padStart(8) +
    (r.mean / r.sd).toFixed(3).padStart(9) + pct(r.worst).padStart(10) + pct(r.dd).padStart(9) +
    usd(r.profit).padStart(12))
}

/** Pearson correlation of the monthly returns, over months both strategies ran. Two strategies that
 * move together are one position held twice, whatever their names say. */
function correlate(idA: string, idB: string): number[] {
  const out: number[] = []
  for (const sym of SYMBOLS) {
    const a = dump[key(sym, idA)]
    const b = dump[key(sym, idB)]
    if (!a || !b) continue
    const byMonth = new Map(b.map((m) => [m.month, m.returnPct]))
    const xs: number[] = []
    const ys: number[] = []
    for (const m of a) {
      const y = byMonth.get(m.month)
      if (y !== undefined) { xs.push(m.returnPct); ys.push(y) }
    }
    if (xs.length < 3) continue
    const mx = mean(xs)
    const my = mean(ys)
    let num = 0, dx = 0, dy = 0
    for (let i = 0; i < xs.length; i++) { num += (xs[i] - mx) * (ys[i] - my); dx += (xs[i] - mx) ** 2; dy += (ys[i] - my) ** 2 }
    out.push(num / Math.sqrt(dx * dy))
  }
  return out
}
const cors = correlate(trendRegimeEnsemble.id, shortTermChannelRegime.id)
if (cors.length) {
  console.log('\n  monthly-return correlation with ' + trendRegimeEnsemble.name + ': ' +
    Math.min(...cors).toFixed(2) + ' to ' + Math.max(...cors).toFixed(2) +
    ' across ' + cors.length + ' symbols')
  console.log('  -> not a diversifier. Running both is one bet at larger size, not two bets.')
}
