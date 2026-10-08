import { describe, expect, it } from 'vitest'
import { REVIEW_LINES, type NewsReading } from '../shared/aiAdditions'
import { newsAgainstBlock, storiesAgainst, type NewsAgainstInput, type NewsAgainstStory } from '../shared/paperNewsBlock'

// News against a paper trade of the watch's (the second V3 document, §25): a story of major impact
// naming the coin, from three hours before the event to now, that points the other way, refuses it.
// Which way a story points is the signal score's rule: the analyst's reading, else its kind.

const T = Date.parse('2026-10-08T09:00:00Z') / 1000

const story = (over: Partial<NewsAgainstStory> = {}): NewsAgainstStory => ({
  id: 'coindesk:1',
  eventType: 'HACK',
  assets: [{ ticker: 'SOL', relationship: 'DIRECT' }],
  impact: 77,
  publishedAt: T - 600,
  stale: false,
  title: 'Hackers drain $50 million from a Solana bridge',
  sourceName: 'CoinDesk',
  ...over
})

const input = (over: Partial<NewsAgainstInput> = {}): NewsAgainstInput => ({
  event: { baseAsset: 'SOL', time: T },
  side: 'buy',
  stories: [story()],
  readings: undefined,
  nowSec: T + 30,
  ...over
})

const reading = (direction: NewsReading['direction'], ticker = 'SOL'): Record<string, NewsReading> => ({
  'coindesk:1': { ticker, relationship: 'DIRECT', direction, impact: 80, horizon: '4h', confidence: 0.7, pricedIn: false, reasons: 'read for the test' }
})

describe('news against a paper trade', () => {
  it('refuses a buy on a major story naming the coin that points down, and names the story', () => {
    expect(newsAgainstBlock(input())).toBe(
      'A story of impact 77 names SOL and points down, against a paper BUY ("Hackers drain $50 million from a Solana bridge", CoinDesk, 08:50 UTC).'
    )
    // The same story is the way a sell wants.
    expect(newsAgainstBlock(input({ side: 'sell' }))).toBeNull()
    // A listing points up: against a sell, not a buy.
    expect(newsAgainstBlock(input({ stories: [story({ eventType: 'LISTING' })] }))).toBeNull()
    expect(newsAgainstBlock(input({ side: 'sell', stories: [story({ eventType: 'LISTING' })] }))).toMatch(/points up, against a paper SELL/)
  })

  it('refuses nothing on a story under the line, stale, outside the window, about another coin, or with no way of its own', () => {
    expect(newsAgainstBlock(input({ stories: [story({ impact: REVIEW_LINES.majorNewsImpact - 1 })] }))).toBeNull()
    expect(newsAgainstBlock(input({ stories: [story({ impact: REVIEW_LINES.majorNewsImpact })] }))).not.toBeNull()
    expect(newsAgainstBlock(input({ stories: [story({ stale: true })] }))).toBeNull()
    expect(newsAgainstBlock(input({ stories: [story({ publishedAt: T - REVIEW_LINES.majorNewsSeconds - 1 })] }))).toBeNull()
    expect(newsAgainstBlock(input({ stories: [story({ publishedAt: T - REVIEW_LINES.majorNewsSeconds })] }))).not.toBeNull()
    expect(newsAgainstBlock(input({ stories: [story({ publishedAt: T + 31 })] }))).toBeNull()
    expect(newsAgainstBlock(input({ stories: [story({ assets: [{ ticker: 'ETH', relationship: 'DIRECT' }] })] }))).toBeNull()
    expect(newsAgainstBlock(input({ stories: [story({ eventType: 'REGULATION' })] }))).toBeNull()
    expect(newsAgainstBlock(input({ stories: [] }))).toBeNull()
  })

  it("takes the analyst's reading of the story about this coin over its kind, and ignores one about another coin", () => {
    expect(newsAgainstBlock(input({ readings: reading('up') }))).toBeNull()
    expect(newsAgainstBlock(input({ readings: reading('none') }))).toBeNull()
    expect(newsAgainstBlock(input({ stories: [story({ eventType: 'LISTING' })], readings: reading('down') }))).not.toBeNull()
    expect(newsAgainstBlock(input({ readings: reading('up', 'ETH') }))).not.toBeNull()
  })

  it('names the strongest story against it, and cuts a long title', () => {
    const stories = [story({ id: 'a', impact: 71, title: 'A' }), story({ id: 'b', impact: 90, title: 'B'.repeat(120) }), story({ id: 'c', impact: 90, publishedAt: T - 60, title: 'C' })]
    expect(storiesAgainst(input({ stories })).map((entry) => entry.id)).toEqual(['c', 'b', 'a'])
    expect(newsAgainstBlock(input({ stories: stories.slice(0, 2) }))).toContain(`"${'B'.repeat(87)}…"`)
  })
})
