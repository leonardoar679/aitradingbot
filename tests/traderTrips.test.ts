import { describe, expect, it } from 'vitest'
import type { FundingPayment, TraderFill } from '../shared/traders/hyperliquid'
import { orderedFills, roundTripsOf } from '../shared/traders/roundTrips'
import { traderFiguresOf } from '../shared/traders/traderFigures'

// A TRADER'S ROUND TRIPS AND FIGURES (shared/traders/roundTrips.ts, traderFigures.ts; V8 Stage 6): fills rebuilt into
// trips -- added to, reduced, closed, crossed through nothing -- in the order they were made, a trip opened before the
// record or missing fills left out; and the figures of the trips: net after fees and funding, how often they made money,
// the fall from a high, holds, stakes and leverage, money in and out, coins and what is open.

const T0 = 1_790_000_000_000
const MIN = 60_000
let tid = 1
const fill = (over: Partial<TraderFill> & Pick<TraderFill, 'side' | 'sz' | 'px' | 'startPosition'>): TraderFill => ({
  coin: 'BTC',
  timeMs: T0,
  dir: '',
  closedPnl: 0,
  fee: 0.01,
  feeToken: 'USDC',
  crossed: true,
  tid: tid++,
  oid: 1,
  label: 'VERIFIED',
  ...over
})

