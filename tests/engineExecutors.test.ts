import { describe, it, expect } from 'vitest'
import { simulateTwap, simulateOrder, simulatePosition, simulateGrid, twapNumOrders, buildGridLevels } from '../src/executors/engine'
import { scoreOpportunity, type OpportunityCall } from '../shared/aiOpportunityOutcome'
import { FEE_RATE } from '../shared/fees'
import type { Candle, TwapExecutorParams, OrderExecutorParams, PositionExecutorParams, GridExecutorParams } from '../shared/ipc'

const c = (time: number, open: number, high: number, low: number, close: number): Candle => ({ time, open, high, low, close, volume: 0 })

describe('simulateTwap', () => {
  const params: TwapExecutorParams = { side: 'buy', totalAmountQuote: 1000, totalDurationSec: 300, orderIntervalSec: 100 }

  it('derives slice count from duration / interval', () => {
    expect(twapNumOrders(params)).toBe(3)
    expect(twapNumOrders({ ...params, totalDurationSec: 50 })).toBe(1) // never below one
  })

  it('splits the notional evenly across slices', () => {
    const s = simulateTwap([c(0, 10, 10, 10, 10)], params, 0)
    expect(s.numOrders).toBe(3)
    expect(s.amountPerOrder).toBeCloseTo(1000 / 3, 9)
  })

  it('reports partial progress before every slice is due', () => {
    const s = simulateTwap([c(0, 10, 10, 10, 10)], params, 0)
    expect(s.fills).toHaveLength(1)
    expect(s.progressPct).toBeCloseTo(100 / 3, 6)
    expect(s.done).toBe(false)
  })

  it('completes once every slice time has passed and averages by VWAP', () => {
    const s = simulateTwap([c(0, 10, 10, 10, 10), c(100, 20, 20, 20, 20), c(200, 40, 40, 40, 40)], params, 0)
    expect(s.done).toBe(true)
    expect(s.fills).toHaveLength(3)
    const per = 1000 / 3
    const qty = per / 10 + per / 20 + per / 40
    expect(s.vwap).toBeCloseTo(1000 / qty, 6)
    // VWAP must be below the arithmetic mean of 10/20/40, since equal *quote* buys more when cheap
    expect(s.vwap!).toBeLessThan((10 + 20 + 40) / 3)
  })

  it('has no VWAP before any slice fills', () => {
    expect(simulateTwap([], params, 0).vwap).toBeNull()
  })
})

describe('simulateOrder', () => {
  it('fills a market order at the first open', () => {
    const s = simulateOrder([c(1, 42, 50, 40, 45)], { side: 'buy', amountQuote: 100, executionStrategy: 'market', limitPrice: null })
    expect(s.status).toBe('filled')
    expect(s.fillPrice).toBe(42)
  })

  it('leaves a limit order pending until price touches it', () => {
    const p: OrderExecutorParams = { side: 'buy', amountQuote: 100, executionStrategy: 'limit', limitPrice: 30 }
    expect(simulateOrder([c(1, 42, 50, 40, 45)], p).status).toBe('pending')
    const s = simulateOrder([c(1, 42, 50, 40, 45), c(2, 40, 41, 29, 31)], p)
    expect(s.status).toBe('filled')
    expect(s.fillPrice).toBe(30)
    expect(s.filledAt).toBe(2)
  })

  it('stays pending when a limit order has no price', () => {
    expect(simulateOrder([c(1, 42, 50, 40, 45)], { side: 'buy', amountQuote: 100, executionStrategy: 'limit', limitPrice: null }).status).toBe('pending')
  })

  it('returns pending with no candles at all', () => {
    expect(simulateOrder([], { side: 'buy', amountQuote: 100, executionStrategy: 'market', limitPrice: null }).status).toBe('pending')
  })
})

