import { describe, expect, it } from 'vitest'
import type { Candle } from '../shared/ipc'
import {
  FEED_SOURCES,
  IMPACT_MIN_STORIES,
  STALE_STORY_SECONDS,
  assetDictionary,
  eventTypeOf,
  expectedDirection,
  describeTypeExcursions,
  foldSameStories,
  impactByType,
  isRepeatOf,
  isSameStory,
  isStorySource,
  namedTickers,
  parseRss,
  readStory,
  storyAssets,
  storyReaction,
  titleSimilarity,
  toStory,
  type FeedStory,
  type StoryReaction
} from '../shared/newsFeed'

// shared/newsFeed.ts: the news of the whole market, matched to coins by rules and judged by what the
// price did (the second V3 document, §11-14). The main process's newsFeedService.ts reads the feeds.

const NOW = Date.parse('2026-10-06T12:00:00Z') / 1000
const COINDESK = FEED_SOURCES.find((source) => source.id === 'coindesk')!
const DECRYPT = FEED_SOURCES.find((source) => source.id === 'decrypt')!
const DICTIONARY = assetDictionary(['BTC', 'ETH', 'SOL', 'BCH', 'XRP', 'ONE', 'AI', 'OP', 'PEPE', 'S', 'LA'])

const RSS = `<?xml version="1.0"?><rss version="2.0"><channel><title>Feed</title>
<item><title><![CDATA[Solana's SOL jumps 8% as ETF filing advances]]></title><link>https://www.coindesk.com/markets/2026/10/06/sol-etf</link><guid isPermaLink="false">abc-123</guid><pubDate>Tue, 06 Oct 2026 10:00:00 +0000</pubDate><description><![CDATA[<p>The <b>SOL</b> token rose &amp; traders cheered. Bitcoin was flat.</p>]]></description></item>
<item><title>Exploit drains $40M from DeFi protocol</title><link>https://www.coindesk.com/tech/x</link><pubDate>Tue, 06 Oct 2026 09:00:00 GMT</pubDate><description>Funds were stolen &#8212; the team said.</description></item>
<item><title>Wrapped</title><link><![CDATA[https://decrypt.co/wrapped]]></link><guid><![CDATA[w-1]]></guid><pubDate>Tue, 06 Oct 2026 08:00:00 GMT</pubDate></item>
<item><title>No link here</title><pubDate>Tue, 06 Oct 2026 09:00:00 GMT</pubDate></item>
</channel></rss>`

function story(over: Partial<FeedStory> = {}): FeedStory {
  return {
    id: 'coindesk:1',
    source: 'coindesk',
    sourceName: 'CoinDesk',
    sourceClass: 'media',
    title: 'A story',
    url: 'https://www.coindesk.com/x',
    publishedAt: NOW - 600,
    seenAt: NOW - 500,
    summary: '',
    ...over
  }
}

describe('reading a feed', () => {
  it("takes each item's title, link, id, time and summary, as plain text, and leaves out one with no link", () => {
    const items = parseRss(RSS)
    expect(items).toHaveLength(3)
    // A link or an id wrapped as character data is read without its wrapping.
    expect(items[2]).toMatchObject({ link: 'https://decrypt.co/wrapped', guid: 'w-1' })
    expect(items[0]).toEqual({
      title: "Solana's SOL jumps 8% as ETF filing advances",
      link: 'https://www.coindesk.com/markets/2026/10/06/sol-etf',
      guid: 'abc-123',
      pubDate: 'Tue, 06 Oct 2026 10:00:00 +0000',
      description: 'The SOL token rose & traders cheered. Bitcoin was flat.'
    })
    expect(items[1].description).toBe('Funds were stolen — the team said.')
    expect(parseRss('<html><body>not a feed</body></html>')).toEqual([])
  })

  it('makes a story of an item with an https link and a time, under an id that does not change', () => {
    const [first, second] = parseRss(RSS)
    const made = toStory(first, COINDESK, NOW)
    expect(made).toMatchObject({ source: 'coindesk', sourceName: 'CoinDesk', sourceClass: 'media', publishedAt: Date.parse('2026-10-06T10:00:00Z') / 1000, seenAt: NOW })
    expect(made?.id).toMatch(/^coindesk:[0-9a-f]{8}$/)
    expect(toStory(first, COINDESK, NOW + 999)?.id).toBe(made?.id)
    expect(toStory(second, COINDESK, NOW)?.id).not.toBe(made?.id)
    expect(toStory({ ...first, link: 'http://example.com/x' }, COINDESK, NOW)).toBeNull()
    expect(toStory({ ...first, pubDate: 'yesterday' }, COINDESK, NOW)).toBeNull()
    expect(toStory({ ...first, description: 'x'.repeat(900) }, COINDESK, NOW)?.summary).toHaveLength(400)
  })
})

