import { describe, expect, it } from 'vitest'
import {
  MAX_SPREAD_PCT,
  STALE_PRICE_MS,
  bookSpreadPct,
  executionQuality,
  fillPrice,
  foldMinute,
  isStale,
  livePaperBlock,
  liveReturns,
  revalidate,
  type LiveBook,
  type LiveMinute
} from '../shared/liveMarket'

// shared/liveMarket.ts: the live price against a recommendation (the second V3 document, §7, §25,
// §42). The stream that fills it is electron/services/liveMarketService.ts.

const NOW_MS = Date.parse('2026-10-06T12:00:30Z')
const NOW = NOW_MS / 1000
const EVENT = Date.parse('2026-10-06T11:50:00Z') / 1000

const book = (over: Partial<LiveBook> = {}): LiveBook => ({ symbol: 'SOLUSDT', bid: 99.99, bidQty: 50, ask: 100.01, askQty: 50, updatedAt: NOW_MS - 500, source: 'stream', ...over })
const minute = (time: number, open: number, close = open, closed = true): LiveMinute => ({ time, open, high: Math.max(open, close), low: Math.min(open, close), close, volume: 1, closed })

/** Bitcoin's minutes from an hour before the event, at 100 until `from`, then at `after`. */
function btc(after = 100, from = EVENT): LiveMinute[] {
  const out: LiveMinute[] = []
  for (let time = EVENT - 3600; time + 60 <= NOW; time += 60) out.push(minute(time, time >= from ? after : 100))
  return out
}

const call = { side: 'buy' as const, entryMin: 99.9, entryMax: 100.2, expiresAt: NOW + 300, eventTime: EVENT }

describe('a book', () => {
  it('has a spread, an age, and a price a fill on each side would take', () => {
    expect(bookSpreadPct(book())).toBeCloseTo(0.02, 10)
    expect(bookSpreadPct(book({ ask: 99.98 }))).toBeNull()
    expect(fillPrice(book(), 'buy')).toBe(100.01)
    expect(fillPrice(book(), 'sell')).toBe(99.99)
    expect(isStale(book({ updatedAt: NOW_MS - STALE_PRICE_MS }), NOW_MS)).toBe(false)
    expect(isStale(book({ updatedAt: NOW_MS - STALE_PRICE_MS - 1 }), NOW_MS)).toBe(true)
  })
})

describe('the execution score', () => {
  it('is full marks for a tight, deep and fresh book', () => {
    expect(executionQuality({ book: book(), side: 'buy', stakeQuote: 100, nowMs: NOW_MS })).toMatchObject({ score: 100, reasons: [] })
  })

  it('loses half for the spread at the line, three tenths for no depth, a fifth for an old price, and says which', () => {
    const wide = executionQuality({ book: book({ bid: 99.9, ask: 100.1 }), side: 'buy', stakeQuote: 100, nowMs: NOW_MS })
    expect(wide.score).toBe(50)
    expect(wide.reasons).toEqual([`spread 0.200%, over the ${MAX_SPREAD_PCT}% a trade is entered at`])
    // Halfway between a tight spread and the line: half the spread's part.
    expect(executionQuality({ book: book({ bid: 99.97, ask: 100.03 }), side: 'buy', stakeQuote: 100, nowMs: NOW_MS }).score).toBe(75)
    // 2 at 100.01 on the ask is about 200 against the 1,000 of ten stakes: a fifth of the depth's part.
    const thin = executionQuality({ book: book({ askQty: 2 }), side: 'buy', stakeQuote: 100, nowMs: NOW_MS })
    expect(thin.score).toBe(Math.round(100 * (0.5 + 0.3 * ((100.01 * 2) / 1000) + 0.2)))
    expect(thin.reasons).toEqual(['200 on offer at the best price, against a stake of 100'])
    // A sell takes the bids: the five best levels when they are read.
    const levels = executionQuality({
      book: book(),
      depth: { symbol: 'SOLUSDT', bids: [[99.99, 1], [99.98, 1]], asks: [[100.01, 100]], updatedAt: NOW_MS },
      side: 'sell',
      stakeQuote: 100,
      nowMs: NOW_MS
    })
    expect(levels.depthQuote).toBeCloseTo(99.99 + 99.98, 10)
    expect(levels.reasons[0]).toMatch(/in the five best levels/)
    const old = executionQuality({ book: book({ updatedAt: NOW_MS - 6000 }), side: 'buy', stakeQuote: 100, nowMs: NOW_MS })
    expect(old.reasons).toContain('price 6 s old')
    expect(old.score).toBe(Math.round(100 * (0.5 + 0.3 + 0.2 * 0.5)))
    expect(executionQuality({ book: null, side: 'buy', stakeQuote: 100, nowMs: NOW_MS })).toMatchObject({ score: 0, reasons: ['no live price'] })
  })
})

