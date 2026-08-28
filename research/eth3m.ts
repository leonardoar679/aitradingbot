import { load, run, table, segment, SPLIT_AT, register, padWarmup, type Row } from './harness'
import { STRATEGIES } from '../src/backtest/strategies'

const LEAD = 80 * 480
const def = STRATEGIES.find((s) => s.id === 'trend-regime-ensemble')!
const id = register(padWarmup(def, LEAD))
const all = load('ETHUSDT', '3m')
const rows: Row[] = [
  run(segment(all, 0, SPLIT_AT, 0), id, 'TRAIN   ETH 3m ensemble'),
  run(segment(all, SPLIT_AT, Infinity, LEAD), id, 'HOLDOUT ETH 3m ensemble'),
  run(all, id, '3 YEARS ETH 3m ensemble')
]
console.log('===== ETHUSDT 3m -- data that finished downloading AFTER the design was locked =====')
table(rows)
