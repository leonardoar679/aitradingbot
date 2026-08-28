// THE CHOP BAND IS WHERE THE MONEY GOES. What, if anything, stops it?
//
// research/bear.ts decomposed both strategies' returns by market regime and the answer was not
// the one the complaint assumes. Deep bear bars are fine -- Trend Regime's median contribution
// there is +8.5% while buy & hold's is about -90%, which is a long-only trend follower correctly
// sitting in cash. Bull bars are all positive. The loss is concentrated in CHOP, the 10%-to-35%
// band below the running peak: a median contribution of -56.8%, negative on 6 of 8 symbols. That
// band is where tops form and where trends fail, and it is where a trend follower buys a bounce,
// pays the round trip, and does it again.
//
// So the target is not "make money in a bear market" -- research/shortside.ts measured the only
// mechanism that could do that and rejected it. The target is to stop paying for entries inside a
// drawdown that is not going to resolve upward.
//
// FOUR CANDIDATES, each attacking a different reason a chop entry is bad:
//
//   confirm N   the vote must have held for N consecutive bars. Kills the one-bar pop that
//               reverses. Costs lateness on real trends.
//   peak X%     no entry while price is more than X% below its own running peak close. This is
//               the regime definition itself, used causally as a filter.
//   vol X       no entry when realized volatility is above X times its own slow average. Chop is
//               high-volatility by construction; trends are not.
//   rising      every average must be rising, not merely below price. Separates "above a falling
//               line" (a bear bounce) from "above a rising line" (a trend).
//
// METHOD, and it is the whole point of the file. Parameters are chosen on DESIGN ONLY --
// 2017-01 to 2021-12, which contains the 2018 bear, the 2019 chop, the March 2020 crash and the
// 2021 bull. The holdout is 2022-01 to 2026-08 and contains the 2022 bear, the 2023-2025 bull and
// the 2025-2026 decline: two more bear episodes, which is what a bear-market fix has to survive.
//
// MODE=design prints only the design window. MODE=holdout prints both. The split is enforced by
// the script rather than by intention, because "I will not look" is not a method.
//
// KNOWN CONTAMINATION, stated rather than hidden: the diagnosis in bear.ts read all years, so the
// KNOWLEDGE that 2022 is the bad year exists. What is withheld here is parameter SELECTION -- no
// value below is chosen using a number from 2022 onward.

import { readFileSync } from 'fs'
import { join } from 'path'
import { runBacktest } from '../src/backtest/engine'
import { STRATEGIES } from '../src/backtest/strategies'
import { shortTermChannel } from '../src/backtest/strategies/shortTermChannel'
import { trendRegimeEnsemble, rollingSma, inferBarSeconds } from '../src/backtest/strategies/trendRegimeEnsemble'
import type { StrategyDefinition } from '../src/backtest/strategies/types'
import type { Candle } from '../shared/ipc'

const DIR = process.env.CANDLE_DIR || '.candles'
const CAPITAL = 10_000
const DAY = 86_400
const SYMBOLS = (process.env.SYMBOLS || 'BTCUSDT,ETHUSDT,SOLUSDT,BNBUSDT,XRPUSDT,ADAUSDT,LINKUSDT,LTCUSDT').split(',')
const INTERVAL = process.env.INTERVAL || '1h'
const MODE = process.env.MODE || 'design'

const WINDOWS: Array<[string, number, number]> = [
  ['DESIGN 2017-01 -> 2021-12', Date.parse('2017-01-01T00:00:00Z') / 1000, Date.parse('2022-01-01T00:00:00Z') / 1000],
  ['HOLDOUT 2022-01 -> 2026-08', Date.parse('2022-01-01T00:00:00Z') / 1000, Date.parse('2026-08-27T00:00:00Z') / 1000]
]

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

function register(def: StrategyDefinition): string {
  const i = STRATEGIES.findIndex((s) => s.id === def.id)
  if (i >= 0) STRATEGIES[i] = def
  else STRATEGIES.push(def)
  return def.id
}

// ------------------------------------------------------------------------------------- filters
//
// Every filter below narrows `entries` and touches NOTHING else. Exits, stops and warmup are the
// strategy's own. A filter that also suppressed exits would trap a position inside exactly the
// drawdown it was added to avoid.

