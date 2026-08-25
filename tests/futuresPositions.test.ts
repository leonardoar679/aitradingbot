import { describe, expect, it } from 'vitest'
import {
  describeFuturesPosition,
  distanceToLiquidationPct,
  readableFuturesPositions,
  type FuturesPosition,
  type RawFuturesPosition
} from '../shared/futuresPositions'

// This is the first thing in the app that reads a REAL leveraged position. Everything it can get
// wrong tells someone their money is safer than it is: a dropped position reads as flat, a zeroed
// liquidation price reads as unreachable, and a cross-margin position mislabelled as isolated
// says only part of the wallet is at stake when all of it is.

const raw = (over: Partial<RawFuturesPosition> = {}): RawFuturesPosition => ({
  symbol: 'BTCUSDT',
  positionAmt: '0.010',
  entryPrice: '60000',
  markPrice: '59000',
  liquidationPrice: '54000',
  leverage: '10',
  unRealizedProfit: '-10',
  marginType: 'isolated',
  ...over
})

describe('reading what the exchange sent', () => {
  it('keeps a real position and reads every number off it', () => {
    const { positions } = readableFuturesPositions([raw()])

    expect(positions).toEqual([
      {
        symbol: 'BTCUSDT',
        positionAmt: 0.01,
        entryPrice: 60_000,
        markPrice: 59_000,
        liquidationPrice: 54_000,
        leverage: 10,
        unrealizedPnl: -10,
        marginType: 'isolated'
      }
    ])
  })

  it('drops the flat rows, which are almost all of them', () => {
    // Binance returns a row for every symbol the account has ever touched. A list of two hundred
    // zero-size positions hides the one that is real.
    const { positions } = readableFuturesPositions([
      raw({ symbol: 'ETHUSDT', positionAmt: '0' }),
      raw({ symbol: 'SOLUSDT', positionAmt: '0.000' }),
      raw()
    ])

    expect(positions.map((p) => p.symbol)).toEqual(['BTCUSDT'])
  })

  it('keeps a short, which arrives as a negative size', () => {
    const { positions } = readableFuturesPositions([raw({ positionAmt: '-0.01' })])

    expect(positions[0].positionAmt).toBe(-0.01)
  })

  it('reports a row it cannot read rather than dropping it', () => {
    // A position that exists and cannot be displayed is worse than no list at all, because the
    // user concludes they are flat.
    const { positions, unreadable } = readableFuturesPositions([raw({ symbol: 'ETHUSDT', entryPrice: 'n/a' }), raw()])

    expect(unreadable).toEqual(['ETHUSDT'])
    expect(positions.map((p) => p.symbol)).toEqual(['BTCUSDT'])
  })

  it('skips a row with no symbol at all, which nothing could be said about', () => {
    const { positions, unreadable } = readableFuturesPositions([raw({ symbol: '' }), raw()])

    expect(positions).toHaveLength(1)
    expect(unreadable).toEqual([])
  })

  it('treats a liquidation price of zero as none, not as a price of nothing', () => {
    // Binance sends "0" for a position it will not liquidate. Drawn literally it is a line at
    // zero, which reads as infinitely far away -- the opposite of what a zero usually warns.
    const { positions } = readableFuturesPositions([raw({ liquidationPrice: '0' })])

    expect(positions[0].liquidationPrice).toBeNull()
  })

  it('calls anything that is not explicitly isolated cross', () => {
    // Cross is the answer that risks more. Guessing "isolated" about a cross position tells
    // someone one position's margin is at stake when their whole futures wallet is.
    for (const marginType of ['cross', 'CROSS', undefined, 'something else']) {
      const { positions } = readableFuturesPositions([raw({ marginType })])
      expect(positions[0].marginType).toBe('cross')
    }
  })

  it('puts the position closest to liquidation first', () => {
    // The ordering is the warning. Whatever is about to be taken should not be below the fold.
    const { positions } = readableFuturesPositions([
      raw({ symbol: 'FARUSDT', markPrice: '59000', liquidationPrice: '30000' }),
      raw({ symbol: 'NEARUSDT', markPrice: '59000', liquidationPrice: '58000' }),
      raw({ symbol: 'MIDUSDT', markPrice: '59000', liquidationPrice: '50000' })
    ])

    expect(positions.map((p) => p.symbol)).toEqual(['NEARUSDT', 'MIDUSDT', 'FARUSDT'])
  })

  it('sorts a position with no liquidation price last, whatever order it arrived in', () => {
    // Null sorting first would put the safest position at the top of a list ordered by danger.
    //
    // Asserted over every arrival order rather than one, because the two halves of that rule are
    // separate branches -- "the left one is unmeasurable" and "the right one is" -- and which of
    // them a sort actually calls depends on where the row happened to sit in the input. A single
    // ordering can leave one branch unexercised and pass even when it is reversed; worse,
    // reversing it makes the comparator INCONSISTENT (claiming "a first" for both a-vs-b and
    // b-vs-a), and an inconsistent comparator produces whatever the sort's internals happen to
    // produce rather than an answer that is wrong in an obvious place.
    const safe = raw({ symbol: 'SAFEUSDT', liquidationPrice: '0' })
    const risk = raw({ symbol: 'RISKUSDT', markPrice: '59000', liquidationPrice: '58000' })
    const mid = raw({ symbol: 'MIDUSDT', markPrice: '59000', liquidationPrice: '50000' })

    for (const arrival of [
      [safe, risk, mid],
      [risk, safe, mid],
      [risk, mid, safe],
      [mid, safe, risk]
    ]) {
      const { positions } = readableFuturesPositions(arrival)
      expect(positions.map((p) => p.symbol)).toEqual(['RISKUSDT', 'MIDUSDT', 'SAFEUSDT'])
    }
  })

  it('keeps two unmeasurable positions in a stable, nameable order', () => {
    // Neither can be ranked by danger, so they fall back to something a reader can predict rather
    // than to whatever order the exchange happened to send.
    const { positions } = readableFuturesPositions([
      raw({ symbol: 'ZZZUSDT', liquidationPrice: '0' }),
      raw({ symbol: 'AAAUSDT', liquidationPrice: '0' })
    ])

    expect(positions.map((p) => p.symbol)).toEqual(['AAAUSDT', 'ZZZUSDT'])
  })
})

