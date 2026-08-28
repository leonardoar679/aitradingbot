import { load, register, padWarmup } from './harness'
import { runBacktest } from '../src/backtest/engine'
import { STRATEGIES } from '../src/backtest/strategies'

const LEAD15 = 80 * 96
const def = STRATEGIES.find((s) => s.id === 'trend-regime-ensemble')!
const id = register(padWarmup(def, LEAD15))

const btc = load('BTCUSDT', '15m')
// forceCloseAtEnd false -> tells us the REAL current position rather than a synthetic close.
const r = runBacktest(btc, id, { startingBalance: 10_000, forceCloseAtEnd: false })

console.log('=== BTCUSDT 15m, month by month (strategy vs buy & hold) ===')
// Buy & hold monthly, from the same benchmark curve the engine builds.
const bh = new Map<string, { first: number; last: number }>()
for (const p of r.benchmarkCurve) {
  const m = new Date(p.time * 1000).toISOString().slice(0, 7)
  const e = bh.get(m)
  if (!e) bh.set(m, { first: p.value, last: p.value })
  else e.last = p.value
}

let wins = 0, losses = 0, flat = 0
console.log('month     trades   strategy%    b&h%   verdict')
console.log('-'.repeat(52))
for (const row of r.monthlyBreakdown) {
  const b = bh.get(row.month)
  const bhPct = b ? ((b.last - b.first) / b.first) * 100 : NaN
  if (row.returnPct > 0.05) wins++
  else if (row.returnPct < -0.05) losses++
  else flat++
  const verdict = Math.abs(row.returnPct) < 0.05 ? 'flat (in cash)' : row.returnPct > 0 ? 'up' : 'down'
  console.log(
    row.month.padEnd(10) +
      String(row.trades).padStart(5) +
      row.returnPct.toFixed(2).padStart(11) +
      (Number.isFinite(bhPct) ? bhPct.toFixed(2) : '-').padStart(9) +
      '   ' + verdict
  )
}
console.log('-'.repeat(52))
console.log(`up ${wins}   down ${losses}   flat/cash ${flat}   total ${r.monthlyBreakdown.length} months`)
console.log(`net ${r.stats.totalNetProfitPct.toFixed(2)}%   losing months ${r.stats.losingMonthsCount}   max consecutive losing ${r.stats.maxConsecutiveLosingMonths}`)

console.log('\n=== WHAT IS IT DOING RIGHT NOW? ===')
console.log(`last candle: ${new Date(btc[btc.length - 1].time * 1000).toISOString()}  close ${btc[btc.length - 1].close}`)
console.log(`open position at end: ${r.openPositionAtEnd ? JSON.stringify(r.openPositionAtEnd) : 'NONE -- sitting in cash'}`)
const last6 = btc[btc.length - 1].close
const ago30 = btc[btc.length - 1 - 30 * 96].close
const ago90 = btc[btc.length - 1 - 90 * 96].close
console.log(`BTC last 30d: ${(((last6 - ago30) / ago30) * 100).toFixed(2)}%   last 90d: ${(((last6 - ago90) / ago90) * 100).toFixed(2)}%`)
