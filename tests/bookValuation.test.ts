import { describe, expect, it } from 'vitest'
import { bookOpenNetOf, bookPriceRefOf, priceRefKey } from '../shared/bookValuation'
import type { ExecutorConfig } from '../shared/ipc'

// WHAT A BOOK'S OPEN TRADES STAND AT (shared/bookValuation.ts; V8 Stage 9): each from its own stamp and one price --
// its move, what it has realized, its fees with the exit's, funding assumed against it -- the price read where its
// stamp says.

const T0 = Date.UTC(2026, 9, 27, 12)
const base = { id: 'x', type: 'position', mode: 'paper', status: 'active', params: {} } as unknown as ExecutorConfig

describe("an open book trade's value", () => {
  it("is a follow's realized result, less its fees and the exit's, its move on what is held, and funding assumed against it", () => {
    const follow = { ...base, follow: { venue: 'binance', symbol: 'ETHUSDT', side: 'short', size: 0.5, avgPx: 2000, realizedQuote: 3, feesQuote: 1, maxStakeQuote: 1000, openedAtMs: T0 } } as unknown as ExecutorConfig
    expect(bookPriceRefOf(follow)).toEqual({ kind: 'perp', venue: 'binance', symbol: 'ETHUSDT' })
    // Short 0.5 from 2,000 at 1,900: 50; 3 realized; 1 paid and 0.05% of 950 to leave; 16:00 crossed: 0.01% of 1,000.
    expect(bookOpenNetOf(follow, 1900, T0 + 5 * 3_600_000)).toBeCloseTo(3 - 1 - 0.475 + 50 - 0.1, 12)
  })

  it("is a clone's or a news short's the same way, on its perpetual, a baseline trade's on spot; and nothing for a trade no book values", () => {
    const clone = { ...base, clone: { venue: 'bitget', symbol: 'SOLUSDT', side: 'long', qty: 10, entryPx: 100, stakeQuote: 1000, feesQuote: 0.6, openedAtMs: T0 } } as unknown as ExecutorConfig
    expect(priceRefKey(bookPriceRefOf(clone)!)).toBe('perp:bitget:SOLUSDT')
    expect(bookOpenNetOf(clone, 110, T0 + 3_600_000)).toBeCloseTo(100 - 0.6 - 0.0006 * 1100, 12)
    const news = { ...base, newsBook: { venue: 'binance', symbol: 'ABCUSDT', entryPx: 1, qty: 1000, stakeQuote: 1000, feesQuote: 0.5, openedAtMs: T0 } } as unknown as ExecutorConfig
    expect(bookPriceRefOf(news)).toEqual({ kind: 'perp', venue: 'binance', symbol: 'ABCUSDT' })
    expect(bookOpenNetOf(news, 0.9, T0 + 3_600_000)).toBeCloseTo(100 - 0.5 - 0.45, 12)
    // A baseline trade is long on spot: no funding, Binance's spot taker each way.
    const baseline = { ...base, baseline: { symbol: 'BTCUSDT', signalBarSec: 0, entryPx: 100_000, qty: 0.0125, stakeQuote: 1250, feesQuote: 1.25, openedAtMs: T0, stopPx: 80_000, closeReason: null, exitPx: null } } as unknown as ExecutorConfig
    expect(bookPriceRefOf(baseline)).toEqual({ kind: 'spot', venue: 'binance', symbol: 'BTCUSDT' })
    expect(bookOpenNetOf(baseline, 104_000, T0 + 30 * 3_600_000)).toBeCloseTo(50 - 1.25 - 0.001 * 1300, 12)
    expect(bookPriceRefOf(base)).toBeNull()
    expect(bookOpenNetOf(base, 1, T0)).toBeNull()
    expect(bookOpenNetOf(clone, 0, T0)).toBeNull()
  })
})
