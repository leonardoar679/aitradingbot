import { type Candle, type Exchange, type Interval } from '../../shared/ipc'

// A candle window that grows by its tail instead of being re-downloaded every poll.
//
// THE PROBLEM THIS FIXES. useDryRun polls every 60 seconds and each poll re-fetched the strategy's
// ENTIRE warm-up window. Trend Regime looks back 80 days, which is 7,800 bars at 15m -- so a single
// bot re-downloaded 7,800 candles a minute, paged from the exchange 1,000 at a time, to learn about
// at most one new bar. That is eight REST calls a minute per bot, forever, for four candles an hour
// of actual news.
//
// It also silently capped which intervals a strategy could use. At 1m the same 80-day window is
// 115,320 bars, or 116 paged calls per bot per minute, which would exhaust an exchange's per-minute
// budget with a handful of bots and surface to the user as a broken bot rather than a rate limit.
// research/INTERVAL-1M.md records that constraint deciding an interval question on its own.
//
// WHY THE REFETCH OVERLAPS BY ONE BAR. The newest candle an exchange returns is the one still
// forming: its close, high and low all keep moving until the bar ends. Appending strictly after the
// last cached candle would freeze that partial bar forever, and every later poll would compute
// signals against a final bar that stopped updating -- a strategy reading a price that never
// changes. So the incremental fetch starts AT the last cached candle's open time and the incoming
// copy replaces it.
//
// CONCURRENT POLLS ARE SAFE BUT NOT ALWAYS OPTIMAL, and the difference is worth naming. Two bots
// on the same series poll independently. If both are in flight at once they read the same held
// array, fetch the same tail and write equivalent results, so nothing is corrupted -- the merge
// is deterministic in its inputs. The one imperfect case is two bots with DIFFERENT enabled
// dates: if the one needing older history stores its wider series while the other is mid-flight,
// the narrower write can land second and drop the extra history. That costs the older bot a full
// refetch on its next poll and nothing else -- it misses, refetches wide, and the cache is
// correct again. Left unsynchronised deliberately: a lock here would buy a rare saved refetch at
// the price of a shared mutable await, and the failure it prevents is slowness, not wrongness.
//
// WHY A CANCELLED FETCH IS SAFE TO KEEP. fetchHistoricalRange pages forward from startTime and
// stops early when cancelled, so a cancelled result is a contiguous PREFIX of what was asked for,
// never a series with a hole in it. Merging one leaves the cache contiguous and merely shorter than
// hoped; the next poll extends from wherever it actually reached. A gap in the middle would be the
// dangerous case, and this API cannot produce one.

/** A fetch of [startSec, endSec], as the renderer's market API provides it. Injected rather than
 * imported so this module can be exercised without an Electron bridge. */
export type RangeFetcher = (
  exchange: Exchange,
  symbol: string,
  interval: Interval,
  startSec: number,
  endSec: number
) => Promise<{ candles: Candle[]; cancelled: boolean }>

/** Above this, the oldest candles are dropped. A cache that has fallen behind the requested start
 * simply misses and refetches in full, so trimming can never produce a wrong answer -- only a slow
 * poll. 200,000 bars is over four months at 1m and more than a decade at 15m. */
const MAX_CACHED_CANDLES = 200_000

const cache = new Map<string, Candle[]>()

const keyFor = (exchange: Exchange, symbol: string, interval: Interval): string =>
  exchange + '|' + symbol.toUpperCase() + '|' + interval

/** Test seam, and a reset for callers that need to be sure they are reading live data. */
export function clearCandleCache(): void {
  cache.clear()
}

/** Bars currently held for a series. Exposed for tests and diagnostics, not for signal generation --
 * callers must go through fetchRangeCached so the tail is refreshed. */
export function cachedCandleCount(exchange: Exchange, symbol: string, interval: Interval): number {
  return cache.get(keyFor(exchange, symbol, interval))?.length ?? 0
}

/** Replaces any cached bar at or after the first incoming one, then appends. The overlap is what
 * refreshes the still-forming final bar; without it the merge would keep a stale copy of it. */
function merge(existing: Candle[], incoming: Candle[]): Candle[] {
  if (incoming.length === 0) return existing
  const firstNew = incoming[0].time
  let cut = existing.length
  while (cut > 0 && existing[cut - 1].time >= firstNew) cut--
  return cut === 0 ? incoming : existing.slice(0, cut).concat(incoming)
}

/** Candles covering [startSec, endSec], fetching only what is not already held.
 *
 * Falls back to a full fetch whenever the cache cannot serve the request -- no entry, an entry that
 * starts too late, or one trimmed past the requested start. The result is identical either way;
 * only the number of network calls differs. */
export async function fetchRangeCached(
  fetcher: RangeFetcher,
  exchange: Exchange,
  symbol: string,
  interval: Interval,
  startSec: number,
  endSec: number
): Promise<Candle[]> {
  const key = keyFor(exchange, symbol, interval)
  const held = cache.get(key)

  if (held !== undefined && held.length > 0 && held[0].time <= startSec) {
    const last = held[held.length - 1]
    // Only the still-forming bar and anything after it. If nothing new has closed, this returns
    // that one bar and the merge is a no-op except for refreshing it.
    if (last.time <= endSec) {
      const tail = await fetcher(exchange, symbol, interval, last.time, endSec)
      const merged = trim(merge(held, tail.candles))
      cache.set(key, merged)
      return merged.filter((c) => c.time >= startSec)
    }
    return held.filter((c) => c.time >= startSec)
  }

  const full = await fetcher(exchange, symbol, interval, startSec, endSec)
  const stored = trim(full.candles)
  cache.set(key, stored)
  return stored.filter((c) => c.time >= startSec)
}

function trim(candles: Candle[]): Candle[] {
  return candles.length > MAX_CACHED_CANDLES ? candles.slice(candles.length - MAX_CACHED_CANDLES) : candles
}
