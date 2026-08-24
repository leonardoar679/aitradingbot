/** The daily live-trading cap's bucket arithmetic, split out from liveTradingService so tests can
 * exercise the real thing rather than a copy of it.
 *
 * tests/dailyCap.test.ts used to re-implement this logic and test that -- the file said so
 * outright ("Mirrors liveTradingService.recordLiveOrderUsage's bucket logic"). The copy was
 * faithful, but nothing made it stay faithful: the shipped function could drift or be broken
 * outright and the suite would still pass, on a gate that bounds how much real money can be
 * committed in a day. */
export interface DailyUsageBucket {
  date: string
  usedQuote: number
}

/** UTC day key for a unix-seconds timestamp. One bucket per UTC day. */
export function utcDayKey(sec: number): string {
  return new Date(sec * 1000).toISOString().slice(0, 10)
}

/** Usage recorded against `today`, or 0 when the stored bucket belongs to an earlier day. */
export function usageForDay(bucket: DailyUsageBucket | null, today: string): number {
  if (bucket === null || bucket.date !== today) return 0
  return bucket.usedQuote
}

/** The bucket after applying `quoteAmount` (negative for a refund), or null to make no change.
 *
 * A refund must land on the SAME day bucket that took the reservation. A resting order placed at
 * 23:50 reserves against day 1 and may not resolve until day 2 -- crediting the refund to day 2
 * would hand back cap that day 2 never spent. ($20 reserved on day 1, $30 traded on day 2, then
 * the day-1 order expires: day 2's usage drops to $10, granting $40 of headroom against a $50
 * limit.) Day 1's bucket is already gone by then, so the correct action is to drop the adjustment
 * -- the capital was committed, and counted, on the day it was actually committed. */
export function nextDailyUsage(
  current: DailyUsageBucket | null,
  today: string,
  quoteAmount: number,
  reservedAtSec?: number
): DailyUsageBucket | null {
  if (reservedAtSec !== undefined && utcDayKey(reservedAtSec) !== today) return null
  const usedToday = usageForDay(current, today)
  return { date: today, usedQuote: Math.max(0, usedToday + quoteAmount) }
}
