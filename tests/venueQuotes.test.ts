import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// THE VENUES' BOOKS FOR THE PAIRS THAT MATTER (electron/services/venueQuotesService.ts; V7.2-R Stage 4): Binance's and
// Bitget's public books read for the pairs asked, at most twelve; Bitget's per-pair fees from its list; a pair's round
// trip on each venue whose book is fresh, and the cheaper. The reads are faked here.

const books = new Map<string, { binance: unknown; bitget: unknown }>()
const asked: string[] = []
let feeReads = 0

vi.mock('electron', () => ({ app: { getPath: () => '' } }))
vi.mock('../electron/services/marketCompareService', () => ({
  readVenueBooks: vi.fn(async (symbol: string) => {
    asked.push(symbol)
    const held = books.get(symbol)
    return { at: Date.now(), books: held ?? { binance: null, bitget: null }, problems: {} }
  })
}))
vi.mock('../electron/services/exchanges/bitget', () => ({
  fetchBitgetFeeRates: vi.fn(async () => {
    feeReads++
    return new Map([
      ['BTCUSDT', 0.002],
      ['PEPEUSDT', 0.001]
    ])
  })
}))

const level = (price: number, qty: number): [number, number] => [price, qty]
const deepBook = (mid: number, halfSpreadPct: number): { bids: [number, number][]; asks: [number, number][] } => ({
  bids: [level(mid * (1 - halfSpreadPct / 100), 1000), level(mid * (1 - (2 * halfSpreadPct) / 100), 1000)],
  asks: [level(mid * (1 + halfSpreadPct / 100), 1000), level(mid * (1 + (2 * halfSpreadPct) / 100), 1000)]
})

async function service() {
  const mod = await import('../electron/services/venueQuotesService')
  mod.venueQuotesForTest.reset()
  return mod
}

beforeEach(() => {
  vi.resetModules()
  books.clear()
  asked.length = 0
  feeReads = 0
})
afterEach(() => vi.useRealTimers())

describe('the books read', () => {
  it('are those of the pairs asked, at most twelve, each once, a pair no longer asked let go', async () => {
    const venues = await service()
    venues.setVenuePairs(['btcusdt', 'BTCUSDT', ...Array.from({ length: 20 }, (_, k) => `P${k}USDT`)])
    await venues.venueQuotesForTest.readOnce()
    expect(asked[0]).toBe('BTCUSDT')
    expect(asked).toHaveLength(venues.VENUE_PAIRS_MAX)
    expect(venues.venueQuotesState()).toMatchObject({ held: venues.VENUE_PAIRS_MAX, bitgetFees: 2 })
    venues.setVenuePairs(['BTCUSDT'])
    await venues.venueQuotesForTest.readOnce()
    expect(venues.venueQuotesState().held).toBe(1)
    // Bitget's fees are read once in six hours.
    expect(feeReads).toBe(1)
  })
})

describe("a pair's round trip", () => {
  it("is costed on each venue whose book is held, at Bitget's own rate for the pair, and the cheaper is named", async () => {
    books.set('BTCUSDT', { binance: deepBook(100, 0.01), bitget: deepBook(100, 0.005) })
    const venues = await service()
    venues.setVenuePairs(['BTCUSDT'])
    await venues.venueQuotesForTest.readOnce()
    const costs = venues.venueCostOf('BTCUSDT', 'BUY')!
    const binance = costs.trips.find((trip) => trip.venue === 'binance')!
    const bitget = costs.trips.find((trip) => trip.venue === 'bitget')!
    expect(binance.feePct).toBeCloseTo(0.1, 12)
    // Bitget lists BTCUSDT at 0.2% a side: dearer though its spread is tighter.
    expect(bitget.feePct).toBeCloseTo(0.2, 12)
    expect(binance.basis).toBe('book')
    expect(costs.cheapest!.venue).toBe('binance')
    // A pair Bitget lists at 0.1%, its book tighter: Bitget the cheaper.
    books.set('PEPEUSDT', { binance: deepBook(1, 0.02), bitget: deepBook(1, 0.005) })
    venues.setVenuePairs(['PEPEUSDT'])
    await venues.venueQuotesForTest.readOnce()
    expect(venues.venueCostOf('PEPEUSDT', 'SELL')!.cheapest!.venue).toBe('bitget')
  })

  it('is not read from a book older than three minutes, nor where no venue holds one', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-10-22T10:00:00Z'))
    books.set('BTCUSDT', { binance: deepBook(100, 0.01), bitget: null })
    const venues = await service()
    venues.setVenuePairs(['BTCUSDT', 'NONEUSDT'])
    await venues.venueQuotesForTest.readOnce()
    const read = Date.parse('2026-10-22T10:00:00Z')
    expect(venues.venueCostOf('BTCUSDT', 'BUY', read + venues.VENUE_BOOK_FRESH_MS)!.trips.map((trip) => trip.venue)).toEqual(['binance'])
    expect(venues.venueCostOf('BTCUSDT', 'BUY', read + venues.VENUE_BOOK_FRESH_MS + 1)).toBeNull()
    expect(venues.venueCostOf('NONEUSDT', 'BUY', read)).toBeNull()
    expect(venues.venueCostOf('XYZUSDT', 'BUY', read)).toBeNull()
  })
})
