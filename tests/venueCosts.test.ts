import { describe, expect, it } from 'vitest'
import { ROUND_TRIP_PCT } from '../shared/forecast/edge'
import { SLIPPAGE_RATE } from '../shared/fees'
import { COSTED_VENUES, VENUE_FEES, VENUE_STAKE_QUOTE, cheapestOf, impactPct, isCostedVenue, paperFillOf, roundTripOf, venueFeeOf, type RoundTrip } from '../shared/venueCosts'

// WHAT A ROUND TRIP COSTS, VENUE BY VENUE (shared/venueCosts.ts; V7.2-R Stage 4): a taker fee each way, the spread
// crossed, and each leg's impact at the stake from the book's levels; the flat slippage where only the best levels are
// read, the flat round trip at the venue's fee where no book is.

describe('the fees', () => {
  it('are each venue base tier, read with their date and source, and a pair rate replaces one where it was read', () => {
    expect(COSTED_VENUES).toEqual(['binance', 'bitget'])
    expect(VENUE_FEES.binance).toMatchObject({ takerPct: 0.1, makerPct: 0.1, readOn: '2026-10-22' })
    expect(VENUE_FEES.bitget).toMatchObject({ takerPct: 0.1, makerPct: 0.1, readOn: '2026-10-22' })
    expect(VENUE_FEES.bitget.source).toMatch(/0\.2% on 53 older/)
    expect(venueFeeOf('bitget', 0.002)).toBeCloseTo(0.2, 12)
    expect(venueFeeOf('bitget', 0.001)).toBeCloseTo(0.1, 12)
    expect(venueFeeOf('bitget', null)).toBe(0.1)
    // A rate that is no fraction of a fill is not read.
    expect(venueFeeOf('bitget', 0.5)).toBe(0.1)
    expect(venueFeeOf('binance', Number.NaN)).toBe(0.1)
    expect(isCostedVenue('bitget')).toBe(true)
    expect(isCostedVenue('kraken')).toBe(false)
  })
})

describe("a paper trade's fill", () => {
  it('is on the venue its round trip was read on, at its fee, each market fill a half spread and a leg of impact worse', () => {
    const trip: RoundTrip = { venue: 'bitget', feePct: 0.2, spreadPct: 0.06, impactPct: 0.04, totalPct: 0.5, basis: 'book' }
    const fill = paperFillOf(trip)
    expect(fill.exchange).toBe('bitget')
    expect(fill.feeRate).toBeCloseTo(0.002, 12)
    expect(fill.slippageRate).toBeCloseTo((0.03 + 0.02) / 100, 12)
    // Never under the flat slippage, however tight the book.
    expect(paperFillOf({ ...trip, spreadPct: 0, impactPct: 0 }).slippageRate).toBe(SLIPPAGE_RATE)
    // No round trip read: Binance at the flat lines.
    expect(paperFillOf(null)).toEqual({ exchange: 'binance', feeRate: 0.001, slippageRate: SLIPPAGE_RATE })
    expect(paperFillOf(undefined).exchange).toBe('binance')
    // The stake a round trip is costed at: the laboratory's most, a tenth of its 10,000 USDT.
    expect(VENUE_STAKE_QUOTE).toBe(1000)
  })
})

describe("a stake's impact", () => {
  const asks: [number, number][] = [
    [100, 5],
    [100.1, 5],
    [100.2, 10]
  ]

  it('is the average price of the levels it fills from against the best, and unknown past the levels read', () => {
    // 500 at 100, then 500 of the next level at 100.1: 9.995 coins for 1,000.
    expect(impactPct(asks, 1000)).toBeCloseTo((1000 / (5 + 500 / 100.1) / 100 - 1) * 100, 10)
    expect(impactPct(asks, 400)).toBeCloseTo(0, 12)
    expect(impactPct(asks, 10_000)).toBeNull()
    expect(impactPct([], 100)).toBeNull()
    expect(impactPct(asks, 0)).toBe(0)
    // A level with nothing at it is passed over.
    expect(impactPct([[100, 5], [100.05, 0], [100.1, 5]], 1000)).toBeCloseTo(impactPct(asks, 1000)!, 12)
  })
})

