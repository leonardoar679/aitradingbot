import { INTERVAL_SECONDS, type Candle, type Interval } from './ipc'

// Moved here from electron/services/exchanges/aggregate.ts, which now re-exports it. The exchange
// adapters still build their 4h and 1w bars with it; shared/aiContext.ts needs the same aggregation
// to build the 1h and 4h views a model is shown, and shared/ cannot import from electron/. One
// implementation means the higher-timeframe bar in a prompt is the bar a chart would have drawn.

// Unix epoch (1970-01-01) was a Thursday; the first Monday after it was 1970-01-05,
// 4 days in. Offsetting by that anchors weekly buckets to Monday 00:00 UTC, matching
// the convention exchanges use for their own native weekly candles.
const MONDAY_EPOCH_OFFSET = 4 * 24 * 60 * 60

export function bucketTimeFor(unixSeconds: number, interval: Interval): number {
  const width = INTERVAL_SECONDS[interval]
  if (interval === '1w') {
    return unixSeconds - ((unixSeconds - MONDAY_EPOCH_OFFSET) % width)
  }
  return unixSeconds - (unixSeconds % width)
}

/** Merges real candles into coarser bars for `interval` — exact aggregation of real data, used
 * when an exchange has no native endpoint for `interval` but does for a finer one that divides
 * evenly into it (Bithumb, Coinbase and GOPAX all build 4h and 1w this way, and bots run on 4h).
 *
 * Sorts its input rather than requiring the caller to: `open` is taken from the first candle in a
 * bucket and `close` from the last, so an exchange that returns newest-first would otherwise
 * produce a bar with its open and close swapped, silently and only for the aggregated intervals.
 *
 * Drops a leading bucket the input only partly covers. The requested window rarely starts on a
 * bucket boundary — a bot's 4h dry-run window starts at `now - 600 * 4h`, and a weekly bucket
 * starts on a Monday — so the first bucket routinely gets, say, two of its four source hours.
 * Emitting it produces a complete-looking historical bar whose open is wrong and whose high/low
 * never saw the start of the period, which a backtest then treats as real. There is no honest
 * way to fill it in, so it is left out.
 *
 * The trailing bucket is deliberately kept even when partial: that one is the period still in
 * progress, which is exactly what an exchange's own native endpoint returns for the current bar.
 * Missing data and not-yet-existing data are different things. */
export function aggregateCandles(candles: Candle[], interval: Interval): Candle[] {
  const ascending = [...candles].sort((a, b) => a.time - b.time)
  const buckets = new Map<number, Candle>()
  for (const c of ascending) {
    const bucketTime = bucketTimeFor(c.time, interval)
    const existing = buckets.get(bucketTime)
    if (!existing) {
      buckets.set(bucketTime, { ...c, time: bucketTime })
    } else {
      existing.high = Math.max(existing.high, c.high)
      existing.low = Math.min(existing.low, c.low)
      existing.close = c.close
      existing.volume += c.volume
    }
  }

  const result = Array.from(buckets.values()).sort((a, b) => a.time - b.time)
  const first = ascending[0]
  if (first !== undefined && first.time !== bucketTimeFor(first.time, interval)) result.shift()
  return result
}