describe('simulatePosition barriers', () => {
  const p: PositionExecutorParams = {
    side: 'buy', entryPrice: null, amountQuote: 1000,
    takeProfitPct: null, stopLossPct: null, timeLimitSec: null, trailingStop: null
  }

  it('enters at market on the first candle when no entry price is set', () => {
    const s = simulatePosition([c(1, 100, 101, 99, 100)], p)
    expect(s.status).toBe('open')
    expect(s.entryPrice).toBe(100)
  })

  it('waits for a touch when an entry price is set', () => {
    const s = simulatePosition([c(1, 100, 101, 99, 100)], { ...p, entryPrice: 90 })
    expect(s.status).toBe('pending')
  })

  it('exits on a time limit with the reason recorded', () => {
    const s = simulatePosition([c(1, 100, 101, 99, 100), c(500, 100, 101, 99, 100)], { ...p, timeLimitSec: 10 })
    expect(s.status).toBe('closed')
    expect(s.exitReason).toBe('time_limit')
  })

  it("pays its venue's fee where it carries one, FEE_RATE otherwise (V7.2-R Stage 4)", () => {
    const candles = [c(1, 100, 101, 99, 100), c(500, 100, 101, 99, 100)]
    // A flat round trip at 100: what is lost is the fee, on 1,000 in and 1,000 out.
    const flat = simulatePosition(candles, { ...p, timeLimitSec: 10 })
    expect(flat.realizedPnl).toBeCloseTo(-2000 * FEE_RATE, 9)
    expect(simulatePosition(candles, { ...p, timeLimitSec: 10, feeRate: 0.002 }).realizedPnl).toBeCloseTo(-2000 * 0.002, 9)
    // A rate that is no fraction of a fill is not read.
    expect(simulatePosition(candles, { ...p, timeLimitSec: 10, feeRate: 2 }).realizedPnl).toBeCloseTo(-2000 * FEE_RATE, 9)
  })

  it('only trails after the activation threshold is cleared', () => {
    const trailing: PositionExecutorParams = { ...p, trailingStop: { activationPct: 10, trailPct: 5 } }
    // Rises to 105 (below the 110 activation) then falls back -- must NOT have trailed out.
    const notActivated = simulatePosition([c(1, 100, 101, 99, 100), c(2, 100, 105, 99, 100)], trailing)
    expect(notActivated.status).toBe('open')
    // Rises past 110, then drops more than 5% off the peak -> trailing stop fires.
    const activated = simulatePosition([c(1, 100, 101, 99, 100), c(2, 100, 120, 99, 118), c(3, 118, 118, 100, 101)], trailing)
    expect(activated.status).toBe('closed')
    expect(activated.exitReason).toBe('trailing_stop')
  })
})

describe('simulatePosition: an entry that expires', () => {
  const p: PositionExecutorParams = {
    side: 'buy', entryPrice: 90, amountQuote: 1000,
    takeProfitPct: 5, stopLossPct: 5, timeLimitSec: 3600, trailingStop: null, entryExpiresAt: 300
  }

  it('abandons an entry the price never reached, at the first candle that opens at or after the expiry', () => {
    const s = simulatePosition([c(60, 100, 101, 99, 100), c(240, 100, 101, 95, 96), c(300, 96, 97, 80, 85), c(360, 85, 86, 70, 72)], p)
    // The candle at 300 trades through 90, and it is too late: the entry was good until 300.
    expect(s).toMatchObject({ status: 'closed', exitReason: 'entry_expired', entryPrice: null, enteredAt: null, exitPrice: null, closedAt: 300, realizedPnl: 0 })
  })

  it('fills in the last candle that opens before the expiry, and is then an ordinary position', () => {
    const s = simulatePosition([c(60, 100, 101, 99, 100), c(240, 91, 91.5, 89, 90.5), c(300, 90.5, 91, 90, 90.5), c(360, 90.5, 92, 90, 91)], p)
    expect(s.status).toBe('open')
    expect(s.entryPrice).toBe(90)
    expect(s.enteredAt).toBe(240)
    expect(s.exitReason).toBeNull()
  })

  it('goes on to its own exits once it has filled, however long after the expiry they come', () => {
    const s = simulatePosition([c(240, 91, 91.5, 89, 90.5), c(900, 90.5, 96, 90, 95)], p)
    expect(s).toMatchObject({ status: 'closed', exitReason: 'take_profit', entryPrice: 90, closedAt: 900 })
    expect(s.realizedPnl).toBeGreaterThan(0)
  })

  it('abandons a market entry whose first candle is already past the expiry', () => {
    const s = simulatePosition([c(300, 100, 101, 99, 100)], { ...p, entryPrice: null })
    expect(s).toMatchObject({ status: 'closed', exitReason: 'entry_expired', entryPrice: null, realizedPnl: 0 })
    // One second earlier it is a market entry like any other.
    expect(simulatePosition([c(299, 100, 101, 99, 100)], { ...p, entryPrice: null })).toMatchObject({ status: 'open', entryPrice: 100 })
  })

  it('is still waiting while no candle has reached the expiry', () => {
    expect(simulatePosition([c(60, 100, 101, 99, 100), c(240, 100, 101, 95, 96)], p).status).toBe('pending')
  })

  it('waits for ever with no expiry, as every position stored before there was one does', () => {
    const forever: PositionExecutorParams = { side: 'buy', entryPrice: 90, amountQuote: 1000, takeProfitPct: 5, stopLossPct: 5, timeLimitSec: 3600, trailingStop: null }
    const candles = [c(60, 100, 101, 99, 100), c(86_400 * 30, 100, 101, 95, 96)]
    expect(simulatePosition(candles, forever).status).toBe('pending')
    expect(simulatePosition(candles, { ...forever, entryExpiresAt: null }).status).toBe('pending')
  })

  it('mirrors for a short', () => {
    const short: PositionExecutorParams = { ...p, side: 'sell', entryPrice: 110 }
    expect(simulatePosition([c(60, 100, 101, 99, 100), c(300, 100, 120, 99, 118)], short)).toMatchObject({ status: 'closed', exitReason: 'entry_expired', realizedPnl: 0 })
    expect(simulatePosition([c(60, 108, 111, 107, 109)], short)).toMatchObject({ status: 'open', entryPrice: 110 })
  })
})

