import { load, run, table, segment, SPLIT_AT, register, padWarmup, type Row } from './harness'
import { dipReversion } from './dip'

const BPD = 96
const LEAD = 80 * BPD
const train = segment(load('BTCUSDT', '15m'), 0, SPLIT_AT, 0)
const mk = (o: Parameters<typeof dipReversion>[0]): string => register(padWarmup(dipReversion(o), LEAD))
const base = { dipBars: 4, holdBars: 96, barsPerDay: BPD, regimeDays: 30 as number | null, takeProfitPct: null as number | null }

console.log('===== is the STOP what destroys the measured edge? (TRAIN, dip -1%, hold 24h) =====')
console.log('(the probe measured a pure 24h hold with no stop at all -- this reproduces that)')
const r: Row[] = []
for (const atrStop of [1.5, 3, 6, 12, 1000]) {
  r.push(run(train, mk({ ...base, dipPct: -1, atrStop }), atrStop === 1000 ? 'no stop (matches the probe)' : `ATR x${atrStop}`))
}
table(r)

console.log('\n===== no stop, across dip depth and hold (TRAIN) =====')
const r2: Row[] = []
for (const dipPct of [-1, -2, -3]) {
  for (const holdBars of [96, 192, 384]) {
    r2.push(run(train, mk({ ...base, dipPct, holdBars, atrStop: 1000 }), `dip ${dipPct}%  hold ${holdBars / 4}h  no stop`))
  }
}
table(r2.sort((a, b) => b.netPct - a.netPct))
