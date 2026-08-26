import { describe, expect, it } from 'vitest'
import { limitFillPrice, simulateDca, simulateGrid, simulatePosition } from '../src/executors/engine'
import type { Candle, DcaExecutorParams, GridExecutorParams, PositionExecutorParams } from '../shared/ipc'

// simulateOrder was fixed to treat a limit order as a standing bid or offer rather than asking
// whether the candle printed exactly at its price. Grid levels, DCA levels and a position's entry
// price still required that straddle, so the same order filled or sat pending forever depending on
// which executor happened to be holding it.

const T = 1_700_000_000
const c = (i: number, open: number, high: number, low: number, close: number): Candle => ({
  time: T + i * 60, open, high, low, close, volume: 1
})

describe('limitFillPrice', () => {
  it('fills a buy at its own price when the candle comes down to it', () => {
    expect(limitFillPrice(c(0, 105, 106, 99, 100), 100, true)).toBe(100)
  })

  it('fills a buy at the open when the candle gapped clean through it', () => {
    // A buy at 95 and a candle spanning 88-91: sellers sweeping down the book take the 95 bid on
    // the way past. The straddle test left this order pending for good.
    expect(limitFillPrice(c(0, 91, 91, 88, 89), 95, true)).toBe(91)
  })

  it('fills a buy at the open when it was already marketable', () => {
    expect(limitFillPrice(c(0, 100, 101, 99, 100), 120, true)).toBe(100)
  })

  it('leaves a buy pending when the candle never reached it', () => {
    expect(limitFillPrice(c(0, 105, 106, 101, 104), 100, true)).toBeNull()
  })

  it('mirrors all of it for a sell', () => {
    expect(limitFillPrice(c(0, 95, 101, 94, 100), 100, false)).toBe(100)
    expect(limitFillPrice(c(0, 109, 112, 108, 110), 100, false)).toBe(109)
    expect(limitFillPrice(c(0, 100, 101, 99, 100), 80, false)).toBe(100)
    expect(limitFillPrice(c(0, 95, 99, 94, 96), 100, false)).toBeNull()
  })
})

describe('a position whose entry price is above the market', () => {
  const params = (entryPrice: number): PositionExecutorParams =>
    ({ side: 'buy', amountQuote: 300, entryPrice, takeProfitPct: 1000, stopLossPct: null, timeLimitSec: null, trailingStop: null }) as PositionExecutorParams

  it('enters immediately instead of reporting the price was never reached', () => {
    // Found by running the app: a Position executor buying at 200000 while BTC traded near 110000
    // reported "the entry price was never reached — nothing was bought" over 8,642 candles. On any
    // exchange that is a marketable buy limit and fills at once.
    const state = simulatePosition([c(0, 100, 101, 99, 100), c(1, 100, 102, 99, 101)], params(200))

    expect(state.status).not.toBe('pending')
    expect(state.entryPrice).toBe(100)
    expect(state.enteredAt).toBe(T)
  })

  it('still waits for a price below the market', () => {
    const state = simulatePosition([c(0, 100, 101, 99, 100), c(1, 100, 102, 99, 101)], params(90))

    expect(state.status).toBe('pending')
    expect(state.entryPrice).toBeNull()
  })

  it('enters on a candle that gapped through the entry price', () => {
    const state = simulatePosition([c(0, 100, 101, 99, 100), c(1, 91, 91, 88, 89)], params(95))

    expect(state.entryPrice).toBe(91)
  })
})

describe('a DCA level the price gapped past', () => {
  const params: DcaExecutorParams = {
    side: 'buy',
    levels: [{ priceOffsetPct: 0, amountQuote: 100 }, { priceOffsetPct: 10, amountQuote: 100 }],
    takeProfitPct: 1000,
    stopLossPct: null,
    timeLimitSec: null
  } as DcaExecutorParams

  it('fills the level rather than leaving the ladder half-built', () => {
    // Level two sits at 90. A candle spanning 85-88 never prints at 90, but a resting bid there
    // is taken on the way down.
    const state = simulateDca([c(0, 100, 101, 99, 100), c(1, 88, 88, 85, 86)], params, 100)

    expect(state.fills).toHaveLength(2)
    expect(state.fills[1].price).toBe(88)
  })

  it('leaves a level the price never approached unfilled', () => {
    const state = simulateDca([c(0, 100, 101, 99, 100), c(1, 100, 102, 95, 101)], params, 100)

    expect(state.fills).toHaveLength(1)
  })
})

describe('a grid rung, which is not an ordinary limit order', () => {
  const params: GridExecutorParams = {
    side: 'buy', startPrice: 100, endPrice: 110, totalAmountQuote: 300,
    maxOpenOrders: 10, levelSpreadPct: 5, takeProfitPct: 5, limitPrice: null
  }

  it('does not buy every rung above the market at once', () => {
    // The rungs are 100, 105 and 110. Treating them as ordinary limit orders makes the two above
    // the market marketable on arrival, and the whole grid collapses into one bulk buy at the
    // open -- the opposite of what a grid does.
    const state = simulateGrid([c(0, 100, 100.5, 99.5, 100)], params)

    expect(state.filledCount).toBe(1)
    expect(state.levels.filter((l) => l.status === 'filled')[0].entryPrice).toBe(100)
  })

  it('does not buy a rung on the way up through it', () => {
    // Opening at 100 and running to 106: the grid had no bid resting at 105 to be hit, because
    // the market had never been up there.
    const state = simulateGrid([c(0, 100, 100.5, 99.5, 100), c(1, 100, 106, 100, 106)], params)

    expect(state.levels.find((l) => l.price === 105)?.status).toBe('pending')
  })

  it('buys the rung once the market has been above it and comes back down', () => {
    const state = simulateGrid(
      [c(0, 106, 106, 105.5, 106), c(1, 106, 106, 104, 104.5)],
      params
    )

    expect(state.levels.find((l) => l.price === 105)?.status).toBe('filled')
    expect(state.levels.find((l) => l.price === 105)?.entryPrice).toBe(105)
  })

  it('buys an armed rung at the open when a candle gaps past it', () => {
    // Armed at 106, then a candle opening at 103 skips straight past the 105 rung. Requiring the
    // straddle left that rung pending while the price ran away below it.
    const state = simulateGrid(
      [c(0, 106, 106, 105.5, 106), c(1, 103, 103, 101, 102)],
      params
    )

    expect(state.levels.find((l) => l.price === 105)?.entryPrice).toBe(103)
  })
})
