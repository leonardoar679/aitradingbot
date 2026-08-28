import { runBacktest } from '../src/backtest/engine'
import type { Candle } from '../shared/ipc'
import { load, segment, padWarmup, register } from './harness'
import { shortTermChannel } from '../src/backtest/strategies/shortTermChannel'

/** Month by month over the full three years, on $10,000. The monthly shape matters more than the
 * total: a strategy that makes its year in one month is a different thing to hold than one that
 * grinds, even when the totals match. */

const DAY = 86_400
const FROM = Date.parse('2023-08-27T00:00:00Z') / 1000
const TO = Date.parse('2026-08-27T00:00:00Z') / 1000
const START = 10_000

interface Series {
  key: string
  months: Map<string, number>
  bh: Map<string, number>
  net: number
  finish: number
  trades: number
  fees: number
  maxDd: number
}

const SPECS: Array<[string, string, number]> = [
  ['BTCUSDT', '15m', 900],
  ['BTCUSDT', '1h', 3600],
  ['BTCUSDT', '4h', 14_400],
  ['ETHUSDT', '15m', 900],
  ['ETHUSDT', '4h', 14_400],
  ['SOLUSDT', '15m', 900],
  ['SOLUSDT', '4h', 14_400]
]

/** Buy & hold return for each calendar month, from the engine's own benchmark curve, so the
 * comparison uses the identical window the strategy traded. */
function benchmarkMonths(curve: Array<{ time: number; value: number }>): Map<string, number> {
  const first = new Map<string, number>()
  const last = new Map<string, number>()
  for (const p of curve) {
    const m = new Date(p.time * 1000).toISOString().slice(0, 7)
    if (!first.has(m)) first.set(m, p.value)
    last.set(m, p.value)
  }
  const out = new Map<string, number>()
  for (const [m, a] of first) out.set(m, ((last.get(m) as number) - a) / a * 100)
  return out
}

function maxDrawdown(values: number[]): number {
  let peak = -Infinity
  let worst = 0
  for (const v of values) {
    if (v > peak) peak = v
    const dd = ((v - peak) / peak) * 100
    if (dd < worst) worst = dd
  }
  return worst
}

const series: Series[] = []
for (const [sym, tf, bs] of SPECS) {
  let all: Candle[]
  try { all = load(sym, tf) } catch { continue }
  const lead = Math.round((9 * DAY) / bs) + 2
  const id = register(padWarmup(shortTermChannel, lead))
  const cs = segment(all, FROM, TO, lead)
  if (cs.length < lead * 3) continue
  const r = runBacktest(cs, id, { startingBalance: START, leverage: 1 })
  series.push({
    key: `${sym.replace('USDT', '')} ${tf}`,
    months: new Map(r.monthlyBreakdown.map((m) => [m.month, m.returnPct])),
    bh: benchmarkMonths(r.benchmarkCurve),
    net: r.stats.totalNetProfitPct,
    finish: r.stats.finishingBalance,
    trades: r.stats.totalClosedTrades,
    fees: r.stats.totalPaidFees,
    maxDd: maxDrawdown(r.equityCurve.map((p) => p.value))
  })
}

const allMonths = [...new Set(series.flatMap((s) => [...s.months.keys()]))].sort()

console.log('MONTH-BY-MONTH RETURN %, 3 YEARS, $10,000 START, ALL FEES AND SLIPPAGE CHARGED')
console.log('='.repeat(96))
console.log('month  ' + series.map((s) => s.key.padStart(11)).join(''))
console.log('-'.repeat(96))
let yr = ''
for (const m of allMonths) {
  if (m.slice(0, 4) !== yr) { yr = m.slice(0, 4); console.log('') }
  const cells = series.map((s) => {
    const v = s.months.get(m)
    if (v === undefined) return ''.padStart(11)
    return (v === 0 ? '  ·' : (v > 0 ? '+' : '') + v.toFixed(1)).padStart(11)
  })
  console.log(m + ' ' + cells.join(''))
}

console.log('\n' + '='.repeat(96))
console.log('SUMMARY'.padEnd(14) + series.map((s) => s.key.padStart(11)).join(''))
console.log('-'.repeat(96))
const rowOf = (label: string, f: (s: Series) => string) =>
  console.log(label.padEnd(14) + series.map((s) => f(s).padStart(11)).join(''))

const counts = (s: Series) => {
  let up = 0, down = 0, flat = 0
  for (const v of s.months.values()) { if (v === 0) flat++; else if (v > 0) up++; else down++ }
  return { up, down, flat }
}
rowOf('up months', (s) => String(counts(s).up))
rowOf('down months', (s) => String(counts(s).down))
rowOf('flat (cash)', (s) => String(counts(s).flat))
rowOf('best month', (s) => '+' + Math.max(...s.months.values()).toFixed(1))
rowOf('worst month', (s) => Math.min(...s.months.values()).toFixed(1))
rowOf('worst streak', (s) => {
  let run = 0, worst = 0
  for (const m of allMonths) { const v = s.months.get(m); if (v !== undefined && v < 0) { run++; worst = Math.max(worst, run) } else run = 0 }
  return String(worst) + 'mo'
})
rowOf('max drawdown', (s) => s.maxDd.toFixed(1) + '%')
rowOf('trades', (s) => String(s.trades))
rowOf('fees paid', (s) => '$' + s.fees.toFixed(0))
rowOf('NET 3yr', (s) => (s.net > 0 ? '+' : '') + s.net.toFixed(1) + '%')
rowOf('final $', (s) => '$' + s.finish.toFixed(0))

console.log('\n\n' + '='.repeat(96))
console.log('STRATEGY vs BUY & HOLD, PER MONTH — BTCUSDT 15m')
console.log('='.repeat(96))
{
  const s = series.find((x) => x.key === 'BTC 15m') as Series
  console.log('month      strategy    buy & hold    difference')
  console.log('-'.repeat(52))
  let beat = 0, total = 0
  for (const m of allMonths) {
    const a = s.months.get(m)
    const b = s.bh.get(m)
    if (a === undefined || b === undefined) continue
    total++
    if (a > b) beat++
    console.log(
      m.padEnd(10) +
        ((a > 0 ? '+' : '') + a.toFixed(1) + '%').padStart(10) +
        ((b > 0 ? '+' : '') + b.toFixed(1) + '%').padStart(14) +
        ((a - b > 0 ? '+' : '') + (a - b).toFixed(1)).padStart(14)
    )
  }
  console.log(`\n  beat buy & hold in ${beat} of ${total} months`)
}

console.log('\n\n' + '='.repeat(96))
console.log('CALENDAR YEAR TOTALS (compounded from the monthly returns)')
console.log('='.repeat(96))
console.log('year   ' + series.map((s) => s.key.padStart(11)).join(''))
console.log('-'.repeat(96))
for (const y of ['2023', '2024', '2025', '2026']) {
  const cells = series.map((s) => {
    let mult = 1
    let any = false
    for (const [m, v] of s.months) if (m.startsWith(y)) { mult *= 1 + v / 100; any = true }
    if (!any) return ''.padStart(11)
    const pct = (mult - 1) * 100
    return ((pct > 0 ? '+' : '') + pct.toFixed(1) + '%').padStart(11)
  })
  console.log(y.padEnd(7) + cells.join(''))
}
console.log('\n2023 is four months (Sep-Dec) and 2026 is eight (Jan-Aug); neither is a full year.')
