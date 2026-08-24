import { describe, it, expect } from 'vitest'
import { nextDailyUsage, usageForDay, utcDayKey, type DailyUsageBucket } from '../electron/services/dailyUsage'

// This file used to re-implement the bucket logic and test the copy -- faithful at the time, but
// nothing kept it faithful, so the shipped function could break and the suite stay green on a
// gate that bounds how much real money can be committed in a day. It now drives the real thing.
//
// `nextDailyUsage` returns null to mean "make no change", which is how a refund belonging to a
// day whose bucket is gone gets dropped rather than credited to today.
const apply = (
  bucket: DailyUsageBucket | null,
  today: string,
  delta: number,
  reservedAtSec?: number
): DailyUsageBucket | null => nextDailyUsage(bucket, today, delta, reservedAtSec) ?? bucket

const DAY1_LATE = Date.UTC(2026, 0, 1, 23, 50) / 1000
const D1 = utcDayKey(DAY1_LATE)
const D2 = utcDayKey(Date.UTC(2026, 0, 2, 10, 0) / 1000)

describe('daily live-trading cap', () => {
  it('ignores a refund belonging to a previous UTC day', () => {
    let b: DailyUsageBucket | null = null
    b = apply(b, D1, 20) // reserve $20 late on day 1
    b = apply(b, D2, 30) // trade $30 on day 2
    b = apply(b, D2, -20, DAY1_LATE) // day-1 order expires, refund lands on day 2
    expect(b!.usedQuote).toBe(30) // was 10 before the fix -> $40 of false headroom
  })

  it('makes no change at all for a cross-day refund, rather than rewriting the bucket', () => {
    // The null return is what stops the service persisting a no-op write, so it is part of the
    // contract rather than an implementation detail.
    expect(nextDailyUsage({ date: D2, usedQuote: 30 }, D2, -20, DAY1_LATE)).toBeNull()
  })

  it('still applies a same-day refund', () => {
    const sameDay = Date.UTC(2026, 0, 2, 9, 0) / 1000
    let b: DailyUsageBucket | null = null
    b = apply(b, D2, 20)
    b = apply(b, D2, -20, sameDay)
    expect(b!.usedQuote).toBe(0)
  })

  it('never lets usage go negative', () => {
    const sameDay = Date.UTC(2026, 0, 2, 9, 0) / 1000
    expect(apply({ date: D2, usedQuote: 5 }, D2, -50, sameDay)!.usedQuote).toBe(0)
  })

  it('adds each order to the same day, rather than replacing it', () => {
    // The cap only binds if usage accumulates. Every other case here happens to survive the
    // prior total being ignored -- a refund clamps to 0 either way, a day roll-over starts from
    // 0 by design -- so without this, dropping the running total went unnoticed and the daily
    // cap would never have been reached no matter how many orders were placed.
    let b: DailyUsageBucket | null = null
    b = apply(b, D2, 20)
    b = apply(b, D2, 20)
    b = apply(b, D2, 5)
    expect(b!.usedQuote).toBe(45)
  })

  it('resets when the day rolls over', () => {
    expect(apply({ date: D1, usedQuote: 40 }, D2, 10)!.usedQuote).toBe(10)
  })

  it('applies an unreserved adjustment to today regardless of the stored day', () => {
    // No reservedAtSec means "this is happening now" -- a fresh order, not a refund.
    expect(nextDailyUsage({ date: D1, usedQuote: 40 }, D2, 10)).toEqual({ date: D2, usedQuote: 10 })
  })
})

describe('usageForDay', () => {
  it('reads the bucket when it belongs to today', () => {
    expect(usageForDay({ date: D2, usedQuote: 12.5 }, D2)).toBe(12.5)
  })

  it('reports nothing used when the bucket is from an earlier day', () => {
    // The cap has to reset overnight; reading a stale bucket would block a fresh day's trading.
    expect(usageForDay({ date: D1, usedQuote: 999 }, D2)).toBe(0)
  })

  it('reports nothing used when there is no bucket yet', () => {
    expect(usageForDay(null, D2)).toBe(0)
  })
})

describe('utcDayKey', () => {
  it('buckets by UTC date, not local date', () => {
    // 23:50 UTC on Jan 1 is already Jan 2 in some zones; using local time would split one UTC day
    // across two buckets and hand back cap on the boundary.
    expect(utcDayKey(DAY1_LATE)).toBe('2026-01-01')
    expect(utcDayKey(Date.UTC(2026, 0, 2, 0, 5) / 1000)).toBe('2026-01-02')
  })
})
