import { describe, expect, it } from 'vitest'
import { DAILY_SIZE_LINES, bandFactors, dailyQuantilesPct, dailySigma, garmanKlass, logMove, type DayBar } from '../shared/forecast/daily/dailySize'
import { expectedMove } from '../shared/forecast/size'

// THE SIZE OVER ONE, THREE AND SEVEN DAYS (shared/forecast/daily/dailySize.ts; V10 Stage 4): a day's variance from its
// range, the spread a coming day is expected to have, a move over h days, the ranges' widths from past moves, the five
// levels symmetric about no move.

const DAY = 86_400
const T0 = 1_790_000_000 - (1_790_000_000 % DAY)

/** Days of bars, each its open at 100 and its range `range` either side, closing where `close` says. */
function days(count: number, range: (k: number) => number, close: (k: number) => number = () => 100): Map<number, DayBar> {
  const out = new Map<number, DayBar>()
  for (let k = 0; k < count; k++) out.set(T0 + k * DAY, { time: T0 + k * DAY, open: 100, high: 100 * (1 + range(k)), low: 100 * (1 - range(k)), close: close(k) })
  return out
}

describe('the daily size rule', () => {
  it("reads a day's variance from its range and its body, never below none, and no bar that cannot be read", () => {
    // A day that closed where it opened: half the squared log range.
    expect(garmanKlass({ open: 100, high: 102, low: 98, close: 100 })).toBeCloseTo(0.5 * Math.log(102 / 98) ** 2, 12)
    // The body takes some of it away.
    expect(garmanKlass({ open: 100, high: 102, low: 98, close: 101 })!).toBeLessThan(garmanKlass({ open: 100, high: 102, low: 98, close: 100 })!)
    expect(garmanKlass({ open: 100, high: 100, low: 100, close: 100 })).toBe(0)
    expect(garmanKlass({ open: 0, high: 1, low: 1, close: 1 })).toBeNull()
    expect(garmanKlass({ open: 1, high: 1, low: 2, close: 1 })).toBeNull()
  })

  it('expects half the last week and half the last month, from the days before alone, none without thirty days', () => {
    // Calm for 23 days, then a week twice as wide: the expected spread lies between.
    const bars = days(40, (k) => (k >= 23 ? 0.04 : 0.02))
    const day = T0 + 30 * DAY
    const calm = Math.sqrt(garmanKlass(bars.get(T0)!)!)
    const wide = Math.sqrt(garmanKlass(bars.get(T0 + 25 * DAY)!)!)
    const sigma = dailySigma(bars, day)!
    expect(sigma).toBeGreaterThan(calm)
    expect(sigma).toBeLessThan(wide)
    const variance = (k: number): number => garmanKlass(bars.get(T0 + k * DAY)!)!
    const week = [23, 24, 25, 26, 27, 28, 29].reduce((sum, k) => sum + variance(k), 0) / 7
    const month = Array.from({ length: 30 }, (_, k) => variance(k)).reduce((a, b) => a + b, 0) / 30
    expect(sigma).toBeCloseTo(Math.sqrt(0.5 * week + 0.5 * month), 12)
    // The day itself is never read: a wild day at `day` leaves it as it was.
    const wild = new Map(bars)
    wild.set(day, { time: day, open: 100, high: 200, low: 50, close: 100 })
    expect(dailySigma(wild, day)).toBe(sigma)
    expect(dailySigma(bars, T0 + 29 * DAY)).toBeNull()
    expect(DAILY_SIZE_LINES.shortDays).toBe(7)
  })

  it("moves from the call day's open to the close h days on, every day between held", () => {
    const bars = days(10, () => 0.01, (k) => 100 + k)
    expect(logMove(bars, T0, 1)).toBeCloseTo(Math.log(100 / 100), 12)
    expect(logMove(bars, T0 + DAY, 3)).toBeCloseTo(Math.log(103 / 100), 12)
    const gap = new Map(bars)
    gap.delete(T0 + 2 * DAY)
    expect(logMove(gap, T0 + DAY, 3)).toBeNull()
    expect(logMove(bars, T0 + 9 * DAY, 3)).toBeNull()
  })

  it("reads the ranges' widths where half and eight in ten of past moves fell, and none from too few", () => {
    const zs = Array.from({ length: 1000 }, (_, k) => ((k % 100) - 49.5) / 25)
    const [inner, outer] = bandFactors(zs)!
    const inside = (width: number): number => zs.filter((z) => Math.abs(z) <= width).length / zs.length
    expect(inside(inner)).toBeCloseTo(0.5, 2)
    expect(inside(outer)).toBeCloseTo(0.8, 2)
    expect(bandFactors(zs.slice(0, DAILY_SIZE_LINES.minFitMoves - 1))).toBeNull()
  })

  it('puts no move in the middle and the ranges symmetric in log terms, wider with the days, the size growing as their root', () => {
    const one = dailyQuantilesPct(0.03, 1, [0.67, 1.28])
    expect(one[2]).toBe(0)
    expect(Math.log(1 + one[4] / 100)).toBeCloseTo(-Math.log(1 + one[0] / 100), 12)
    expect(Math.log(1 + one[4] / 100)).toBeCloseTo(1.28 * 0.03, 12)
    const week = dailyQuantilesPct(0.03, 7, [0.67, 1.28])
    expect(expectedMove(week) / expectedMove(one)).toBeCloseTo(Math.sqrt(7), 1)
  })
})
