import type { Candle } from '../shared/ipc'
import { EVENT_LOOKBACK_BARS } from '../shared/marketEvent'

// Synthetic 1-minute markets for the tests of the event detector and everything built on it.
// Deterministic: the same arguments always give the same candles.

export const T0 = Date.parse('2026-09-01T00:00:00Z') / 1000

/** A quiet market: a small wobble around 100, the same volume every minute. */
export function quiet(bars: number, seed = 7, start = T0): Candle[] {
  let state = seed
  const next = (): number => {
    state = (state * 1103515245 + 12345) % 2147483648
    return state / 2147483648 - 0.5
  }
  const out: Candle[] = []
  let price = 100
  for (let i = 0; i < bars; i++) {
    const open = price
    const close = open * (1 + next() * 0.0006)
    out.push({ time: start + i * 60, open, high: Math.max(open, close) * 1.0001, low: Math.min(open, close) * 0.9999, close, volume: 1000 })
    price = close
  }
  return out
}

export interface Move {
  /** Percent over the last fifteen bars. Negative for a fall. */
  pct: number
  /** Volume of each of the last five bars, as a multiple of the usual. */
  volume?: number
  /** Where each moving bar closes inside its own range: 1 at the favourable end, 0 at the other. */
  closeAt?: number
}

/** A quiet market that ends in a fifteen-minute move. `lead` quiet bars come first. */
export function withMove(move: Move, lead = EVENT_LOOKBACK_BARS + 20, seed = 7, start = T0): Candle[] {
  const bars = quiet(lead, seed, start)
  const step = move.pct / 15 / 100
  const closeAt = move.closeAt ?? 1
  let price = bars[bars.length - 1].close
  for (let i = 0; i < 15; i++) {
    const open = price
    const close = open * (1 + step)
    const body = Math.abs(close - open)
    // The bar's range is its body plus a wick on the side the close is held away from.
    const wick = closeAt >= 1 ? 0 : (body * (1 - closeAt)) / Math.max(closeAt, 0.05)
    const up = close >= open
    bars.push({
      time: start + (lead + i) * 60,
      open,
      high: up ? close + wick : open,
      low: up ? open : close - wick,
      close,
      volume: i >= 10 ? 1000 * (move.volume ?? 1) : 1000
    })
    price = close
  }
  return bars
}

/** `bars` followed by `count` flat minutes at its last price. */
export function thenFlat(bars: Candle[], count: number): Candle[] {
  const last = bars[bars.length - 1]
  const out = [...bars]
  for (let i = 1; i <= count; i++) {
    out.push({ time: last.time + i * 60, open: last.close, high: last.close * 1.0001, low: last.close * 0.9999, close: last.close, volume: 1000 })
  }
  return out
}

/** `count` fifteen-minute bars, the last of which closes at `endTime`. A gentle wander around
 * 100: enough for indicators to have something to read, and nothing a test depends on. */
export function fifteenMinuteBars(count: number, endTime: number, seed = 5): Candle[] {
  let state = seed
  const next = (): number => {
    state = (state * 1103515245 + 12345) % 2147483648
    return state / 2147483648 - 0.5
  }
  const out: Candle[] = []
  let price = 100
  for (let i = 0; i < count; i++) {
    const open = price
    price = Math.max(1, open * (1 + next() * 0.004))
    out.push({ time: endTime - (count - i) * 900, open, high: Math.max(open, price) * 1.001, low: Math.min(open, price) * 0.999, close: price, volume: 15_000 })
  }
  return out
}

/** The candles an event's question is built from: twelve hours and a little more of 1-minute bars
 * ending in `move`, and seven days and a little more of 15-minute bars that had closed by then. */
export function eventQuestionCandles(move: Move = { pct: 3, volume: 8 }, seed = 7): { candles1m: Candle[]; candles15m: Candle[]; eventTime: number } {
  const candles1m = withMove(move, EVENT_LOOKBACK_BARS + 20, seed)
  const eventTime = candles1m[candles1m.length - 1].time + 60
  const boundary = Math.floor(eventTime / 900) * 900
  return { candles1m, candles15m: fifteenMinuteBars(672 + 8, boundary), eventTime }
}
