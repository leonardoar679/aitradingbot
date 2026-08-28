import { load, run, table, segment, SPLIT_AT, register, padWarmup, type Row } from './harness'
import { bandRegime, asymRegime, ensembleRegime, donchian } from './families'
import type { StrategyDefinition } from '../src/backtest/strategies/types'

const LEAD = 7680 // 80d -- >= every candidate's true warmup, so all share one window
const P = [1920, 2880, 4800, 7680]
const btc = load('BTCUSDT', '15m')
const train = segment(btc, 0, SPLIT_AT, 0)
const reg = (d: StrategyDefinition): string => register(padWarmup(d, LEAD))

console.log('===== APPLES-TO-APPLES: identical window + benchmark for every candidate (TRAIN) =====')
const r: Row[] = []
r.push(run(train, reg(ensembleRegime(P, 0.75, 0.25, 10)), 'ensemble 20/30/50/80d  .75/.25'))
r.push(run(train, reg(ensembleRegime(P, 1.0, 0.25, 10)), 'ensemble 20/30/50/80d  1.0/.25'))
for (const drop of [0, 1, 2, 3]) {
  r.push(run(train, reg(ensembleRegime(P.filter((_, i) => i !== drop), 0.75, 0.25, 10)), `  without ${(P[drop] / 96).toFixed(0)}d`))
}
r.push(run(train, reg(asymRegime(4800, 1, 8, 10)), 'asym MA50d +1/-8  (8 trades!)'))
r.push(run(train, reg(asymRegime(4800, 1, 4, 10)), 'asym MA50d +1/-4'))
r.push(run(train, reg(asymRegime(2880, 1, 4, 10)), 'asym MA30d +1/-4'))
r.push(run(train, reg(bandRegime(4800, 2, 10)), 'band MA50d 2%'))
r.push(run(train, reg(donchian(960, 960, 10)), 'donchian 10d/10d'))
table(r)
