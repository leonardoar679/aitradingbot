import { writeFileSync } from 'fs'
import { runBacktest } from '../src/backtest/engine'
import type { Candle } from '../shared/ipc'
import { load, segment, padWarmup, register } from './harness'
import { shortTermChannel } from '../src/backtest/strategies/shortTermChannel'

/** Emits the monthly report as JSON so the write-up embeds measured numbers rather than numbers
 * re-typed from a console table. Transcription is the one error a reader cannot catch. */

const DAY = 86_400
const FROM = Date.parse('2023-08-27T00:00:00Z') / 1000
const TO = Date.parse('2026-08-27T00:00:00Z') / 1000

const SPECS: Array<[string, string, number]> = [
  ['BTCUSDT', '15m', 900],
  ['BTCUSDT', '1h', 3600],
  ['BTCUSDT', '4h', 14_400],
  ['ETHUSDT', '15m', 900],
  ['ETHUSDT', '4h', 14_400],
  ['SOLUSDT', '15m', 900],
  ['SOLUSDT', '4h', 14_400]
]

function benchmarkMonths(curve: Array<{ time: number; value: number }>): Record<string, number> {
  const first = new Map<string, number>()
  const last = new Map<string, number>()
  for (const p of curve) {
    const m = new Date(p.time * 1000).toISOString().slice(0, 7)
    if (!first.has(m)) first.set(m, p.value)
    last.set(m, p.value)
  }
  const out: Record<string, number> = {}
  for (const [m, a] of first) out[m] = (((last.get(m) as number) - a) / a) * 100
  return out
}

function maxDrawdown(values: number[]): number {
  let peak = -Infinity
  let worst = 0
  for (const v of values) {
    if (v > peak) peak = v
    const dd = ((v - peak) / peak) * 100
    if (dd < worst) worst = dd
  }
  return worst
}

const out: unknown[] = []
for (const [sym, tf, bs] of SPECS) {
  let all: Candle[]
  try { all = load(sym, tf) } catch { continue }
  const lead = Math.round((9 * DAY) / bs) + 2
  const id = register(padWarmup(shortTermChannel, lead))
  const cs = segment(all, FROM, TO, lead)
  if (cs.length < lead * 3) continue
  const r = runBacktest(cs, id, { startingBalance: 10_000, leverage: 1 })
  const months: Record<string, number> = {}
  const trades: Record<string, number> = {}
  for (const m of r.monthlyBreakdown) { months[m.month] = m.returnPct; trades[m.month] = m.trades }
  let streak = 0
  let worstStreak = 0
  for (const m of r.monthlyBreakdown) { if (m.returnPct < 0) { streak++; worstStreak = Math.max(worstStreak, streak) } else streak = 0 }
  out.push({
    symbol: sym.replace('USDT', ''),
    timeframe: tf,
    months,
    trades,
    bh: benchmarkMonths(r.benchmarkCurve),
    net: r.stats.totalNetProfitPct,
    finish: r.stats.finishingBalance,
    totalTrades: r.stats.totalClosedTrades,
    fees: r.stats.totalPaidFees,
    winRate: r.stats.winRatePct,
    maxDd: maxDrawdown(r.equityCurve.map((p) => p.value)),
    worstStreak
  })
}

const dest = process.env.JSON_OUT as string
writeFileSync(dest, JSON.stringify(out, null, 1))
console.log(`wrote ${dest}: ${out.length} series`)
