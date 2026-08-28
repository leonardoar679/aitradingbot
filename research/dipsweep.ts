import { load, run, table, segment, SPLIT_AT, register, padWarmup, type Row } from './harness'
import { dipReversion } from './dip'

const BPD = 96 // 15m
const LEAD = 80 * BPD
const train = segment(load('BTCUSDT', '15m'), 0, SPLIT_AT, 0)
const mk = (o: Parameters<typeof dipReversion>[0]): string => register(padWarmup(dipReversion(o), LEAD))
const base = { dipBars: 4, holdBars: 96, barsPerDay: BPD, atrStop: 3, takeProfitPct: null as number | null }

console.log('===== does the regime filter matter? (TRAIN, BTCUSDT 15m, dip -1%, hold 24h) =====')
console.log('(the era split said the edge nearly vanishes in a bear market, so this is the test of that)')
const r1: Row[] = []
for (const regimeDays of [null, 10, 20, 30, 50, 80]) {
  r1.push(run(train, mk({ ...base, dipPct: -1, regimeDays }), regimeDays === null ? 'no regime filter' : `above ${regimeDays}d MA`))
}
table(r1)

console.log('\n===== dip depth x hold length (TRAIN, regime = above 30d MA) =====')
const r2: Row[] = []
for (const dipPct of [-0.5, -1, -2, -3]) {
  for (const holdBars of [24, 96, 192]) {
    r2.push(run(train, mk({ ...base, dipPct, holdBars, regimeDays: 30 }), `dip ${dipPct}%  hold ${holdBars / 4}h`))
  }
}
table(r2.sort((a, b) => b.netPct - a.netPct))
