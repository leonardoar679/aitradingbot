import { describe, expect, it } from 'vitest'
import type { ForecastBar } from '../shared/forecast/bars'
import type { PricePrediction } from '../shared/forecast/prediction'
import { RANGE_LINES, bandOrderOf, gridOrderOf, resolveBand, resolveGrid, type BandOrder, type GridOrder } from '../shared/forecast/rangeStrategies'

// THE TWO STRATEGIES THAT NEED NO WAY (shared/forecast/rangeStrategies.ts; V7.2-R Stage 5): a band's bid at the P10
// price, sold at the median or stopped at the excursion's likely low, and a day's grid between P10 and P90 -- each order
// made from a forecast and played on the bars after it by rules that flatter less.

const T = 1_800_000_000
const bar = (k: number, open: number, high: number, low: number, close: number): ForecastBar => ({ time: T + k * 300, open, high, low, close, volume: 1, quoteVolume: open, takerBuyVolume: 0.5, trades: 1 })
/** Twelve quiet bars at 99.5 (an hour), with the given ones put in place. */
const hour = (put: Record<number, [number, number, number, number]> = {}): ForecastBar[] => Array.from({ length: 12 }, (_, k) => (put[k] === undefined ? bar(k, 99.5, 99.6, 99.4, 99.5) : bar(k, ...put[k])))

const band = (overrides: Partial<BandOrder> = {}): BandOrder => ({ pair: 'SOLUSDT', predictionId: 'p', t: T, horizon: 'hour1', price: 100, entry: 98, target: 100, stop: 97, until: T + 3600, ...overrides })
const legs = (buy: number, sell: number, buyFee: number, sellFee: number): number => ((sell / buy) * (1 - sellFee / 100) - 1 - buyFee / 100) * 100
const fee = RANGE_LINES.makerFeePct
const slip = (price: number): number => price * (1 - RANGE_LINES.slippagePct / 100)

function prediction(levels: number[], lowPct: number[] | null, horizon: 'hour1' | 'hours24' = 'hour1'): PricePrediction {
  return {
    id: 'SOLUSDT:1:2',
    pair: 'SOLUSDT',
    barTime: T,
    currentPrice: 100,
    horizons: { [horizon]: { quantilePrices: levels, ...(lowPct === null ? {} : { excursion: { highPct: [1, 2, 3], lowPct, held: null } }) } }
  } as unknown as PricePrediction
}

