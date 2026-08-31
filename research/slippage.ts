import { load, register, padWarmup } from './harness'
import { runBacktest } from '../src/backtest/engine'
import { ensembleDays } from './families'

/** Re-costs a finished run at a higher per-side trading cost.
 *
 * The engine fills at the signal bar's close with no slippage and no order book, which flatters
 * every strategy -- and flatters a strategy that trades twice as often twice as much. Positions
 * here are all-in and sequential, so each trade's return can simply be reduced by the extra cost
 * on both sides and the sequence recompounded. Approximate (it ignores the tiny effect on
 * position size), and stated as such, but the comparison it supports is the point: which variant
 * degrades faster as reality is added back. */
function recost(returnPcts: number[], extraPerSidePct: number): number {
  let equity = 1
  for (const r of returnPcts) equity *= 1 + (r - 2 * extraPerSidePct) / 100
  return (equity - 1) * 100
}

const SLOW = [20, 30, 50, 80]
const FAST = [10, 15, 25, 40]
const BPS = [0, 2, 5, 10, 20]

console.log('===== how fast does each variant decay as slippage is added back? =====')
console.log('(engine models zero slippage; real market/taker fills are not free)\n')
for (const [sym, iv, bpd] of [['BTCUSDT', '15m', 96], ['ETHUSDT', '15m', 96], ['SOLUSDT', '15m', 96]] as [string, string, number][]) {
  const all = load(sym, iv)
  console.log(`${sym} ${iv}, full 3 years`)
  console.log('variant          trades' + BPS.map((b) => `${b}bps`.padStart(10)).join(''))
  for (const [name, set] of [['20/30/50/80', SLOW], ['10/15/25/40', FAST]] as [string, number[]][]) {
    const lead = Math.max(...set) * bpd
    const id = register(padWarmup(ensembleDays(set, bpd, 1, 0.25, 10), lead))
    const r = runBacktest(all, id, { startingBalance: 10_000 })
    const rets = r.trades.map((t) => t.returnPct)
    console.log(
      name.padEnd(17) + String(rets.length).padStart(4) +
        BPS.map((b) => recost(rets, b / 100).toFixed(1).padStart(10)).join('')
    )
  }
  console.log('')
}
