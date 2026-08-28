import { load, register, padWarmup } from './harness'
import { dipReversion } from './dip'
import { runBacktest } from '../src/backtest/engine'
import { FEE_RATE, SLIPPAGE_RATE } from '../shared/fees'

const BPD = 96
const LEAD = 80 * BPD
const id = register(padWarmup(dipReversion({ dipPct: -1, dipBars: 4, holdBars: 192, barsPerDay: BPD, regimeDays: 30, atrStop: 1000, takeProfitPct: null }), LEAD))

/** Re-costs a finished run at a different per-side fee. Positions are all-in and sequential, so
 * each trade's return simply moves by the change in round-trip cost and the sequence recompounds. */
function recost(returnPcts: number[], newFeePerSide: number): number {
  const delta = (FEE_RATE - newFeePerSide) * 2 * 100 // positive = saving, added back per trade
  let eq = 1
  for (const r of returnPcts) eq *= 1 + (r + delta) / 100
  return (eq - 1) * 100
}

console.log('===== what fee would this strategy need to be worth running? =====')
console.log(`(slippage stays at ${(SLIPPAGE_RATE * 200).toFixed(2)}% round trip throughout)\n`)
console.log('symbol     trades   at 0.10%/side   0.075%   0.04% (BNB)   0.02% (maker)   0.00%    buy & hold')
for (const sym of ['BTCUSDT', 'ETHUSDT', 'SOLUSDT']) {
  const all = load(sym, '15m')
  const r = runBacktest(all, id, { startingBalance: 10_000 })
  const rets = r.trades.map((t) => t.returnPct)
  const bh = r.benchmarkCurve
  const bhPct = ((bh[bh.length - 1].value - bh[0].value) / bh[0].value) * 100
  console.log(
    sym.padEnd(11) + String(rets.length).padStart(6) +
      [0.001, 0.00075, 0.0004, 0.0002, 0].map((f) => recost(rets, f).toFixed(1).padStart(14)).join('') +
      bhPct.toFixed(1).padStart(14)
  )
}

console.log('\n===== and the concentration check on the shipped-fee result (BTCUSDT) =====')
const r = runBacktest(load('BTCUSDT', '15m'), id, { startingBalance: 10_000 })
const months = [...r.monthlyBreakdown].sort((a, b) => b.netProfit - a.netProfit)
const best = months[0]
console.log(`net over 3 years: ${r.stats.totalNetProfitPct.toFixed(2)}%`)
console.log(`best single month: ${best.month} contributing ${best.netProfit.toFixed(0)} of ${r.stats.totalNetProfit.toFixed(0)} total profit`)
console.log(`top 3 months' share of all profitable months: ${r.stats.topThreeMonthsProfitSharePct.toFixed(0)}%`)
