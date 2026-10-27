import { describe, expect, it } from 'vitest'
import type { Candle } from '../shared/ipc'
import { NEWS_BOOK_LINES, assumedFundingAgainst, newsBookExitOf, newsBookFundingOf, newsBookOpenNetOf, newsBookResultOf, type NewsBookStamp } from '../shared/newsBook'

// THE NEWS BOOK'S ARITHMETIC (shared/newsBook.ts; V8 Stage 9): where a short on a coin's perpetual leaves -- its stop,
// the loss of its stake, its target, its hold -- read from the closed minutes after the one it was entered in; what it
// made after both taker fees and the funding over its hold; and what it stands at while open.

const T0 = Date.UTC(2026, 9, 27, 12, 0, 30)
const MINUTE = Math.floor(T0 / 60_000) * 60
const bar = (time: number, open: number, high: number, low: number, close = open): Candle => ({ time, open, high, low, close, volume: 1 })

const stamp = (over: Partial<NewsBookStamp> = {}): NewsBookStamp => ({
  articleId: 7,
  ticker: 'ABC',
  category: 'DELISTING',
  releaseSec: MINUTE - 60,
  title: 'Binance Will Delist ABC',
  venue: 'binance',
  symbol: 'ABCUSDT',
  entryPx: 1,
  qty: 1000,
  stakeQuote: 1000,
  feesQuote: 0.5,
  openedAtMs: T0,
  stopPx: null,
  targetPx: null,
  exitAtSec: MINUTE + 240 * 60,
  closeReason: null,
  exitPx: null,
  ...over
})

describe("a short's exit", () => {
  it('reads only the closed minutes after the one it was entered in, and leaves at the open of its exit minute', () => {
    const bars = [bar(MINUTE, 1, 5, 0.1), bar(MINUTE + 60, 1, 1.1, 0.9), bar(MINUTE + 240 * 60, 0.8, 0.9, 0.7, 0.75)]
    // The entry minute's own 5 and 0.1 are before the short was entered: not read.
    expect(newsBookExitOf(stamp(), bars)).toEqual({ reason: 'time', px: 0.8, atSec: MINUTE + 240 * 60 })
    expect(newsBookExitOf(stamp(), bars.slice(0, 2))).toBeNull()
  })

  it("leaves a tag's short at its stop before its target where one minute reaches both, at its target, or at the loss of its stake", () => {
    const tag = stamp({ category: 'MONITORING_TAG', stopPx: 1.05, targetPx: 0.9, exitAtSec: MINUTE + 61 * 60 })
    expect(newsBookExitOf(tag, [bar(MINUTE + 60, 1, 1.06, 0.89)])).toEqual({ reason: 'stop', px: 1.05, atSec: MINUTE + 120 })
    expect(newsBookExitOf(tag, [bar(MINUTE + 60, 1, 1.01, 0.89)])).toEqual({ reason: 'target', px: 0.9, atSec: MINUTE + 120 })
    // A minute that opens past a level fills at its open.
    expect(newsBookExitOf(tag, [bar(MINUTE + 60, 1.2, 1.3, 1.1)])).toMatchObject({ reason: 'stop', px: 1.2 })
    expect(newsBookExitOf(tag, [bar(MINUTE + 60, 0.8, 0.85, 0.7)])).toMatchObject({ reason: 'target', px: 0.8 })
    // A delisting's short has no stop: it leaves where its loss reaches its stake, the price twice its entry.
    expect(newsBookExitOf(stamp(), [bar(MINUTE + 60, 1, 1.99, 0.9)])).toBeNull()
    expect(newsBookExitOf(stamp(), [bar(MINUTE + 60, 1, 2.5, 0.9)])).toEqual({ reason: 'loss cap', px: 1 + NEWS_BOOK_LINES.lossCapPct / 100, atSec: MINUTE + 120 })
  })
})

describe("a short's result", () => {
  it('is its move on its size, after both taker fees and its funding, in the quote and in percent of its stake', () => {
    const result = newsBookResultOf(stamp(), { px: 0.8, atSec: MINUTE + 3600 }, 0.25)
    // Short 1,000 from 1 to 0.8: 200 made; 0.5 in, 0.05% of 800 out; 0.25 of funding paid to it.
    expect(result.feesQuote).toBeCloseTo(0.5 + 0.4, 12)
    expect(result.netQuote).toBeCloseTo(200 - 0.9 + 0.25, 12)
    expect(result.netPct).toBeCloseTo(((200 - 0.9 + 0.25) / 1000) * 100, 12)
    expect(result).toMatchObject({ fundingQuote: 0.25, closedAt: MINUTE + 3600 })
    // Bitget's taker on a Bitget perpetual.
    expect(newsBookResultOf(stamp({ venue: 'bitget' }), { px: 1, atSec: 0 }, 0).feesQuote).toBeCloseTo(0.5 + 0.0006 * 1000, 12)
  })

  it("is paid a positive published rate, as a short is; and, with none read, charged an assumed one at each funding time crossed", () => {
    const rates = [
      { timeSec: Math.floor(T0 / 1000) - 60, rate: 0.01 },
      { timeSec: Math.floor(T0 / 1000) + 3600, rate: 0.0002 },
      { timeSec: Math.floor(T0 / 1000) + 7200, rate: -0.0001 },
      { timeSec: Math.floor(T0 / 1000) + 99_000, rate: 0.5 }
    ]
    expect(newsBookFundingOf(stamp(), rates, T0 + 4 * 3_600_000)).toBeCloseTo(1000 * (0.0002 - 0.0001), 12)
    // From 12:00 to 17:00 UTC one funding time, 16:00, is crossed; to 23:00 none more; to 00:30, two.
    expect(assumedFundingAgainst(1000, T0, T0 + 5 * 3_600_000)).toBeCloseTo(-0.1, 12)
    expect(assumedFundingAgainst(1000, T0, T0 + 3_600_000)).toBe(0)
    expect(assumedFundingAgainst(1000, T0, T0 + 12.5 * 3_600_000)).toBeCloseTo(-0.2, 12)
  })

  it('stands, while open, at what it would make closed now, funding assumed against it', () => {
    expect(newsBookOpenNetOf(stamp(), 0.9, T0 + 5 * 3_600_000)).toBeCloseTo(100 - 0.5 - 0.45 - 0.1, 12)
  })
})