describe('which coins a story names', () => {
  it('reads names, longest first, and tickers in capitals or with a dollar sign', () => {
    expect(namedTickers('Bitcoin Cash rallies while Bitcoin stalls', DICTIONARY)).toEqual(['BCH', 'BTC'])
    expect(namedTickers('SOL and $XRP climb; eth lags', DICTIONARY)).toEqual(['SOL', 'XRP'])
    expect(namedTickers('Ethereum and ether-based tokens', DICTIONARY)).toEqual(['ETH'])
  })

  it('takes a ticker that is also a word only with its dollar sign or its name', () => {
    expect(namedTickers('ONE more AI agent wrote an OP-ED', DICTIONARY)).toEqual([])
    expect(namedTickers('$ONE and $AI rise; Optimism too', DICTIONARY)).toEqual(['ONE', 'AI', 'OP'])
    // A city's two letters: a story read in a one-hour run named Lagrange's LA for Los Angeles.
    expect(namedTickers('Adam Iza used off-duty LA deputies to pull warrants', DICTIONARY)).toEqual([])
    expect(namedTickers('$LA jumps after its listing', DICTIONARY)).toEqual(['LA'])
    // A coin not traded on Binance is not matched, nor a one-letter ticker.
    expect(namedTickers('DOGE and S rally', DICTIONARY)).toEqual([])
  })

  it("makes the coins in the title its subject, and those only in the summary mentioned; Binance's own tickers are its subject", () => {
    expect(storyAssets({ title: 'SOL hits a record', summary: 'Bitcoin and SOL rose together.' }, DICTIONARY)).toEqual([
      { ticker: 'SOL', relationship: 'DIRECT' },
      { ticker: 'BTC', relationship: 'INDIRECT' }
    ])
    expect(storyAssets({ title: 'Binance Will Delist PEPE', summary: '', tickers: ['PEPE'] }, DICTIONARY)).toEqual([{ ticker: 'PEPE', relationship: 'DIRECT' }])
  })
})

describe('what kind of news', () => {
  it('is the first rule the words meet, and Binance its own kind', () => {
    expect(eventTypeOf({ title: 'Exploit drains $40M from a bridge after it listed a token', summary: '' })).toBe('HACK')
    expect(eventTypeOf({ title: 'Coinbase will list XYZ', summary: '' })).toBe('LISTING')
    expect(eventTypeOf({ title: 'SEC sues an exchange', summary: '' })).toBe('REGULATION')
    expect(eventTypeOf({ title: 'U.S. scraps proposed reporting rule for crypto', summary: '' })).toBe('REGULATION')
    // A company's coins are not the bond market.
    expect(eventTypeOf({ title: 'Strive adds bitcoin to its treasury', summary: '' })).toBe('OTHER')
    expect(eventTypeOf({ title: 'Treasury yields climb', summary: '' })).toBe('MACRO')
    expect(eventTypeOf({ title: 'Spot ETH ETFs see inflows', summary: '' })).toBe('ETF')
    expect(eventTypeOf({ title: 'Token unlock of 2% next week', summary: '' })).toBe('TOKEN_UNLOCK')
    expect(eventTypeOf({ title: 'Markets wait on the Fed', summary: '' })).toBe('MACRO')
    expect(eventTypeOf({ title: 'Mainnet goes live', summary: '' })).toBe('UPGRADE')
    expect(eventTypeOf({ title: 'A partnership with a bank', summary: '' })).toBe('PARTNERSHIP')
    expect(eventTypeOf({ title: 'A quiet day', summary: '' })).toBe('OTHER')
    expect(eventTypeOf({ title: 'Notice', summary: '', binanceCategory: 'MONITORING_TAG' })).toBe('DELISTING')
    expect(eventTypeOf({ title: 'Notice', summary: '', binanceCategory: 'FUTURES_LAUNCH' })).toBe('LISTING')
  })

  it('says which way it would move its coin, where it says', () => {
    expect([expectedDirection('HACK'), expectedDirection('LISTING'), expectedDirection('MACRO')]).toEqual(['down', 'up', null])
  })
})

