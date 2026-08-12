import { INTERVAL_SECONDS, type Candle, type Interval } from '../../../shared/ipc'

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

/** Merges ascending, evenly-spaced real candles into coarser bars for `interval` — exact
 * aggregation of real data, used when an exchange has no native endpoint for `interval`
 * but does for a finer one that divides evenly into it. */
export function aggregateCandles(candles: Candle[], interval: Interval): Candle[] {
  const buckets = new Map<number, Candle>()
  for (const c of candles) {
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
  return Array.from(buckets.values()).sort((a, b) => a.time - b.time)
}
