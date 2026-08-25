import { describe, expect, it } from 'vitest'
import { describeBelowExchangeMinimum, type SymbolTradingRules } from '../shared/exchangeMinimums'

// A ladder divides one total into many small orders, and an exchange refuses each of them on its
// own. A 10 USDT TWAP over three slices is 3.33 an order, which BTCUSDT will not accept -- and
// finding that out from "Filter failure: NOTIONAL" after creating the strategy is the experience
// this check exists to replace.

const rules: SymbolTradingRules = { minNotional: 5, minQty: 0.00001, stepSize: '0.00001000', tickSize: '0.01000000' }

function check(perOrderQuote: number, orderCount = 1, override: Partial<SymbolTradingRules> | null = {}) {
  return describeBelowExchangeMinimum({
    perOrderQuote,
    orderCount,
    rules: override === null ? null : { ...rules, ...override },
    symbol: 'BTCUSDT',
    quoteAsset: 'USDT',
    exchangeLabel: 'Binance'
  })
}

describe('refusing orders the exchange will not accept', () => {
  it('catches a ladder whose slices fall under the minimum', () => {
    const message = check(10 / 3, 3)

    expect(message).toContain('Each of the 3 orders this would place is 3.33 USDT')
    expect(message).toContain('will not accept a BTCUSDT order below 5 USDT')
    // The fix, in the units the person was typing in: they chose a total, not a slice.
    expect(message).toContain('Raise the total to at least 15.00 USDT, or use fewer orders')
  })

  it('speaks about a single order as one order', () => {
    const message = check(2)

    expect(message).toContain('This order is 2.00 USDT')
    expect(message).toContain('Raise it to at least 5 USDT')
    expect(message).not.toContain('orders this would place')
  })

  it('accepts an order exactly at the minimum', () => {
    // The exchange rejects below, not at.
    expect(check(5)).toBeNull()
    expect(check(5.01)).toBeNull()
  })

  it('says nothing when the rules could not be read', () => {
    // A warning ahead of the real check. Inventing a minimum would block strategies the exchange
    // would have accepted, and the exchange still enforces the real one either way.
    expect(check(1, 3, null)).toBeNull()
  })

  it('says nothing when the symbol has no minimum', () => {
    expect(check(0.01, 3, { minNotional: 0 })).toBeNull()
    expect(check(0.01, 3, { minNotional: Number.NaN })).toBeNull()
  })

  it('catches an unreadable order amount before the minimum is even consulted', () => {
    // It fails whatever the minimum is, so it is not phrased as being under one. Every
    // comparison against NaN is false, which is how a one-sided test would let it through.
    expect(check(Number.NaN, 3)).toContain('works out to NaN, which is not an amount Binance can be sent')
    expect(check(0)).toContain('not an amount Binance can be sent')
    expect(check(-5)).toContain('not an amount Binance can be sent')
  })

  it('catches an unreadable amount even when the rules are unknown', () => {
    expect(check(Number.NaN, 3, null)).toContain('not an amount Binance can be sent')
  })
})
