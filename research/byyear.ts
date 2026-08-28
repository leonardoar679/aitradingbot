import { load, register, padWarmup } from './harness'
import { runBacktest } from '../src/backtest/engine'
import { STRATEGIES } from '../src/backtest/strategies'

const def = STRATEGIES.find((s) => s.id === 'trend-regime-ensemble')!
const BPD: Record<string, number> = { '15m': 96, '1h': 24, '4h': 6, '1d': 1 }

function yearly(sym: string, iv: string): { year: string; strat: number; bh: number }[] {
  const bpd = BPD[iv]
  const id = register(padWarmup(def, Math.round(80 * bpd)))
  const r = runBacktest(load(sym, iv), id, { startingBalance: 10_000 })
  const eq = new Map<string, { f: number; l: number }>()
  const bh = new Map<string, { f: number; l: number }>()
  const put = (m: Map<string, { f: number; l: number }>, k: string, v: number): void => {
    const e = m.get(k)
    if (!e) m.set(k, { f: v, l: v })
    else e.l = v
  }
  for (const p of r.equityCurve) put(eq, new Date(p.time * 1000).toISOString().slice(0, 4), p.value)
  for (const p of r.benchmarkCurve) put(bh, new Date(p.time * 1000).toISOString().slice(0, 4), p.value)
  return [...eq.entries()].map(([year, e]) => {
    const b = bh.get(year)
    return { year, strat: ((e.l - e.f) / e.f) * 100, bh: b ? ((b.l - b.f) / b.f) * 100 : NaN }
  })
}

console.log('===== BTCUSDT daily, year by year, 2017-2026 =====')
console.log('year   strategy       b&h    verdict')
let wins = 0, total = 0, lossYears: string[] = []
for (const row of yearly('BTCUSDT', '1d')) {
  const better = row.strat > row.bh
  if (row.strat > 0) wins++
  else lossYears.push(row.year)
  total++
  console.log(
    row.year + row.strat.toFixed(1).padStart(11) + '%' + row.bh.toFixed(1).padStart(10) + '%' +
    (better ? '   beat b&h' : '')
  )
}
console.log(`\nprofitable in ${wins}/${total} calendar years; losing years: ${lossYears.join(', ') || 'none'}`)

console.log('\n===== ALL SYMBOLS, daily: how many calendar years are profitable? =====')
console.log('symbol      years  profitable  worst year  best year')
for (const s of ['BTCUSDT', 'ETHUSDT', 'BNBUSDT', 'XRPUSDT', 'ADAUSDT', 'LTCUSDT', 'LINKUSDT', 'DOGEUSDT', 'SOLUSDT']) {
  try {
    const rows = yearly(s, '1d')
    const pos = rows.filter((r) => r.strat > 0).length
    const worst = Math.min(...rows.map((r) => r.strat))
    const best = Math.max(...rows.map((r) => r.strat))
    console.log(
      s.padEnd(12) + String(rows.length).padStart(3) + String(pos).padStart(11) +
      worst.toFixed(1).padStart(12) + '%' + best.toFixed(1).padStart(10) + '%'
    )
  } catch { /* symbol not downloaded */ }
}

console.log('\n===== FAIR TIMEFRAME TEST: identical window (last 3 years), BTCUSDT =====')
console.log('(the earlier table compared 3 years of 15m against 9 years of daily)')
const SINCE = Date.parse('2023-08-27T00:00:00Z') / 1000
for (const iv of ['15m', '1h', '4h', '1d']) {
  try {
    const bpd = BPD[iv]
    const lead = Math.round(80 * bpd)
    const all = load('BTCUSDT', iv)
    const start = all.findIndex((c) => c.time >= SINCE)
    const win = all.slice(Math.max(0, start - lead))
    const r = runBacktest(win, register(padWarmup(def, lead)), { startingBalance: 10_000 })
    const b = r.benchmarkCurve
    const bhPct = ((b[b.length - 1].value - b[0].value) / b[0].value) * 100
    console.log(
      `${iv.padEnd(5)} net ${r.stats.totalNetProfitPct.toFixed(1).padStart(7)}%   b&h ${bhPct.toFixed(1).padStart(7)}%   trades ${String(r.stats.totalClosedTrades).padStart(3)}   maxDD ${r.stats.maxDrawdownPct.toFixed(1)}%   sharpe ${r.stats.sharpeRatio.toFixed(2)}`
    )
  } catch { /* not downloaded */ }
}
