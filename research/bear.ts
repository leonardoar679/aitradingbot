// IS THE PREMISE TRUE? "These strategies make money in a bull market and lose it in a bear one."
//
// Two ways of asking, because they can disagree and the disagreement is the finding.
//
// FIRST FIX, and it matters: attribution is in LOG RETURNS, not dollars. An earlier cut of this
// summed the equity curve's dollar changes per regime and reported that Trend Regime made
// +$6.3M in bull bars and lost -$2.6M in chop. Both numbers are real and neither means anything:
// on a $10,000 start compounding to millions, a 1% move in the last year is worth more dollars
// than a 100% move in the first, so dollar attribution is a report on WHEN a regime happened, not
// on how the strategy behaved in it. Log returns are additive and scale-free -- every regime's
// contribution is stated as the return the strategy would have earned if only those bars existed,
// and the parts compose back to the whole exactly.
//
// SECOND: regimes are defined per symbol from a RUNNING peak close, so the label at bar i is one
// a live system could have computed at bar i. Thresholds are conventional and not swept.
//
// This file classifies and measures. It changes nothing and tunes nothing.

import { readFileSync } from 'fs'
import { join } from 'path'
import { runBacktest } from '../src/backtest/engine'
import { shortTermChannel } from '../src/backtest/strategies/shortTermChannel'
import { trendRegimeEnsemble } from '../src/backtest/strategies/trendRegimeEnsemble'
import type { StrategyDefinition } from '../src/backtest/strategies/types'
import type { Candle } from '../shared/ipc'

const DIR = process.env.CANDLE_DIR || '.candles'
const CAPITAL = 10_000
const SYMBOLS = (process.env.SYMBOLS || 'BTCUSDT,ETHUSDT,SOLUSDT,BNBUSDT,XRPUSDT,ADAUSDT,LINKUSDT,LTCUSDT').split(',')
const INTERVAL = process.env.INTERVAL || '1d'

const cache = new Map<string, Candle[]>()
function load(symbol: string, interval: string): Candle[] | null {
  const key = symbol + interval
  const hit = cache.get(key)
  if (hit) return hit
  try {
    const rows = JSON.parse(readFileSync(join(DIR, symbol + '-' + interval + '.json'), 'utf-8')) as number[][]
    const out: Candle[] = rows.map((r) => ({ time: r[0], open: r[1], high: r[2], low: r[3], close: r[4], volume: r[5] }))
    cache.set(key, out)
    return out
  } catch {
    return null
  }
}

type Regime = 'bull' | 'chop' | 'bear'

function regimes(candles: Candle[]): Regime[] {
  let peak = -Infinity
  return candles.map((c) => {
    if (c.close > peak) peak = c.close
    const dd = (c.close - peak) / peak
    return dd > -0.1 ? 'bull' : dd > -0.35 ? 'chop' : 'bear'
  })
}

const STRATS: StrategyDefinition[] = [trendRegimeEnsemble, shortTermChannel]

const pc = (v: number): string => (v >= 0 ? '+' : '') + v.toFixed(1) + '%'
const median = (v: number[]): number => {
  if (v.length === 0) return 0
  const s = [...v].sort((a, b) => a - b)
  const m = Math.floor(s.length / 2)
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2
}

// ------------------------------------------------------- part 1: contribution by market regime

