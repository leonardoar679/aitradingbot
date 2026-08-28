import { runBacktest } from '../src/backtest/engine'
import type { Candle } from '../shared/ipc'
import type { StrategyDefinition } from '../src/backtest/strategies/types'
import { load, segment, padWarmup, register } from './harness'
import { shortTermChannel } from '../src/backtest/strategies/shortTermChannel'
import { trendRegimeEnsemble } from '../src/backtest/strategies/trendRegimeEnsemble'

/** Does spreading one strategy over several symbols fix the concentration problem?
 *
 * The stress test found that both strategies deliver essentially all of their profit through a
 * handful of trades -- removing the top 5 winners leaves almost nothing, and on SOL removing 3
 * turns +9161% into -77%. Drawdown diversification was already measured and barely helps, because
 * crypto falls together. CONCENTRATION is a different risk from drawdown, though, and it is the
 * one more independent trades should actually address.
 *
 * SURVIVORSHIP. Picking the symbols that went up would answer a question nobody can act on. The
 * set here is every major with history in the data, each one entering the portfolio when it starts
 * trading rather than from the beginning, so no sleeve is chosen for what it later did. LTC and
 * XRP are in it, and both are strategies' worst symbols.
 *
 * The engine holds one position at a time, so this composes it rather than changing it: N sleeves
 * of capital/N, each running the same strategy on its own symbol, never rebalanced -- exactly what
 * running N bots with equal money does. */

const DAY = 86_400
const TOTAL = 10_000
const SYMS = ['BTCUSDT', 'ETHUSDT', 'BNBUSDT', 'ADAUSDT', 'DOGEUSDT', 'LTCUSDT', 'LINKUSDT', 'XRPUSDT', 'SOLUSDT']
const lead = (bs: number, d: number) => Math.round((d * DAY) / bs) + 2

function maxDd(values: number[]): number {
  let peak = -Infinity
  let worst = 0
  for (const v of values) {
    if (v > peak) peak = v
    const dd = ((v - peak) / peak) * 100
    if (dd < worst) worst = dd
  }
  return worst
}

interface Sleeve {
  symbol: string
  curve: Array<{ time: number; value: number }>
  pnls: number[]
  net: number
}

/** Sums the sleeves onto one clock. A symbol that has not listed yet contributes its untouched
 * allocation rather than nothing, or the portfolio would appear to grow simply because more money
 * arrived later. */
function combine(sleeves: Sleeve[], perSleeve: number): number[] {
  const times = [...new Set(sleeves.flatMap((s) => s.curve.map((p) => p.time)))].sort((a, b) => a - b)
  const cursors = sleeves.map(() => 0)
  const held = sleeves.map(() => perSleeve)
  const out: number[] = []
  for (const t of times) {
    let total = 0
    for (let i = 0; i < sleeves.length; i++) {
      const c = sleeves[i].curve
      while (cursors[i] < c.length && c[cursors[i]].time <= t) {
        held[i] = c[cursors[i]].value
        cursors[i]++
      }
      total += held[i]
    }
    out.push(total)
  }
  return out
}

/** Share of all gross profit contributed by the best N trades.
 *
 * NOT the compounded "remove the top N and re-multiply" figure used for a single symbol. That one
 * is only valid when trades happen in sequence, each compounding on the last. Across a portfolio
 * the sleeves run in PARALLEL, so multiplying every trade's return together treats simultaneous
 * trades as consecutive and produces numbers in the trillions -- which is what the first version
 * of this file printed. Dollar contribution has no such assumption and is comparable across any
 * number of sleeves. */
function concentration(pnls: number[]): string {
  const winners = pnls.filter((v) => v > 0).sort((a, b) => b - a)
  const gross = winners.reduce((a, b) => a + b, 0)
  if (gross <= 0) return [1, 3, 5, 10].map(() => '-'.padStart(9)).join('')
  return [1, 3, 5, 10]
    .map((k) => `${((winners.slice(0, k).reduce((a, b) => a + b, 0) / gross) * 100).toFixed(0)}%`.padStart(9))
    .join('')
}

