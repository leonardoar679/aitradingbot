import { load, register, padWarmup } from './harness'
import { runBacktest } from '../src/backtest/engine'
import { STRATEGIES } from '../src/backtest/strategies'

const def = STRATEGIES.find((s) => s.id === 'trend-regime-ensemble')!
const D = 86_400
/** Everything before the tuning window opened. The parameters were chosen on 2023-08 -> 2025-08
 * BTC/ETH/SOL 15m; none of this period, and for six of these symbols none of this asset, was
 * looked at while choosing them. This is the closest thing to a genuine out-of-sample test that
 * exists for this strategy, and unlike the held-out year it has never been consulted at all. */
const TUNING_OPENED = Date.parse('2023-08-27T00:00:00Z') / 1000

console.log('===== PURE OUT-OF-SAMPLE: 2017-08 -> 2023-08, before tuning began =====')
console.log('symbol        net%      b&h%   trades   maxDD%   bhDD%   sharpe   years')
const rows: { net: number; bh: number }[] = []
for (const s of ['BTCUSDT', 'ETHUSDT', 'BNBUSDT', 'XRPUSDT', 'ADAUSDT', 'LTCUSDT', 'LINKUSDT', 'DOGEUSDT']) {
  try {
    const all = load(s, '1d').filter((c) => c.time < TUNING_OPENED)
    if (all.length < 500) continue
    const r = runBacktest(all, register(padWarmup(def, 80)), { startingBalance: 10_000 })
    const b = r.benchmarkCurve
    const bhPct = ((b[b.length - 1].value - b[0].value) / b[0].value) * 100
    let peak = -Infinity, bhDd = 0
    for (const p of b) { if (p.value > peak) peak = p.value; const d = ((p.value - peak) / peak) * 100; if (d < bhDd) bhDd = d }
    rows.push({ net: r.stats.totalNetProfitPct, bh: bhPct })
    console.log(
      s.padEnd(11) + r.stats.totalNetProfitPct.toFixed(1).padStart(8) + bhPct.toFixed(1).padStart(11) +
      String(r.stats.totalClosedTrades).padStart(8) + r.stats.maxDrawdownPct.toFixed(1).padStart(9) +
      bhDd.toFixed(1).padStart(9) + r.stats.sharpeRatio.toFixed(2).padStart(9) +
      ((all[all.length - 1].time - all[0].time) / (365.25 * D)).toFixed(1).padStart(8)
    )
  } catch { /* not downloaded */ }
}
const pos = rows.filter((r) => r.net > 0).length
const beat = rows.filter((r) => r.net > r.bh).length
console.log(`\nprofitable on ${pos}/${rows.length}; beat buy & hold on ${beat}/${rows.length}`)
console.log('This period includes the 2018 bear (-84% BTC), the March 2020 crash, the 2021 bull,')
console.log('and the 2022 bear (-64% BTC). None of it informed a single parameter.')
