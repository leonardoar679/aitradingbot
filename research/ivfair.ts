// WHICH CANDLE INTERVAL SHOULD THESE STRATEGIES ACTUALLY RUN ON?
//
// THE TRAP THIS FILE EXISTS TO AVOID, restated because research/README.md records it being fallen
// into twice already: comparing intervals by slicing each from the same DATE gives them different
// TRADEABLE starts. Trend Regime needs 80 days of warmup, which is 7,680 bars of 15m and 20 bars
// of 1d; slice both from January and the 1d run is trading in March while the 15m run is still
// warming up. That silently hands the faster interval a different window AND a different buy &
// hold anchor. Doing it correctly moved an earlier daily result from +207% to +141% and reversed
// the conclusion from "daily is best" to "daily is worst".
//
// So the window here is pinned by TRADEABLE time, not by slice time. Every interval starts
// trading at the same wall-clock instant and stops at the same one; each simply carries however
// many warmup bars it personally needs from before that instant.
//
// WHY THE ANSWER IS NOT OBVIOUS IN EITHER DIRECTION. Both strategies define their lookbacks in
// DAYS, not bars, so changing the interval does NOT change what the strategy means -- a 20-day
// average is 20 days at every interval. Only two things actually change:
//
//   FINER BARS: the entry and exit conditions are checked more often, so the strategy reacts
//   sooner, and it crosses its own hysteresis thresholds more times. More crossings means more
//   round trips, and a round trip costs 0.24%.
//
//   COARSER BARS: fewer crossings and a smaller fee bill, but the exit can be up to a whole bar
//   late, which on 1d candles is a real amount of a crash.
//
// That is a genuine trade-off and it is what this measures. The user's specific question was
// whether to go FASTER than 15m -- 3m or similar -- so 3m and 5m are included, downloaded back to
// 2021 for exactly this comparison.

import { readFileSync } from 'fs'
import { join } from 'path'
import { runBacktest } from '../src/backtest/engine'
import { shortTermChannel } from '../src/backtest/strategies/shortTermChannel'
import { trendRegimeEnsemble } from '../src/backtest/strategies/trendRegimeEnsemble'
import type { StrategyDefinition } from '../src/backtest/strategies/types'
import type { Candle } from '../shared/ipc'

const DIR = process.env.CANDLE_DIR || '.candles'
const CAPITAL = 10_000
const SYMBOLS = (process.env.SYMBOLS || 'BTCUSDT,ETHUSDT,SOLUSDT').split(',')
const INTERVALS = (process.env.INTERVALS || '3m,5m,15m,1h,4h,1d').split(',')

// The fine intervals were pulled from 2021-01. Trend Regime needs 80 days before it can trade,
// so trading opens at 2021-06 with room to spare, and the window then covers the 2021 top, the
// 2022 bear, the 2023-2025 bull and the 2025-2026 decline -- every regime the strategies have to
// survive, rather than one of them.
// Overridable, because the 3m/5m files only reach back to 2021 while 15m and coarser reach to
// 2017. The default window is the one every interval can cover; FROM=2018-01-01 re-asks the
// 15m-versus-1h question on three extra years, including the 2018 bear, once the fine intervals
// are out of the comparison.
const TRADE_FROM = Date.parse((process.env.FROM || '2021-06-01') + 'T00:00:00Z') / 1000
const TRADE_TO = Date.parse((process.env.TO || '2026-08-27') + 'T00:00:00Z') / 1000

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

interface Cell {
  netPct: number
  bhPct: number
  trades: number
  fees: number
  maxDd: number
  sharpe: number
  barSeconds: number
}

/** Slices so the strategy's FIRST TRADEABLE BAR is at `from` on every interval. Returns null when
 * the series cannot cover the warmup, rather than quietly trading a shorter window. */