for (const def of STRATS) {
  console.log('\n\n############ ' + def.name + ' -- ' + INTERVAL + ', full history ############')
  console.log('\nContribution by regime, as the return each regime\'s bars alone would have produced.')
  console.log('"buy & hold" is the same decomposition of holding the coin, for comparison.\n')
  console.log(
    'symbol'.padEnd(8) + 'net%'.padStart(11) +
      'BULL'.padStart(11) + 'CHOP'.padStart(11) + 'BEAR'.padStart(11) +
      'b&h bull'.padStart(11) + 'b&h chop'.padStart(11) + 'b&h bear'.padStart(11) +
      '% bars bear'.padStart(13)
  )
  console.log('-'.repeat(98))

  const collect: Record<Regime, number[]> = { bull: [], chop: [], bear: [] }
  for (const symbol of SYMBOLS) {
    const candles = load(symbol, INTERVAL)
    if (!candles) continue
    const r = runBacktest(candles, def.id, { startingBalance: CAPITAL })
    const reg = regimes(candles)
    const at = new Map<number, number>()
    candles.forEach((c, i) => at.set(c.time, i))

    const logs: Record<Regime, number> = { bull: 0, chop: 0, bear: 0 }
    const bhLogs: Record<Regime, number> = { bull: 0, chop: 0, bear: 0 }
    const bars: Record<Regime, number> = { bull: 0, chop: 0, bear: 0 }
    const curve = r.equityCurve
    const bench = r.benchmarkCurve
    for (let k = 1; k < curve.length; k++) {
      const i = at.get(curve[k].time)
      if (i === undefined || i === 0) continue
      const g = reg[i]
      bars[g]++
      if (curve[k - 1].value > 0 && curve[k].value > 0) logs[g] += Math.log(curve[k].value / curve[k - 1].value)
      if (bench[k - 1]?.value > 0 && bench[k]?.value > 0) bhLogs[g] += Math.log(bench[k].value / bench[k - 1].value)
    }
    const totalBars = bars.bull + bars.chop + bars.bear
    const asPct = (x: number): number => (Math.exp(x) - 1) * 100
    for (const g of ['bull', 'chop', 'bear'] as Regime[]) collect[g].push(asPct(logs[g]))

    console.log(
      symbol.replace('USDT', '').padEnd(8) +
        pc(r.stats.totalNetProfitPct).padStart(11) +
        pc(asPct(logs.bull)).padStart(11) + pc(asPct(logs.chop)).padStart(11) + pc(asPct(logs.bear)).padStart(11) +
        pc(asPct(bhLogs.bull)).padStart(11) + pc(asPct(bhLogs.chop)).padStart(11) + pc(asPct(bhLogs.bear)).padStart(11) +
        ((bars.bear / Math.max(1, totalBars)) * 100).toFixed(0).padStart(12) + '%'
    )
  }
  console.log('-'.repeat(98))
  console.log(
    'median'.padEnd(8) + ''.padStart(11) +
      pc(median(collect.bull)).padStart(11) + pc(median(collect.chop)).padStart(11) + pc(median(collect.bear)).padStart(11)
  )
  console.log(
    'losers'.padEnd(8) + ''.padStart(11) +
      (collect.bull.filter((v) => v < 0).length + '/' + collect.bull.length).padStart(11) +
      (collect.chop.filter((v) => v < 0).length + '/' + collect.chop.length).padStart(11) +
      (collect.bear.filter((v) => v < 0).length + '/' + collect.bear.length).padStart(11) +
      '   <- how many symbols LOST money in that regime'
  )
}

// ------------------------------------------------- part 2: the calendar years everyone means

console.log('\n\n############ CALENDAR YEARS -- the form "bear market" usually means ############')
console.log('\nEach cell is that year in isolation for the strategy, with buy & hold beneath it.')
console.log('Warmup is carried in from before the year, so January is tradeable.\n')

const YEARS = [2018, 2019, 2020, 2021, 2022, 2023, 2024, 2025, 2026]

for (const def of STRATS) {
  console.log('\n--- ' + def.name + ' -- ' + INTERVAL + ' ---')
  console.log('symbol'.padEnd(9) + YEARS.map((y) => String(y).padStart(9)).join(''))
  console.log('-'.repeat(9 + YEARS.length * 9))
  const perYear: Record<number, number[]> = {}
  const bhPerYear: Record<number, number[]> = {}
  for (const y of YEARS) {
    perYear[y] = []
    bhPerYear[y] = []
  }

  for (const symbol of SYMBOLS) {
    const all = load(symbol, INTERVAL)
    if (!all) continue
    const barSeconds = all.length > 1 ? all[1].time - all[0].time : 0
    const warmup = def.warmupBarsFor ? def.warmupBarsFor(barSeconds) : 0
    const cells: string[] = []
    const bhCells: string[] = []
    for (const y of YEARS) {
      const from = Date.UTC(y, 0, 1) / 1000
      const to = Date.UTC(y + 1, 0, 1) / 1000
      const first = all.findIndex((c) => c.time >= from)
      const last = all.findIndex((c) => c.time >= to)
      if (first < 0 || first - warmup < 0) {
        cells.push('-')
        bhCells.push('-')
        continue
      }
      const slice = all.slice(first - warmup, last < 0 ? all.length : last)
      if (slice.length < warmup + 5) {
        cells.push('-')
        bhCells.push('-')
        continue
      }
      const r = runBacktest(slice, def.id, { startingBalance: CAPITAL })
      const b = r.benchmarkCurve
      const bh = b.length > 1 ? ((b[b.length - 1].value - b[0].value) / b[0].value) * 100 : 0
      cells.push(pc(r.stats.totalNetProfitPct))
      bhCells.push(pc(bh))
      perYear[y].push(r.stats.totalNetProfitPct)
      bhPerYear[y].push(bh)
    }
    console.log(symbol.replace('USDT', '').padEnd(9) + cells.map((c) => c.padStart(9)).join(''))
    console.log(''.padEnd(9) + bhCells.map((c) => ('(' + c + ')').padStart(9)).join(''))
  }
  console.log('-'.repeat(9 + YEARS.length * 9))
  console.log('median'.padEnd(9) + YEARS.map((y) => pc(median(perYear[y])).padStart(9)).join(''))
  console.log('b&h'.padEnd(9) + YEARS.map((y) => pc(median(bhPerYear[y])).padStart(9)).join(''))
  console.log('losers'.padEnd(9) + YEARS.map((y) =>
    (perYear[y].length ? perYear[y].filter((v) => v < 0).length + '/' + perYear[y].length : '-').padStart(9)).join(''))
}
