import { load, run, table, segment, SPLIT_AT, register, type Row } from './harness'
import { bandRegime, donchian } from './families'

const btc = load('BTCUSDT', '15m')
const train = segment(btc, 0, SPLIT_AT, 0)

console.log('===== FAMILY A: band regime (TRAIN ONLY, BTCUSDT 15m) =====')
const a: Row[] = []
for (const p of [1920, 2880, 4800, 7680]) for (const band of [0, 1, 2, 4]) {
  a.push(run(train, register(bandRegime(p, band, 3)), `MA${(p / 96).toFixed(0)}d band${band}%`))
}
table(a.sort((x, y) => y.netPct - x.netPct))

console.log('\n===== FAMILY B: donchian breakout (TRAIN ONLY, BTCUSDT 15m) =====')
const b: Row[] = []
for (const e of [480, 960, 1920, 3840]) for (const x of [240, 480, 960]) {
  b.push(run(train, register(donchian(e, x, 3)), `enter${(e / 96).toFixed(0)}d exit${(x / 96).toFixed(0)}d`))
}
table(b.sort((x, y) => y.netPct - x.netPct))
console.log(`\nreference: buy & hold on this window = ${a[0].bhPct.toFixed(2)}%`)