describe('how close the position is to being taken', () => {
  const position = (over: Partial<FuturesPosition> = {}): FuturesPosition => ({
    symbol: 'BTCUSDT',
    positionAmt: 0.01,
    entryPrice: 60_000,
    markPrice: 59_000,
    liquidationPrice: 54_000,
    leverage: 10,
    unrealizedPnl: -10,
    marginType: 'isolated',
    ...over
  })

  it('is the gap to the liquidation price as a share of the mark', () => {
    // 59,000 down to 54,000 is 5,000, which is 8.47% of the mark.
    expect(distanceToLiquidationPct(position())).toBeCloseTo((5_000 / 59_000) * 100, 9)
  })

  it('is positive for a short too, where the price rises to reach the level', () => {
    // A distance, not a direction: "3% away" means the same urgent thing on either side.
    const short = position({ positionAmt: -0.01, liquidationPrice: 64_000 })

    expect(distanceToLiquidationPct(short)).toBeCloseTo((5_000 / 59_000) * 100, 9)
  })

  it('is null when there is no liquidation price to measure against', () => {
    expect(distanceToLiquidationPct(position({ liquidationPrice: null }))).toBeNull()
  })

  it('is null rather than infinite when the mark price is unusable', () => {
    // A one-sided guard would let a NaN mark through and produce a NaN distance, which every
    // comparison downstream reads as "not close" -- the wrong direction to fail in.
    for (const markPrice of [0, -1, Number.NaN]) {
      expect(distanceToLiquidationPct(position({ markPrice }))).toBeNull()
    }
  })
})

describe('what the user is told', () => {
  const position = (over: Partial<FuturesPosition> = {}): FuturesPosition => ({
    symbol: 'BTCUSDT',
    positionAmt: 0.01,
    entryPrice: 60_000,
    markPrice: 59_000,
    liquidationPrice: 54_000,
    leverage: 10,
    unrealizedPnl: -10,
    marginType: 'isolated',
    ...over
  })

  it('says what happens rather than naming it', () => {
    // "Liquidation" is jargon; "the exchange closes it for you and that margin is gone" is the
    // fact, and it is the fact that changes behaviour.
    const said = describeFuturesPosition(position())

    expect(said).toContain('closes it for you')
    expect(said).toContain('gone')
    expect(said).toContain('10x long')
  })

  it('says cross margin risks the whole wallet, because that is a different thing to own', () => {
    expect(describeFuturesPosition(position({ marginType: 'cross' }))).toContain('whole futures wallet')
    expect(describeFuturesPosition(position({ marginType: 'isolated' }))).toContain('only the margin on this position')
  })

  it('does not invent a liquidation price when the exchange reported none', () => {
    const said = describeFuturesPosition(position({ liquidationPrice: null }))

    expect(said).toContain('no liquidation price')
    expect(said).not.toContain('move against it')
  })
})