describe('simulatePosition: an entry by a range, as a recommendation names one', () => {
  // "Enter between 99.8 and 100.2." Barriers far enough away that these tests are about the entry.
  const p: PositionExecutorParams = {
    side: 'buy', entryPrice: null, amountQuote: 1000,
    takeProfitPct: 20, stopLossPct: 20, timeLimitSec: null, trailingStop: null, entryRange: { min: 99.8, max: 100.2 }
  }

  it('enters at the open of the first candle that opens inside the range', () => {
    expect(simulatePosition([c(0, 100.1, 100.3, 100, 100.2)], p)).toMatchObject({ status: 'open', entryPrice: 100.1, enteredAt: 0 })
    // The edges are inside it.
    expect(simulatePosition([c(0, 99.8, 99.9, 99.7, 99.75)], p)).toMatchObject({ status: 'open', entryPrice: 99.8 })
    expect(simulatePosition([c(0, 100.2, 100.4, 100.15, 100.3)], p)).toMatchObject({ status: 'open', entryPrice: 100.2 })
  })

  it('does not chase a price that has left the range, where a market entry would', () => {
    const ran = [c(0, 100.9, 101.5, 100.7, 101.4), c(60, 101.4, 102, 101.2, 101.9)]
    expect(simulatePosition(ran, p)).toMatchObject({ status: 'pending', entryPrice: null, enteredAt: null })
    expect(simulatePosition(ran, { ...p, entryRange: null })).toMatchObject({ status: 'open', entryPrice: 100.9 })
  })

  it('does not buy at once under a range the price has fallen out of, where a limit at its edge would', () => {
    // The case a check in the app pointed at: the price is at 99.4 and falling, the range starts at 99.8.
    const fell = [c(0, 99.4, 99.6, 99, 99.1), c(60, 99.1, 99.3, 98.9, 99)]
    expect(simulatePosition(fell, p)).toMatchObject({ status: 'pending', entryPrice: null })
    expect(simulatePosition(fell, { ...p, entryRange: null, entryPrice: 99.8 })).toMatchObject({ status: 'open', entryPrice: 99.4 })
  })

  it('enters at the edge the price comes in by, from either side', () => {
    const fromBelow = simulatePosition([c(0, 99.4, 99.6, 99, 99.1), c(60, 99.1, 99.9, 99.05, 99.85)], p)
    expect(fromBelow).toMatchObject({ status: 'open', entryPrice: 99.8, enteredAt: 60 })
    const fromAbove = simulatePosition([c(0, 100.9, 101, 100.5, 100.6), c(60, 100.6, 100.7, 100.1, 100.15)], p)
    expect(fromAbove).toMatchObject({ status: 'open', entryPrice: 100.2, enteredAt: 60 })
    // A candle that comes down to the top of the range and no further has traded at it, and one
    // that comes up to the bottom of it has too.
    expect(simulatePosition([c(0, 100.6, 100.7, 100.2, 100.5)], p)).toMatchObject({ status: 'open', entryPrice: 100.2 })
    expect(simulatePosition([c(0, 99.4, 99.8, 99.3, 99.5)], p)).toMatchObject({ status: 'open', entryPrice: 99.8 })
  })

  it('does not enter in a candle that only touches past the range without trading in it', () => {
    // Closes at 99.4, opens the next minute at 100.6: nothing traded between 99.8 and 100.2.
    expect(simulatePosition([c(0, 99, 99.5, 98.9, 99.4), c(60, 100.6, 101, 100.5, 100.9)], p).status).toBe('pending')
    // One that trades from under it to over it did trade in it, and came in by the bottom.
    expect(simulatePosition([c(0, 99.5, 100.6, 99.4, 100.5)], p)).toMatchObject({ status: 'open', entryPrice: 99.8 })
  })

  it('is the same rule for a short: a range is a place, not a direction', () => {
    const short: PositionExecutorParams = { ...p, side: 'sell' }
    expect(simulatePosition([c(0, 100.9, 101.5, 100.7, 101.4)], short).status).toBe('pending')
    expect(simulatePosition([c(0, 100.9, 101, 100.5, 100.6), c(60, 100.6, 100.7, 100.1, 100.15)], short)).toMatchObject({ status: 'open', entryPrice: 100.2, enteredAt: 60 })
    expect(simulatePosition([c(0, 99.4, 99.6, 99, 99.1), c(60, 99.1, 99.9, 99.05, 99.85)], short)).toMatchObject({ status: 'open', entryPrice: 99.8 })
  })

  it('does not consult an entry price that sits beside a range', () => {
    const candles = [c(0, 100.9, 101.5, 100.7, 101.4), c(60, 101.4, 101.5, 100.1, 100.3), c(120, 100.3, 100.4, 100.2, 100.3)]
    expect(simulatePosition(candles, { ...p, entryPrice: 150 })).toEqual(simulatePosition(candles, p))
    expect(simulatePosition(candles, { ...p, entryPrice: 50 })).toEqual(simulatePosition(candles, p))
  })

  it('is abandoned at its expiry like any other entry, and then is an ordinary position once in', () => {
    const waiting: PositionExecutorParams = { ...p, entryExpiresAt: 120 }
    expect(simulatePosition([c(0, 100.9, 101.5, 100.7, 101.4), c(60, 101.4, 102, 101.2, 101.9), c(120, 100.1, 100.2, 100, 100.1)], waiting)).toMatchObject({
      status: 'closed', exitReason: 'entry_expired', entryPrice: null, closedAt: 120, realizedPnl: 0
    })
    const stopped = simulatePosition([c(0, 100, 100.1, 99.9, 100), c(60, 100, 100.1, 78, 79)], { ...p, entryExpiresAt: 120 })
    expect(stopped).toMatchObject({ status: 'closed', exitReason: 'stop_loss', entryPrice: 100 })
  })

  it('enters when and where the recommendation\'s own score says it did', () => {
    // The scoring a recommendation is judged by (shared/aiOpportunityOutcome.ts), with costs
    // switched off so that its entry is the raw price. Each path is twelve minutes of candles.
    const flat = (from: number, to: number, price: number): Candle[] => Array.from({ length: (to - from) / 60 }, (_, i) => c(from + i * 60, price, price + 0.05, price - 0.05, price))
    const paths: Candle[][] = [
      [c(0, 100.1, 100.3, 100, 100.2), ...flat(60, 720, 100.2)],
      [c(0, 100.9, 101.5, 100.7, 101.4), ...flat(60, 720, 101.4)],
      [c(0, 99.4, 99.6, 99, 99.1), ...flat(60, 720, 99.1)],
      [c(0, 99.4, 99.6, 99, 99.1), c(60, 99.1, 99.9, 99.05, 99.85), ...flat(120, 720, 99.9)],
      [c(0, 100.9, 101, 100.5, 100.6), c(60, 100.6, 100.7, 100.1, 100.15), ...flat(120, 720, 100.1)],
      [c(0, 99, 99.5, 98.9, 99.4), c(60, 100.6, 101, 100.5, 100.9), ...flat(120, 720, 100.9)],
      [...flat(0, 600, 101), c(600, 100.1, 100.2, 100, 100.1), c(660, 100.1, 100.2, 100, 100.1)],
      [...flat(0, 540, 101), c(540, 100.5, 100.6, 100.15, 100.3), c(600, 100.3, 100.4, 100.2, 100.3), c(660, 100.3, 100.4, 100.2, 100.3)],
      [c(0, 100.6, 100.7, 100.2, 100.5), ...flat(60, 720, 100.5)],
      [c(0, 99.4, 99.8, 99.3, 99.5), ...flat(60, 720, 99.5)]
    ]
    for (const side of ['long', 'short'] as const) {
      const call: OpportunityCall = { time: 0, side, entryMin: 99.8, entryMax: 100.2, stopLoss: side === 'long' ? 50 : 150, takeProfit: side === 'long' ? 150 : 50, expiresAt: 600, holdSeconds: 86_400, answeredAt: 0 }
      for (const path of paths) {
        const scored = scoreOpportunity(call, path, 1_000_000, { feeRate: 0, slippageRate: 0 })
        const state = simulatePosition(path, { ...p, side: side === 'long' ? 'buy' : 'sell', takeProfitPct: null, stopLossPct: null, entryExpiresAt: 600 })
        expect(state.enteredAt).toBe(scored.entryTime)
        expect(state.entryPrice).toBe(scored.entryPrice)
        // And they agree on the ones that never entered.
        expect(state.exitReason === 'entry_expired').toBe(scored.status === 'expired')
      }
    }
    // The paths are not all one answer: some enter and some do not.
    const entered = paths.map((path) => simulatePosition(path, { ...p, entryExpiresAt: 600 }).enteredAt)
    expect(entered).toEqual([0, null, null, 60, 60, null, null, 540, 0, 0])
  })
})