describe('a recommendation against the live price', () => {
  const at = (over: Partial<Parameters<typeof revalidate>[0]> = {}): ReturnType<typeof revalidate> =>
    revalidate({ ...call, book: book(), btcMinutes: btc(), btcPrice: 100, btcLimitPct: 1, nowMs: NOW_MS, ...over })

  it('can be entered when what a fill pays is inside its range', () => {
    expect(at()).toEqual({ state: 'enterable', price: 100.01, reasons: [] })
  })

  it('waits while the price is outside its range, and says which side', () => {
    expect(at({ entryMin: 99.5, entryMax: 99.9 })).toEqual({ state: 'waiting', price: 100.01, reasons: ['the ask 100 is over the range'] })
    expect(at({ side: 'sell', entryMin: 100.1, entryMax: 100.5 })).toEqual({ state: 'waiting', price: 99.99, reasons: ['the bid 99.99 is under the range'] })
  })

  it('no longer stands once expired, Bitcoin is against it by the safeguard, the spread is wide or the price is old', () => {
    expect(at({ expiresAt: NOW - 30 })).toMatchObject({ state: 'invalidated', reasons: ['its entry expired at 12:00 UTC'] })
    // Bitcoin 1.5% lower than at the event's minute: against a buy, past a 1% safeguard.
    expect(at({ btcMinutes: btc(98.5, EVENT + 60), btcPrice: 98.5 })).toMatchObject({ state: 'invalidated', reasons: ['Bitcoin fell 1.50% since the event'] })
    // The same fall is for a sell, and a safeguard of 0 checks nothing.
    expect(at({ side: 'sell', entryMin: 99.9, entryMax: 100.2, btcMinutes: btc(98.5, EVENT + 60), btcPrice: 98.5 }).state).toBe('enterable')
    expect(at({ btcMinutes: btc(98.5, EVENT + 60), btcPrice: 98.5, btcLimitPct: 0 }).state).toBe('enterable')
    expect(at({ book: book({ bid: 99.8, ask: 100.2 }) })).toMatchObject({ state: 'invalidated', reasons: ['the spread is 0.400%, over the 0.1% a trade is entered at'] })
    expect(at({ book: book({ updatedAt: NOW_MS - 15_000 }) })).toMatchObject({ state: 'invalidated', reasons: ['the price is 15 s old'] })
    expect(at({ book: null })).toEqual({ state: 'invalidated', price: null, reasons: ['no live price'] })
  })
})

describe('a paper trade on the live price', () => {
  it('is refused with no fresh price or a spread over the line, and only then', () => {
    expect(livePaperBlock(book(), NOW_MS)).toBeNull()
    expect(livePaperBlock(null, NOW_MS)).toBe('The live price could not be read, so the market it would enter is not known.')
    expect(livePaperBlock(book({ updatedAt: NOW_MS - 15_000 }), NOW_MS)).toBe('The live price is 15 seconds old, so the market it would enter is not known.')
    expect(livePaperBlock(book({ ask: 99.98 }), NOW_MS)).toBe('The book is one-sided or crossed, so no fill price can be known.')
    expect(livePaperBlock(book({ bid: 99.8, ask: 100.2 }), NOW_MS)).toBe('The spread is 0.400%, over the 0.1% a trade is entered at.')
    // At the line exactly, it is let through.
    const mid = 100
    const half = (MAX_SPREAD_PCT / 100) * mid * 0.4999
    expect(livePaperBlock(book({ bid: mid - half, ask: mid + half }), NOW_MS)).toBeNull()
  })
})

describe('the minutes the stream sends', () => {
  it('are kept in order, one a minute, the newest replacing the one forming', () => {
    let kept: LiveMinute[] = []
    kept = foldMinute(kept, minute(120, 2, 2.1, false), 3)
    kept = foldMinute(kept, minute(60, 1), 3)
    kept = foldMinute(kept, minute(120, 2, 2.2, true), 3)
    expect(kept.map((entry) => [entry.time, entry.close, entry.closed])).toEqual([
      [60, 1, true],
      [120, 2.2, true]
    ])
    for (const time of [180, 240, 300]) kept = foldMinute(kept, minute(time, time / 60), 3)
    expect(kept.map((entry) => entry.time)).toEqual([180, 240, 300])
  })

  it('give the move over the last minute and five, from the opens of the minutes then', () => {
    const minutes = [minute(Date.parse('2026-10-06T11:55:00Z') / 1000, 98), minute(Date.parse('2026-10-06T11:59:00Z') / 1000, 99.5)]
    const moves = liveReturns(minutes, 100, NOW)
    expect(moves.m1).toBeCloseTo((100 / 99.5 - 1) * 100, 10)
    expect(moves.m5).toBeCloseTo((100 / 98 - 1) * 100, 10)
    expect(liveReturns(minutes.slice(1), 100, NOW).m5).toBeNull()
    expect(liveReturns(minutes, null, NOW)).toEqual({ m1: null, m5: null })
  })
})
