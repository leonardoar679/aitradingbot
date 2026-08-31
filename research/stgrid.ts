import type { Candle } from '../shared/ipc'
import { load, segment, register, run, table, SPLIT_AT, padWarmup } from './harness'
import { channelEnsemble } from './families'


const SETS: number[][] = [[2, 3, 5, 8], [1, 2, 3, 5], [3, 5, 8, 12], [2, 4, 8]]
const ENTER = [0.9, 0.95, 0.98]
const EXIT = [0.15, 0.25, 0.35]
const TF: Array<[string, number]> = [['15m', 96], ['1h', 24], ['4h', 6]]
const from = Date.parse('2023-08-27T00:00:00Z') / 1000

for (const sym of ['BTCUSDT', 'ETHUSDT', 'SOLUSDT']) {
  for (const [tf, bpd] of TF) {
    let all: Candle[]
    try { all = load(sym, tf) } catch { continue }
    const lead = Math.round(12 * bpd) + 2
    const cs = segment(all, from, SPLIT_AT, lead)
    if (cs.length < lead * 3) continue
    console.log(`\n=== ${sym} ${tf} TRAIN ===`)
    const rows = []
    for (const set of SETS) for (const e of ENTER) for (const x of EXIT) {
      const id = register(padWarmup(channelEnsemble(set, bpd, e, x), lead))
      rows.push(run(cs, id, `[${set.join(',')}] in${e} out${x}`))
    }
    rows.sort((a, b) => b.netPct - a.netPct)
    table(rows)
  }
}
