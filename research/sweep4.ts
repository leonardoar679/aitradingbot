import { load, run, table, segment, SPLIT_AT, register, type Row } from './harness'
import { ensembleRegime } from './families'

const P = [1920, 2880, 4800, 7680] // 20d, 30d, 50d, 80d
const train = segment(load('BTCUSDT', '15m'), 0, SPLIT_AT, 0)
console.log('===== FAMILY D: ensemble regime, votes across 20/30/50/80d (TRAIN, BTCUSDT 15m) =====')
const r: Row[] = []
for (const e of [0.5, 0.75, 1.0]) for (const x of [0, 0.25, 0.5]) {
  if (x >= e) continue
  r.push(run(train, register(ensembleRegime(P, e, x, 10)), `enter>=${e}  exit<=${x}`))
}
table(r.sort((a, b) => b.netPct - a.netPct))

console.log('\n===== is the ensemble less parameter-sensitive than one MA? (TRAIN) =====')
console.log('dropping each lookback in turn -- a robust signal should barely notice:')
const d: Row[] = []
for (const drop of [-1, 0, 1, 2, 3]) {
  const set = drop < 0 ? P : P.filter((_, i) => i !== drop)
  d.push(run(train, register(ensembleRegime(set, 0.75, 0.25, 10)), drop < 0 ? 'all four' : `without ${(P[drop] / 96).toFixed(0)}d`))
}
table(d)
