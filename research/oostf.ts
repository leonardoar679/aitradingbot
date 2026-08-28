import { load, register, padWarmup } from './harness'
import { runBacktest } from '../src/backtest/engine'
import { STRATEGIES } from '../src/backtest/strategies'

const def = STRATEGIES.find((s) => s.id === 'trend-regime-ensemble')!
const BPD: Record<string, number> = { '1h': 24, '4h': 6, '1d': 1 }
const TUNING_OPENED = Date.parse('2023-08-27T00:00:00Z') / 1000

console.log('===== PURE OUT-OF-SAMPLE (2017-2023), EVERY TIMEFRAME =====')
console.log('the parameters were chosen on 15m data; these are timeframes they never saw either\n')
console.log('symbol      tf      net%      b&h%   trades   maxDD%   sharpe')
for (const s of ['BTCUSDT', 'ETHUSDT', 'BNBUSDT']) {
  for (const iv of ['1h', '4h', '1d']) {
    try {
      const all = load(s, iv).filter((c) => c.time < TUNING_OPENED)
      const lead = Math.round(80 * BPD[iv])
      if (all.length < lead + 200 * BPD[iv]) continue
      const r = runBacktest(all, register(padWarmup(def, lead)), { startingBalance: 10_000 })
      const b = r.benchmarkCurve
      const bhPct = ((b[b.length - 1].value - b[0].value) / b[0].value) * 100
      console.log(
        s.padEnd(11) + iv.padEnd(5) + r.stats.totalNetProfitPct.toFixed(1).padStart(9) +
        bhPct.toFixed(1).padStart(11) + String(r.stats.totalClosedTrades).padStart(8) +
        r.stats.maxDrawdownPct.toFixed(1).padStart(9) + r.stats.sharpeRatio.toFixed(2).padStart(9)
      )
    } catch { /* not downloaded */ }
  }
}

console.log('\n===== every strategy in the app, on the pure out-of-sample window =====')
console.log('BTCUSDT 4h, 2017-2023 -- the comparison the Compare Strategies view would show\n')
console.log('strategy                    net%      trades   maxDD%   sharpe')
const all4h = load('BTCUSDT', '4h').filter((c) => c.time < TUNING_OPENED)
for (const st of STRATEGIES) {
  if (st.id.startsWith('x-') || st.id.includes('-pad')) continue
  const r = runBacktest(all4h, register(padWarmup(st, 80 * 6)), { startingBalance: 10_000 })
  console.log(
    st.name.padEnd(26) + r.stats.totalNetProfitPct.toFixed(1).padStart(9) +
    String(r.stats.totalClosedTrades).padStart(9) + r.stats.maxDrawdownPct.toFixed(1).padStart(9) +
    r.stats.sharpeRatio.toFixed(2).padStart(9)
  )
}