describe('a round trip', () => {
  const book = { bid: 99.95, ask: 100.05 }
  const levels = {
    asks: [
      [100.05, 4],
      [100.15, 20]
    ] as [number, number][],
    bids: [
      [99.95, 4],
      [99.85, 20]
    ] as [number, number][]
  }

  it('pays a fee each way, the spread crossed and each leg its impact from the levels', () => {
    const trip = roundTripOf({ venue: 'binance', feePct: 0.1, side: 'BUY', stakeQuote: 1000, book, levels })
    const entry = impactPct(levels.asks, 1000)!
    const exit = impactPct(levels.bids, 1000)!
    expect(trip.basis).toBe('book')
    expect(trip.spreadPct).toBeCloseTo(0.1, 10)
    expect(trip.impactPct).toBeCloseTo(entry + exit, 12)
    expect(trip.totalPct).toBeCloseTo(0.2 + 0.1 + entry + exit, 12)
    // A sell takes the bids first and the asks on the way out: the same here, the book being even.
    expect(roundTripOf({ venue: 'binance', feePct: 0.1, side: 'SELL', stakeQuote: 1000, book, levels }).totalPct).toBeCloseTo(trip.totalPct, 12)
  })

  it("takes the entry's impact from the side it buys into and the exit's from the other", () => {
    const lopsided = {
      asks: [
        [100.05, 1],
        [100.5, 100]
      ] as [number, number][],
      bids: [
        [99.95, 100],
        [99.9, 100]
      ] as [number, number][]
    }
    const trip = roundTripOf({ venue: 'binance', feePct: 0.1, side: 'BUY', stakeQuote: 1000, book, levels: lopsided })
    expect(trip.impactPct).toBeCloseTo(impactPct(lopsided.asks, 1000)! + impactPct(lopsided.bids, 1000)!, 12)
    expect(impactPct(lopsided.asks, 1000)!).toBeGreaterThan(impactPct(lopsided.bids, 1000)! + 0.1)
  })

  it('pays the flat slippage where only the best levels are read, or the levels do not hold the stake, and the flat round trip with no book', () => {
    const best = roundTripOf({ venue: 'bitget', feePct: 0.2, side: 'BUY', stakeQuote: 1000, book })
    expect(best).toMatchObject({ basis: 'best', feePct: 0.2 })
    expect(best.totalPct).toBeCloseTo(0.4 + 0.1 + 0.04, 12)
    expect(roundTripOf({ venue: 'bitget', feePct: 0.1, side: 'BUY', stakeQuote: 1_000_000, book, levels }).basis).toBe('best')
    const flat = roundTripOf({ venue: 'binance', feePct: 0.1, side: 'BUY', stakeQuote: 1000, book: null })
    expect(flat).toMatchObject({ basis: 'flat', spreadPct: null })
    // At Binance's fee the flat round trip is the 0.24% the forecast charged before.
    expect(flat.totalPct).toBeCloseTo(ROUND_TRIP_PCT, 12)
    expect(roundTripOf({ venue: 'binance', feePct: 0.1, side: 'BUY', stakeQuote: 1000, book: { bid: 101, ask: 100 } }).basis).toBe('flat')
  })

  it('is cheapest on the venue whose total is lowest, a tie to the first given', () => {
    const at = (venue: 'binance' | 'bitget', totalPct: number): RoundTrip => ({ venue, feePct: 0.1, spreadPct: 0.01, impactPct: 0, totalPct, basis: 'book' })
    expect(cheapestOf([at('binance', 0.25), at('bitget', 0.21)])!.venue).toBe('bitget')
    expect(cheapestOf([at('binance', 0.21), at('bitget', 0.21)])!.venue).toBe('binance')
    expect(cheapestOf([])).toBeNull()
  })
})
