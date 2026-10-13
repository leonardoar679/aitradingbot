import { describe, expect, it } from 'vitest'
import type { NewsReading } from '../shared/aiAdditions'
import type { MarketEvent } from '../shared/marketEvent'
import type { MarketRegime } from '../shared/marketResearch'
import type { ReadStory, StoryReaction } from '../shared/newsFeed'
import { OPPORTUNITY_SCORE_VERSION, SIGNAL_PENALTIES, SIGNAL_WEIGHTS, scoredSide, signalScore, storiesAbout, type SignalCall } from '../shared/opportunityScore'

// shared/opportunityScore.ts: the signal score of an opportunity (the second V3 document, §20 and
// §42) -- fixed weights shown on screen, penalties, and a model counted only as a side it would take.

const T = Date.parse('2026-10-06T12:00:00Z') / 1000
const NOW = T + 300

function event(over: Partial<MarketEvent> = {}): MarketEvent {
  return {
    id: `binance:SOLUSDT:${T}`,
    exchange: 'binance',
    symbol: 'SOLUSDT',
    baseAsset: 'SOL',
    quoteAsset: 'USDT',
    time: T,
    type: 'breakout',
    direction: 'up',
    band: 'urgent',
    score: 91,
    components: { price: 90, volume: 95, volatility: 85, pressure: 90, breakout: 95 },
    price: 100,
    returnsPct: { m1: 0.4, m5: 1.5, m15: 3, h1: 3.2, h4: 2.5 },
    moveSigmas: 6,
    volumeRatio: 4.7,
    rangeRatio: 3,
    live: { detectedAt: T + 8, quoteVolume24h: 80_000_000, spreadPct: 0.01, candidateScore: 93, rank: 1 },
    ...over
  }
}

function story(over: Partial<ReadStory> = {}): ReadStory {
  return {
    id: 'coindesk:1',
    source: 'coindesk',
    sourceName: 'CoinDesk',
    sourceClass: 'media',
    title: 'Binance lists a Solana product',
    url: 'https://www.coindesk.com/x',
    publishedAt: T - 600,
    seenAt: T - 590,
    summary: '',
    assets: [{ ticker: 'SOL', relationship: 'DIRECT' }],
    marketWide: false,
    eventType: 'LISTING',
    credibility: 0.85,
    impact: 60,
    stale: false,
    alsoIn: [],
    ...over
  }
}

const long = (acted = true): SignalCall => ({ side: 'long', refused: false, acted })
const short = (acted = true): SignalCall => ({ side: 'short', refused: false, acted })
const hold: SignalCall = { side: null, refused: false, acted: false }
const refused: SignalCall = { side: null, refused: true, acted: false }

function score(over: { event?: MarketEvent; side?: 'long' | 'short' | null; calls?: SignalCall[]; stories?: ReadStory[]; reactions?: Record<string, StoryReaction>; regime?: MarketRegime | null } = {}): ReturnType<typeof signalScore> {
  return signalScore({
    event: over.event ?? event(),
    side: over.side === undefined ? 'long' : over.side,
    calls: over.calls ?? [long(), hold],
    stories: over.stories ?? [],
    reactions: over.reactions ?? {},
    regime: over.regime === undefined ? null : over.regime,
    nowSec: NOW
  })
}
const part = (result: ReturnType<typeof signalScore>, id: string): { value: number; points: number; fact: string } => {
  const found = result.parts.find((entry) => entry.id === id)
  if (found === undefined) throw new Error(`no part ${id}`)
  return found
}

