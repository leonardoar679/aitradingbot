// 36 INDEPENDENT months. Each one starts with $10,000, trades that calendar month alone, and is
// flat again at the end of it.
//
// This is a different question from research/m15.ts, which ran once across three years and split
// the equity curve by month. There, month 14 inherits whatever month 13 left it -- both the
// balance and any open position. Here every month is its own account: same starting capital, no
// position carried in, and anything still open on the last bar is closed. The 36 results are
// therefore comparable with each other and independent of the order they happened in, which is
// what "what does a month with this strategy look like" actually asks.
//
// WARMUP IS THE WHOLE DIFFICULTY. Trend Regime looks back 80 days, which at 15m is 7,680 bars --
// more than twice the 2,976 bars in a month. Handed one month of candles it can never trade at
// all, and the honest-looking output would be 36 rows of zero. So each run is given exactly
// `warmupBarsFor(900)` candles of history BEFORE the month opens. Exactly, not approximately: the
// engine gates trading on `i >= warmupBars` (engine.ts:425), so an exact lead makes the first
// tradeable bar the first bar of the month, while one bar too many would let a position open in
// the previous month and one too few would waste the month's opening bar.
//
// Candles run from 2023-06-01 so that September 2023 has its 80 days of lead available.

import { readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import { runBacktest } from '../src/backtest/engine'
import { shortTermChannel } from '../src/backtest/strategies/shortTermChannel'
import { trendRegimeEnsemble } from '../src/backtest/strategies/trendRegimeEnsemble'
import type { StrategyDefinition } from '../src/backtest/strategies/types'
import type { Candle } from '../shared/ipc'

const DIR = process.env.CANDLE_DIR as string
const CAPITAL = 10_000
const BAR_SECONDS = 900
const SYMBOLS = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT']
const CHART_SYMBOL = 'BTCUSDT'
/** Points kept per month for the drawn chart. 2,976 bars in a 15m month is more than a 640px-wide
 * SVG can show, and every point costs bytes in a file that carries 36 of them. */
const CHART_POINTS = 420

const STRATS: Array<{ def: StrategyDefinition; name: string }> = [
  { def: trendRegimeEnsemble, name: 'Trend Regime' },
  { def: shortTermChannel, name: 'Short-Term Channel' }
]

function load(symbol: string): Candle[] {
  const raw = JSON.parse(readFileSync(join(DIR, `${symbol}-15m.json`), 'utf-8')) as number[][]
  return raw.map((r) => ({ time: r[0], open: r[1], high: r[2], low: r[3], close: r[4], volume: r[5] }))
}

/** The 36 calendar months, as [label, startSeconds, endSeconds). */
function months(): Array<[string, number, number]> {
  const out: Array<[string, number, number]> = []
  for (let i = 0; i < 36; i++) {
    const y = 2023 + Math.floor((8 + i) / 12)
    const m = (8 + i) % 12
    const start = Date.UTC(y, m, 1) / 1000
    const end = Date.UTC(m === 11 ? y + 1 : y, (m + 1) % 12, 1) / 1000
    out.push([`${y}-${String(m + 1).padStart(2, '0')}`, start, end])
  }
  return out
}

export interface MonthTrade {
  entryTime: number
  entryPrice: number
  exitTime: number
  exitPrice: number
  pnl: number
  returnPct: number
  exitReason: string
}

export interface MonthResult {
  month: string
  trades: number
  finalBalance: number
  profit: number
  returnPct: number
  maxDrawdownPct: number
  fees: number
  bhPct: number
  detail: MonthTrade[]
}

function maxDrawdown(values: number[]): number {
  let peak = -Infinity
  let worst = 0
  for (const v of values) {
    if (v > peak) peak = v
    if (peak > 0) worst = Math.min(worst, ((v - peak) / peak) * 100)
  }
  return worst
}

function runMonth(all: Candle[], def: StrategyDefinition, start: number, end: number): MonthResult | null {
  const warmup = def.warmupBarsFor ? def.warmupBarsFor(BAR_SECONDS) : 0
  const first = all.findIndex((c) => c.time >= start)
  const last = all.findIndex((c) => c.time >= end)
  if (first < 0) return null
  const lo = first - warmup
  // A month whose lead reaches back before the data begins would be scored on a shorter warmup
  // than the strategy asked for, which is a different strategy. Skip rather than quietly weaken it.
  if (lo < 0) return null
  const hi = last < 0 ? all.length : last

  const candles = all.slice(lo, hi)
  const result = runBacktest(candles, def.id, { startingBalance: CAPITAL })

  // Only the month itself counts for drawdown: the lead is flat cash by construction.
  const inMonth = result.equityCurve.filter((p) => p.time >= start)
  const monthCandles = all.slice(first, hi)
  const bhPct =
    monthCandles.length > 1
      ? ((monthCandles[monthCandles.length - 1].close - monthCandles[0].close) / monthCandles[0].close) * 100
      : 0

  return {
    month: '',
    trades: result.trades.length,
    finalBalance: result.stats.finishingBalance,
    profit: result.stats.finishingBalance - CAPITAL,
    returnPct: result.stats.totalNetProfitPct,
    maxDrawdownPct: maxDrawdown(inMonth.map((p) => p.value)),
    fees: result.stats.totalPaidFees,
    bhPct,
    detail: result.trades.map((t) => ({
      entryTime: t.entryTime,
      entryPrice: t.entryPrice,
      exitTime: t.exitTime,
      exitPrice: t.exitPrice,
      pnl: t.pnl,
      returnPct: t.returnPct,
      exitReason: t.exitReason
    }))
  }
}

const pct = (v: number, d = 2): string => `${v >= 0 ? '+' : ''}${v.toFixed(d)}%`
const usd = (v: number): string => `${v < 0 ? '-' : ''}$${Math.abs(v).toLocaleString('en-US', { maximumFractionDigits: 0 })}`

const MONTHS = months()
const dump: Record<string, unknown> = {}

for (const symbol of SYMBOLS) {
  const all = load(symbol)
  for (const { def, name } of STRATS) {
    const rows: MonthResult[] = []
    for (const [label, start, end] of MONTHS) {
      const r = runMonth(all, def, start, end)
      if (r) rows.push({ ...r, month: label })
    }
    dump[`${symbol}|${def.id}`] = rows

    if (symbol === CHART_SYMBOL) {
      console.log(`\n\n########## ${symbol} 15m — ${name} — every month starts at $10,000 ##########\n`)
      console.log(
        'month'.padEnd(10) + 'trades'.padStart(8) + 'final'.padStart(12) + 'profit'.padStart(11) +
          'return'.padStart(10) + 'maxDD'.padStart(9) + 'fees'.padStart(8) + 'buy&hold'.padStart(11)
      )
      console.log('-'.repeat(79))
      for (const r of rows) {
        console.log(
          r.month.padEnd(10) + String(r.trades).padStart(8) + usd(r.finalBalance).padStart(12) +
            usd(r.profit).padStart(11) + pct(r.returnPct).padStart(10) +
            `${r.maxDrawdownPct.toFixed(1)}%`.padStart(9) + usd(r.fees).padStart(8) + pct(r.bhPct).padStart(11)
        )
      }
      const wins = rows.filter((r) => r.profit > 0).length
      const flat = rows.filter((r) => r.trades === 0).length
      const total = rows.reduce((a, b) => a + b.profit, 0)
      const best = rows.reduce((a, b) => (b.profit > a.profit ? b : a))
      const worst = rows.reduce((a, b) => (b.profit < a.profit ? b : a))
      console.log('-'.repeat(79))
      console.log(
        `${rows.length} months  ·  profitable ${wins}  ·  losing ${rows.length - wins - flat}  ·  no trades ${flat}`
      )
      console.log(
        `sum of all 36 months ${usd(total)}  ·  average ${usd(total / rows.length)} per month  ·  ` +
          `best ${best.month} ${usd(best.profit)}  ·  worst ${worst.month} ${usd(worst.profit)}`
      )
      console.log(
        `NOTE: the sum is what 36 separate $10,000 accounts made, i.e. $360,000 deployed one month ` +
          `at a time. It is not what one $10,000 account compounds to.`
      )
    }
  }
}

// Price series for the drawn charts, one per month, shared by both strategies since the candles
// are the same. Stored as [time, close] pairs to keep the file roughly half the size of objects.
const chartAll = load(CHART_SYMBOL)
const series: Record<string, Array<[number, number]>> = {}
for (const [label, start, end] of MONTHS) {
  const inMonth = chartAll.filter((c) => c.time >= start && c.time < end)
  if (inMonth.length === 0) continue
  const stride = Math.max(1, Math.ceil(inMonth.length / CHART_POINTS))
  const points: Array<[number, number]> = []
  for (let i = 0; i < inMonth.length; i += stride) points.push([inMonth[i].time, inMonth[i].close])
  const lastPoint = inMonth[inMonth.length - 1]
  if (points[points.length - 1][0] !== lastPoint.time) points.push([lastPoint.time, lastPoint.close])
  series[label] = points
}

if (process.env.JSON_OUT) {
  writeFileSync(process.env.JSON_OUT, JSON.stringify({ capital: CAPITAL, symbol: CHART_SYMBOL, series, results: dump }))
  console.log(`\nwrote ${process.env.JSON_OUT}`)
}
