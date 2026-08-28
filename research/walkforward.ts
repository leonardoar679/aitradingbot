import { load, run, register, padWarmup, segment, SPLIT_AT, table, type Row } from './harness'
import { ensembleDays } from './families'

const LEAD = 80 * 96
const A = [20, 30, 50, 80]
const B = [10, 15, 25, 40]
const mk = (set: number[]): string => register(padWarmup(ensembleDays(set, 96, 1, 0.25, 10), LEAD))

/** Rolling 6-month windows INSIDE the training period. Each is scored with 80 days of lead
 * before it, so both candidates trade the identical window. This spends no holdout. */
console.log('===== walk-forward inside TRAIN: six-month windows, all three symbols =====')
const D = 86_400
const starts: number[] = []
for (let t = Date.parse('2023-12-01T00:00:00Z') / 1000; t < SPLIT_AT - 180 * D; t += 182 * D) starts.push(t)

let winsA = 0, winsB = 0
for (const sym of ['BTCUSDT', 'ETHUSDT', 'SOLUSDT']) {
  const all = load(sym, '15m')
  console.log(`\n${sym}`)
  console.log('window start   20/30/50/80d   10/15/25/40d   better')
  for (const s of starts) {
    const win = segment(all, s, s + 182 * D, LEAD)
    const ra = run(win, mk(A), 'a')
    const rb = run(win, mk(B), 'b')
    if (ra.netPct > rb.netPct) winsA++
    else if (rb.netPct > ra.netPct) winsB++
    console.log(
      new Date(s * 1000).toISOString().slice(0, 10).padEnd(15) +
        ra.netPct.toFixed(2).padStart(10) + '%' +
        rb.netPct.toFixed(2).padStart(14) + '%   ' +
        (rb.netPct > ra.netPct ? 'faster set' : ra.netPct > rb.netPct ? 'shipped set' : 'tie')
    )
  }
}
console.log(`\nsub-window wins: shipped ${winsA}   faster ${winsB}`)

console.log('\n===== leave-one-out on the faster set (TRAIN, BTCUSDT) =====')
const train = segment(load('BTCUSDT', '15m'), 0, SPLIT_AT, 0)
const loo: Row[] = [run(train, mk(B), 'all four 10/15/25/40')]
for (let i = 0; i < B.length; i++) loo.push(run(train, mk(B.filter((_, j) => j !== i)), `  without ${B[i]}d`))
table(loo)