function fairRun(symbol: string, interval: string, def: StrategyDefinition): Cell | null {
  const all = load(symbol, interval)
  if (!all || all.length < 10) return null
  const barSeconds = all.length > 1 ? all[Math.floor(all.length / 2)].time - all[Math.floor(all.length / 2) - 1].time : 0
  if (barSeconds <= 0) return null
  const warmup = def.warmupBarsFor ? def.warmupBarsFor(barSeconds) : 0

  const first = all.findIndex((c) => c.time >= TRADE_FROM)
  const last = all.findIndex((c) => c.time >= TRADE_TO)
  if (first < 0 || first - warmup < 0) return null
  const slice = all.slice(first - warmup, last < 0 ? all.length : last)
  if (slice.length < warmup + 10) return null

  const r = runBacktest(slice, def.id, { startingBalance: CAPITAL })
  const b = r.benchmarkCurve
  return {
    netPct: r.stats.totalNetProfitPct,
    bhPct: b.length > 1 ? ((b[b.length - 1].value - b[0].value) / b[0].value) * 100 : 0,
    trades: r.stats.totalClosedTrades,
    fees: r.stats.totalPaidFees,
    maxDd: r.stats.maxDrawdownPct,
    sharpe: r.stats.sharpeRatio,
    barSeconds
  }
}

const pc = (v: number): string => (v >= 0 ? '+' : '') + v.toFixed(1) + '%'
const median = (v: number[]): number => {
  if (v.length === 0) return 0
  const s = [...v].sort((a, b) => a - b)
  const m = Math.floor(s.length / 2)
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2
}

console.log('Tradeable window pinned for every interval: ' +
  new Date(TRADE_FROM * 1000).toISOString().slice(0, 10) + ' to ' + new Date(TRADE_TO * 1000).toISOString().slice(0, 10))
console.log('Each interval carries its own warmup from BEFORE that start, so all of them trade the same days.\n')

for (const def of [trendRegimeEnsemble, shortTermChannel]) {
  console.log('\n\n############ ' + def.name + ' ############\n')
  for (const symbol of SYMBOLS) {
    console.log('--- ' + symbol + ' ---')
    console.log(
      'interval'.padEnd(10) + 'net%'.padStart(11) + 'b&h%'.padStart(11) + 'trades'.padStart(8) +
        'fees'.padStart(11) + 'maxDD'.padStart(9) + 'sharpe'.padStart(9)
    )
    console.log('-'.repeat(69))
    for (const interval of INTERVALS) {
      const c = fairRun(symbol, interval, def)
      if (!c) {
        console.log(interval.padEnd(10) + 'no data'.padStart(11))
        continue
      }
      console.log(
        interval.padEnd(10) + pc(c.netPct).padStart(11) + pc(c.bhPct).padStart(11) +
          String(c.trades).padStart(8) + ('$' + c.fees.toFixed(0)).padStart(11) +
          pc(c.maxDd).padStart(9) + c.sharpe.toFixed(2).padStart(9)
      )
    }
    console.log('')
  }

  // The summary that decides it: median and worst across symbols, per interval. A single symbol
  // can carry a mean -- SOL has done exactly that twice in this directory -- so the worst case is
  // reported beside the middle one and both have to agree before anything is concluded.
  console.log('--- across ' + SYMBOLS.length + ' symbols ---')
  console.log(
    'interval'.padEnd(10) + 'median net'.padStart(12) + 'worst net'.padStart(12) +
      'median DD'.padStart(12) + 'median fees'.padStart(13) + 'median trades'.padStart(15)
  )
  console.log('-'.repeat(74))
  for (const interval of INTERVALS) {
    const cells = SYMBOLS.map((s) => fairRun(s, interval, def)).filter((c): c is Cell => c !== null)
    if (cells.length === 0) {
      console.log(interval.padEnd(10) + 'no data'.padStart(12))
      continue
    }
    console.log(
      interval.padEnd(10) +
        pc(median(cells.map((c) => c.netPct))).padStart(12) +
        pc(Math.min(...cells.map((c) => c.netPct))).padStart(12) +
        pc(median(cells.map((c) => c.maxDd))).padStart(12) +
        ('$' + median(cells.map((c) => c.fees)).toFixed(0)).padStart(13) +
        median(cells.map((c) => c.trades)).toFixed(0).padStart(15)
    )
  }
}
