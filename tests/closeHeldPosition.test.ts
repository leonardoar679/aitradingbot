import { describe, expect, it } from 'vitest'
import { describeHeldCloseBlock, describeHeldCloseConfirm, heldPositionCloseValue } from '../src/positions/closeHeldPosition'
import { netUnrealizedPct } from '../shared/fees'
import type { HeldPosition } from '../shared/ipc'

// Closing a position held in Inventory returned nothing to the balance. The cash had already left
// it when the position was handed over, so deleting the row destroyed the stake and the profit
// together -- silently, with no error.

function held(overrides: Partial<HeldPosition> = {}): HeldPosition {
  return {
    id: 'h1',
    sourceExecutorId: 'e1',
    sourceExecutorName: 'Keeper',
    exchange: 'binance',
    symbol: 'BTCUSDT',
    baseAsset: 'BTC',
    quoteAsset: 'USDT',
    side: 'buy',
    entryPrice: 100,
    amountQuote: 1_000,
    openedAt: 1,
    ...overrides
  }
}

describe('what closing a held position pays back', () => {
  it('returns the stake plus the gain, net of fees', () => {
    // Up 10% before costs; the fee drag is the same one the row's percentage already shows, so
    // the money that arrives is the money the user was looking at.
    const value = heldPositionCloseValue(held(), 110)

    expect(value).toBeCloseTo(1_000 * (1 + netUnrealizedPct(100, 110, 'buy') / 100), 10)
    expect(value).toBeGreaterThan(1_090)
    expect(value).toBeLessThan(1_100)
  })

  it('returns less than the stake on a loser', () => {
    expect(heldPositionCloseValue(held(), 90)).toBeLessThan(1_000)
  })

  it('returns very slightly under the stake at the entry price, because closing costs fees', () => {
    const value = heldPositionCloseValue(held(), 100) as number

    expect(value).toBeLessThan(1_000)
    expect(value).toBeGreaterThan(997)
  })

  it('inverts the move for a short', () => {
    expect(heldPositionCloseValue(held({ side: 'sell' }), 90)).toBeGreaterThan(1_000)
    expect(heldPositionCloseValue(held({ side: 'sell' }), 110)).toBeLessThan(1_000)
  })

  it('never pays back less than nothing', () => {
    // A spot holding cannot be worth under zero, and a negative credit would take money out of
    // the balance on the way past -- the same floor Portfolio uses to value the row.
    expect(heldPositionCloseValue(held(), 0.0001)).toBe(0)
    expect(heldPositionCloseValue(held({ side: 'sell' }), 1_000_000)).toBe(0)
  })

  it('refuses to value a position with no price', () => {
    expect(heldPositionCloseValue(held(), null)).toBeNull()
    expect(heldPositionCloseValue(held(), NaN)).toBeNull()
    expect(heldPositionCloseValue(held(), 0)).toBeNull()
    expect(heldPositionCloseValue(held(), -5)).toBeNull()
  })

  it('refuses to value a position whose own numbers are unusable', () => {
    expect(heldPositionCloseValue(held({ entryPrice: 0 }), 110)).toBeNull()
    expect(heldPositionCloseValue(held({ amountQuote: NaN }), 110)).toBeNull()
    expect(heldPositionCloseValue(held({ amountQuote: -100 }), 110)).toBeNull()
  })
})

describe('refusing to close what cannot be valued', () => {
  it('blocks an unpriced position instead of discarding it', () => {
    // The old behaviour deleted the row regardless of whether a price was available, which is
    // exactly how the money went missing.
    expect(describeHeldCloseBlock(held(), null)).toMatch(/No current price for BTCUSDT/)
    expect(describeHeldCloseBlock(held(), null)).toMatch(/Closing is blocked/)
  })

  it('blocks a position whose own figures are broken, and says nothing changed', () => {
    expect(describeHeldCloseBlock(held({ entryPrice: 0 }), 110)).toMatch(/Nothing has been changed/)
  })

  it('does not block one that can be valued', () => {
    expect(describeHeldCloseBlock(held(), 110)).toBeNull()
  })
})

describe('the confirmation label', () => {
  it('names the amount rather than asking for a blind confirmation', () => {
    // "Confirm discard?" was frightening and wrong: closing does not discard a position, it sells
    // it, and the number is what the user needs to see before agreeing.
    expect(describeHeldCloseConfirm(held(), 110)).toMatch(/^Close for 1,?09[0-9]\.\d\d USDT\?$/)
  })

  it('says so plainly when there is nothing to confirm', () => {
    expect(describeHeldCloseConfirm(held(), null)).toBe('Cannot close')
  })
})
