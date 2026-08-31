import type { Candle } from './ipc'

// Average True Range, in ONE place, for the same reason shared/fees.ts exists: the backtest engine
// and the main-process services must not disagree about a number they both act on.
//
// WHY THIS MOVED HERE. GPT Intraday computes its stop twice. The engine side placed it from the
// Wilder ATR below; aiSignalService.ts had its own `atrAt` that took a plain mean of the last 14
// true ranges, and used it to decide whether the simulated position had been stopped out. That
// position is not cosmetic -- it goes into the prompt ("you are flat" / "you are long") AND into
// the cache key. Measured over 2,986 BTCUSDT 15m bars the two estimators differ by 11.6% on
// average, 27% at the 95th percentile and 61% at worst, which is more than enough to move a stop
// across a candle's low and flip the position the model is asked about.
//
// Wilder smoothing, not a simple mean: seed with the mean of the first `period` true ranges, then
// carry it forward. That makes it depend on all history before `i`, which a trailing window does
// not, and it is what every other strategy in this repository already uses.

/** Wilder's ATR. `out[i]` is NaN until `period - 1`, where the seed lands. */
export function computeAtr(candles: Candle[], period: number): number[] {
  const out = new Array<number>(candles.length).fill(NaN)
  if (candles.length === 0) return out

  const trueRange = new Array<number>(candles.length)
  trueRange[0] = candles[0].high - candles[0].low
  for (let i = 1; i < candles.length; i++) {
    const { high, low } = candles[i]
    const prevClose = candles[i - 1].close
    trueRange[i] = Math.max(high - low, Math.abs(high - prevClose), Math.abs(low - prevClose))
  }

  if (candles.length < period) return out
  let seedSum = 0
  for (let i = 0; i < period; i++) seedSum += trueRange[i]
  out[period - 1] = seedSum / period
  for (let i = period; i < candles.length; i++) {
    out[i] = (out[i - 1] * (period - 1) + trueRange[i]) / period
  }
  return out
}