describe("a band's bid", () => {
  it('rests at the P10 price, is sold at the median, and is stopped at the likely low the path stays above nine times in ten', () => {
    const order = bandOrderOf(prediction([98, 99, 100, 101, 102], [-1, -2, -3]), 'hour1')!
    expect(order).toMatchObject({ pair: 'SOLUSDT', t: T, horizon: 'hour1', price: 100, entry: 98, target: 100, until: T + 3600 })
    expect(order.stop).toBeCloseTo(97, 12)
    expect(bandOrderOf(prediction([98, 99, 100, 101, 102], [-1, -2, -3], 'hours24'), 'hours24')!.until).toBe(T + 86_400)
  })

  it('is no order where the horizon is not forecast, the bid is not under the price, the median does not clear a round trip, or no stop can be read under the bid', () => {
    expect(bandOrderOf(prediction([98, 99, 100, 101, 102], [-1, -2, -3]), 'hours4')).toBeNull()
    expect(bandOrderOf(prediction([100, 100.5, 101, 101.5, 102], [-1, -2, -3]), 'hour1')).toBeNull()
    // The median 0.2% over the bid: under the 0.24% round trip.
    expect(bandOrderOf(prediction([99.8, 99.9, 100, 100.1, 100.2], [-1, -2, -3]), 'hour1')).toBeNull()
    expect(bandOrderOf(prediction([99.7, 99.9, 100, 100.1, 100.2], [-1, -2, -3]), 'hour1')).not.toBeNull()
    expect(bandOrderOf(prediction([98, 99, 100, 101, 102], null), 'hour1')).toBeNull()
    // A likely low at or over the bid leaves no room for a stop.
    expect(bandOrderOf(prediction([98, 99, 100, 101, 102], [-1, -1.5, -2]), 'hour1')).toBeNull()
  })

  it('fills only where a later bar trades through it, at its own price, never better', () => {
    // A touch of 98 exactly, and 0.01% under it: not through.
    expect(resolveBand(band(), hour({ 3: [99, 99.2, 98, 98.5], 4: [98.5, 98.6, 97.99, 98.2] }))).toMatchObject({ exit: 'unfilled', filledAt: null, netPct: 0, grossPct: 0, costPct: 0, endedAt: T + 3600 })
    // Through by 0.02%, then up to the median and through it: filled at 98 even on a bar that opened under it.
    const made = resolveBand(band(), hour({ 3: [97.5, 98.2, 97.4, 98], 6: [99.5, 100.03, 99.4, 99.9] }))!
    expect(made).toMatchObject({ exit: 'target', filledAt: T + 900, fillPrice: 98, exitAt: T + 1800, exitPrice: 100, endedAt: T + 2100 })
    expect(made.grossPct).toBeCloseTo((100 / 98 - 1) * 100, 12)
    expect(made.netPct).toBeCloseTo(legs(98, 100, fee, fee), 12)
    expect(made.costPct).toBeCloseTo(made.grossPct - made.netPct, 12)
  })

  it('is stopped in the bar it filled in where that bar went on down through the stop, and is not sold at its target in it', () => {
    const stopped = resolveBand(band(), hour({ 2: [99, 99.2, 96.5, 96.8] }))!
    expect(stopped).toMatchObject({ exit: 'stop', filledAt: T + 600, exitAt: T + 600 })
    expect(stopped.exitPrice).toBeCloseTo(slip(97), 12)
    expect(stopped.netPct).toBeCloseTo(legs(98, slip(97), fee, RANGE_LINES.takerFeePct), 12)
    // Down through the bid and up through the median in one bar: sold a bar later, not in it.
    const later = resolveBand(band(), hour({ 2: [99, 100.5, 97.9, 100.2], 3: [100.2, 100.5, 100, 100.3] }))!
    expect(later).toMatchObject({ exit: 'target', filledAt: T + 600, exitAt: T + 900 })
  })

  it('calls a later bar that reached both its stop and its target a stop, and takes a gap past the stop at the open', () => {
    const both = resolveBand(band(), hour({ 2: [99, 99.2, 97.9, 98.4], 4: [98.5, 100.5, 96.9, 99] }))!
    expect(both).toMatchObject({ exit: 'stop', exitAt: T + 1200 })
    expect(both.exitPrice).toBeCloseTo(slip(97), 12)
    const gapped = resolveBand(band(), hour({ 2: [99, 99.2, 97.9, 98.4], 5: [96, 96.5, 95.8, 96.2] }))!
    expect(gapped).toMatchObject({ exit: 'stop', exitAt: T + 1500 })
    expect(gapped.exitPrice).toBeCloseTo(slip(96), 12)
  })

  it("is sold at its horizon's last close at market where nothing else ended it", () => {
    const timed = resolveBand(band(), hour({ 2: [99, 99.2, 97.9, 98.4], 11: [98.6, 98.9, 98.5, 98.8] }))!
    expect(timed).toMatchObject({ exit: 'time', exitAt: T + 3300, endedAt: T + 3600 })
    expect(timed.exitPrice).toBeCloseTo(slip(98.8), 12)
    expect(timed.grossPct).toBeCloseTo((98.8 / 98 - 1) * 100, 12)
    expect(timed.netPct).toBeCloseTo(legs(98, slip(98.8), fee, RANGE_LINES.takerFeePct), 12)
  })

  it('is not settled where the bars on file stop before its horizon ends', () => {
    expect(resolveBand(band(), hour().slice(0, 11))).toBeNull()
    // A bar missing inside the hour is no reason: its last bar is there.
    const gappy = hour({ 2: [99, 99.2, 97.9, 98.4] }).filter((_, k) => k !== 7)
    expect(resolveBand(band(), gappy)!.exit).toBe('time')
  })
})

