import { runBacktest } from '../src/backtest/engine'
import type { Candle } from '../shared/ipc'
import { load, segment, run, table, padWarmup, register, type Row } from './harness'
import { shortTermChannel } from '../src/backtest/strategies/shortTermChannel'
import { trendRegimeEnsemble } from '../src/backtest/strategies/trendRegimeEnsemble'

/** Holds the short-term strategy to the same breadth the slow one was tested at: every symbol
 * with history, every timeframe available, the full 9 years, year by year -- and then the
 * question the era table raised, which is whether the two strategies are complementary enough
 * that running BOTH beats running either. */

const DAY = 86_400
const lead = (bs: number, d: number) => Math.round((d * DAY) / bs) + 2
const SYMS = ['BTCUSDT', 'ETHUSDT', 'BNBUSDT', 'ADAUSDT', 'DOGEUSDT', 'LTCUSDT', 'LINKUSDT', 'XRPUSDT', 'SOLUSDT']

function maxDd(values: number[]): number {
  let peak = -Infinity
  let worst = 0
  for (const v of values) {
    if (v > peak) peak = v
    const dd = ((v - peak) / peak) * 100
    if (dd < worst) worst = dd
  }
  return worst
}

console.log('########## A. EVERY SYMBOL, FULL HISTORY (4h) ##########')
console.log('Six of these nine were never looked at while choosing any parameter.\n')
for (const tf of ['4h', '1d'] as const) {
  const bs = tf === '4h' ? 14_400 : 86_400
  const rows: Row[] = []
  for (const sym of SYMS) {
    let all: Candle[]
    try { all = load(sym, tf) } catch { continue }
    const L = lead(bs, 81)
    if (all.length < L * 4) continue
    const id = register(padWarmup(shortTermChannel, L))
    rows.push(run(all, id, `${sym.replace('USDT', '').padEnd(5)} ${tf}`))
  }
  const wins = rows.filter((r) => r.netPct > 0).length
  const beat = rows.filter((r) => r.netPct > r.bhPct).length
  console.log(`\n--- ${tf}: profitable on ${wins}/${rows.length}, beat buy & hold on ${beat}/${rows.length} ---`)
  table(rows)
}

console.log('\n\n########## B. YEAR BY YEAR, BTCUSDT 4h, 9 years ##########\n')
{
  const all = load('BTCUSDT', '4h')
  const L = lead(14_400, 81)
  const shortId = register(padWarmup(shortTermChannel, L))
  const slowId = register(padWarmup(trendRegimeEnsemble, L))
  const rows: Row[] = []
  for (let y = 2018; y <= 2026; y++) {
    const a = Date.parse(`${y}-01-01T00:00:00Z`) / 1000
    const b = Date.parse(`${y + 1}-01-01T00:00:00Z`) / 1000
    const cs = segment(all, a, b, L)
    if (cs.length < L * 2) continue
    rows.push(run(cs, shortId, `${y} SHORT`))
    rows.push(run(cs, slowId, `${y} slow `))
  }
  table(rows)
}

console.log('\n\n########## C. DO THE TWO STRATEGIES COMPLEMENT EACH OTHER? ##########')
console.log('Two independent sleeves, half the capital each, never rebalanced -- exactly what')
console.log('running two bots at $5,000 apiece does. Not a new strategy, just both of them.\n')
for (const [sym, tf, bs] of [
  ['BTCUSDT', '4h', 14_400],
  ['BTCUSDT', '1h', 3600],
  ['ETHUSDT', '4h', 14_400],
  ['ETHUSDT', '1h', 3600]
] as Array<[string, string, number]>) {
  let all: Candle[]
  try { all = load(sym, tf) } catch { continue }
  const L = lead(bs, 81)
  const shortId = register(padWarmup(shortTermChannel, L))
  const slowId = register(padWarmup(trendRegimeEnsemble, L))
  const cs = segment(all, Date.parse('2017-08-17T00:00:00Z') / 1000, Date.parse('2023-08-27T00:00:00Z') / 1000, L)
  if (cs.length < L * 3) continue

  const a = runBacktest(cs, shortId, { startingBalance: 5_000 })
  const b = runBacktest(cs, slowId, { startingBalance: 5_000 })
  const n = Math.min(a.equityCurve.length, b.equityCurve.length)
  const blend: number[] = []
  for (let i = 0; i < n; i++) blend.push(a.equityCurve[i].value + b.equityCurve[i].value)
  const bh = a.benchmarkCurve.map((p) => p.value)

  const pct = (v: number[]) => ((v[v.length - 1] - v[0]) / v[0]) * 100
  console.log(`--- ${sym} ${tf}, 2017-08 > 2023-08 (true out-of-sample) ---`)
  const line = (label: string, net: number, dd: number, extra = '') =>
    console.log(`   ${label.padEnd(22)} net ${net.toFixed(1).padStart(8)}%   maxDD ${dd.toFixed(1).padStart(6)}%${extra}`)
  line('short-term alone', a.stats.totalNetProfitPct, maxDd(a.equityCurve.map((p) => p.value)), `   ${a.stats.totalClosedTrades} trades`)
  line('slow alone', b.stats.totalNetProfitPct, maxDd(b.equityCurve.map((p) => p.value)), `   ${b.stats.totalClosedTrades} trades`)
  line('BOTH, 50/50', pct(blend), maxDd(blend), `   ${a.stats.totalClosedTrades + b.stats.totalClosedTrades} trades`)
  line('buy & hold', pct(bh), maxDd(bh))
  // Return per unit of drawdown -- the comparison that matters when one option simply risks more.
  const rpd = (net: number, dd: number) => (dd === 0 ? 0 : net / Math.abs(dd))
  console.log(
    `   return/drawdown: short ${rpd(a.stats.totalNetProfitPct, maxDd(a.equityCurve.map((p) => p.value))).toFixed(1)}` +
      `  slow ${rpd(b.stats.totalNetProfitPct, maxDd(b.equityCurve.map((p) => p.value))).toFixed(1)}` +
      `  BOTH ${rpd(pct(blend), maxDd(blend)).toFixed(1)}\n`
  )
}