describe('how much it might matter', () => {
  it('is its kind, how directly it names a coin, its source and its freshness', () => {
    const hack = readStory(story({ title: 'SOL bridge hacked', publishedAt: NOW - 600 }), DICTIONARY, 0.85, NOW)
    expect(hack).toMatchObject({ eventType: 'HACK', impact: Math.round(90 * 0.85), stale: false, marketWide: false })
    const mentioned = readStory(story({ title: 'A bridge was hacked', summary: 'It held SOL.' }), DICTIONARY, 0.85, NOW)
    expect(mentioned.impact).toBe(Math.round(90 * 0.6 * 0.85))
    const macro = readStory(story({ title: 'Markets wait on the Fed' }), DICTIONARY, 0.85, NOW)
    expect(macro).toMatchObject({ marketWide: true, impact: Math.round(55 * 0.8 * 0.85) })
    // Twelve and a half hours old: worth seven tenths.
    const older = readStory(story({ title: 'SOL bridge hacked', publishedAt: NOW - 45_000 }), DICTIONARY, 0.85, NOW)
    expect(older.impact).toBe(Math.round(90 * 0.85 * (1 - (0.6 * (45_000 - 3600)) / (86_400 - 3600))))
  })

  it('is old news when it was published a day before it was read', () => {
    expect(readStory(story({ publishedAt: NOW - STALE_STORY_SECONDS - 600, seenAt: NOW - 500 }), DICTIONARY, 0.85, NOW).stale).toBe(true)
    expect(readStory(story({ publishedAt: NOW - 3600, seenAt: NOW - 500 }), DICTIONARY, 0.85, NOW).stale).toBe(false)
  })
})

describe('the same story from several sources', () => {
  it('is carried once, by the first to publish it, naming the others', () => {
    expect(titleSimilarity('SOL jumps 8% as ETF filing advances', 'Solana SOL jumps 8% as the ETF filing advances')).toBeGreaterThanOrEqual(0.6)
    const first = readStory(story({ id: 'coindesk:1', title: 'SOL jumps 8% as ETF filing advances', publishedAt: NOW - 3000 }), DICTIONARY, 0.85, NOW)
    const later = readStory(
      story({ id: 'decrypt:1', source: 'decrypt', sourceName: DECRYPT.name, title: 'Solana SOL jumps 8% as the ETF filing advances', publishedAt: NOW - 1000 }),
      DICTIONARY,
      0.8,
      NOW
    )
    const apart = readStory(story({ id: 'decrypt:2', source: 'decrypt', sourceName: DECRYPT.name, title: 'A different story', publishedAt: NOW - 500 }), DICTIONARY, 0.8, NOW)
    const folded = foldSameStories([later, apart, first])
    expect(folded.map((entry) => [entry.id, entry.alsoIn])).toEqual([
      ['decrypt:2', []],
      ['coindesk:1', ['Decrypt']]
    ])
    expect(folded.map((entry) => entry.sources)).toEqual([[], []])
    // The same source twice is two stories; seven hours apart, two stories.
    expect(foldSameStories([first, { ...first, id: 'coindesk:2', publishedAt: NOW - 2000 }])).toHaveLength(2)
    expect(foldSameStories([first, { ...later, publishedAt: first.publishedAt + 7 * 3600 }])).toHaveLength(2)
  })

  it('is one story at record time since 8 October 2026: a second source is a source record on it, and named with it', () => {
    const first = readStory(story({ id: 'coindesk:1', title: 'SOL jumps 8% as ETF filing advances', publishedAt: NOW - 3000 }), DICTIONARY, 0.85, NOW)
    const copy = story({ id: 'decrypt:1', source: 'decrypt', sourceName: DECRYPT.name, title: 'Solana SOL jumps 8% as the ETF filing advances', publishedAt: NOW - 1000 })
    expect(isSameStory(first, copy)).toBe(true)
    expect(isSameStory(copy, first)).toBe(true)
    expect(isSameStory(first, { ...copy, source: 'coindesk' })).toBe(false)
    expect(isSameStory(first, { ...copy, publishedAt: first.publishedAt + 6 * 3600 + 1 })).toBe(false)
    expect(isSameStory(first, { ...copy, title: 'Something else entirely' })).toBe(false)
    const record = { kind: 'source' as const, storyId: 'coindesk:1', source: 'decrypt', sourceName: 'Decrypt', url: copy.url, publishedAt: copy.publishedAt, seenAt: NOW }
    expect(isStorySource(record)).toBe(true)
    expect(isStorySource({ ...record, kind: 'story' })).toBe(false)
    expect(isStorySource(first)).toBe(false)
    const folded = foldSameStories([first], [record, { ...record, storyId: 'other:9' }])
    expect(folded).toHaveLength(1)
    expect(folded[0].alsoIn).toEqual(['Decrypt'])
    expect(folded[0].sources).toEqual([record])
  })

  it('is recycled news a title like one of the previous seven days\', beyond six hours: half the impact', () => {
    const first = story({ id: 'coindesk:1', title: 'SOL jumps 8% as ETF filing advances', publishedAt: NOW - 2 * 86_400 })
    const again = story({ id: 'coindesk:2', title: 'Solana SOL jumps 8% as the ETF filing advances', publishedAt: NOW - 600 })
    expect(isRepeatOf(first, again)).toBe(true)
    expect(isRepeatOf(first, { ...again, publishedAt: first.publishedAt + 6 * 3600 })).toBe(false)
    expect(isRepeatOf({ ...first, publishedAt: NOW - 8 * 86_400 }, again)).toBe(false)
    expect(isRepeatOf(first, { ...again, title: 'Something else entirely' })).toBe(false)
    const fresh = readStory(again, DICTIONARY, 0.85, NOW)
    const recycled = readStory({ ...again, repeat: true }, DICTIONARY, 0.85, NOW)
    expect(recycled.impact).toBe(Math.round(fresh.impact * 0.5))
    expect(recycled.repeat).toBe(true)
  })
})

