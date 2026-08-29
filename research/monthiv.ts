// THE 36 INDEPENDENT MONTHS, RE-ASKED AT FOUR BAR SIZES.
//
// Same question as research/m15months.ts -- every month is its own $10,000 account, nothing
// carried in, flat at the end -- but run at 1m, 3m, 5m and 15m so the months can be compared
// across intervals rather than only across strategies.
//
// WHY THE WARMUP LEAD IS THE WHOLE DIFFICULTY, restated because it gets worse at finer bars.
// Trend Regime looks back 80 DAYS, which is 7,680 bars of 15m and 115,200 bars of 1m. Handed one
// month of candles it can never trade, and the output would be 36 honest-looking rows of zero.
// Each run is therefore given exactly warmupBarsFor(barSeconds) candles of lead: the engine gates
// trading on i >= warmupBars, so an exact lead puts the first tradeable bar on the 1st of the
// month, one bar more would open a position in the previous month, one fewer wastes a bar.
//
// A month whose lead reaches back past the start of the data is SKIPPED, not shortened. Scoring a
// strategy on less warmup than it declares is scoring a different strategy, and at 1m the lead is
// 80 days, so this is a live risk rather than a theoretical one.
//
// GPT INTRADAY IS ABSENT AND CANNOT BE ADDED HERE. shared/aiSignal.ts throws
// 'GPT Intraday only supports 15-minute candles' for any other interval, caps a run at
// GPT_MAX_DECISIONS = 672 (seven days at 15m, against ~2,976 bars in a month), and reaches the
// live OpenAI endpoint once per decision. Its generateSignals returns hold by construction, so a
// direct engine call here would silently produce a strategy that never trades -- 36 rows of zero
// that look like a measurement. It is left out rather than misrepresented.

import { readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import { runBacktest } from '../src/backtest/engine'
import { shortTermChannel } from '../src/backtest/strategies/shortTermChannel'
import { trendRegimeEnsemble } from '../src/backtest/strategies/trendRegimeEnsemble'
import type { StrategyDefinition } from '../src/backtest/strategies/types'
import type { Candle } from '../shared/ipc'

const DIR = process.env.CANDLE_DIR || '.candles'
const CAPITAL = 10_000
const SYMBOLS = (process.env.SYMBOLS || 'BTCUSDT,ETHUSDT,SOLUSDT').split(',')
const INTERVALS = (process.env.INTERVALS || '1m,3m,5m,15m').split(',')
const OUT = process.env.OUT || 'research/.monthiv.json'

const STRATS: Array<{ def: StrategyDefinition; name: string }> = [
  { def: trendRegimeEnsemble, name: 'Trend Regime' },
  { def: shortTermChannel, name: 'Short-Term Channel' }
]

const cache = new Map<string, Candle[]>()
function load(symbol: string, interval: string): Candle[] | null {
  const key = symbol + interval
  const hit = cache.get(key)
  if (hit) return hit
  try {
    const raw = JSON.parse(readFileSync(join(DIR, `${symbol}-${interval}.json`), 'utf-8')) as number[][]
    const out = raw.map((r) => ({ time: r[0], open: r[1], high: r[2], low: r[3], close: r[4], volume: r[5] }))
    cache.set(key, out)
    return out
  } catch {
    return null
  }
}

/** The same 36 calendar months the existing report uses: 2023-09 through 2026-08. */
function months(): Array<[string, number, number]> {
  const out: Array<[string, number, number]> = []
  for (let i = 0; i < 36; i++) {
    const y = 2023 + Math.floor((8 + i) / 12)
    const m = (8 + i) % 12
    out.push([
      `${y}-${String(m + 1).padStart(2, '0')}`,
      Date.UTC(y, m, 1) / 1000,
      Date.UTC(m === 11 ? y + 1 : y, (m + 1) % 12, 1) / 1000
    ])
  }
  return out
}

interface MonthResult {
  month: string
  trades: number
  finalBalance: number
  returnPct: number
  maxDrawdownPct: number
  fees: number
  bhPct: number
}

function maxDrawdown(values: number[]): number {
  let peak = -Infinity, worst = 0
  for (const v of values) {
    if (v > peak) peak = v
    if (peak > 0) worst = Math.min(worst, ((v - peak) / peak) * 100)
  }
  return worst
}

function runMonth(all: Candle[], def: StrategyDefinition, barSeconds: number,
                  start: number, end: number): MonthResult | null {
  const warmup = def.warmupBarsFor(barSeconds)
  const first = all.findIndex((c) => c.time >= start)
  const last = all.findIndex((c) => c.time >= end)
  if (first < 0) return null
  const lo = first - warmup
  if (lo < 0) return null
  const hi = last < 0 ? all.length : last
  if (hi - first < 10) return null

  const r = runBacktest(all.slice(lo, hi), def.id, { startingBalance: CAPITAL })
  const inMonth = r.equityCurve.filter((p) => p.time >= start)
  const mc = all.slice(first, hi)
  return {
    month: '',
    trades: r.trades.length,
    finalBalance: r.stats.finishingBalance,
    returnPct: r.stats.totalNetProfitPct,
    maxDrawdownPct: maxDrawdown(inMonth.map((p) => p.value)),
    fees: r.stats.totalPaidFees,
    bhPct: mc.length > 1 ? ((mc[mc.length - 1].close - mc[0].close) / mc[0].close) * 100 : 0
  }
}

/** Bar size as the MODE of adjacent deltas, not one sampled pair.
 *
 * Binance is missing ~356 bars per symbol over these windows, so a single `all[i].time -
 * all[i-1].time` that happens to straddle an outage reports 2x or 30x the true bar size. That
 * value feeds warmupBarsFor(), so the error would not surface as a crash -- it would quietly hand
 * every month the wrong lead and still print a full, plausible table. */
function inferBarSeconds(candles: Candle[]): number {
  const counts = new Map<number, number>()
  const step = Math.max(1, Math.floor(candles.length / 4000))
  for (let i = 1; i < candles.length; i += step) {
    const d = candles[i].time - candles[i - 1].time
    counts.set(d, (counts.get(d) || 0) + 1)
  }
  let best = 0, bestN = 0
  for (const [d, n] of counts) if (n > bestN) { best = d; bestN = n }
  return best
}

const pct = (v: number, d = 1): string => `${v >= 0 ? '+' : ''}${v.toFixed(d)}%`
const median = (v: number[]): number => {
  if (!v.length) return 0
  const s = [...v].sort((a, b) => a - b), m = Math.floor(s.length / 2)
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2
}

const MONTHS = months()
const dump: Record<string, MonthResult[]> = {}

console.log(`36 independent months, each starting at $${CAPITAL.toLocaleString('en-US')}, ` +
  `${MONTHS[0][0]} to ${MONTHS[MONTHS.length - 1][0]}`)
console.log(`symbols: ${SYMBOLS.join(', ')}   intervals: ${INTERVALS.join(', ')}\n`)

for (const { def, name } of STRATS) {
  console.log(`\n################ ${name} ################`)
  console.log('interval'.padEnd(9) + 'symbol'.padStart(9) + 'months'.padStart(8) + 'profitable'.padStart(12) +
    'median'.padStart(10) + 'mean'.padStart(10) + 'best'.padStart(10) + 'worst'.padStart(10) +
    'tot profit'.padStart(12) + 'trades/mo'.padStart(11))
  console.log('-'.repeat(101))
  for (const interval of INTERVALS) {
    for (const symbol of SYMBOLS) {
      const all = load(symbol, interval)
      if (!all || all.length < 100) { console.log(interval.padEnd(9) + symbol.padStart(9) + '   no data'); continue }
      const barSeconds = inferBarSeconds(all)
      const rows: MonthResult[] = []
      for (const [label, s, e] of MONTHS) {
        const r = runMonth(all, def, barSeconds, s, e)
        if (r) rows.push({ ...r, month: label })
      }
      dump[`${symbol}|${def.id}|${interval}`] = rows
      if (!rows.length) { console.log(interval.padEnd(9) + symbol.padStart(9) + '   no months'); continue }
      const rets = rows.map((r) => r.returnPct)
      const profitable = rets.filter((v) => v > 0).length
      console.log(
        interval.padEnd(9) + symbol.padStart(9) + String(rows.length).padStart(8) +
        `${profitable}/${rows.length}`.padStart(12) +
        pct(median(rets)).padStart(10) + pct(rets.reduce((a, b) => a + b, 0) / rets.length).padStart(10) +
        pct(Math.max(...rets)).padStart(10) + pct(Math.min(...rets)).padStart(10) +
        `$${Math.round(rows.reduce((a, r) => a + r.finalBalance - CAPITAL, 0)).toLocaleString('en-US')}`.padStart(12) +
        (rows.reduce((a, r) => a + r.trades, 0) / rows.length).toFixed(1).padStart(11)
      )
    }
    console.log('-'.repeat(101))
  }
}

writeFileSync(OUT, JSON.stringify(dump))
console.log(`\nper-month detail written to ${OUT}`)
