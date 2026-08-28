import { load, run, table, segment, SPLIT_AT, register, type Row } from './harness'
import { asymRegime } from './families'

const train = segment(load('BTCUSDT', '15m'), 0, SPLIT_AT, 0)
console.log('===== asymmetric band, MA50d, wide stop (TRAIN, BTCUSDT 15m) =====')
const r: Row[] = []
for (const e of [1, 2, 3]) for (const x of [2, 4, 6, 8]) {
  r.push(run(train, register(asymRegime(4800, e, x, 10)), `enter +${e}%  exit -${x}%`))
}
table(r.sort((a, b) => b.netPct - a.netPct))

console.log('\n===== plateau check: MA period x exit band, enter +2%, stop ATR10 =====')
const p: Row[] = []
for (const per of [2880, 3840, 4800, 5760, 7680]) for (const x of [4, 6]) {
  p.push(run(train, register(asymRegime(per, 2, x, 10)), `MA${(per / 96).toFixed(0)}d exit-${x}%`))
}
table(p.sort((a, b) => b.netPct - a.netPct))