describe('grid level construction and cycling', () => {
  const params: GridExecutorParams = {
    side: 'buy', startPrice: 90, endPrice: 110, totalAmountQuote: 1000,
    maxOpenOrders: 10, levelSpreadPct: 2, takeProfitPct: 5, limitPrice: null
  }

  it('spans the configured range', () => {
    const levels = buildGridLevels(params)
    expect(levels[0]).toBeCloseTo(90, 9)
    expect(levels[levels.length - 1]).toBeCloseTo(110, 9)
    expect(levels.length).toBeGreaterThan(2)
  })

  it('handles an inverted or degenerate range without throwing', () => {
    expect(buildGridLevels({ ...params, startPrice: 110, endPrice: 90 })[0]).toBeCloseTo(90, 9)
    expect(buildGridLevels({ ...params, startPrice: 100, endPrice: 100 })).toHaveLength(2)
  })

  it('caps concurrently open levels at maxOpenOrders', () => {
    const capped = simulateGrid([c(1, 110, 110, 90, 95)], { ...params, maxOpenOrders: 2 })
    expect(capped.filledCount).toBe(2)
  })

  it('books profit and frees a level to refill after take-profit', () => {
    const s = simulateGrid([c(1, 110, 110, 90, 95), c(2, 95, 130, 95, 128)], { ...params, maxOpenOrders: 1 })
    expect(s.closedLevels).toBeGreaterThanOrEqual(1)
    expect(s.realizedPnl).toBeGreaterThan(0)
  })

  it('takes the round-trip fee out of a take-profit close', () => {
    // Asserting only "profit" let the fee be dropped entirely from this branch without any
    // test noticing -- and take-profit is how a grid normally makes money, so every grid
    // would have reported inflated realized P&L.
    //
    // The exact figure needs no reference to which level filled: gross is
    // qty * (target - entry) where qty = amountPerLevel / entry and target = entry * (1 + tp),
    // so entry cancels and gross is amountPerLevel * tp. The fee is charged on both sides of
    // the same round trip, giving amountPerLevel * (2 + tp) * FEE_RATE.
    const single = { ...params, maxOpenOrders: 1 }
    const amountPerLevel = single.totalAmountQuote / buildGridLevels(single).length
    const tp = single.takeProfitPct / 100

    const s = simulateGrid([c(1, 110, 110, 90, 95), c(2, 95, 130, 95, 128)], single)
    expect(s.closedLevels).toBe(1)
    expect(s.realizedPnl).toBeCloseTo(amountPerLevel * tp - amountPerLevel * (2 + tp) * FEE_RATE, 9)
  })
})