describe('what the price did', () => {
  const PUBLISHED = Date.parse('2026-10-06T08:00:20Z') / 1000
  const MINUTE = Math.floor(PUBLISHED / 60) * 60
  /** Minutes from an hour before to four hours after, at 100 and volume 10, unless `at` says. */
  function minutes(at: Record<number, Partial<Candle>> = {}): Candle[] {
    const out: Candle[] = []
    for (let offset = -60; offset <= 240; offset++) {
      const close = at[offset]?.close ?? 100
      out.push({ time: MINUTE + offset * 60, open: close, high: close, low: close, close, volume: at[offset]?.volume ?? 10 })
    }
    return out
  }
  const react = (type: Parameters<typeof storyReaction>[0]['eventType'], bars: Candle[], nowSec = MINUTE + 300 * 60): StoryReaction =>
    storyReaction({ storyId: 's', ticker: 'SOL', symbol: 'SOLUSDT', eventType: type, publishedAt: PUBLISHED, bars, nowSec })

  it('measures from the close of the minute it was published in, before and after, and the volume after', () => {
    // The minute after it was published in closed elsewhere: it is not where a move is measured from.
    const reaction = react('LISTING', minutes({ [-15]: { close: 99 }, 1: { close: 100.3 }, 5: { close: 100.5 }, 15: { close: 101.2 }, 60: { close: 102 }, 240: { close: 99.5 } }))
    expect(reaction.before15mPct).toBeCloseTo(1.0101, 3)
    expect(reaction.after.m5).toBeCloseTo(0.5, 10)
    expect(reaction.after.m15).toBeCloseTo(1.2, 10)
    expect(reaction.after.h1).toBeCloseTo(2, 10)
    expect(reaction.after.h4).toBeCloseTo(-0.5, 10)
    expect(reaction.volumeRatio).toBeCloseTo(1, 10)
    // A listing up 1.2% in fifteen minutes is confirmed, and it had already moved its way before.
    expect(reaction).toMatchObject({ verdict: 'CONFIRMED', pricedIn: true })
  })

  it('measures how far the price went up and down within an hour and within four (8 October 2026)', () => {
    const bars = minutes({ 10: { close: 100 }, 30: { close: 100 }, 100: { close: 100 }, 200: { close: 100 } })
    bars[60 + 10] = { ...bars[60 + 10], high: 102.5, low: 99.8 }
    bars[60 + 30] = { ...bars[60 + 30], high: 100.4, low: 97 }
    bars[60 + 100] = { ...bars[60 + 100], high: 104, low: 100 }
    bars[60 + 200] = { ...bars[60 + 200], high: 100, low: 95 }
    const reaction = react('LISTING', bars)
    expect(reaction.excursion).toEqual({ best1hPct: expect.closeTo(2.5, 10), worst1hPct: expect.closeTo(-3, 10), best4hPct: expect.closeTo(4, 10), worst4hPct: expect.closeTo(-5, 10) })
    // The minutes reaching an hour and not four: the four hours are not known.
    const short = react('LISTING', bars.filter((bar) => bar.time <= MINUTE + 90 * 60), MINUTE + 95 * 60)
    expect(short.excursion).toEqual({ best1hPct: expect.closeTo(2.5, 10), worst1hPct: expect.closeTo(-3, 10), best4hPct: null, worst4hPct: null })
    // A minute missing inside the hour: the hour is not known either.
    const gap = react('LISTING', bars.filter((bar) => bar.time !== MINUTE + 20 * 60))
    expect(gap.excursion?.best1hPct).toBeNull()
  })

  it('is against the news, none, or not yet known', () => {
    expect(react('LISTING', minutes({ 15: { close: 98.8 } })).verdict).toBe('AGAINST')
    expect(react('HACK', minutes({ 15: { close: 98.8 } })).verdict).toBe('CONFIRMED')
    expect(react('LISTING', minutes({ 15: { close: 100.5 } })).verdict).toBe('NONE')
    expect(react('LISTING', minutes(), MINUTE + 10 * 60).verdict).toBe('PENDING')
    // With no direction to expect, a reaction is a large move on high volume.
    const loud: Record<number, Partial<Candle>> = { 15: { close: 98 } }
    for (let offset = 1; offset <= 15; offset++) loud[offset] = { ...(loud[offset] ?? {}), volume: 30 }
    expect(react('MACRO', minutes(loud)).verdict).toBe('CONFIRMED')
    expect(react('MACRO', minutes({ 15: { close: 98 } })).verdict).toBe('NONE')
  })
})

