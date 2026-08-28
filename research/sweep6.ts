import { load, run, table, segment, SPLIT_AT, register, padWarmup, type Row } from './harness'
import { ensembleRegime } from './families'
import type { StrategyDefinition } from '../src/backtest/strategies/types'

const LEAD = 7680
const P = [1920, 2880, 4800, 7680]
const reg = (d: StrategyDefinition): string => register(padWarmup(d, LEAD))

console.log('===== stop sensitivity (TRAIN, BTCUSDT 15m, ensemble 1.0/0.25) =====')
const train = segment(load('BTCUSDT', '15m'), 0, SPLIT_AT, 0)
const s: Row[] = []
for (const m of [3, 5, 8, 10, 15, 25]) s.push(run(train, reg(ensembleRegime(P, 1.0, 0.25, m)), `disaster stop ATR x${m}`))
table(s)

console.log('\n===== same parameters, every symbol (TRAIN only) =====')
const x: Row[] = []
for (const sym of ['BTCUSDT', 'ETHUSDT', 'SOLUSDT']) {
  x.push(run(segment(load(sym, '15m'), 0, SPLIT_AT, 0), reg(ensembleRegime(P, 1.0, 0.25, 10)), `${sym}  ensemble 1.0/0.25/ATR10`))
}
table(x)
