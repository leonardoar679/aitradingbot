import { describe, expect, it } from 'vitest'
import {
  describeProtectiveStop,
  describeStopPlacementError,
  readableProtectiveStops,
  stopDistancePct,
  stopForPosition,
  stopRiskQuote,
  type ProtectiveStop
} from '../shared/futuresStops'
import type { FuturesPosition } from '../shared/futuresPositions'

// The question this whole module exists to answer is "is this position protected?", and there is
// exactly one answer that must never be given wrongly: saying yes when nothing is guarding the
// position. Most of what follows is about that direction of the mistake.

function long(overrides: Partial<FuturesPosition> = {}): FuturesPosition {
  return {
    symbol: 'BTCUSDT',
    positionAmt: 0.01,
    entryPrice: 60_000,
    markPrice: 59_000,
    liquidationPrice: 55_000,
    leverage: 20,
    unrealizedPnl: -10,
    marginType: 'isolated',
    ...overrides
  }
}

function short(overrides: Partial<FuturesPosition> = {}): FuturesPosition {
  return long({ positionAmt: -0.5, entryPrice: 3_000, markPrice: 2_900, liquidationPrice: 4_100, symbol: 'ETHUSDT', ...overrides })
}

describe('reading which resting orders are actually protection', () => {
  it('keeps a closePosition stop and a reduce-only stop', () => {
    const stops = readableProtectiveStops([
      { symbol: 'BTCUSDT', orderId: 1, side: 'SELL', type: 'STOP_MARKET', stopPrice: '58000', closePosition: true },
      { symbol: 'ETHUSDT', orderId: 2, side: 'BUY', type: 'STOP', stopPrice: '3100', reduceOnly: true }
    ])

    expect(stops.map((s) => s.symbol)).toEqual(['BTCUSDT', 'ETHUSDT'])
    expect(stops[0].closesWholePosition).toBe(true)
    // A reduce-only order was sized when it was placed, so a position added to since can outgrow
    // it. That is a real difference and it is not flattened into the same flag.
    expect(stops[1].closesWholePosition).toBe(false)
  })

  it('does not count a take-profit order as protection', () => {
    // The one that matters most. A take-profit also rests, also has a trigger price and is also
    // reduce-only -- and someone told their downside was covered by it would be wrong in the
    // only direction that costs money.
    const stops = readableProtectiveStops([
      { symbol: 'BTCUSDT', orderId: 1, side: 'SELL', type: 'TAKE_PROFIT_MARKET', stopPrice: '70000', closePosition: true },
      { symbol: 'BTCUSDT', orderId: 2, side: 'SELL', type: 'TAKE_PROFIT', stopPrice: '70000', reduceOnly: true }
    ])

    expect(stops).toEqual([])
  })

  it('does not count a stop that could open a position', () => {
    // A stop-entry: same type, same trigger, and it does the opposite of protecting anything.
    const stops = readableProtectiveStops([
      { symbol: 'BTCUSDT', orderId: 1, side: 'SELL', type: 'STOP_MARKET', stopPrice: '58000' }
    ])

    expect(stops).toEqual([])
  })

  it('drops a stop whose trigger price cannot be read', () => {
    // Rather than reporting a stop at NaN. "Protected" is the word people act on, so a row that
    // cannot say at what price is not a row worth drawing.
    const stops = readableProtectiveStops([
      { symbol: 'BTCUSDT', orderId: 1, side: 'SELL', type: 'STOP_MARKET', stopPrice: 'nonsense', closePosition: true },
      { symbol: 'BTCUSDT', orderId: 2, side: 'SELL', type: 'STOP_MARKET', stopPrice: '0', closePosition: true }
    ])

    expect(stops).toEqual([])
  })

  it('drops rows with no order id or an unrecognised side', () => {
    const stops = readableProtectiveStops([
      { symbol: 'BTCUSDT', side: 'SELL', type: 'STOP_MARKET', stopPrice: '58000', closePosition: true },
      { symbol: 'BTCUSDT', orderId: 3, side: 'sideways', type: 'STOP_MARKET', stopPrice: '58000', closePosition: true },
      { orderId: 4, side: 'SELL', type: 'STOP_MARKET', stopPrice: '58000', closePosition: true }
    ])

    expect(stops).toEqual([])
  })
})

describe('matching a stop to the position it protects', () => {
  const sellStop: ProtectiveStop = { symbol: 'BTCUSDT', orderId: 1, stopPrice: 58_000, side: 'SELL', type: 'STOP_MARKET', closesWholePosition: true }

  it('protects a long with a sell and a short with a buy', () => {
    expect(stopForPosition(long(), [sellStop])?.orderId).toBe(1)
    expect(stopForPosition(short({ symbol: 'BTCUSDT' }), [sellStop])).toBeNull()
  })

  it('does not treat another symbol as cover', () => {
    expect(stopForPosition(long(), [{ ...sellStop, symbol: 'ETHUSDT' }])).toBeNull()
  })

  it('reports nothing when there are no stops at all', () => {
    expect(stopForPosition(long(), [])).toBeNull()
  })
})

