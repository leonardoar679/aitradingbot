import { load, register, padWarmup, run, table, segment, SPLIT_AT, type Row } from './harness'
import { STRATEGIES } from '../src/backtest/strategies'
import type { StrategyDefinition } from '../src/backtest/strategies/types'

/** Delays every signal by n bars. The engine fills at the close of the bar the signal is on, so
 * shifting the signal forward moves the fill a whole bar later than the information that caused
 * it -- a deliberately pessimistic stand-in for "you cannot trade the close you just saw".
 * Reality sits between n=0 and n=1. */
function delayed(def: StrategyDefinition, n: number): StrategyDefinition {
  return {
    ...def,
    id: `${def.id}-delay${n}`,
    generateSignals(candles) {
      const s = def.generateSignals(candles)
      const shift = <T,>(arr: T[], fill: T): T[] => [...new Array(n).fill(fill), ...arr.slice(0, arr.length - n)]
      return {
        entries: shift(s.entries, false),
        exits: shift(s.exits, false),
        stopPrices: shift(s.stopPrices, null),
        warmupBars: s.warmupBars + n
      }
    }
  }
}

const LEAD = 80 * 96 + 4
const def = STRATEGIES.find((s) => s.id === 'trend-regime-ensemble')!
console.log('===== cost of not being able to trade the close you just saw =====')
console.log('(n = bars between the signal and the fill; the engine ships n=0)\n')
for (const sym of ['BTCUSDT', 'ETHUSDT', 'SOLUSDT']) {
  const all = load(sym, '15m')
  const rows: Row[] = []
  for (const n of [0, 1, 2, 4]) {
    rows.push(run(all, register(padWarmup(delayed(def, n), LEAD)), `${sym} 3y   fill ${n} bars later`))
  }
  rows.push({ label: '', netPct: NaN, bhPct: NaN, trades: 0, winPct: NaN, maxDdPct: NaN, sharpe: NaN, profitFactor: NaN, feesPaid: NaN, bhMaxDdPct: NaN })
  table(rows.filter((r) => r.label !== ''))
  console.log('')
}
console.log('===== same, on the held-out year only =====')
const h: Row[] = []
for (const sym of ['BTCUSDT', 'ETHUSDT', 'SOLUSDT']) {
  const all = load(sym, '15m')
  for (const n of [0, 1]) h.push(run(segment(all, SPLIT_AT, Infinity, LEAD), register(padWarmup(delayed(def, n), LEAD)), `${sym} holdout  delay ${n}`))
}
table(h)
