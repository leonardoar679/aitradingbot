import { describe, it, expect } from 'vitest'

// Mirrors liveTradingService.recordLiveOrderUsage's bucket logic. A resting order reserves its
// notional on the day it is placed but may resolve on a later UTC day; refunding that to the new
// day would hand back cap the new day never spent.
interface Bucket { date: string; used: number }
const utcDay = (sec: number): string => new Date(sec * 1000).toISOString().slice(0, 10)

function record(bucket: Bucket | null, today: string, delta: number, reservedAtSec?: number): Bucket | null {
  if (reservedAtSec !== undefined && utcDay(reservedAtSec) !== today) return bucket
  const used = bucket && bucket.date === today ? bucket.used : 0
  return { date: today, used: Math.max(0, used + delta) }
}

const DAY1_LATE = Date.UTC(2026, 0, 1, 23, 50) / 1000
const D1 = utcDay(DAY1_LATE)
const D2 = utcDay(Date.UTC(2026, 0, 2, 10, 0) / 1000)

describe('daily live-trading cap', () => {
  it('ignores a refund belonging to a previous UTC day', () => {
    let b: Bucket | null = null
    b = record(b, D1, 20)                    // reserve $20 late on day 1
    b = record(b, D2, 30)                    // trade $30 on day 2
    b = record(b, D2, -20, DAY1_LATE)        // day-1 order expires, refund lands on day 2
    expect(b!.used).toBe(30)                 // was 10 before the fix -> $40 of false headroom
  })

  it('still applies a same-day refund', () => {
    const sameDay = Date.UTC(2026, 0, 2, 9, 0) / 1000
    let b: Bucket | null = null
    b = record(b, D2, 20)
    b = record(b, D2, -20, sameDay)
    expect(b!.used).toBe(0)
  })

  it('never lets usage go negative', () => {
    const sameDay = Date.UTC(2026, 0, 2, 9, 0) / 1000
    expect(record({ date: D2, used: 5 }, D2, -50, sameDay)!.used).toBe(0)
  })

  it('resets when the day rolls over', () => {
    expect(record({ date: D1, used: 40 }, D2, 10)!.used).toBe(10)
  })
})