describe('round trips', () => {
  it('opens, adds to, reduces and closes a trip, its prices averaged by size', () => {
    const fills = [
      fill({ timeMs: T0, side: 'buy', sz: 1, px: 100, startPosition: 0 }),
      fill({ timeMs: T0 + MIN, side: 'buy', sz: 1, px: 110, startPosition: 1 }),
      fill({ timeMs: T0 + 2 * MIN, side: 'sell', sz: 0.5, px: 120, startPosition: 2, closedPnl: 7.5 }),
      fill({ timeMs: T0 + 3 * MIN, side: 'sell', sz: 1.5, px: 130, startPosition: 1.5, closedPnl: 37.5, fee: 0.05 })
    ]
    const { trips, partial, open } = roundTripsOf(fills)
    expect(partial).toBe(0)
    expect(open).toEqual([])
    expect(trips).toHaveLength(1)
    const [trip] = trips
    expect(trip).toMatchObject({ coin: 'BTC', side: 'long', openedAtMs: T0, closedAtMs: T0 + 3 * MIN, maxSize: 2, fills: 4, realizedPnl: 45 })
    expect(trip.entryPx).toBeCloseTo(105, 9)
    expect(trip.exitPx).toBeCloseTo(127.5, 9)
    expect(trip.entryNotional).toBeCloseTo(210, 9)
    expect(trip.fees).toBeCloseTo(0.08, 9)
    expect(trip.net).toBeCloseTo(44.92, 9)
    expect(trip.movePct).toBeCloseTo((127.5 / 105 - 1) * 100, 9)
  })

  it('closes a trip and opens the next where a fill crosses through nothing, its fee split by size', () => {
    const fills = [
      fill({ timeMs: T0, side: 'sell', sz: 2, px: 100, startPosition: 0, fee: 0.02 }),
      fill({ timeMs: T0 + MIN, side: 'buy', sz: 3, px: 90, startPosition: -2, closedPnl: 20, fee: 0.03 }),
      fill({ timeMs: T0 + 2 * MIN, side: 'sell', sz: 1, px: 95, startPosition: 1, closedPnl: 5, fee: 0.01 })
    ]
    const { trips } = roundTripsOf(fills)
    expect(trips.map((trip) => [trip.side, trip.entryPx, trip.exitPx, trip.maxSize])).toEqual([
      ['short', 100, 90, 2],
      ['long', 90, 95, 1]
    ])
    expect(trips[0].fees).toBeCloseTo(0.02 + 0.03 * (2 / 3), 12)
    expect(trips[1].fees).toBeCloseTo(0.03 * (1 / 3) + 0.01, 12)
    expect(trips[0].realizedPnl).toBe(20)
    expect(trips[1].realizedPnl).toBe(5)
    expect(trips[0].movePct).toBeCloseTo(10, 9)
  })

  it("leaves out a trip opened before the record, and one whose fills the record lacks, counting them", () => {
    const fills = [
      // Already long 1 when the record starts: its entry is not known.
      fill({ timeMs: T0, side: 'sell', sz: 1, px: 100, startPosition: 1, closedPnl: 3 }),
      // A trip whose size jumps: the record lacks a fill.
      fill({ timeMs: T0 + MIN, side: 'buy', sz: 1, px: 100, startPosition: 0 }),
      fill({ timeMs: T0 + 2 * MIN, side: 'sell', sz: 2, px: 101, startPosition: 2 }),
      // A whole trip.
      fill({ timeMs: T0 + 3 * MIN, side: 'buy', sz: 1, px: 100, startPosition: 0 }),
      fill({ timeMs: T0 + 4 * MIN, side: 'sell', sz: 1, px: 102, startPosition: 1, closedPnl: 2 })
    ]
    const result = roundTripsOf(fills)
    expect(result.partial).toBe(2)
    expect(result.trips).toHaveLength(1)
    expect(result.trips[0].openedAtMs).toBe(T0 + 3 * MIN)
  })

  it('drops a trip the venue says was flat before it closed, and keeps what is still open', () => {
    const fills = [
      fill({ timeMs: T0, side: 'buy', sz: 1, px: 100, startPosition: 0 }),
      // The venue says flat: the open trip's close is not on file.
      fill({ timeMs: T0 + MIN, side: 'sell', sz: 1, px: 101, startPosition: 0 }),
      fill({ coin: 'ETH', timeMs: T0 + 2 * MIN, side: 'buy', sz: 2, px: 10, startPosition: 0 })
    ]
    const result = roundTripsOf(fills)
    expect(result.partial).toBe(1)
    expect(result.trips).toEqual([])
    expect(result.open.map((leg) => [leg.coin, leg.side, leg.size, leg.partial])).toEqual([
      ['BTC', 'short', 1, false],
      ['ETH', 'long', 2, false]
    ])
  })

  it("orders a millisecond's fills by the position each started from, not by their trade ids", () => {
    // One sell taking three resting bids in the same millisecond, their ids out of order.
    const fills = [
      fill({ timeMs: T0, side: 'buy', sz: 3, px: 100, startPosition: 0, tid: 10 }),
      fill({ timeMs: T0 + MIN, side: 'sell', sz: 1, px: 101, startPosition: 1, tid: 99, closedPnl: 1 }),
      fill({ timeMs: T0 + MIN, side: 'sell', sz: 1, px: 101, startPosition: 3, tid: 50, closedPnl: 1 }),
      fill({ timeMs: T0 + MIN, side: 'sell', sz: 1, px: 101, startPosition: 2, tid: 70, closedPnl: 1 })
    ]
    expect(orderedFills(fills).map((entry) => entry.startPosition)).toEqual([0, 3, 2, 1])
    const result = roundTripsOf(fills)
    expect(result.partial).toBe(0)
    expect(result.trips).toHaveLength(1)
    expect(result.trips[0]).toMatchObject({ maxSize: 3, realizedPnl: 3, fills: 4 })
  })

  it("gives each funding payment to the trip of its coin open at its time, counts rebates, and counts spot fills apart", () => {
    const fills = [
      fill({ timeMs: T0, side: 'buy', sz: 1, px: 100, startPosition: 0, fee: -0.01 }),
      fill({ timeMs: T0 + 10 * MIN, side: 'sell', sz: 1, px: 100, startPosition: 1, fee: 0.02 }),
      fill({ coin: '@107', timeMs: T0 + MIN, side: 'sell', sz: 1, px: 70, startPosition: 5 })
    ]
    const funding: FundingPayment[] = [
      { timeMs: T0 + 5 * MIN, coin: 'BTC', usdc: -0.3, szi: 1, rate: 0.0001 },
      { timeMs: T0 + 11 * MIN, coin: 'BTC', usdc: -9, szi: 0, rate: 0.0001 },
      { timeMs: T0 + 5 * MIN, coin: 'ETH', usdc: -9, szi: 1, rate: 0.0001 }
    ]
    const result = roundTripsOf(fills, funding)
    expect(result.spotFills).toBe(1)
    expect(result.trips).toHaveLength(1)
    const [trip] = result.trips
    expect(trip.funding).toBeCloseTo(-0.3, 12)
    expect(trip.fees).toBeCloseTo(0.01, 12)
    expect(trip.rebates).toBeCloseTo(0.01, 12)
    expect(trip.net).toBeCloseTo(0 - 0.01 - 0.3, 12)
  })
})