describe('the signal score', () => {
  it('weighs seven parts that add up to one, and is versioned', () => {
    expect(Object.values(SIGNAL_WEIGHTS).reduce((sum, weight) => sum + weight, 0)).toBeCloseTo(1, 12)
    expect(score().version).toBe(OPPORTUNITY_SCORE_VERSION)
    expect(score().parts.map((entry) => entry.id)).toEqual(['event', 'volume', 'breakout', 'liquidity', 'news', 'regime', 'models'])
  })

  it('adds each part at its weight, less what the penalties take', () => {
    const result = score()
    // 91 x .25 + 95 x .1 + 95 x .1 + liquidity x .1 + no news + an unread regime's 50 x .15 + one of two models x .15.
    const liquidity = (100 * Math.log10(80)) / 2
    expect(part(result, 'liquidity').value).toBeCloseTo(liquidity, 10)
    const parts = 22.75 + 9.5 + 9.5 + liquidity / 10 + 0 + 7.5 + 7.5
    // Bars 3x their usual range score 85, 35 points past the calm line of 50: 70% of the 10.
    expect(result.penalties).toEqual([{ id: 'volatility', label: 'Wild bars', points: 7, fact: 'bars 3.0 times their usual range (full at 5)' }])
    expect(result.score).toBe(Math.round(parts - 7))
    expect(result.score).toBe(59)
  })

  it('is 100 for an event at full marks on every part, and never under 0', () => {
    const full = event({ score: 100, components: { price: 100, volume: 100, volatility: 50, pressure: 100, breakout: 100 }, live: { detectedAt: T, quoteVolume24h: 2e8, spreadPct: 0.01, candidateScore: 100, rank: 1 } })
    expect(score({ event: full, calls: [long(), long()], stories: [story({ impact: 100 })], regime: 'bull' }).score).toBe(100)
    const empty = event({ score: 0, components: { price: 0, volume: 0, volatility: 100, pressure: 0, breakout: 0 }, live: { detectedAt: T, quoteVolume24h: 1e5, spreadPct: 0.01, candidateScore: 0, rank: 1 } })
    expect(score({ event: empty, calls: [long(), short()], regime: 'bear' }).score).toBe(0)
  })

  it('reads the news that names the coin by its impact and whether it points the same way', () => {
    // A listing, for a BUY: its impact in full.
    expect(part(score({ stories: [story()] }), 'news')).toMatchObject({ value: 60, fact: 'Listing, impact 60: Binance lists a Solana product (CoinDesk)' })
    // A hack, for a BUY: it points the other way, and counts nothing.
    const against = part(score({ stories: [story({ eventType: 'HACK', title: 'Solana bridge drained', impact: 77 })] }), 'news')
    expect(against).toMatchObject({ value: 0, fact: 'Hack, impact 77: Solana bridge drained (CoinDesk), which points the other way' })
    // For a SELL the hack is the case: in full.
    expect(part(score({ side: 'short', stories: [story({ eventType: 'HACK', impact: 77 })] }), 'news').value).toBe(77)
    // A kind with no way of its own counts half, and so does any story with no side to read it by.
    expect(part(score({ stories: [story({ eventType: 'REGULATION', impact: 50 })] }), 'news').value).toBe(25)
    expect(part(score({ side: null, stories: [story()] }), 'news').value).toBe(30)
    // The strongest counts, not the first.
    expect(part(score({ stories: [story({ id: 'a', impact: 40 }), story({ id: 'b', impact: 70 }), story({ id: 'c', eventType: 'HACK', impact: 90 })] }), 'news').value).toBe(70)
  })

  it("takes which way a story points from the news analyst's reading of it about this coin, and keeps the rule's impact", () => {
    const reading = (direction: 'up' | 'down' | 'none', ticker = 'SOL'): NewsReading => ({ ticker, relationship: 'DIRECT', direction, impact: 90, horizon: '4h', confidence: 0.7, pricedIn: false, reasons: '' })
    const withReading = (read: NewsReading): ReturnType<typeof part> =>
      part(
        signalScore({ event: event(), side: 'long', calls: [long()], stories: [story()], reactions: {}, readings: { 'coindesk:1': read }, regime: null, nowSec: NOW }),
        'news'
      )
    // The rule reads a listing as up; the analyst reads this one down: for a BUY it now counts nothing.
    expect(withReading(reading('down'))).toMatchObject({ value: 0, fact: 'Listing, impact 60: Binance lists a Solana product (CoinDesk), which points the other way, read by the news analyst as pointing down' })
    expect(withReading(reading('up'))).toMatchObject({ value: 60, fact: 'Listing, impact 60: Binance lists a Solana product (CoinDesk), read by the news analyst as pointing up' })
    expect(withReading(reading('none')).value).toBe(30)
    // A reading about another coin is not this coin's: the rule stands.
    expect(withReading(reading('down', 'BTC'))).toMatchObject({ value: 60, fact: 'Listing, impact 60: Binance lists a Solana product (CoinDesk)' })
  })

  it('counts only stories about the coin, from three hours before the event to now', () => {
    expect(part(score({ stories: [story({ publishedAt: T - 3 * 3600 })] }), 'news').value).toBe(60)
    expect(part(score({ stories: [story({ publishedAt: T - 3 * 3600 - 1 })] }), 'news')).toMatchObject({ value: 0, fact: 'no story names SOL in the 3 hours before the event or since' })
    expect(part(score({ stories: [story({ publishedAt: NOW + 1 })] }), 'news').value).toBe(0)
    expect(part(score({ stories: [story({ assets: [{ ticker: 'XRP', relationship: 'DIRECT' }] })] }), 'news').value).toBe(0)
    // Named only in the summary, it still names the coin; its impact already says it matters less.
    expect(part(score({ stories: [story({ assets: [{ ticker: 'SOL', relationship: 'INDIRECT' }], impact: 36 })] }), 'news').value).toBe(36)
    expect(storiesAbout('SOL', T, [story(), story({ id: 'x', assets: [] })], NOW).map((entry) => entry.id)).toEqual(['coindesk:1'])
  })

  it('takes points off for old news: only stale stories, or the strongest already priced in', () => {
    const stale = score({ stories: [story({ stale: true })] })
    expect(part(stale, 'news')).toMatchObject({ value: 0, fact: 'only old news names the coin' })
    expect(stale.penalties.find((entry) => entry.id === 'staleNews')).toEqual({ id: 'staleNews', label: 'Old news', points: SIGNAL_PENALTIES.staleNews, fact: 'the only stories that name the coin are old news' })
    // A stale story beside a fresh one costs nothing.
    expect(score({ stories: [story({ id: 'old', stale: true }), story()] }).penalties.map((entry) => entry.id)).toEqual(['volatility'])
    const reaction = { storyId: 'coindesk:1', pricedIn: true } as StoryReaction
    expect(score({ stories: [story()], reactions: { 'coindesk:1': reaction } }).penalties.find((entry) => entry.id === 'staleNews')?.fact).toBe(
      'the price had already moved its way before the story was published'
    )
    expect(score({ stories: [story()], reactions: { 'coindesk:1': { ...reaction, pricedIn: false } } }).penalties.map((entry) => entry.id)).toEqual(['volatility'])
  })

  it('counts a model only as a side it would take at the confidence acted on, and takes points off when they split', () => {
    expect(part(score({ calls: [] }), 'models')).toMatchObject({ value: 0, fact: 'no model has answered' })
    expect(part(score({ calls: [long(), long(), hold] }), 'models')).toMatchObject({ value: (100 * 2) / 3, fact: '2 of the 3 that answered would BUY at the confidence this app acts on' })
    // Under the confidence acted on, a BUY is not one; a refused answer is not an answer.
    expect(part(score({ calls: [long(false), long(), refused] }), 'models').value).toBe(50)
    expect(part(score({ side: null, calls: [hold, hold] }), 'models')).toMatchObject({ value: 0, fact: '2 answered, and none would trade it' })
    const split = score({ calls: [long(), short(false)] })
    expect(split.penalties.find((entry) => entry.id === 'disagreement')).toEqual({ id: 'disagreement', label: 'Models split', points: 15, fact: 'the models take opposite sides' })
  })

  it('suits each regime to the side, and reads the middle without either', () => {
    const fit = (regime: MarketRegime | null, side: 'long' | 'short' | null): number => part(score({ regime, side }), 'regime').value
    expect([fit('bull', 'long'), fit('recovery', 'long'), fit('sideways', 'long'), fit('high-vol', 'long'), fit('bear', 'long'), fit('panic', 'long')]).toEqual([100, 75, 50, 25, 0, 0])
    expect([fit('bull', 'short'), fit('recovery', 'short'), fit('sideways', 'short'), fit('high-vol', 'short'), fit('bear', 'short'), fit('panic', 'short')]).toEqual([0, 25, 50, 25, 100, 50])
    expect(fit(null, 'long')).toBe(50)
    expect(fit('bull', null)).toBe(50)
    expect(part(score({ regime: 'bear' }), 'regime').fact).toBe('BEAR, for a BUY')
    expect(part(score({ regime: null }), 'regime').fact).toBe('the market has not been read')
  })

  it('reads a pair whose trading is not known at the middle, and calm bars at no cost', () => {
    expect(part(score({ event: event({ live: null }) }), 'liquidity')).toMatchObject({ value: 50, fact: 'how much it trades is not known' })
    expect(score({ event: event({ components: { price: 90, volume: 95, volatility: 50, pressure: 90, breakout: 95 } }) }).penalties).toEqual([])
  })

  it('is read on the side on offer, else on the way the event moved', () => {
    expect(scoredSide('short', 'up')).toBe('short')
    expect(scoredSide(null, 'up')).toBe('long')
    expect(scoredSide(null, 'down')).toBe('short')
    expect(scoredSide(null, 'none')).toBeNull()
  })
})
