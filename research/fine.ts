// IS 3m ACTUALLY BETTER THAN 15m? -- head-to-head on all eight symbols, at two slippage levels.
//
// WHY THIS FILE RATHER THAN READING ivfair's TABLE. Three separate conclusions about 3m have been
// written into the docs and two of them were wrong, each time because the answer was read off a
// subset of symbols and each time the subset was simply whichever downloads had finished. The
// volatility gate died of the same thing. So this reports a TALLY across a fixed symbol list and
// refuses to run at all if any symbol is missing, rather than quietly averaging what it found.
//
// WHY TWO SLIPPAGE LEVELS. 3m takes more fills than 15m, so it is more exposed to the fill-cost
// assumption than the coarser interval is -- and SLIPPAGE_RATE is flat and interval-blind, 2bps per
// side at every bar size. A 3m win that evaporates at a higher assumption is a win in the model, not
// in a market. Build with research/build-slip.mjs to vary it.
//
//   node research/build-slip.mjs && ... node research/.fine.mjs
//   SLIP=0.002 ENTRY=research/fine.ts OUT=research/.fine.mjs node research/build-slip.mjs && ...

import { readFileSync } from 'fs'
import { join } from 'path'
import { runBacktest } from '../src/backtest/engine'
import { shortTermChannel } from '../src/backtest/strategies/shortTermChannel'
import { trendRegimeEnsemble } from '../src/backtest/strategies/trendRegimeEnsemble'
import { SLIPPAGE_RATE } from '../shared/fees'
import type { StrategyDefinition } from '../src/backtest/strategies/types'
import type { Candle } from '../shared/ipc'

const DIR = process.env.CANDLE_DIR || '.candles'
const CAPITAL = 10_000
const SYMBOLS = (process.env.SYMBOLS || 'ADAUSDT,BNBUSDT,BTCUSDT,ETHUSDT,LINKUSDT,LTCUSDT,SOLUSDT,XRPUSDT').split(',')
const FINE = process.env.FINE || '3m'
const BASE = process.env.BASE || '15m'
const TRADE_FROM = Date.parse((process.env.FROM || '2021-06-01') + 'T00:00:00Z') / 1000
const TRADE_TO = Date.parse((process.env.TO || '2026-08-27') + 'T00:00:00Z') / 1000

function load(symbol: string, interval: string): Candle[] {
  const rows = JSON.parse(readFileSync(join(DIR, symbol + '-' + interval + '.json'), 'utf-8')) as number[][]
  return rows.map((r) => ({ time: r[0], open: r[1], high: r[2], low: r[3], close: r[4], volume: r[5] }))
}

interface Cell { net: number; sharpe: number; dd: number; trades: number; fees: number }

/** Slices so the first TRADEABLE bar is at TRADE_FROM on both intervals. Throws rather than
 * returning null: a missing symbol must stop the run, not shrink the sample silently. */
function run(symbol: string, interval: string, def: StrategyDefinition): Cell {
  const all = load(symbol, interval)
  const mid = Math.floor(all.length / 2)
  const barSeconds = all[mid].time - all[mid - 1].time
  const warmup = def.warmupBarsFor(barSeconds)
  const first = all.findIndex((c) => c.time >= TRADE_FROM)
  const last = all.findIndex((c) => c.time >= TRADE_TO)
  if (first < 0 || first - warmup < 0) throw new Error(symbol + ' ' + interval + ': cannot cover warmup')
  if (last < 0) throw new Error(symbol + ' ' + interval + ': history ends before TO -- truncated download?')
  const r = runBacktest(all.slice(first - warmup, last), def.id, { startingBalance: CAPITAL })
  return {
    net: r.stats.totalNetProfitPct, sharpe: r.stats.sharpeRatio,
    dd: r.stats.maxDrawdownPct, trades: r.stats.totalClosedTrades, fees: r.stats.totalPaidFees
  }
}

const pc = (v: number) => (v >= 0 ? '+' : '') + v.toFixed(1) + '%'
const median = (v: number[]) => {
  const s = [...v].sort((a, b) => a - b), m = Math.floor(s.length / 2)
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2
}

console.log('SLIPPAGE_RATE in this build: ' + SLIPPAGE_RATE + '  (' + (SLIPPAGE_RATE * 10000).toFixed(1) + ' bps per side)')
console.log(FINE + ' against ' + BASE + ', ' + SYMBOLS.length + ' symbols, tradeable window pinned ' +
  new Date(TRADE_FROM * 1000).toISOString().slice(0, 10) + ' to ' + new Date(TRADE_TO * 1000).toISOString().slice(0, 10))

for (const def of [trendRegimeEnsemble, shortTermChannel]) {
  console.log('\n######## ' + def.name + ' ########')
  console.log('symbol'.padEnd(10) + (FINE + ' net').padStart(12) + (BASE + ' net').padStart(12) +
    'winner'.padStart(8) + 'sharpe'.padStart(14) + 'trades'.padStart(12) + 'fees x'.padStart(9))
  console.log('-'.repeat(77))
  let winNet = 0, winSharpe = 0, winDd = 0
  const fineNet: number[] = [], baseNet: number[] = []
  for (const s of SYMBOLS) {
    const f = run(s, FINE, def), b = run(s, BASE, def)
    fineNet.push(f.net); baseNet.push(b.net)
    if (f.net > b.net) winNet++
    if (f.sharpe > b.sharpe) winSharpe++
    if (f.dd > b.dd) winDd++
    console.log(s.padEnd(10) + pc(f.net).padStart(12) + pc(b.net).padStart(12) +
      (f.net > b.net ? FINE : BASE).padStart(8) +
      (f.sharpe.toFixed(2) + '/' + b.sharpe.toFixed(2)).padStart(14) +
      (f.trades + '/' + b.trades).padStart(12) +
      (b.fees > 0 ? (f.fees / b.fees).toFixed(2) : '-').padStart(9))
  }
  console.log('-'.repeat(77))
  console.log('  ' + FINE + ' wins net on ' + winNet + '/' + SYMBOLS.length +
    ', Sharpe on ' + winSharpe + '/' + SYMBOLS.length + ', drawdown on ' + winDd + '/' + SYMBOLS.length)
  console.log('  median  ' + FINE + ' ' + pc(median(fineNet)) + '   ' + BASE + ' ' + pc(median(baseNet)))
  console.log('  worst   ' + FINE + ' ' + pc(Math.min(...fineNet)) + '   ' + BASE + ' ' + pc(Math.min(...baseNet)))
}