describe("a day's grid", () => {
  it('spans P10 to P90 in steps of at least twice the round trip, at most forty of them', () => {
    const order = gridOrderOf(prediction([96, 98, 100, 102, 104], null, 'hours24'))!
    const least = 2 * 0.24
    expect(order.steps).toBe(Math.floor(Math.log(104 / 96) / Math.log(1 + least / 100)))
    expect(order.steps).toBe(16)
    expect(order.stepPct).toBeGreaterThanOrEqual(least)
    expect(order.lower * (1 + order.stepPct / 100) ** order.steps).toBeCloseTo(104, 9)
    expect(order).toMatchObject({ t: T, until: T + 86_400, lower: 96, upper: 104, horizon: 'hours24' })
    expect(gridOrderOf(prediction([50, 80, 100, 150, 200], null, 'hours24'))!.steps).toBe(40)
    // Two steps exactly, and a hair under.
    const two = 100 * (1 + least / 100) ** 2
    expect(gridOrderOf(prediction([99.9, 99.95, 100, 100.4, 99.9 * (two / 100) + 1e-9], null, 'hours24'))!.steps).toBe(2)
    expect(gridOrderOf(prediction([99.9, 99.95, 100, 100.4, 99.9 * (two / 100) - 1e-6], null, 'hours24'))).toBeNull()
  })

  it('is no grid where the day is not forecast or the price is not inside its range', () => {
    expect(gridOrderOf(prediction([96, 98, 100, 102, 104], null, 'hour1'))).toBeNull()
    expect(gridOrderOf(prediction([100.5, 101, 102, 103, 104], null, 'hours24'))).toBeNull()
    expect(gridOrderOf(prediction([96, 97, 98, 99, 99.9], null, 'hours24'))).toBeNull()
  })

  const small = (overrides: Partial<GridOrder> = {}): GridOrder => ({ pair: 'SOLUSDT', predictionId: 'p', t: T, horizon: 'hours24', price: 101.5, lower: 100, upper: 102.01, steps: 2, stepPct: 1, until: T + 1800, ...overrides })

  it('buys a rung where a bar trades through it, sells it a step up a bar later or after, and buys it again', () => {
    const bars = [
      // Opened over both rungs: both bid; the low through 101 alone.
      bar(0, 101.5, 101.6, 100.9, 101.2),
      // Through 102.01: the 101 rung sold.
      bar(1, 101.2, 102.1, 101.1, 101.8),
      // Down through both: both bought.
      bar(2, 101.8, 101.9, 99.9, 100.5),
      // Up through 101: the 100 rung sold; the 101 rung's step up not reached.
      bar(3, 100.5, 101.2, 100.4, 101),
      bar(4, 101, 101.1, 100.8, 100.9),
      bar(5, 100.9, 100.95, 100.5, 100.6)
    ]
    const made = resolveGrid(small(), bars)!
    expect(made).toMatchObject({ cycles: 2, heldAtEnd: 1, maxHeld: 2, endedAt: T + 1800 })
    const net = 0.5 * (legs(101, 102.01, fee, fee) + legs(100, 101, fee, fee) + legs(101, slip(100.6), fee, RANGE_LINES.takerFeePct))
    expect(made.netPct).toBeCloseTo(net, 12)
    expect(made.grossPct).toBeCloseTo(0.5 * ((102.01 / 101 - 1) + (101 / 100 - 1) + (100.6 / 101 - 1)) * 100, 12)
    expect(made.costPct).toBeCloseTo(made.grossPct - made.netPct, 12)
  })

  it('does not sell a rung in the bar it was bought in, nor buy it again in the bar it was sold in', () => {
    // Bought and through its step up in the same bar: held.
    const same = resolveGrid(small(), [bar(0, 101.5, 102.1, 100.9, 101.5), bar(1, 101.5, 101.6, 101.3, 101.5), bar(2, 101.5, 101.6, 101.3, 101.5), bar(3, 101.5, 101.6, 101.3, 101.5), bar(4, 101.5, 101.6, 101.3, 101.5), bar(5, 101.5, 101.6, 101.3, 101.5)])!
    expect(same).toMatchObject({ cycles: 0, heldAtEnd: 1 })
    // Sold, then down through it again in the same bar: not bought again in it; the price not back through it after.
    const again = resolveGrid(small(), [bar(0, 101.5, 101.6, 100.9, 101.2), bar(1, 101.2, 102.1, 100.9, 101.2), bar(2, 101.2, 101.3, 101.05, 101.1), bar(3, 101.1, 101.2, 101.05, 101.1), bar(4, 101.1, 101.2, 101.05, 101.1), bar(5, 101.1, 101.2, 101.05, 101.1)])!
    expect(again).toMatchObject({ cycles: 1, heldAtEnd: 0, maxHeld: 1 })
    // Bought again in the next bar that trades through it.
    const later = resolveGrid(small(), [bar(0, 101.5, 101.6, 100.9, 101.2), bar(1, 101.2, 102.1, 100.9, 101.2), bar(2, 101.2, 101.3, 100.9, 101.1), bar(3, 101.1, 101.2, 101.05, 101.1), bar(4, 101.1, 101.2, 101.05, 101.1), bar(5, 101.1, 101.2, 101.05, 101.1)])!
    expect(later).toMatchObject({ cycles: 1, heldAtEnd: 1 })
  })

  it('bids no rung over the market until a bar has opened at or over it', () => {
    const bars = [
      bar(0, 100.5, 100.7, 100.3, 100.6),
      // Through 101 from below, on a bar that opened under it: no bid rests there yet.
      bar(1, 100.6, 101.3, 100.5, 100.9),
      bar(2, 100.9, 101, 100.85, 100.95),
      // Opened over 101: bid; through it: bought.
      bar(3, 101.2, 101.4, 100.95, 101.1),
      bar(4, 101.1, 101.2, 101, 101.1),
      bar(5, 101.1, 101.2, 101, 101.1)
    ]
    const made = resolveGrid(small(), bars)!
    expect(made).toMatchObject({ cycles: 0, heldAtEnd: 1, maxHeld: 1 })
    // Through it from below and never opened over it after: never bid, never bought.
    const never = resolveGrid(small(), [bar(0, 100.5, 100.7, 100.3, 100.6), bar(1, 100.6, 101.3, 100.5, 100.9), ...[2, 3, 4, 5].map((k) => bar(k, 100.9, 101, 100.7, 100.9))])!
    expect(never).toMatchObject({ cycles: 0, heldAtEnd: 0, maxHeld: 0, netPct: 0 })
  })

  it('is not settled where the bars on file stop before its day ends', () => {
    expect(resolveGrid(small(), [bar(0, 101.5, 101.6, 100.9, 101.2)])).toBeNull()
  })
})
