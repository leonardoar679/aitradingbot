import { readFileSync } from 'fs'
import { join } from 'path'
import { runBacktest } from '../src/backtest/engine'
import { STRATEGIES } from '../src/backtest/strategies'
import type { StrategyDefinition } from '../src/backtest/strategies/types'
import type { Candle } from '../shared/ipc'

export const DATA_DIR = process.env.CANDLE_DIR as string

export function load(symbol: string, interval: string): Candle[] {
  const raw = JSON.parse(readFileSync(join(DATA_DIR, `${symbol}-${interval}.json`), 'utf-8')) as number[][]
  return raw.map((r) => ({ time: r[0], open: r[1], high: r[2], low: r[3], close: r[4], volume: r[5] }))
}

/** The split. Tuning may only ever read TRAIN; HOLDOUT is scored once, at the end.
 *
 * Warmup is the subtlety: a strategy with a 200-bar indicator needs history BEFORE the segment
 * starts, or its first 200 bars are dead and the segment is not comparable to the full run. So a
 * segment carries `lead` candles of context that the engine warms up on but that are excluded
 * from the reported window by the strategy's own warmupBars. */
export const SPLIT_AT = Date.parse('2025-08-27T00:00:00Z') / 1000

export function segment(candles: Candle[], from: number, to: number, lead: number): Candle[] {
  const start = candles.findIndex((c) => c.time >= from)
  const end = candles.findIndex((c) => c.time >= to)
  const lo = Math.max(0, (start < 0 ? candles.length : start) - lead)
  const hi = end < 0 ? candles.length : end
  return candles.slice(lo, hi)
}

export function register(def: StrategyDefinition): string {
  const i = STRATEGIES.findIndex((s) => s.id === def.id)
  if (i >= 0) STRATEGIES[i] = def
  else STRATEGIES.push(def)
  return def.id
}

export interface Row {
  label: string
  netPct: number
  bhPct: number
  trades: number
  winPct: number
  maxDdPct: number
  sharpe: number
  profitFactor: number
  feesPaid: number
  bhMaxDdPct: number
}

function maxDd(values: number[]): number {
  let peak = -Infinity
  let worst = 0
  for (const v of values) {
    if (v > peak) peak = v
    const dd = ((v - peak) / peak) * 100
    if (dd < worst) worst = dd
  }
  return worst
}

export function run(candles: Candle[], strategyId: string, label: string, leverage = 1): Row {
  const r = runBacktest(candles, strategyId, { startingBalance: 10_000, leverage })
  const bh = r.benchmarkCurve
  const bhPct = bh.length > 1 ? ((bh[bh.length - 1].value - bh[0].value) / bh[0].value) * 100 : 0
  return {
    label,
    netPct: r.stats.totalNetProfitPct,
    bhPct,
    trades: r.stats.totalClosedTrades,
    winPct: r.stats.winRatePct,
    maxDdPct: r.stats.maxDrawdownPct,
    sharpe: r.stats.sharpeRatio,
    profitFactor: r.stats.profitFactor,
    feesPaid: r.stats.totalPaidFees,
    bhMaxDdPct: maxDd(bh.map((p) => p.value))
  }
}

const n = (v: number, d = 2): string => (Number.isFinite(v) ? v.toFixed(d) : v > 0 ? 'inf' : '-')

export function table(rows: Row[]): void {
  const w = Math.max(28, ...rows.map((r) => r.label.length))
  console.log(
    'strategy'.padEnd(w) + '   net%     b&h%   trades   win%    maxDD%  bhDD%  sharpe    PF     fees'
  )
  console.log('-'.repeat(w + 69))
  for (const r of rows) {
    console.log(
      r.label.padEnd(w) +
        n(r.netPct).padStart(8) +
        n(r.bhPct).padStart(9) +
        String(r.trades).padStart(9) +
        n(r.winPct, 1).padStart(7) +
        n(r.maxDdPct, 1).padStart(9) +
        n(r.bhMaxDdPct, 1).padStart(7) +
        n(r.sharpe).padStart(8) +
        n(r.profitFactor).padStart(7) +
        n(r.feesPaid, 0).padStart(9)
    )
  }
}

/** Forces every candidate to declare the SAME warmup, so all of them trade the identical window
 * and are scored against the identical benchmark.
 *
 * Without this the comparison is not one. The engine anchors buy & hold at `warmupBars`, so a
 * strategy carrying an 80-day lookback was being scored on a shorter window AND against a
 * different benchmark than one carrying 50 -- which made a leave-one-out test read as though
 * dropping the slowest lookback nearly doubled the return, when most of that was the extra 30
 * days of window it silently gained. `lead` must be >= every candidate's true warmup. */
export function padWarmup(def: StrategyDefinition, lead: number): StrategyDefinition {
  return {
    ...def,
    id: `${def.id}-pad${lead}`,
    generateSignals(candles) {
      const s = def.generateSignals(candles)
      if (s.warmupBars > lead) throw new Error(`${def.id} needs ${s.warmupBars} > lead ${lead}`)
      return { ...s, warmupBars: lead }
    }
  }
}
