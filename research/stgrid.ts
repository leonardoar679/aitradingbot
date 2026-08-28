import type { Candle } from '../shared/ipc'
import type { StrategyDefinition, StrategySignals } from '../src/backtest/strategies/types'
import { load, segment, register, run, table, SPLIT_AT, padWarmup } from './harness'
import { highest, lowest } from './families'

/** Channel-position ensemble.
 *
 * A vote over DONCHIAN channels is vacuous, which is worth stating because it looks like the
 * obvious move: the channels are NESTED -- highest(8d) >= highest(5d) >= ... -- so "close breaks
 * k of the 4 highs" is just "close breaks the k-th slowest high". Voting across them re-picks a
 * single lookback under another name and adds no robustness at all.
 *
 * Where price sits WITHIN each channel is not nested, so averaging that across lookbacks is a
 * genuinely different signal from any one of them. pos = (close - low) / (high - low), averaged;
 * enter near the top of all the channels at once, leave only when well down them. The asymmetry
 * between the two thresholds is the hysteresis that the scan showed is what keeps the fee bill
 * survivable at this timescale. */
export function channelEnsemble(days: number[], barsPerDay: number, enterAt: number, exitAt: number): StrategyDefinition {
  const periods = days.map((d) => Math.max(2, Math.round(d * barsPerDay)))
  const warm = Math.max(...periods) + 1
  return {
    id: `x-chens-${days.join('_')}-${enterAt}-${exitAt}-${barsPerDay}`,
    name: 'channel ensemble', description: '',
    warmupBarsFor: () => warm,
    generateSignals(candles: Candle[]): StrategySignals {
      const his = periods.map((p) => highest(candles.map((x) => x.high), p))
      const los = periods.map((p) => lowest(candles.map((x) => x.low), p))
      const n = candles.length
      const entries = new Array<boolean>(n).fill(false)
      const exits = new Array<boolean>(n).fill(false)
      const stopPrices = new Array<number | null>(n).fill(null)
      for (let i = warm; i < n; i++) {
        const c = candles[i].close
        let sum = 0
        for (let k = 0; k < periods.length; k++) {
          const hi = his[k][i - 1], lo = los[k][i - 1]
          const span = hi - lo
          sum += span > 0 ? Math.min(1, Math.max(0, (c - lo) / span)) : 0.5
        }
        const pos = sum / periods.length
        // Disaster stop only -- the channel exit is the risk control. Never null: the engine
        // refuses to open a position without one.
        if (pos >= enterAt) { entries[i] = true; stopPrices[i] = c * 0.5 }
        if (pos <= exitAt) exits[i] = true
      }
      return { entries, exits, stopPrices, warmupBars: warm }
    }
  }
}

const SETS: number[][] = [[2, 3, 5, 8], [1, 2, 3, 5], [3, 5, 8, 12], [2, 4, 8]]
const ENTER = [0.9, 0.95, 0.98]
const EXIT = [0.15, 0.25, 0.35]
const TF: Array<[string, number]> = [['15m', 96], ['1h', 24], ['4h', 6]]
const from = Date.parse('2023-08-27T00:00:00Z') / 1000

for (const sym of ['BTCUSDT', 'ETHUSDT', 'SOLUSDT']) {
  for (const [tf, bpd] of TF) {
    let all: Candle[]
    try { all = load(sym, tf) } catch { continue }
    const lead = Math.round(12 * bpd) + 2
    const cs = segment(all, from, SPLIT_AT, lead)
    if (cs.length < lead * 3) continue
    console.log(`\n=== ${sym} ${tf} TRAIN ===`)
    const rows = []
    for (const set of SETS) for (const e of ENTER) for (const x of EXIT) {
      const id = register(padWarmup(channelEnsemble(set, bpd, e, x), lead))
      rows.push(run(cs, id, `[${set.join(',')}] in${e} out${x}`))
    }
    rows.sort((a, b) => b.netPct - a.netPct)
    table(rows)
  }
}