function evaluate(
  label: string,
  def: StrategyDefinition,
  symbols: string[],
  tf: string,
  bs: number,
  from: number,
  to: number
): void {
  const L = lead(bs, 81)
  const id = register(padWarmup(def, L))
  const perSleeve = TOTAL / symbols.length
  const sleeves: Sleeve[] = []
  for (const sym of symbols) {
    let all: Candle[]
    try { all = load(sym, tf) } catch { continue }
    const cs = segment(all, from, to, L)
    if (cs.length < L * 3) continue
    const r = runBacktest(cs, id, { startingBalance: perSleeve })
    sleeves.push({
      symbol: sym,
      curve: r.equityCurve,
      pnls: r.trades.map((t) => t.pnl),
      net: r.stats.totalNetProfitPct
    })
  }
  if (!sleeves.length) return
  const curve = combine(sleeves, perSleeve)
  const net = ((curve[curve.length - 1] - curve[0]) / curve[0]) * 100
  const allPnls = sleeves.flatMap((s) => s.pnls)
  console.log(
    label.padEnd(30) +
      `${net.toFixed(0)}%`.padStart(10) +
      `${maxDd(curve).toFixed(1)}%`.padStart(10) +
      String(allPnls.length).padStart(8) +
      '   ' + concentration(allPnls)
  )
}

const header = (): void => {
  console.log(
    'configuration'.padEnd(30) + 'net'.padStart(10) + 'maxDD'.padStart(10) + 'trades'.padStart(8) +
      '   ' + ['top1', 'top3', 'top5', 'top10'].map((s) => s.padStart(9)).join('')
  )
  console.log('share of all gross profit from the best N trades'.padStart(105))
  console.log('-'.repeat(105))
}

const WINDOWS: Array<[string, number, number]> = [
  ['TRUE OOS 2017-08 > 2023-08', Date.parse('2017-08-17T00:00:00Z') / 1000, Date.parse('2023-08-27T00:00:00Z') / 1000],
  ['FULL HISTORY 2017 > 2026', Date.parse('2017-08-17T00:00:00Z') / 1000, Date.parse('2026-08-27T00:00:00Z') / 1000],
  ['HELD-OUT 2025-08 > 2026-08', Date.parse('2025-08-27T00:00:00Z') / 1000, Date.parse('2026-08-27T00:00:00Z') / 1000]
]

for (const [wl, from, to] of WINDOWS) {
  console.log(`\n\n########## ${wl}, 4h ##########\n`)
  header()
  for (const [name, def] of [['slow', trendRegimeEnsemble], ['fast', shortTermChannel]] as Array<[string, StrategyDefinition]>) {
    evaluate(`${name}  BTC only`, def, ['BTCUSDT'], '4h', 14_400, from, to)
    evaluate(`${name}  BTC+ETH+BNB`, def, ['BTCUSDT', 'ETHUSDT', 'BNBUSDT'], '4h', 14_400, from, to)
    evaluate(`${name}  all ${SYMS.length} majors`, def, SYMS, '4h', 14_400, from, to)
  }
}

console.log('\n\nPer-sleeve detail, all 9 majors, full history 4h, slow strategy:\n')
{
  const L = lead(14_400, 81)
  const id = register(padWarmup(trendRegimeEnsemble, L))
  const from = Date.parse('2017-08-17T00:00:00Z') / 1000
  const to = Date.parse('2026-08-27T00:00:00Z') / 1000
  const per = TOTAL / SYMS.length
  console.log('symbol'.padEnd(10) + 'net'.padStart(10) + 'contribution'.padStart(16) + 'trades'.padStart(9))
  console.log('-'.repeat(46))
  let sum = 0
  const rows: Array<[string, number, number, number]> = []
  for (const sym of SYMS) {
    let all: Candle[]
    try { all = load(sym, '4h') } catch { continue }
    const cs = segment(all, from, to, L)
    if (cs.length < L * 3) continue
    const r = runBacktest(cs, id, { startingBalance: per })
    const final = r.stats.finishingBalance
    sum += final
    rows.push([sym, r.stats.totalNetProfitPct, final, r.stats.totalClosedTrades])
  }
  for (const [sym, net, final, trades] of rows) {
    console.log(
      sym.replace('USDT', '').padEnd(10) +
        `${net.toFixed(0)}%`.padStart(10) +
        `$${final.toFixed(0)} (${((final / sum) * 100).toFixed(1)}%)`.padStart(16) +
        String(trades).padStart(9)
    )
  }
  console.log('-'.repeat(46))
  console.log('total'.padEnd(10) + `${(((sum - TOTAL) / TOTAL) * 100).toFixed(0)}%`.padStart(10) + `$${sum.toFixed(0)}`.padStart(16))
}
