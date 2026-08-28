import type { Candle } from '../shared/ipc'
import { load, segment, run, table, SPLIT_AT, padWarmup, register, type Row } from './harness'
import { shortTermChannel } from '../src/backtest/strategies/shortTermChannel'
import { trendRegimeEnsemble } from '../src/backtest/strategies/trendRegimeEnsemble'

/** Final scoring for Short-Term Channel Breakout. The holdout is read HERE, once, after the
 * strategy file was written -- not during the sweep that chose the parameters. */

const DAY = 86_400
const TF: Array<[string, number]> = [['15m', 900], ['1h', 3600], ['4h', 14400]]
const SYMS = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT']
const TRAIN_FROM = Date.parse('2023-08-27T00:00:00Z') / 1000
const END = Date.parse('2026-08-27T00:00:00Z') / 1000

function leadFor(barSeconds: number, days: number): number {
  return Math.round((days * DAY) / barSeconds) + 2
}

console.log('\n########## 1. TRAIN vs HELD-OUT YEAR vs FULL 3 YEARS (own warmup, 9 days) ##########')
for (const sym of SYMS) {
  const rows: Row[] = []
  for (const [tf, bs] of TF) {
    let all: Candle[]
    try { all = load(sym, tf) } catch { continue }
    const lead = leadFor(bs, 9)
    const id = register(padWarmup(shortTermChannel, lead))
    const windows: Array<[string, number, number]> = [
      ['train  2023-08>2025-08', TRAIN_FROM, SPLIT_AT],
      ['HOLDOUT 2025-08>2026-08', SPLIT_AT, END],
      ['full   2023-08>2026-08', TRAIN_FROM, END]
    ]
    for (const [label, from, to] of windows) {
      const cs = segment(all, from, to, lead)
      if (cs.length < lead * 3) continue
      rows.push(run(cs, id, `${tf.padEnd(4)} ${label}`))
    }
  }
  if (rows.length) { console.log(`\n--- ${sym} ---`); table(rows) }
}

console.log('\n\n########## 2. TRUE OUT-OF-SAMPLE 2017-2023 (data no tuning ever saw) ##########')
console.log('The 15m files start in 2023-08, so every parameter choice was made after that date.')
console.log('1h and 4h go back to 2017, so this window is untouched by the sweep.\n')
for (const sym of ['BTCUSDT', 'ETHUSDT']) {
  const rows: Row[] = []
  for (const [tf, bs] of [['1h', 3600], ['4h', 14400]] as Array<[string, number]>) {
    let all: Candle[]
    try { all = load(sym, tf) } catch { continue }
    const lead = leadFor(bs, 9)
    const id = register(padWarmup(shortTermChannel, lead))
    const eras: Array<[string, string, string]> = [
      ['2017-08>2019-01 (bear)', '2017-08-17', '2019-01-01'],
      ['2019-01>2020-03 (chop)', '2019-01-01', '2020-03-01'],
      ['2020-03>2021-12 (bull)', '2020-03-01', '2021-12-01'],
      ['2021-12>2023-08 (bear)', '2021-12-01', '2023-08-27'],
      ['2017-08>2023-08 (ALL)  ', '2017-08-17', '2023-08-27']
    ]
    for (const [label, a, b] of eras) {
      const cs = segment(all, Date.parse(a + 'T00:00:00Z') / 1000, Date.parse(b + 'T00:00:00Z') / 1000, lead)
      if (cs.length < lead * 3) continue
      rows.push(run(cs, id, `${tf.padEnd(4)} ${label}`))
    }
  }
  if (rows.length) { console.log(`\n--- ${sym} ---`); table(rows) }
}

console.log('\n\n########## 3. HEAD TO HEAD vs the shipped slow strategy (same window, 81d lead) ##########')
for (const sym of SYMS) {
  const rows: Row[] = []
  for (const [tf, bs] of TF) {
    let all: Candle[]
    try { all = load(sym, tf) } catch { continue }
    const lead = leadFor(bs, 81)
    const shortId = register(padWarmup(shortTermChannel, lead))
    const slowId = register(padWarmup(trendRegimeEnsemble, lead))
    const cs = segment(all, TRAIN_FROM, END, lead)
    if (cs.length < lead * 3) continue
    rows.push(run(cs, shortId, `${tf.padEnd(4)} short-term channel`))
    rows.push(run(cs, slowId, `${tf.padEnd(4)} trend regime (shipped)`))
  }
  if (rows.length) { console.log(`\n--- ${sym} 3 years ---`); table(rows) }
}
