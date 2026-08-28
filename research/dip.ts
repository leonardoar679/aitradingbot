import type { Candle } from '../shared/ipc'
import type { StrategyDefinition, StrategySignals } from '../src/backtest/strategies/types'
import { computeAtr } from '../src/backtest/strategies/emaCrossAtrStop'
import { sma } from './families'

/** Short-term dip reversion, parameterised so the choices can be measured rather than assumed.
 *
 * Mirrors the engine's own state machine, which a stateless strategy does not have to do. The
 * exit here is a HOLDING PERIOD, so it can only be emitted relative to a real entry -- and the
 * engine ignores an entry signal while a position is open, so a strategy that simply set
 * `exits[i + hold]` for every signal would fire exits for entries that never happened and close
 * positions early. Tracking the same open/closed state the engine will keeps the two in step. */
export function dipReversion(opts: {
  dipPct: number
  dipBars: number
  holdBars: number
  regimeDays: number | null
  barsPerDay: number
  atrStop: number
  takeProfitPct: number | null
}): StrategyDefinition {
  const { dipPct, dipBars, holdBars, regimeDays, barsPerDay, atrStop, takeProfitPct } = opts
  return {
    id: `x-dip-${dipPct}-${dipBars}-${holdBars}-${regimeDays}-${atrStop}-${takeProfitPct}`,
    name: 'dip reversion',
    description: '',
    warmupBarsFor: () => (regimeDays === null ? dipBars + 20 : Math.round(regimeDays * barsPerDay)),
    generateSignals(candles: Candle[]): StrategySignals {
      const n = candles.length
      const close = candles.map((c) => c.close)
      const atr = computeAtr(candles, 14)
      const regime = regimeDays === null ? null : sma(close, Math.round(regimeDays * barsPerDay))
      const warmup = regimeDays === null ? dipBars + 20 : Math.round(regimeDays * barsPerDay)

      const entries = new Array<boolean>(n).fill(false)
      const exits = new Array<boolean>(n).fill(false)
      const stopPrices = new Array<number | null>(n).fill(null)

      let open = false
      let entryIdx = -1
      let entryPrice = 0
      let stop = 0

      for (let i = warmup; i < n; i++) {
        if (open) {
          // The engine checks the stop against the candle's LOW before it looks at exits, so the
          // mirror has to do the same or the two disagree about which bar closed the position.
          if (candles[i].low <= stop) {
            open = false
            continue
          }
          const tpHit = takeProfitPct !== null && candles[i].high >= entryPrice * (1 + takeProfitPct / 100)
          if (tpHit || i - entryIdx >= holdBars) {
            exits[i] = true
            open = false
          }
          continue
        }

        const dip = ((close[i] - close[i - dipBars]) / close[i - dipBars]) * 100
        const inRegime = regime === null || close[i] > regime[i]
        if (dip <= dipPct && inRegime) {
          // Floored at half the price so a deliberately huge multiplier means "effectively no
          // stop" rather than "no entries at all": close - atr*1000 is negative, and the guard
          // below then rejected every signal. That produced a table of clean 0.00% rows which
          // read like a finding and were a bug in the harness.
          const raw = close[i] - atr[i] * atrStop
          const s = Math.max(raw, close[i] * 0.5)
          if (Number.isFinite(s) && s > 0) {
            entries[i] = true
            stopPrices[i] = s
            open = true
            entryIdx = i
            entryPrice = close[i]
            stop = s
          }
        }
      }

      return { entries, exits, stopPrices, warmupBars: warmup }
    }
  }
}
