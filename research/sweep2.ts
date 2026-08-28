import { load, run, table, segment, SPLIT_AT, register, type Row } from './harness'
import { bandRegime, donchian } from './families'

console.log('===== does the ATR stop help? (TRAIN, BTCUSDT 15m, MA50d band2%) =====')
const train = segment(load('BTCUSDT', '15m'), 0, SPLIT_AT, 0)
const s: Row[] = []
for (const m of [1.5, 2, 3, 5, 8, 12, 1000]) {
  s.push(run(train, register(bandRegime(4800, 2, m)), m === 1000 ? 'no stop (ATR x1000)' : `ATR x${m}`))
}
table(s)

console.log('\n===== same parameters, other symbols (TRAIN only) =====')
const x: Row[] = []
for (const sym of ['BTCUSDT', 'ETHUSDT', 'SOLUSDT']) {
  const tr = segment(load(sym, '15m'), 0, SPLIT_AT, 0)
  x.push(run(tr, register(bandRegime(4800, 2, 3)), `${sym}  bandRegime MA50d/2%/ATR3`))
  x.push(run(tr, register(donchian(960, 960, 3)), `${sym}  donchian 10d/10d/ATR3`))
}
table(x)
