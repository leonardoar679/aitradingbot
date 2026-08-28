// Both shipped strategies on 15m candles, month by month, for 36 months.
//
// THE QUESTION THIS ANSWERS is not "what did they return" -- a 3-year window ending in a bull
// market answers that flatteringly whatever you put in it. It is "what did they do in the months
// the market was NOT rising", which is the only part of a backtest that says anything about a
// month nobody has seen yet.
//
// WINDOW. 2023-09-01 -> 2026-08-27, 36 calendar months. Candles are fetched from 2023-06-01 so
// that each strategy's warm-up is consumed BEFORE the window opens: Trend Regime needs 80 days
// (7,680 bars at 15m) and Short-Term Channel needs 8 (769). Without that lead the slower strategy
// would sit out its first three months and the two would not be measured over the same 36.
//
// Buy & hold is computed here rather than taken from the engine's benchmark curve, because the
// engine anchors that curve at each strategy's own warmupBars -- so the two strategies would each
// be scored against a differently-dated benchmark. One window, one benchmark, both strategies.
//
// Monthly attribution comes from the equity curve, not from closed trades, so a position held
// across a month boundary contributes the part of its move that happened in each month. Booking
// the whole of a 40-day trade into the month it closed would make a trend follower's monthly
// table meaningless.

import { readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import { runBacktest } from '../src/backtest/engine'
import type { Candle } from '../shared/ipc'

const DIR = process.env.CANDLE_DIR as string
const START = Date.parse('2023-09-01T00:00:00Z') / 1000
const END = Date.parse('2026-08-27T00:00:00Z') / 1000
const CAPITAL = 10_000
const SYMBOLS = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT']

const STRATS = [
  { id: 'trend-regime-ensemble', name: 'Trend Regime', warmupDays: 80 },
  { id: 'short-term-channel', name: 'Short-Term Channel', warmupDays: 8 }
]

const TF_SECONDS: Record<string, number> = { '15m': 900, '1h': 3600, '4h': 14_400, '1d': 86_400 }

function load(symbol: string, interval: string): Candle[] {
  const raw = JSON.parse(readFileSync(join(DIR, `${symbol}-${interval}.json`), 'utf-8')) as number[][]
  return raw.map((r) => ({ time: r[0], open: r[1], high: r[2], low: r[3], close: r[4], volume: r[5] }))
}

const monthKey = (t: number): string => new Date(t * 1000).toISOString().slice(0, 7)
const pct = (v: number, d = 2): string => (Number.isFinite(v) ? `${v >= 0 ? '+' : ''}${v.toFixed(d)}%` : '-')

/** Candles for the reported window plus exactly this strategy's warm-up ahead of it, so trading
 * begins on the first bar of the window for every strategy and timeframe alike. */
function windowed(all: Candle[], warmupDays: number, tfSeconds: number): Candle[] {
  const lead = Math.round((warmupDays * 86_400) / tfSeconds) + 2
  const first = all.findIndex((c) => c.time >= START)
  const last = all.findIndex((c) => c.time >= END)
  return all.slice(Math.max(0, first - lead), last < 0 ? all.length : last)
}

interface MonthRow {
  month: string
  trades: number
  stratPct: number
  bhPct: number
  equity: number
}

/** Buy & hold return for each month of the window: last close of the month against the last close
 * of the month before, with the window's opening close as the first month's base. */
function benchmarkByMonth(candles: Candle[]): Map<string, number> {
  const lastClose = new Map<string, number>()
  let opening = 0
  for (const c of candles) {
    if (c.time < START) continue
    if (opening === 0) opening = c.close
    lastClose.set(monthKey(c.time), c.close)
  }
  const out = new Map<string, number>()
  let prev = opening
  for (const [month, close] of lastClose) {
    out.set(month, ((close - prev) / prev) * 100)
    prev = close
  }
  return out
}

function evaluate(symbol: string, tf: string, strat: (typeof STRATS)[number]): MonthRow[] {
  const candles = windowed(load(symbol, tf), strat.warmupDays, TF_SECONDS[tf])
  const result = runBacktest(candles, strat.id, { startingBalance: CAPITAL })
  const bh = benchmarkByMonth(candles)

  // Equity at each month's last bar. Warm-up months sit before START and are dropped: no position
  // is possible there, so they are flat 10,000 rows that would pad the table with non-results.
  const closeEquity = new Map<string, number>()
  for (const point of result.equityCurve) {
    if (point.time < START) continue
    closeEquity.set(monthKey(point.time), point.value)
  }
  const tradesByMonth = new Map<string, number>()
  for (const t of result.trades) {
    const k = monthKey(t.exitTime)
    tradesByMonth.set(k, (tradesByMonth.get(k) ?? 0) + 1)
  }

  const rows: MonthRow[] = []
  let prev = CAPITAL
  for (const [month, equity] of closeEquity) {
    rows.push({
      month,
      trades: tradesByMonth.get(month) ?? 0,
      stratPct: ((equity - prev) / prev) * 100,
      bhPct: bh.get(month) ?? 0,
      equity
    })
    prev = equity
  }
  return rows
}

function maxDrawdown(equities: number[]): number {
  let peak = -Infinity
  let worst = 0
  for (const v of equities) {
    if (v > peak) peak = v
    worst = Math.min(worst, ((v - peak) / peak) * 100)
  }
  return worst
}

function longestLosingStreak(rows: MonthRow[]): number {
  let run = 0
  let worst = 0
  for (const r of rows) {
    run = r.stratPct < 0 ? run + 1 : 0
    worst = Math.max(worst, run)
  }
  return worst
}

/** Compounded return over a subset of months. */
function compound(rows: MonthRow[], pick: (r: MonthRow) => boolean, of: (r: MonthRow) => number): number {
  let mult = 1
  for (const r of rows) if (pick(r)) mult *= 1 + of(r) / 100
  return (mult - 1) * 100
}

function summarise(rows: MonthRow[]): {
  total: number
  bhTotal: number
  positive: number
  best: MonthRow
  worst: MonthRow
  streak: number
  dd: number
  trades: number
  downMonths: number
  inDown: number
  bhInDown: number
  inUp: number
  bhInUp: number
} {
  const down = (r: MonthRow): boolean => r.bhPct < 0
  return {
    total: ((rows[rows.length - 1].equity - CAPITAL) / CAPITAL) * 100,
    bhTotal: compound(rows, () => true, (r) => r.bhPct),
    positive: rows.filter((r) => r.stratPct > 0).length,
    best: rows.reduce((a, b) => (b.stratPct > a.stratPct ? b : a)),
    worst: rows.reduce((a, b) => (b.stratPct < a.stratPct ? b : a)),
    streak: longestLosingStreak(rows),
    dd: maxDrawdown(rows.map((r) => r.equity)),
    trades: rows.reduce((a, b) => a + b.trades, 0),
    downMonths: rows.filter(down).length,
    inDown: compound(rows, down, (r) => r.stratPct),
    bhInDown: compound(rows, down, (r) => r.bhPct),
    inUp: compound(rows, (r) => !down(r), (r) => r.stratPct),
    bhInUp: compound(rows, (r) => !down(r), (r) => r.bhPct)
  }
}

// ---------------------------------------------------------------- machine-readable dump
//
// Set JSON_OUT to also write every figure to a file. The write-up tables are generated from this
// rather than retyped from the console output: 216 monthly rows copied by hand is 216 chances to
// put a number in the wrong row, and a transcription slip in a report about returns is
// indistinguishable from a wrong result.

if (process.env.JSON_OUT) {
  const dump: Record<string, unknown> = {}
  for (const symbol of SYMBOLS) {
    for (const strat of STRATS) {
      const rows = evaluate(symbol, '15m', strat)
      dump[`${symbol}|${strat.id}`] = { rows, summary: summarise(rows) }
    }
    for (const tf of Object.keys(TF_SECONDS)) {
      for (const strat of STRATS) {
        const candles = windowed(load(symbol, tf), strat.warmupDays, TF_SECONDS[tf])
        const r = runBacktest(candles, strat.id, { startingBalance: CAPITAL })
        dump[`tf|${symbol}|${strat.id}|${tf}`] = {
          net: r.stats.totalNetProfitPct,
          dd: r.stats.maxDrawdownPct,
          trades: r.stats.totalClosedTrades,
          fees: r.stats.totalPaidFees
        }
      }
    }
  }
  writeFileSync(process.env.JSON_OUT, JSON.stringify(dump, null, 1))
  console.log(`wrote ${process.env.JSON_OUT}`)
}

// ---------------------------------------------------------------- monthly tables, 15m

for (const symbol of SYMBOLS) {
  for (const strat of STRATS) {
    const rows = evaluate(symbol, '15m', strat)
    console.log(`\n\n########## ${symbol} 15m — ${strat.name} — $${CAPITAL.toLocaleString()} ##########\n`)
    console.log('month'.padEnd(10) + 'trades'.padStart(8) + 'strategy'.padStart(12) + 'buy&hold'.padStart(12) + 'equity'.padStart(14))
    console.log('-'.repeat(56))
    for (const r of rows) {
      console.log(
        r.month.padEnd(10) +
          String(r.trades).padStart(8) +
          pct(r.stratPct).padStart(12) +
          pct(r.bhPct).padStart(12) +
          `$${r.equity.toFixed(0)}`.padStart(14)
      )
    }
    const s = summarise(rows)
    console.log('-'.repeat(56))
    console.log(
      `${rows.length} months   strategy ${pct(s.total)}   buy&hold ${pct(s.bhTotal)}   ` +
        `positive ${s.positive}/${rows.length}   maxDD(month-end) ${s.dd.toFixed(1)}%   trades ${s.trades}`
    )
    console.log(
      `best ${s.best.month} ${pct(s.best.stratPct)}   worst ${s.worst.month} ${pct(s.worst.stratPct)}   ` +
        `longest losing streak ${s.streak} months`
    )
    console.log(
      `in the ${s.downMonths} months buy&hold FELL: strategy ${pct(s.inDown)} vs buy&hold ${pct(s.bhInDown)}`
    )
    console.log(
      `in the ${rows.length - s.downMonths} months buy&hold ROSE: strategy ${pct(s.inUp)} vs buy&hold ${pct(s.bhInUp)}`
    )
  }
}

// ---------------------------------------------------------------- every 12-month window

// THE STATISTIC THE CALENDAR-YEAR TABLE CANNOT GIVE. Three years is three samples, and they all
// start in September because that is where the data starts. Someone starting this strategy picks a
// month, not a September. Every 12-month window in the 36 gives 25 overlapping samples, and the
// WORST of them is the answer to "what if I start at the wrong time" -- which is the question,
// since nobody gets to choose an entry point in hindsight.
console.log(`\n\n########## EVERY 12-MONTH WINDOW, NOT JUST THE THREE CALENDAR YEARS, 15m ##########\n`)
console.log(
  'symbol'.padEnd(8) + 'strategy'.padEnd(20) + 'worst 12m'.padStart(11) + 'median'.padStart(10) +
    'best 12m'.padStart(11) + 'windows up'.padStart(12) + '   worst window'
)
console.log('-'.repeat(90))
for (const symbol of SYMBOLS) {
  for (const strat of [...STRATS, null]) {
    const rows = evaluate(symbol, '15m', STRATS[0])
    const source = strat ? evaluate(symbol, '15m', strat) : rows
    const take = (r: MonthRow): number => (strat ? r.stratPct : r.bhPct)
    const windows: Array<{ from: string; ret: number }> = []
    for (let i = 0; i + 12 <= source.length; i++) {
      windows.push({ from: source[i].month, ret: compound(source.slice(i, i + 12), () => true, take) })
    }
    const sorted = [...windows].sort((a, b) => a.ret - b.ret)
    const worst = sorted[0]
    console.log(
      symbol.replace('USDT', '').padEnd(8) +
        (strat ? strat.name : 'buy & hold').padEnd(20) +
        pct(worst.ret, 1).padStart(11) +
        pct(sorted[Math.floor(sorted.length / 2)].ret, 1).padStart(10) +
        pct(sorted[sorted.length - 1].ret, 1).padStart(11) +
        `${windows.filter((w) => w.ret > 0).length}/${windows.length}`.padStart(12) +
        `   starting ${worst.from}`
    )
  }
}

// ---------------------------------------------------------------- per-year, then per-timeframe

console.log('\n\n########## THE SAME 36 MONTHS CUT INTO THREE YEARS, 15m ##########\n')
console.log('symbol'.padEnd(8) + 'strategy'.padEnd(20) + 'yr1 23-09/24-08'.padStart(17) + 'yr2 24-09/25-08'.padStart(17) + 'yr3 25-09/26-08'.padStart(17))
console.log('-'.repeat(79))
for (const symbol of SYMBOLS) {
  for (const strat of STRATS) {
    const rows = evaluate(symbol, '15m', strat)
    const year = (from: number, to: number): string =>
      pct(compound(rows.slice(from, to), () => true, (r) => r.stratPct), 1)
    console.log(
      symbol.replace('USDT', '').padEnd(8) +
        strat.name.padEnd(20) +
        year(0, 12).padStart(17) +
        year(12, 24).padStart(17) +
        year(24, 36).padStart(17)
    )
  }
  const bh = evaluate(symbol, '15m', STRATS[0])
  const y = (from: number, to: number): string => pct(compound(bh.slice(from, to), () => true, (r) => r.bhPct), 1)
  console.log(symbol.replace('USDT', '').padEnd(8) + 'buy & hold'.padEnd(20) + y(0, 12).padStart(17) + y(12, 24).padStart(17) + y(24, 36).padStart(17))
}

console.log('\n\n########## DOES 15m EVEN HELP? SAME WINDOW, FOUR BAR SIZES ##########\n')
console.log(
  'symbol'.padEnd(8) + 'strategy'.padEnd(20) + 'timeframe'.padStart(11) + 'net'.padStart(11) +
    'maxDD'.padStart(9) + 'trades'.padStart(8) + 'fees paid'.padStart(12) + 'pos months'.padStart(12)
)
console.log('-'.repeat(91))
for (const symbol of SYMBOLS) {
  for (const strat of STRATS) {
    for (const tf of Object.keys(TF_SECONDS)) {
      const candles = windowed(load(symbol, tf), strat.warmupDays, TF_SECONDS[tf])
      const r = runBacktest(candles, strat.id, { startingBalance: CAPITAL })
      const rows = evaluate(symbol, tf, strat)
      console.log(
        symbol.replace('USDT', '').padEnd(8) +
          strat.name.padEnd(20) +
          tf.padStart(11) +
          pct(r.stats.totalNetProfitPct, 1).padStart(11) +
          `${r.stats.maxDrawdownPct.toFixed(1)}%`.padStart(9) +
          String(r.stats.totalClosedTrades).padStart(8) +
          `$${r.stats.totalPaidFees.toFixed(0)}`.padStart(12) +
          `${rows.filter((x) => x.stratPct > 0).length}/${rows.length}`.padStart(12)
      )
    }
  }
}
