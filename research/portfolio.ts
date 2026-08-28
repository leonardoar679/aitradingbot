import { load, register, padWarmup } from './harness'
import { runBacktest } from '../src/backtest/engine'
import { STRATEGIES } from '../src/backtest/strategies'

const def = STRATEGIES.find((s) => s.id === 'trend-regime-ensemble')!

/** Equal-weight, daily-rebalanced blend of the SAME strategy run on several symbols.
 *
 * The engine is single-symbol and all-in, which is the real constraint on this strategy: one
 * asset, one position, every dollar in it. Splitting the same capital across N symbols cannot
 * raise the expected return -- it is the same rule earning the same edge -- but it does not have
 * to. Drawdowns that do not land on the same day partially cancel, and the drawdown is what
 * decides whether a strategy is actually holdable. */
function blend(symbols: string[], leverage = 1): { cagr: number; total: number; maxDd: number; years: number } | null {
  const curves: Map<number, number>[] = []
  for (const s of symbols) {
    try {
      const r = runBacktest(load(s, '1d'), register(padWarmup(def, 80)), { startingBalance: 10_000, leverage })
      const m = new Map<number, number>()
      for (const p of r.equityCurve) m.set(p.time, p.value)
      curves.push(m)
    } catch { return null }
  }
  // Only days every member can price, so no symbol is silently carried at a stale value.
  const common = [...curves[0].keys()].filter((t) => curves.every((c) => c.has(t))).sort((a, b) => a - b)
  if (common.length < 400) return null

  let equity = 1
  let peak = 1
  let maxDd = 0
  for (let i = 1; i < common.length; i++) {
    let dayReturn = 0
    for (const c of curves) {
      const prev = c.get(common[i - 1]) as number
      const now = c.get(common[i]) as number
      dayReturn += prev > 0 ? (now - prev) / prev / curves.length : 0
    }
    equity *= 1 + dayReturn
    if (equity > peak) peak = equity
    const dd = ((equity - peak) / peak) * 100
    if (dd < maxDd) maxDd = dd
  }
  const years = (common[common.length - 1] - common[0]) / (365.25 * 86_400)
  return { cagr: (Math.pow(equity, 1 / years) - 1) * 100, total: (equity - 1) * 100, maxDd, years }
}

function line(label: string, r: ReturnType<typeof blend>): void {
  if (!r) return console.log(`${label.padEnd(34)}  (not enough overlapping history)`)
  console.log(
    label.padEnd(34) + r.cagr.toFixed(1).padStart(8) + '%' + r.total.toFixed(0).padStart(11) + '%' +
    r.maxDd.toFixed(1).padStart(10) + '%' + r.years.toFixed(1).padStart(8) + 'y' +
    (r.cagr / Math.abs(r.maxDd)).toFixed(2).padStart(9)
  )
}

console.log('===== ONE SYMBOL vs A BLEND, same strategy, same money, daily =====')
console.log('                                      CAGR      total     maxDD   span   CAGR/DD')
for (const s of ['BTCUSDT', 'ETHUSDT', 'BNBUSDT', 'XRPUSDT', 'LTCUSDT']) line(`single: ${s}`, blend([s]))
console.log('')
line('blend: BTC+ETH', blend(['BTCUSDT', 'ETHUSDT']))
line('blend: BTC+ETH+BNB', blend(['BTCUSDT', 'ETHUSDT', 'BNBUSDT']))
line('blend: 5 majors', blend(['BTCUSDT', 'ETHUSDT', 'BNBUSDT', 'LTCUSDT', 'XRPUSDT']))
line('blend: all 8', blend(['BTCUSDT', 'ETHUSDT', 'BNBUSDT', 'XRPUSDT', 'ADAUSDT', 'LTCUSDT', 'LINKUSDT', 'DOGEUSDT']))

console.log('\n===== does the lower drawdown buy back safe leverage? =====')
console.log('                                      CAGR      total     maxDD   span   CAGR/DD')
for (const lev of [1, 1.5, 2, 3]) line(`blend BTC+ETH+BNB at ${lev}x`, blend(['BTCUSDT', 'ETHUSDT', 'BNBUSDT'], lev))