describe("a trader's figures", () => {
  const trip = (k: number, net: number, over: Partial<Parameters<typeof traderFiguresOf>[0]['roundTrips']['trips'][number]> = {}) => ({
    coin: k % 3 === 0 ? 'ETH' : 'BTC',
    side: 'long' as const,
    openedAtMs: T0 + k * 86_400_000,
    closedAtMs: T0 + k * 86_400_000 + (k + 1) * 10 * MIN,
    entryPx: 100,
    exitPx: 100,
    maxSize: 1,
    entryNotional: 100 * (k + 1),
    realizedPnl: net + 0.1,
    fees: 0.1,
    rebates: 0,
    funding: 0,
    net,
    movePct: 0,
    fills: 2,
    ...over
  })
  it('sums the trips after fees and funding, and reads their win rate, holds, stakes and the fall from a high', () => {
    const trips = [trip(0, 10), trip(1, -4), trip(2, -6), trip(3, 20)]
    const figures = traderFiguresOf({
      roundTrips: { version: 'round-trips-v1', trips, open: [], partial: 2, spotFills: 1 },
      values: [{ timeMs: T0 - 1, value: 100 }, { timeMs: T0 + 1.5 * 86_400_000, value: 200 }],
      ledger: [
        { timeMs: T0 + 86_400_000, type: 'deposit', usdc: 50 },
        { timeMs: T0 + 86_400_000, type: 'withdraw', usdc: -20 },
        { timeMs: T0 - 99 * 86_400_000, type: 'deposit', usdc: 1000 }
      ],
      state: { atMs: T0 + 9 * 86_400_000, accountValue: 321, positions: [{ coin: 'SOL', size: -2, entryPx: 150, positionValue: 300, unrealizedPnl: -4.5, leverage: { type: 'cross', value: 3 }, liquidationPx: null, marginUsed: 100, fundingSinceOpen: 0 }] }
    })
    expect(figures).toMatchObject({ trips: 4, partial: 2, spotFills: 1, winRate: 0.5 })
    expect(figures.money.net).toBeCloseTo(20, 9)
    expect(figures.money.fees).toBeCloseTo(0.4, 9)
    expect(figures.money.realized).toBeCloseTo(20.4, 9)
    // Up 10, down to 0: a fall of 10 from the high reached on the first day, when the account held 100.
    expect(figures.drawdown).toEqual({ usdc: 10, pctOfAccount: 10 })
    expect(figures.holdMin).toEqual({ p10: 13, median: 25, p90: 37 })
    expect(figures.stake).toEqual({ medianUsdc: 250 })
    // Stakes over the account's value when each opened: 100/100, 200/100, 300/200, 400/200.
    expect(figures.leverage).toEqual({ median: 1.75, max: 2, trips: 4 })
    // Only the money moved within the trips' span.
    expect(figures.ledger).toEqual({ deposits: 50, withdrawals: 20 })
    expect(figures.coins).toEqual([
      { coin: 'BTC', trips: 2, net: -10 },
      { coin: 'ETH', trips: 2, net: 30 }
    ])
    expect(figures.span).toMatchObject({ fromMs: T0, tradingDays: 4 })
    expect(figures.open).toMatchObject({ unrealized: -4.5, accountValue: 321 })
  })
  it('has nothing to say of a record without a completed trip', () => {
    const figures = traderFiguresOf({ roundTrips: { version: 'round-trips-v1', trips: [], open: [], partial: 0, spotFills: 0 }, values: [], ledger: [], state: null })
    expect(figures).toMatchObject({ trips: 0, span: null, winRate: null, holdMin: null, stake: null, leverage: null, drawdown: { usdc: 0, pctOfAccount: null } })
  })
})