describe('what each kind of news did', () => {
  const reaction = (type: StoryReaction['eventType'], h1: number, h4: number | null = 0): StoryReaction => ({
    storyId: `${type}-${h1}-${Math.random()}`,
    ticker: 'SOL',
    symbol: 'SOLUSDT',
    eventType: type,
    publishedAt: NOW,
    before15mPct: 0,
    after: { m5: h1 / 4, m15: h1 / 2, h1, h4 },
    volumeRatio: 1,
    verdict: 'NONE',
    pricedIn: false,
    measuredAt: NOW
  })

  it('is shown only from thirty stories measured to their end', () => {
    const few = Array.from({ length: IMPACT_MIN_STORIES - 1 }, (_, k) => reaction('LISTING', k - 10))
    const enough = Array.from({ length: IMPACT_MIN_STORIES }, (_, k) => reaction('HACK', k - 20))
    const unfinished = [reaction('ETF', 5, null)]
    const table = impactByType([...few, ...enough, ...unfinished])
    expect(table.map((row) => [row.eventType, row.stories, row.enough])).toEqual([
      ['HACK', 30, true],
      ['LISTING', 29, false]
    ])
    expect(table[1].medianPct).toBeNull()
    expect(table[0].medianPct?.h1).toBeCloseTo(-5.5, 10)
    expect(table[0].shareUp1h).toBeCloseTo(9 / 30, 10)
  })
})

describe('what each kind of news did, in excursions (8 October 2026)', () => {
  const reaction = (type: StoryReaction['eventType'], worst1h: number, best1h: number, withExcursion = true): StoryReaction => ({
    storyId: `${type}-${worst1h}-${best1h}-${Math.random()}`,
    ticker: 'SOL',
    symbol: 'SOLUSDT',
    eventType: type,
    publishedAt: NOW,
    before15mPct: 0,
    after: { m5: 0, m15: 0, h1: 0, h4: 0 },
    volumeRatio: 1,
    verdict: 'NONE',
    pricedIn: false,
    measuredAt: NOW,
    ...(withExcursion ? { excursion: { best1hPct: best1h, worst1hPct: worst1h, best4hPct: best1h * 2, worst4hPct: worst1h * 2 } } : {})
  })

  it('gives the medians from thirty reactions that carry them, and nothing from fewer, old reactions aside', () => {
    const enough = Array.from({ length: IMPACT_MIN_STORIES }, (_, k) => reaction('HACK', -k / 10, k / 20))
    const old = Array.from({ length: 5 }, () => reaction('HACK', 0, 0, false))
    const table = impactByType([...enough, ...old])
    expect(table[0]).toMatchObject({ eventType: 'HACK', stories: 35, enough: true })
    expect(table[0].excursions).toEqual({ best1hPct: expect.closeTo(0.725, 10), worst1hPct: expect.closeTo(-1.45, 10), best4hPct: expect.closeTo(1.45, 10), worst4hPct: expect.closeTo(-2.9, 10) })
    expect(describeTypeExcursions(table[0])).toBe('Within an hour of a hack or exploit story, the median worst move was -1.45% and the median best +0.72%; within four hours, -2.90% and +1.45%.')
    // Thirty-one reactions of which twenty-nine carry excursions: enough for the moves, not for these.
    const few = [...Array.from({ length: IMPACT_MIN_STORIES - 1 }, (_, k) => reaction('LISTING', -k / 10, k / 20)), reaction('LISTING', 0, 0, false), reaction('LISTING', 0, 0, false)]
    const listing = impactByType(few)[0]
    expect(listing).toMatchObject({ eventType: 'LISTING', stories: 31, enough: true, excursions: null })
    expect(describeTypeExcursions(listing)).toBeNull()
  })
})
