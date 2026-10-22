import { describe, expect, it } from 'vitest'
import type { ForecastBar } from '../shared/forecast/bars'
import { MOVE_RATES_LINES, MOVE_RATES_VERSION, moveRatesOf, ratesAt } from '../shared/forecast/moveRates'

// HOW OFTEN A COIN MOVES ENOUGH TO PAY FOR A TRADE (shared/forecast/moveRates.ts; V7.2-R Stage 3): over the
// coin's last ninety days of five-minute bars, at every hour's close, the share of moments whose close a horizon
// on moved 1%, 2% and 5% up or down, whose path touched 1% and 2%, and the typical minutes to the first touch.

const DAY = 86_400
const START = Date.parse('2026-07-01T00:00:00Z') / 1000

/** Five-minute bars from START, the close at bar i given, the high and low a hair either side. */
function series(days: number, closeAt: (i: number) => number, wick = 0.0005): ForecastBar[] {
  return Array.from({ length: days * 288 }, (_, i) => {
    const close = closeAt(i)
    return { time: START + i * 300, open: close, high: close * (1 + wick), low: close * (1 - wick), close, volume: 1, quoteVolume: close, takerBuyVolume: 0.5, trades: 10 }
  })
}

const endOf = (bars: readonly ForecastBar[]): number => bars[bars.length - 1].time + 300

describe("a coin's rates", () => {
  it('are none on a price that never moves, with no time to a touch that never came', () => {
    const bars = series(35, () => 100, 0)
    const rates = moveRatesOf(bars, endOf(bars))!
    expect(rates.version).toBe(MOVE_RATES_VERSION)
    for (const horizon of MOVE_RATES_LINES.horizons) {
      const at = ratesAt(rates, horizon)!
      expect(at.close.every((rate) => rate.up === 0 && rate.down === 0 && rate.either === 0)).toBe(true)
      expect(at.touch.every((rate) => rate.either === 0 && rate.medianMinutes === null)).toBe(true)
    }
    // Every hour's close a horizon on is a moment: 35 days of hours, less the last horizon's.
    expect(ratesAt(rates, 'hour1')!.moments).toBe(35 * 24 - 1)
    expect(ratesAt(rates, 'hours24')!.moments).toBe(35 * 24 - 24)
  })

  it('count a steady rise at every move it clears, at the close and on the way, and the minutes to its first touch', () => {
    // 0.1% a bar: 1.2% an hour, 4.9% in four, 33% in a day.
    const bars = series(35, (i) => 100 * 1.001 ** i)
    const rates = moveRatesOf(bars, endOf(bars))!
    const hour = ratesAt(rates, 'hour1')!
    expect(hour.close.map((rate) => [rate.pct, rate.up, rate.down])).toEqual([
      [1, 1, 0],
      [2, 0, 0],
      [5, 0, 0]
    ])
    expect(ratesAt(rates, 'hours4')!.close.map((rate) => rate.up)).toEqual([1, 1, 0])
    expect(ratesAt(rates, 'hours24')!.close.map((rate) => rate.either)).toEqual([1, 1, 1])
    // +1% is first touched at the tenth bar after the close (its high 1.001^10 x 1.0005), fifty minutes on.
    expect(hour.touch[0]).toEqual({ pct: 1, up: 1, down: 0, either: 1, medianMinutes: 50 })
    expect(hour.touch[1]).toMatchObject({ pct: 2, up: 0, either: 0, medianMinutes: null })
  })

  it('count a fall on its own side, and a swing that touches both sides once either way', () => {
    // An hour up 1.5% and an hour back down, over and over: every hour's close is a top or a bottom.
    const swing = series(35, (i) => 100 * (1 + 0.015 * (1 - Math.abs(((i % 24) - 12) / 12))), 0)
    const hour = ratesAt(moveRatesOf(swing, endOf(swing)), 'hour1')!
    // Half the hours' closes are at the bottom (and rise 1.5%), half at the top (and fall 1.5%).
    expect(hour.close[0].up).toBeCloseTo(0.5, 2)
    expect(hour.close[0].down).toBeCloseTo(0.5, 2)
    expect(hour.close[0].either).toBeCloseTo(1, 6)
    expect(hour.touch[0].either).toBeCloseTo(1, 6)
  })

  it('time the first touch either way from the side touched first, and count each side it touched', () => {
    // Every hour: up 1.2% by the third bar after its close (fifteen minutes), down to -1.2% by the ninth.
    const PATH = [0, 0.4, 0.8, 1.2, 1, 0.5, 0, -0.5, -1.1, -1.2, -0.8, -0.4]
    const both = series(35, (i) => 100 * (1 + PATH[(i + 1) % 12] / 100), 0)
    const hour = ratesAt(moveRatesOf(both, endOf(both)), 'hour1')!
    expect(hour.touch[0]).toEqual({ pct: 1, up: 1, down: 1, either: 1, medianMinutes: 15 })
    // Its close an hour on is where it began: no move.
    expect(hour.close[0].either).toBe(0)
  })

  it('read no moment across a gap in the bars, nor a bar older than the window or not closed by the moment', () => {
    const bars = series(100, () => 100, 0)
    const at = endOf(bars)
    // Ninety days are read: 100 days on file make no more moments than ninety.
    const full = moveRatesOf(bars, at)!
    expect(ratesAt(full, 'hour1')!.moments).toBe(90 * 24 - 1)
    expect(full.fromSec).toBeGreaterThanOrEqual(at - 90 * DAY)
    // A bar missing an hour before the end: the moments whose horizon spans it are not read.
    const gapped = [...bars.slice(0, bars.length - 12), ...bars.slice(bars.length - 11)]
    expect(ratesAt(moveRatesOf(gapped, at), 'hour1')!.moments).toBeLessThan(ratesAt(full, 'hour1')!.moments)
    // A price that steps 2% up inside an hour the bars do not hold: no moment reads across it, so no move is counted.
    const stepped = series(40, (i) => (i < 5000 ? 100 : 102), 0)
    const holed = [...stepped.slice(0, 5000), ...stepped.slice(5012)]
    const read = moveRatesOf(holed, endOf(holed))!
    for (const horizon of MOVE_RATES_LINES.horizons) expect(ratesAt(read, horizon)!.close.every((rate) => rate.either === 0), horizon).toBe(true)
    // A moment before the last bar closed does not read it.
    const before = moveRatesOf(bars, at - 3600)!
    expect(before.toSec).toBeLessThanOrEqual(at - 3600 - 3600)
  })

  it('say nothing of a horizon with fewer than thirty days of moments, and nothing at all where none has them', () => {
    const short = series(20, () => 100, 0)
    expect(moveRatesOf(short, endOf(short))).toBeNull()
    // Thirty and a half days: 731 hours for the hour, 708 for the day, under the 720 a horizon needs.
    const month = series(31, () => 100, 0).slice(0, 31 * 288 - 144)
    const rates = moveRatesOf(month, endOf(month))!
    expect(ratesAt(rates, 'hour1')).not.toBeNull()
    expect(ratesAt(rates, 'hours24')).toBeNull()
    expect(ratesAt(null, 'hour1')).toBeNull()
  })
})
