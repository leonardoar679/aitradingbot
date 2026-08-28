import { load, register, padWarmup } from './harness'
import { runBacktest } from '../src/backtest/engine'
import { STRATEGIES } from '../src/backtest/strategies'

const def = STRATEGIES.find((s) => s.id === 'trend-regime-ensemble')!
const BPD: Record<string, number> = { '3m': 480, '15m': 96, '1h': 24, '4h': 6, '1d': 1 }
const D = 86_400

/** Slices so the TRADEABLE window (after the 80-day warmup) starts at `tradeFrom` on every
 * timeframe. Comparing timeframes without this compares different date ranges: the 15m history
 * only reaches back to 2023-08-27, so its first tradeable bar is 80 days later than a daily run
 * sliced from the same date, and BTC moved a long way in those 80 days. */
function fair(sym: string, iv: string, tradeFrom: number, leverage = 1): string | null {
  const bpd = BPD[iv]
  const lead = Math.round(80 * bpd)
  let all
  try { all = load(sym, iv) } catch { return null }
  const startIdx = all.findIndex((c) => c.time >= tradeFrom - 80 * D)
  if (startIdx < 0) return null
  const win = all.slice(startIdx)
  if (win.length < lead + 50 * bpd) return null
  const r = runBacktest(win, register(padWarmup(def, lead)), { startingBalance: 10_000, leverage })
  const b = r.benchmarkCurve
  const bhPct = ((b[b.length - 1].value - b[0].value) / b[0].value) * 100
  return `${iv.padEnd(5)} net ${r.stats.totalNetProfitPct.toFixed(1).padStart(8)}%   b&h ${bhPct.toFixed(1).padStart(7)}%   trades ${String(r.stats.totalClosedTrades).padStart(3)}   maxDD ${r.stats.maxDrawdownPct.toFixed(1).padStart(6)}%   sharpe ${r.stats.sharpeRatio.toFixed(2)}`
}

// 2023-11-15 is the first bar the 15m history can trade, so it is the only start every
// timeframe can share.
const COMMON = Date.parse('2023-11-15T00:00:00Z') / 1000
console.log('===== TIMEFRAME, identical tradeable window (2023-11-15 -> 2026-08-27), BTCUSDT =====')
for (const iv of ['3m', '15m', '1h', '4h', '1d']) {
  const line = fair('BTCUSDT', iv, COMMON)
  if (line) console.log(line)
}

console.log('\n===== LEVERAGE: where does more stop helping and start killing? =====')
console.log('BTCUSDT daily, full ~9 years (the longest history available)\n')
console.log('lev      net%      maxDD%   trades  liquidated?')
const all1d = load('BTCUSDT', '1d')
for (const lev of [1, 1.5, 2, 3, 5, 10]) {
  const r = runBacktest(all1d, register(padWarmup(def, 80)), { startingBalance: 10_000, leverage: lev })
  const liq = r.trades.filter((t) => t.exitReason === 'liquidation').length
  console.log(
    `${String(lev).padEnd(6)}${r.stats.totalNetProfitPct.toFixed(1).padStart(10)}${r.stats.maxDrawdownPct.toFixed(1).padStart(11)}` +
    String(r.stats.totalClosedTrades).padStart(9) + (liq > 0 ? `   YES (${liq})` : '   no')
  )
}
console.log('\nsame, on the most recent 3 years only:')
console.log('lev      net%      maxDD%   trades  liquidated?')
const s3 = all1d.findIndex((c) => c.time >= Date.parse('2023-08-27T00:00:00Z') / 1000 - 80 * D)
for (const lev of [1, 1.5, 2, 3, 5, 10]) {
  const r = runBacktest(all1d.slice(s3), register(padWarmup(def, 80)), { startingBalance: 10_000, leverage: lev })
  const liq = r.trades.filter((t) => t.exitReason === 'liquidation').length
  console.log(
    `${String(lev).padEnd(6)}${r.stats.totalNetProfitPct.toFixed(1).padStart(10)}${r.stats.maxDrawdownPct.toFixed(1).padStart(11)}` +
    String(r.stats.totalClosedTrades).padStart(9) + (liq > 0 ? `   YES (${liq})` : '   no')
  )
}
