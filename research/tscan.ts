import type { Candle } from '../shared/ipc'
import type { StrategyDefinition, StrategySignals } from '../src/backtest/strategies/types'
import { load, segment, register, run, SPLIT_AT, padWarmup } from './harness'
import { sma, highest, lowest } from './families'

/** Trend-following at a swept timescale, with NO stop.
 *
 * The earlier short-term probe measured mean forward return at a FIXED horizon after a condition.
 * That test cannot see a trend-following edge at all: a trend follower earns from an asymmetric
 * exit over a VARIABLE holding period, not from a positive mean at a fixed one. So "nothing works
 * short-term" was never actually tested for trend. This scan tests it directly -- sweep the trend
 * lookback from a quarter-day to fifty days and find where net-after-fees crosses zero. */
function trendAt(days: number, bandPct: number, barsPerDay: number): StrategyDefinition {
  const p = Math.max(2, Math.round(days * barsPerDay))
  return {
    id: `x-tscan-${days}-${bandPct}-${barsPerDay}`,
    name: 'tscan', description: '',
    warmupBarsFor: () => p,
    generateSignals(candles: Candle[]): StrategySignals {
      const c = candles.map((x) => x.close)
      const ma = sma(c, p)
      const n = c.length
      const entries = new Array<boolean>(n).fill(false)
      const exits = new Array<boolean>(n).fill(false)
      const stopPrices = new Array<number | null>(n).fill(null)
      for (let i = p; i < n; i++) {
        // A 50% disaster stop, NOT a working one -- the regime exit is what controls risk here.
        // It cannot be null: the engine refuses to open a position without a stop price
        // (engine.ts, `signals.stopPrices[i] !== null`), so a stopless trend follower is
        // unexpressible and a null here silently produces zero trades rather than an error.
        if (c[i] > ma[i] * (1 + bandPct / 100)) { entries[i] = true; stopPrices[i] = c[i] * 0.5 }
        if (c[i] < ma[i] * (1 - bandPct / 100)) exits[i] = true
      }
      return { entries, exits, stopPrices, warmupBars: p }
    }
  }
}

function donchAt(days: number, exitDays: number, barsPerDay: number): StrategyDefinition {
  const pe = Math.max(2, Math.round(days * barsPerDay))
  const px = Math.max(2, Math.round(exitDays * barsPerDay))
  return {
    id: `x-dscan-${days}-${exitDays}-${barsPerDay}`,
    name: 'dscan', description: '',
    warmupBarsFor: () => Math.max(pe, px) + 1,
    generateSignals(candles: Candle[]): StrategySignals {
      const hi = highest(candles.map((x) => x.high), pe)
      const lo = lowest(candles.map((x) => x.low), px)
      const n = candles.length
      const entries = new Array<boolean>(n).fill(false)
      const exits = new Array<boolean>(n).fill(false)
      const stopPrices = new Array<number | null>(n).fill(null)
      const warm = Math.max(pe, px) + 1
      for (let i = warm; i < n; i++) {
        if (candles[i].close >= hi[i - 1]) { entries[i] = true; stopPrices[i] = candles[i].close * 0.5 }
        if (candles[i].close <= lo[i - 1]) exits[i] = true
      }
      return { entries, exits, stopPrices, warmupBars: warm }
    }
  }
}

const TF: Array<[string, number]> = [['15m', 96], ['1h', 24], ['4h', 6]]
const DAYS = [0.25, 0.5, 1, 2, 3, 5, 8, 12, 20, 30, 50]
const BANDS = [0, 0.5, 1.5]

for (const sym of ['BTCUSDT', 'ETHUSDT', 'SOLUSDT']) {
  for (const [tf, bpd] of TF) {
    let all: Candle[]
    try { all = load(sym, tf) } catch { continue }
    // 3 years of 15m exists for every symbol; 1h/4h go back to 2017, so clip them to match.
    const from = Date.parse('2023-08-27T00:00:00Z') / 1000
    const lead = Math.round(50 * bpd) + 2
    const cs = segment(all, from, SPLIT_AT, lead)
    if (cs.length < lead * 2) continue
    console.log(`\n=== ${sym} ${tf} TRAIN (${cs.length} bars, lead ${lead}) ===`)
    const rows = []
    for (const band of BANDS) {
      for (const d of DAYS) {
        const id = register(padWarmup(trendAt(d, band, bpd), lead))
        rows.push(run(cs, id, `ma ${String(d).padStart(5)}d band${band}%`))
      }
    }
    for (const d of DAYS) {
      const id = register(padWarmup(donchAt(d, d / 2, bpd), lead))
      rows.push(run(cs, id, `donch ${String(d).padStart(5)}d/${d / 2}d`))
    }
    const { table } = await import('./harness')
    table(rows)
  }
}
