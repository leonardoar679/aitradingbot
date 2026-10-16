import { describe, expect, it } from 'vitest'
import { commonSymbol, DEPTH_BAND, depthWithin, quoteOf } from '../shared/marketCompare'

// THE COMPARISON OF EXCHANGES (shared/marketCompare.ts; V7.1 Stage 6): one pair's quote on an
// exchange from its book and its ticker -- the spread over the mid, the depth within the band, the
// book's age -- and nulls with a reason where a read failed.

const reads = { lastPrice: 100, quoteVolume24h: 5_000_000, roundTripMs: 120, problem: null }

describe('the depth within the band', () => {
  it('sums the quote currency resting within half a percent of the mid, best first, and stops at the first level past it', () => {
    const bids: [number, number][] = [
      [99.9, 10],
      [99.6, 20],
      [99.49, 1000],
      [99.8, 5]
    ]
    // 99.9*10 + 99.6*20 = 999 + 1992; 99.49 is past 99.5, and the level behind it is not counted.
    expect(depthWithin(bids, 100, 'bid')).toBeCloseTo(2991, 9)
    expect(depthWithin([[100.1, 2], [100.5, 1], [100.51, 100]], 100, 'ask')).toBeCloseTo(200.2 + 100.5, 9)
    expect(depthWithin([], 100, 'bid')).toBe(0)
    // A level that cannot be read is skipped, not summed.
    expect(depthWithin([[Number.NaN, 5], [99.9, 1]], 100, 'bid')).toBeCloseTo(99.9, 9)
    expect(DEPTH_BAND).toBe(0.005)
  })
})

describe("an exchange's quote", () => {
  it('reads the best bid and ask, the spread over the mid in percent, the depth each side and the book\'s age', () => {
    const quote = quoteOf('bitget', 'BTCUSDT', { ...reads, book: { bids: [[99.9, 1], [99.4, 1]], asks: [[100.1, 2], [100.6, 1]] }, bookTs: 9_500 }, 10_000)
    expect(quote).toMatchObject({ exchange: 'bitget', symbol: 'BTCUSDT', price: 100, bid: 99.9, ask: 100.1, quoteVolume24h: 5_000_000, bookAgeMs: 500, roundTripMs: 120, problem: null })
    expect(quote.spreadPct).toBeCloseTo((0.2 / 100) * 100, 9)
    expect(quote.bidDepthQuote).toBeCloseTo(99.9, 9)
    expect(quote.askDepthQuote).toBeCloseTo(200.2, 9)
    // A book without a stamp has no age; a stamp in the future is an age of nought, not a negative one.
    expect(quoteOf('binance', 'BTCUSDT', { ...reads, book: { bids: [[99.9, 1]], asks: [[100.1, 1]] }, bookTs: null }, 10_000).bookAgeMs).toBeNull()
    expect(quoteOf('binance', 'BTCUSDT', { ...reads, book: { bids: [[99.9, 1]], asks: [[100.1, 1]] }, bookTs: 11_000 }, 10_000).bookAgeMs).toBe(0)
  })

  it('is nulls with the reason where the read failed, and says so where the book is one-sided', () => {
    const failed = quoteOf('bitget', 'BTCUSDT', { book: null, bookTs: null, lastPrice: null, quoteVolume24h: null, roundTripMs: 10_000, problem: 'Bitget book BTCUSDT failed: 400 40034 Parameter BTCUSDT does not exist' }, 10_000)
    expect(failed).toEqual({
      exchange: 'bitget',
      symbol: 'BTCUSDT',
      price: null,
      bid: null,
      ask: null,
      spreadPct: null,
      bidDepthQuote: null,
      askDepthQuote: null,
      quoteVolume24h: null,
      bookAgeMs: null,
      roundTripMs: 10_000,
      problem: 'Bitget book BTCUSDT failed: 400 40034 Parameter BTCUSDT does not exist'
    })
    const oneSided = quoteOf('binance', 'BTCUSDT', { ...reads, book: { bids: [[99.9, 1]], asks: [] }, bookTs: null }, 10_000)
    expect(oneSided).toMatchObject({ bid: 99.9, ask: null, spreadPct: null, bidDepthQuote: null, problem: 'The book is one-sided or empty.' })
  })

  it('spells the pair as both exchanges do', () => {
    expect(commonSymbol('btc', 'usdt')).toBe('BTCUSDT')
  })
})