function withConfirm(base: StrategyDefinition, bars: number): StrategyDefinition {
  return {
    ...base,
    id: base.id + '-confirm' + bars,
    generateSignals(candles) {
      const s = base.generateSignals(candles)
      const entries = s.entries.map((e, i) => {
        if (!e || i < bars) return false
        for (let k = i - bars + 1; k <= i; k++) if (!s.entries[k]) return false
        return true
      })
      return { ...s, entries }
    }
  }
}

function withPeakGate(base: StrategyDefinition, maxDrawdownPct: number): StrategyDefinition {
  return {
    ...base,
    id: base.id + '-peak' + maxDrawdownPct,
    generateSignals(candles) {
      const s = base.generateSignals(candles)
      // Running peak, so the value at bar i uses only bars up to i.
      let peak = -Infinity
      const dd = candles.map((c) => {
        if (c.close > peak) peak = c.close
        return ((c.close - peak) / peak) * 100
      })
      const entries = s.entries.map((e, i) => e && dd[i] >= -maxDrawdownPct)
      return { ...s, entries }
    }
  }
}

function withVolGate(base: StrategyDefinition, ratio: number): StrategyDefinition {
  return {
    ...base,
    id: base.id + '-vol' + String(ratio).replace('.', '_'),
    generateSignals(candles) {
      const s = base.generateSignals(candles)
      const barSeconds = inferBarSeconds(candles)
      if (barSeconds <= 0) return s
      const perDay = DAY / barSeconds
      // Absolute log return per bar, smoothed fast and slow. The ratio is unitless, so one
      // threshold means the same thing on every interval and every symbol.
      const move = candles.map((c, i) => (i === 0 ? 0 : Math.abs(Math.log(c.close / candles[i - 1].close))))
      const fast = rollingSma(move, Math.max(2, Math.round(3 * perDay)))
      const slow = rollingSma(move, Math.max(2, Math.round(30 * perDay)))
      const entries = s.entries.map((e, i) => {
        if (!e) return false
        if (!Number.isFinite(fast[i]) || !Number.isFinite(slow[i]) || slow[i] <= 0) return false
        return fast[i] / slow[i] <= ratio
      })
      return { ...s, entries }
    }
  }
}

function withRising(base: StrategyDefinition, lookbackDays: number[], slopeDays: number): StrategyDefinition {
  return {
    ...base,
    id: base.id + '-rising' + slopeDays,
    generateSignals(candles) {
      const s = base.generateSignals(candles)
      const barSeconds = inferBarSeconds(candles)
      if (barSeconds <= 0) return s
      const perDay = DAY / barSeconds
      const closes = candles.map((c) => c.close)
      const back = Math.max(1, Math.round(slopeDays * perDay))
      const mas = lookbackDays.map((d) => rollingSma(closes, Math.max(2, Math.round(d * perDay))))
      const entries = s.entries.map((e, i) => {
        if (!e || i < back) return false
        return mas.every((ma) => Number.isFinite(ma[i]) && Number.isFinite(ma[i - back]) && ma[i] > ma[i - back])
      })
      return { ...s, entries }
    }
  }
}

// -------------------------------------------------------------------------------------- runner

interface Res {
  net: number
  dd: number
  trades: number
}

function runWindow(symbol: string, def: StrategyDefinition, id: string, from: number, to: number): Res | null {
  const all = load(symbol, INTERVAL)
  if (!all) return null
  const barSeconds = all.length > 2 ? all[2].time - all[1].time : 0
  if (barSeconds <= 0) return null
  // The gate filters need history of their own; ask for the widest lookback any variant uses so
  // every variant is scored on the identical window and none gains days the others do not have.
  const warmup = Math.max(def.warmupBarsFor ? def.warmupBarsFor(barSeconds) : 0, Math.round(30 * (DAY / barSeconds)))
  const found = all.findIndex((c) => c.time >= from)
  const last = all.findIndex((c) => c.time >= to)
  if (found < 0) return null
  // Clamp to the warmup rather than refusing the symbol. A listing that begins after the window
  // opens -- SOL in 2020, ADA in 2018 -- has no history to warm up on at `from`, and the earlier
  // version returned null for all of them, which printed "no data" for every row. Starting such a
  // symbol at its own first tradeable bar shortens ITS window, but every variant still sees the
  // identical window because the warmup above is the widest any of them uses.
  const start = Math.max(found, warmup)
  if (start - warmup < 0) return null
  const slice = all.slice(start - warmup, last < 0 ? all.length : last)
  if (slice.length < warmup + 20) return null
  const r = runBacktest(slice, id, { startingBalance: CAPITAL })
  return { net: r.stats.totalNetProfitPct, dd: r.stats.maxDrawdownPct, trades: r.stats.totalClosedTrades }
}

