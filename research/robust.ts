import type { Candle } from '../shared/ipc'
import type { StrategyDefinition, StrategySignals } from '../src/backtest/strategies/types'
import { runBacktest } from '../src/backtest/engine'
import { load, segment, run, table, padWarmup, register, type Row } from './harness'
import { shortTermChannel } from '../src/backtest/strategies/shortTermChannel'
import { trendRegimeEnsemble } from '../src/backtest/strategies/trendRegimeEnsemble'
import { ensembleDays, channelEnsemble } from './families'

/** Does either shipped strategy actually have an edge, or is it a shape fitted to one sample?
 *
 * Four stress tests, each aimed at a different way a backtest lies. None of them tunes anything:
 * a strategy that only works at its exact parameters, on its exact start date, filled at the
 * exact bar it signalled on, and only because of three lucky trades, is not a strategy. */

const DAY = 86_400
const lead = (bs: number, d: number) => Math.round((d * DAY) / bs) + 2

/** Fills every signal `bars` late. A real edge survives being a few bars slow; an artefact of
 * one particular close does not. */
function delayed(def: StrategyDefinition, bars: number): StrategyDefinition {
  return {
    ...def,
    id: `${def.id}-delay${bars}`,
    generateSignals(candles: Candle[]): StrategySignals {
      const s = def.generateSignals(candles)
      const n = candles.length
      const entries = new Array<boolean>(n).fill(false)
      const exits = new Array<boolean>(n).fill(false)
      const stopPrices = new Array<number | null>(n).fill(null)
      for (let i = 0; i < n; i++) {
        const j = i + bars
        if (j >= n) break
        // The stop travels with its entry, or a delayed entry gets the stop computed for a bar
        // it did not trade on.
        if (s.entries[i]) { entries[j] = true; stopPrices[j] = s.stopPrices[i] }
        if (s.exits[i]) exits[j] = true
      }
      return { entries, exits, stopPrices, warmupBars: s.warmupBars + bars }
    }
  }
}

const SHIPPED: Array<[string, StrategyDefinition]> = [
  ['slow ', trendRegimeEnsemble],
  ['SHORT', shortTermChannel]
]

console.log('########## 1. FILL DELAY — is the edge in the exact bar it signalled on? ##########')
console.log('Every signal filled 1, 2 and 4 bars late. A signal that needs the close it just saw')
console.log('is made of noise.\n')
for (const [sym, tf, bs] of [['BTCUSDT', '4h', 14_400], ['ETHUSDT', '4h', 14_400], ['SOLUSDT', '4h', 14_400]] as Array<[string, string, number]>) {
  const all = load(sym, tf)
  const L = lead(bs, 81) + 8
  const rows: Row[] = []
  for (const [label, def] of SHIPPED) {
    for (const d of [0, 1, 2, 4]) {
      const id = register(padWarmup(d === 0 ? def : delayed(def, d), L))
      rows.push(run(all, id, `${label} +${d} bar${d === 1 ? '' : 's'}`))
    }
  }
  console.log(`\n--- ${sym} ${tf}, full history ---`)
  table(rows)
}

console.log('\n\n########## 2. START-DATE SENSITIVITY — one window, or any window? ##########')
console.log('Same two-year length, started 12 different weeks apart. A tight spread means the')
console.log('result is a property of the strategy; a wide one means it is a property of a date.\n')
for (const [sym, tf, bs] of [['BTCUSDT', '15m', 900], ['ETHUSDT', '15m', 900]] as Array<[string, string, number]>) {
  const all = load(sym, tf)
  const L = lead(bs, 81)
  for (const [label, def] of SHIPPED) {
    const id = register(padWarmup(def, L))
    const nets: number[] = []
    for (let w = 0; w < 12; w++) {
      const from = Date.parse('2023-09-01T00:00:00Z') / 1000 + w * 7 * DAY
      const to = from + 730 * DAY
      const cs = segment(all, from, to, L)
      if (cs.length < L * 3) continue
      nets.push(run(cs, id, '').netPct)
    }
    if (!nets.length) continue
    const mean = nets.reduce((a, b) => a + b, 0) / nets.length
    const sd = Math.sqrt(nets.reduce((a, b) => a + (b - mean) ** 2, 0) / nets.length)
    console.log(
      `${sym} ${tf} ${label}  n=${nets.length}  mean ${mean.toFixed(1)}%  sd ${sd.toFixed(1)}  ` +
        `min ${Math.min(...nets).toFixed(1)}%  max ${Math.max(...nets).toFixed(1)}%  ` +
        `all positive: ${nets.every((v) => v > 0) ? 'YES' : 'no'}`
    )
  }
}

console.log('\n\n########## 3. PARAMETER PERTURBATION — a plateau or a spike? ##########')
console.log('Every lookback scaled by the same factor. A strategy that only works at its exact')
console.log('numbers was fitted to them.\n')
{
  const bs = 14_400
  const bpd = DAY / bs
  const L = lead(bs, 130)
  for (const sym of ['BTCUSDT', 'ETHUSDT']) {
    const all = load(sym, '4h')
    const rows: Row[] = []
    for (const f of [0.6, 0.8, 1.0, 1.25, 1.5]) {
      const slow = ensembleDays([20, 30, 50, 80].map((d) => d * f), bpd, 1, 0.25, 10)
      rows.push(run(all, register(padWarmup(slow, L)), `slow  x${f.toFixed(2)} [${[20, 30, 50, 80].map((d) => Math.round(d * f)).join(',')}]d`))
    }
    for (const f of [0.6, 0.8, 1.0, 1.25, 1.5]) {
      const fast = channelEnsemble([2, 3, 5, 8].map((d) => d * f), bpd, 0.95, 0.25)
      rows.push(run(all, register(padWarmup(fast, L)), `SHORT x${f.toFixed(2)} [${[2, 3, 5, 8].map((d) => +(d * f).toFixed(1)).join(',')}]d`))
    }
    console.log(`\n--- ${sym} 4h, full history ---`)
    table(rows)
  }
}

console.log('\n\n########## 4. HOW MUCH RIDES ON THE BEST FEW TRADES? ##########')
console.log('Compounded return with the top N winners removed. Trend following is meant to be')
console.log('concentrated, so the question is how far it has to go before nothing is left.\n')
{
  const L = lead(14_400, 81)
  console.log('series                strategy      all    -top1    -top3    -top5   -top10   trades')
  console.log('-'.repeat(88))
  for (const sym of ['BTCUSDT', 'ETHUSDT', 'SOLUSDT']) {
    const all = load(sym, '4h')
    for (const [label, def] of SHIPPED) {
      const id = register(padWarmup(def, L))
      const r = runBacktest(all, id, { startingBalance: 10_000 })
      const rets = r.trades.map((t) => t.returnPct).sort((a, b) => b - a)
      const compound = (skip: number): number =>
        (rets.slice(skip).reduce((acc, v) => acc * (1 + v / 100), 1) - 1) * 100
      console.log(
        `${sym.replace('USDT', '').padEnd(6)} 4h`.padEnd(22) +
          label.padEnd(10) +
          [0, 1, 3, 5, 10].map((k) => compound(k).toFixed(0).padStart(8)).join('') +
          String(rets.length).padStart(9)
      )
    }
  }
}