// A fill already taken from the live book (PositionExecutorParams.entryFill, since 8 October 2026):
// the position is in the market from the minute containing it, at that price plus slippage, and the
// entry rules are not consulted. That minute can stop it and cannot pay its target.
describe('simulatePosition: a fill already taken from the live book', () => {
  const M = 600
  const p: PositionExecutorParams = {
    side: 'buy', entryPrice: null, amountQuote: 1000, takeProfitPct: 4, stopLossPct: 2, timeLimitSec: 600, trailingStop: null,
    entryRange: { min: 99.8, max: 100.2 }, entryExpiresAt: M - 60, slippageRate: 0.0002, entryFill: { price: 100.01, at: M + 18 }
  }

  it('is open from the minute of the fill, at the fill plus slippage, whatever the range or the expiry say', () => {
    const state = simulatePosition([c(M, 100, 100.5, 99.9, 100.2)], p)
    expect(state).toMatchObject({ status: 'open', enteredAt: M, levelPrice: 100.01 })
    expect(state.entryPrice).toBeCloseTo(100.01 * 1.0002, 10)
    // A series that begins after the fill's minute is open from its first bar.
    expect(simulatePosition([c(M + 60, 100.2, 100.4, 100.1, 100.3)], p)).toMatchObject({ status: 'open', enteredAt: M })
    // Candles before the fill's minute are not read: a stop in them is not a stop.
    expect(simulatePosition([c(M - 60, 100, 100.1, 90, 95), c(M, 100, 100.5, 99.9, 100.2)], p)).toMatchObject({ status: 'open' })
  })

  it("stops in the fill's minute, but is not paid its target there, since the high may have come before the fill", () => {
    expect(simulatePosition([c(M, 100, 105, 99.9, 104.5)], p)).toMatchObject({ status: 'open' })
    expect(simulatePosition([c(M, 100, 105, 99.9, 104.5), c(M + 60, 104.5, 104.6, 104.4, 104.5)], p)).toMatchObject({ status: 'closed', exitReason: 'take_profit' })
    expect(simulatePosition([c(M, 100, 100.5, 97, 97.5)], p)).toMatchObject({ status: 'closed', exitReason: 'stop_loss', closedAt: M })
  })

  it('counts its time from that minute, and a short mirrors', () => {
    const flat = [c(M, 100, 100.1, 99.9, 100), c(M + 300, 100, 100.1, 99.9, 100), c(M + 600, 100, 100.1, 99.9, 100)]
    expect(simulatePosition(flat, p)).toMatchObject({ status: 'closed', exitReason: 'time_limit', closedAt: M + 600 })
    const short: PositionExecutorParams = { ...p, side: 'sell', entryFill: { price: 99.99, at: M + 18 } }
    expect(simulatePosition([c(M, 100, 103, 99.9, 102.5)], short)).toMatchObject({ status: 'closed', exitReason: 'stop_loss' })
    expect(simulatePosition([c(M, 100, 100.1, 95, 95.5), c(M + 60, 95.5, 95.6, 95, 95.2)], short)).toMatchObject({ status: 'closed', exitReason: 'take_profit' })
  })

  it('is as it was without a fill, or with one that is not a price', () => {
    expect(simulatePosition([c(M, 100.9, 101, 100.8, 100.9)], { ...p, entryFill: null, entryExpiresAt: null })).toMatchObject({ status: 'pending' })
    expect(simulatePosition([c(M, 100.9, 101, 100.8, 100.9)], { ...p, entryFill: { price: Number.NaN, at: M }, entryExpiresAt: null })).toMatchObject({ status: 'pending' })
  })
})