const pc = (v: number): string => (v >= 0 ? '+' : '') + v.toFixed(1) + '%'
const median = (v: number[]): number => {
  if (v.length === 0) return 0
  const s = [...v].sort((a, b) => a - b)
  const m = Math.floor(s.length / 2)
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2
}

const CANDIDATES: Array<[string, (b: StrategyDefinition, d: number[]) => StrategyDefinition | null]> = [
  ['ships today', () => null],
  ['confirm 6 bars', (b) => withConfirm(b, 6)],
  ['confirm 24 bars', (b) => withConfirm(b, 24)],
  ['no entry >10% off peak', (b) => withPeakGate(b, 10)],
  ['no entry >20% off peak', (b) => withPeakGate(b, 20)],
  ['no entry >35% off peak', (b) => withPeakGate(b, 35)],
  // Swept rather than sampled, because the two values first tried both helped and a pair of
  // points cannot tell a plateau from a peak. The repo's own rule is to take the plateau: if only
  // one cell in this ladder is good, the filter is fitted and none of it should ship.
  ['vol below 1.0x normal', (b) => withVolGate(b, 1.0)],
  ['vol below 1.25x normal', (b) => withVolGate(b, 1.25)],
  ['vol below 1.5x normal', (b) => withVolGate(b, 1.5)],
  ['vol below 1.75x normal', (b) => withVolGate(b, 1.75)],
  ['vol below 2.0x normal', (b) => withVolGate(b, 2.0)],
  ['vol below 2.5x normal', (b) => withVolGate(b, 2.5)],
  ['vol below 3.0x normal', (b) => withVolGate(b, 3.0)],
  ['rising averages (5d)', (b, d) => withRising(b, d, 5)],
  ['rising averages (20d)', (b, d) => withRising(b, d, 20)]
]

const STRATS: Array<[StrategyDefinition, number[]]> = [
  [trendRegimeEnsemble, [20, 30, 50, 80]],
  [shortTermChannel, [2, 3, 5, 8]]
]

const windows = MODE === 'holdout' ? WINDOWS : [WINDOWS[0]]
if (MODE !== 'holdout') {
  console.log('MODE=design -- the holdout is not read. Run with MODE=holdout only after a choice is locked.\n')
}

for (const [base, lookbacks] of STRATS) {
  for (const [wlabel, from, to] of windows) {
    console.log('\n\n############ ' + base.name + ' -- ' + INTERVAL + ' -- ' + wlabel + ' ############\n')
    console.log(
      'variant'.padEnd(24) + 'median net'.padStart(12) + 'worst net'.padStart(12) +
        'losers'.padStart(9) + 'median DD'.padStart(12) + 'median trades'.padStart(15)
    )
    console.log('-'.repeat(84))
    for (const [clabel, make] of CANDIDATES) {
      const built = make(base, lookbacks)
      const id = built ? register(built) : base.id
      const rows = SYMBOLS.map((s) => runWindow(s, base, id, from, to)).filter((r): r is Res => r !== null)
      if (rows.length === 0) {
        console.log(clabel.padEnd(24) + 'no data'.padStart(12))
        continue
      }
      const nets = rows.map((r) => r.net)
      console.log(
        clabel.padEnd(24) +
          pc(median(nets)).padStart(12) +
          pc(Math.min(...nets)).padStart(12) +
          (nets.filter((n) => n < 0).length + '/' + nets.length).padStart(9) +
          pc(median(rows.map((r) => r.dd))).padStart(12) +
          median(rows.map((r) => r.trades)).toFixed(0).padStart(15)
      )
    }
  }
}