describe('what a stop is worth', () => {
  it('measures the loss a long stop would take', () => {
    // 0.01 BTC entered at 60000, stopped at 58000 -> 20 quote.
    expect(stopRiskQuote(long(), 58_000)).toBeCloseTo(20, 10)
  })

  it('measures the loss a short stop would take', () => {
    // 0.5 ETH short from 3000, stopped at 3100 -> 50 quote.
    expect(stopRiskQuote(short(), 3_100)).toBeCloseTo(50, 10)
  })

  it('reports a stop above entry on a long as a gain, not a loss', () => {
    // A stop moved into profit is a materially different thing to own, and showing it as a loss
    // of a negative number would be the wrong sentence entirely.
    expect(stopRiskQuote(long(), 61_000)).toBeCloseTo(-10, 10)
  })

  it('refuses to measure against an unusable price', () => {
    expect(stopRiskQuote(long(), Number.NaN)).toBeNull()
    expect(stopRiskQuote(long(), 0)).toBeNull()
    expect(stopRiskQuote(long({ entryPrice: Number.NaN }), 58_000)).toBeNull()
  })

  it('measures the distance from the mark as an unsigned percentage', () => {
    expect(stopDistancePct(long(), 58_000)).toBeCloseTo((1_000 / 59_000) * 100, 10)
    expect(stopDistancePct(short(), 3_100)).toBeCloseTo((200 / 2_900) * 100, 10)
    expect(stopDistancePct(long({ markPrice: 0 }), 58_000)).toBeNull()
  })
})

describe('refusing a stop that cannot do its job', () => {
  it('refuses a long stop at or above the current price', () => {
    // Above the mark it triggers the instant it is placed, which closes the position now rather
    // than protecting it later -- the opposite of what the person asked for.
    expect(describeStopPlacementError(long(), 59_500)).toMatch(/BELOW the current price/)
    expect(describeStopPlacementError(long(), 59_000)).toMatch(/BELOW the current price/)
  })

  it('refuses a short stop at or below the current price', () => {
    expect(describeStopPlacementError(short(), 2_800)).toMatch(/ABOVE the current price/)
    expect(describeStopPlacementError(short(), 2_900)).toMatch(/ABOVE the current price/)
  })

  it('refuses a stop the exchange would liquidate past', () => {
    // A stop below liquidation on a long is protection in name only: the position is already gone
    // by the time the price gets there.
    expect(describeStopPlacementError(long(), 54_000)).toMatch(/liquidates this position at 55000/)
    expect(describeStopPlacementError(long(), 55_000)).toMatch(/liquidates this position at 55000/)
    expect(describeStopPlacementError(short(), 4_200)).toMatch(/liquidates this position at 4100/)
  })

  it('accepts a stop between the mark and liquidation', () => {
    expect(describeStopPlacementError(long(), 57_000)).toBeNull()
    expect(describeStopPlacementError(short(), 3_500)).toBeNull()
  })

  it('accepts a long stop above the entry price', () => {
    // Moving a stop into profit is a normal thing to want, and only the mark and the liquidation
    // price have any say in whether it can be placed.
    expect(describeStopPlacementError(long({ markPrice: 62_000 }), 61_000)).toBeNull()
  })

  it('refuses a price that is not a price', () => {
    // Every check in here is spelled !(a > b) rather than a <= b: NaN is false against every
    // comparison, so a one-sided test would let an unreadable number through the entire gate.
    for (const bad of [Number.NaN, 0, -1, Number.NEGATIVE_INFINITY]) {
      expect(describeStopPlacementError(long(), bad)).toMatch(/Enter the price/)
    }
  })

  it('refuses to judge a stop when the exchange reports no current price', () => {
    expect(describeStopPlacementError(long({ markPrice: Number.NaN }), 58_000)).toMatch(/not reporting a current price/)
  })

  it('lets a position with no liquidation price take any stop on the right side', () => {
    expect(describeStopPlacementError(long({ liquidationPrice: null }), 1)).toBeNull()
  })
})

describe('describing a resting stop', () => {
  const stop: ProtectiveStop = { symbol: 'BTCUSDT', orderId: 1, stopPrice: 58_000, side: 'SELL', type: 'STOP_MARKET', closesWholePosition: true }

  it('says what it would cost', () => {
    expect(describeProtectiveStop(long(), stop)).toContain('loss of about 20.00 USDT')
    expect(describeProtectiveStop(long(), stop)).toContain('1.69% from here')
  })

  it('says what it would keep when the stop is in profit', () => {
    expect(describeProtectiveStop(long(), { ...stop, stopPrice: 61_000 })).toContain('keeping about 10.00 USDT')
  })

  it('calls a stop at the entry price break even rather than a loss of nothing', () => {
    expect(describeProtectiveStop(long(), { ...stop, stopPrice: 60_000 })).toContain('roughly break even')
  })

  it('still says what it closes when the numbers cannot be read', () => {
    expect(describeProtectiveStop(long({ entryPrice: Number.NaN, markPrice: Number.NaN }), stop)).toBe(
      'Closes this position if the price reaches 58000.'
    )
  })
})
