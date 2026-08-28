import { load, register, padWarmup, run, table, type Row } from './harness'
import { STRATEGIES } from '../src/backtest/strategies'
import type { Candle } from '../shared/ipc'

const def = STRATEGIES.find((s) => s.id === 'trend-regime-ensemble')!
const BARS_PER_DAY: Record<string, number> = { '3m': 480, '15m': 96, '1h': 24, '4h': 6, '1d': 1 }

export function evaluate(sym: string, interval: string, label: string): Row | null {
  const bpd = BARS_PER_DAY[interval]
  const lead = Math.round(80 * bpd)
  let all: Candle[]
  try {
    all = load(sym, interval)
  } catch {
    return null
  }
  // Needs the 80-day warmup plus enough tradeable history to mean anything.
  if (all.length < lead + 200 * bpd) return null
  return run(all, register(padWarmup(def, lead)), label)
}

console.log('===== SAME STRATEGY, EVERY TIMEFRAME (full history each, BTCUSDT) =====')
const tf: Row[] = []
for (const iv of ['3m', '15m', '1h', '4h', '1d']) {
  const r = evaluate('BTCUSDT', iv, `BTCUSDT ${iv}`)
  if (r) tf.push(r)
}
table(tf)

console.log('\n===== SAME STRATEGY, EVERY SYMBOL, DAILY, ~9 YEARS =====')
const sy: Row[] = []
for (const s of ['BTCUSDT', 'ETHUSDT', 'BNBUSDT', 'XRPUSDT', 'ADAUSDT', 'LTCUSDT', 'LINKUSDT', 'DOGEUSDT', 'SOLUSDT']) {
  const r = evaluate(s, '1d', `${s} 1d`)
  if (r) sy.push(r)
}
table(sy)
const beat = sy.filter((r) => r.netPct > r.bhPct).length
const positive = sy.filter((r) => r.netPct > 0).length
console.log(`\npositive on ${positive}/${sy.length} symbols; beat buy & hold on ${beat}/${sy.length}`)
console.log(`median net: ${[...sy].sort((a, b) => a.netPct - b.netPct)[Math.floor(sy.length / 2)].netPct.toFixed(1)}%`)
