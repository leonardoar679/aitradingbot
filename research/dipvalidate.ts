import { load, run, table, segment, SPLIT_AT, register, padWarmup, type Row } from './harness'
import { dipReversion } from './dip'
import { runBacktest } from '../src/backtest/engine'

const BPD = 96
const LEAD = 80 * BPD
const cfg = { dipPct: -1, dipBars: 4, holdBars: 192, barsPerDay: BPD, regimeDays: 30 as number | null, atrStop: 1000, takeProfitPct: null }
const id = register(padWarmup(dipReversion(cfg), LEAD))

console.log('===== dip -1%, hold 48h, regime 30d, no working stop =====')
const rows: Row[] = []
for (const sym of ['BTCUSDT', 'ETHUSDT', 'SOLUSDT']) {
  const all = load(sym, '15m')
  rows.push(run(segment(all, 0, SPLIT_AT, 0), id, `TRAIN   ${sym}`))
  rows.push(run(segment(all, SPLIT_AT, Infinity, LEAD), id, `HOLDOUT ${sym}`))
  rows.push(run(all, id, `3 YEARS ${sym}`))
}
table(rows)

console.log('\n===== month by month, BTCUSDT 15m, 3 years =====')
const r = runBacktest(load('BTCUSDT', '15m'), id, { startingBalance: 10_000 })
let up = 0, down = 0, flat = 0
console.log('month     trades   return%')
for (const m of r.monthlyBreakdown) {
  if (Math.abs(m.returnPct) < 0.05) flat++
  else if (m.returnPct > 0) up++
  else down++
  console.log(m.month.padEnd(10) + String(m.trades).padStart(5) + m.returnPct.toFixed(2).padStart(10))
}
console.log(`\nup ${up}  down ${down}  flat ${flat}   NET ${r.stats.totalNetProfitPct.toFixed(2)}%  maxDD ${r.stats.maxDrawdownPct.toFixed(1)}%  worst streak ${r.stats.maxConsecutiveLosingMonths} months`)
