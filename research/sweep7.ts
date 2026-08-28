import { load, run, table, segment, SPLIT_AT, register, padWarmup, type Row } from './harness'
import { ensembleDays } from './families'

const LEAD = 80 * 96
const SETS: number[][] = [
  [20, 30, 50, 80], // shipped
  [15, 25, 40, 60],
  [10, 20, 35, 50],
  [10, 20, 30, 45],
  [20, 30, 40, 50], // squarely inside the measured band
  [10, 15, 25, 40]
]
console.log('===== lookback set, TRAIN ONLY, all three symbols =====')
console.log('(the probe put the trend edge at 20-50d; the shipped set straddles past it)\n')
for (const sym of ['BTCUSDT', 'ETHUSDT', 'SOLUSDT']) {
  const train = segment(load(sym, '15m'), 0, SPLIT_AT, 0)
  const rows: Row[] = []
  for (const set of SETS) {
    rows.push(run(train, register(padWarmup(ensembleDays(set, 96, 1, 0.25, 10), LEAD)), `${sym}  ${set.join('/')}d`))
  }
  table(rows)
  console.log('')
}
