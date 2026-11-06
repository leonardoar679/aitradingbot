import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import type { Candle } from '../shared/ipc'
import { FEED_SOURCES, toStory, type FeedStory, type StorySource } from '../shared/newsFeed'

// electron/services/newsFeedService.ts, driven with its feeds, Binance's pairs, the coins' candles
// and the news reader faked, and its two files in a folder of its own: what a read keeps, once;
// what it says of a feed that fails; the same story folded; and what the price did, measured and,
// once four hours have passed, kept.

const NOW = Date.parse('2026-10-06T12:00:00Z') / 1000
const rig = vi.hoisted(() => ({
  dir: '',
  opened: [] as string[],
  feeds: {} as Record<string, { status: number; body: string; etag?: string }>,
  candles: {} as Record<string, Candle[]>,
  requests: [] as string[],
  asked: [] as { url: string; headers: Record<string, string> }[]
}))

vi.mock('electron', () => ({
  app: { getPath: () => rig.dir },
  shell: { openExternal: async (url: string) => void rig.opened.push(url) }
}))
vi.mock('../electron/services/marketService', () => ({
  listSymbols: async () => [
    { symbol: 'BTCUSDT', baseAsset: 'BTC', quoteAsset: 'USDT' },
    { symbol: 'SOLUSDT', baseAsset: 'SOL', quoteAsset: 'USDT' },
    { symbol: 'PEPEUSDT', baseAsset: 'PEPE', quoteAsset: 'USDT' },
    { symbol: 'ETHBTC', baseAsset: 'ETH', quoteAsset: 'BTC' }
  ],
  scanSourceFor: () => ({
    fetchRecentCandles: async (symbol: string, interval: string, limit: number) => {
      rig.requests.push(`${symbol} ${interval} ${limit}`)
      return rig.candles[symbol] ?? []
    }
  })
}))
/** What the main process told: every feed dead (the V4 document, §48). */
const told = vi.hoisted(() => [] as { title: string; body: string; extra: { kind: string; thread?: string } }[])
// A notice the main process builds in the person's language (V6 Stage 14) is handed as a builder:
// built here in English, as the language of a profile that chose none.
vi.mock('../electron/services/noticeService', async () => {
  const { ENGLISH } = await import('../shared/i18n/translate')
  type Told = { title: string; body: string; extra: { kind: string; thread?: string } }
  return {
    tell: (notice: Told | ((i18n: typeof ENGLISH) => Told)) => void told.push(typeof notice === 'function' ? notice(ENGLISH) : notice),
    tellNotice: async () => true
  }
})
vi.mock('../electron/services/newsService', () => ({
  getNewsState: async () => ({
    config: {},
    lastReadAt: NOW,
    nextReadAt: null,
    error: null,
    recent: [{ id: 301, catalog: 161, title: 'Binance Will Delist PEPE on 2026-10-20', releaseSec: NOW - 1200, seenAt: NOW - 1190, category: 'DELISTING', tickers: ['PEPE'] }]
  }),
  onNewsUpdate: () => () => undefined
}))

import { getNewsFeedState, newsHistory, openStoryLink, startNewsFeed } from '../electron/services/newsFeedService'

const rss = (items: { title: string; link: string; guid?: string; at: number; description?: string }[]): string =>
  `<?xml version="1.0"?><rss version="2.0"><channel>${items
    .map(
      (item) =>
        `<item><title>${item.title}</title><link>${item.link}</link>${item.guid === undefined ? '' : `<guid>${item.guid}</guid>`}<pubDate>${new Date(item.at * 1000).toUTCString()}</pubDate><description>${item.description ?? ''}</description></item>`
    )
    .join('')}</channel></rss>`

/** A coin's closed minutes from an hour before `published` to now, at 100, with `after` set. */
function minutes(published: number, after: Record<number, number> = {}): Candle[] {
  const first = Math.floor(published / 60) * 60 - 3600
  const out: Candle[] = []
  for (let time = first; time + 60 <= NOW; time += 60) {
    const offset = (time - Math.floor(published / 60) * 60) / 60
    const close = after[offset] ?? 100
    out.push({ time, open: close, high: close, low: close, close, volume: 10 })
  }
  return out
}

const SOL_AT = NOW - 6 * 60
const BTC_AT = NOW - 5 * 3600
const OLD_AT = NOW - 2 * 86_400
/** A story read two days ago, on file, and still in CoinDesk's feed: it must not be kept twice. */
const OLD = toStory(
  { title: 'An older story', link: 'https://www.coindesk.com/old', guid: 'old-1', pubDate: new Date(OLD_AT * 1000).toUTCString(), description: '' },
  FEED_SOURCES[0],
  OLD_AT
) as FeedStory

beforeAll(async () => {
  vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] })
  vi.setSystemTime(NOW * 1000)
  rig.dir = mkdtempSync(join(tmpdir(), 'feed-'))
  mkdirSync(join(rig.dir, 'news'))
  writeFileSync(join(rig.dir, 'news', 'feed-2026-10.jsonl'), `${JSON.stringify(OLD)}\nnot json\n`)
  rig.feeds = {
    'https://www.coindesk.com/arc/outboundfeeds/rss': {
      status: 200,
      etag: '"cd-1"',
      body: rss([
        { title: 'Coinbase will list SOL futures for US traders', link: 'https://www.coindesk.com/sol-futures', guid: 'sol-1', at: SOL_AT },
        { title: 'An older story', link: 'https://www.coindesk.com/old', guid: 'old-1', at: OLD_AT }
      ])
    },
    'https://www.theblock.co/rss.xml': { status: 503, body: '' },
    'https://cointelegraph.com/rss': {
      status: 200,
      body: rss([{ title: 'Coinbase will list SOL futures for traders in the US', link: 'https://cointelegraph.com/news/sol-futures', at: SOL_AT + 300 }])
    },
    'https://decrypt.co/feed': {
      status: 200,
      body: rss([{ title: 'Bitcoin ETF inflows jump', link: 'https://decrypt.co/btc-etf', at: BTC_AT, description: 'Spot ETFs drew money.' }])
    }
  }
  rig.candles = { SOLUSDT: minutes(SOL_AT), BTCUSDT: minutes(BTC_AT, { 15: 101.5, 60: 102, 240: 103 }) }
  vi.stubGlobal('fetch', async (url: string, init?: { headers?: Record<string, string> }) => {
    const feed = rig.feeds[url]
    const headers = init?.headers ?? {}
    rig.asked.push({ url, headers })
    // A feed asked with the ETag it last gave, and unchanged since, answers 304 with nothing.
    if (feed !== undefined && feed.status === 200 && feed.etag !== undefined && headers['If-None-Match'] === feed.etag) return { ok: false, status: 304, headers: new Headers(), text: async () => '' }
    return { ok: feed !== undefined && feed.status === 200, status: feed?.status ?? 404, headers: new Headers(feed?.etag === undefined ? {} : { etag: feed.etag }), text: async () => feed?.body ?? '' }
  })
  await startNewsFeed()
  await vi.waitFor(() => expect(getNewsFeedState().measured).toBe(1))
})

afterAll(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('the news feed', () => {
  it('says how each feed read, and what a failed one answered', () => {
    expect(getNewsFeedState().sources.map((source) => [source.id, source.ok, source.items, source.error])).toEqual([
      ['coindesk', true, 2, null],
      ['theblock', false, 0, 'The Block could not be read: it answered 503'],
      ['cointelegraph', true, 1, null],
      ['decrypt', true, 1, null]
    ])
  })

  it("carries each story once, the same story folded, Binance's announcement beside them, and the week before kept", () => {
    const stories = getNewsFeedState().stories
    expect(stories.map((story) => [story.source, story.title, story.alsoIn])).toEqual([
      ['coindesk', 'Coinbase will list SOL futures for US traders', ['Cointelegraph']],
      ['binance', 'Binance Will Delist PEPE on 2026-10-20', []],
      ['decrypt', 'Bitcoin ETF inflows jump', []],
      ['coindesk', 'An older story', []]
    ])
    const sol = stories[0]
    expect(sol).toMatchObject({ eventType: 'LISTING', assets: [{ ticker: 'SOL', relationship: 'DIRECT' }] })
    expect(stories[1]).toMatchObject({ sourceClass: 'exchange', eventType: 'DELISTING', assets: [{ ticker: 'PEPE', relationship: 'DIRECT' }] })
    // Written once each: the new two beside the one already on file, which is not written again;
    // and Cointelegraph's copy of the SOL story as a source record on it, not a story (8 October 2026).
    const lines = readFileSync(join(rig.dir, 'news', 'feed-2026-10.jsonl'), 'utf-8')
      .split('\n')
      .filter((line) => line.trim() !== '' && line !== 'not json')
      .map((line) => JSON.parse(line) as FeedStory | StorySource)
    expect(lines.map((row) => ('kind' in row ? `source of ${row.storyId}: ${row.sourceName}` : row.title))).toEqual([
      'An older story',
      'Coinbase will list SOL futures for US traders',
      `source of ${sol.id}: Cointelegraph`,
      'Bitcoin ETF inflows jump'
    ])
    expect(sol.sources).toEqual([{ kind: 'source', storyId: sol.id, source: 'cointelegraph', sourceName: 'Cointelegraph', url: 'https://cointelegraph.com/news/sol-futures', publishedAt: SOL_AT + 300, seenAt: NOW }])
    // The older story was told two days ago; the ETF story is new: neither is recycled news.
    expect(stories.map((story) => story.repeat ?? false)).toEqual([false, false, false, false])
  })

  it('measures what the price did, keeps the reaction four hours on, and gives no history under thirty', () => {
    const state = getNewsFeedState()
    const sol = state.stories[0]
    const btc = state.stories[2]
    expect(state.reactions[sol.id]).toMatchObject({ symbol: 'SOLUSDT', verdict: 'PENDING' })
    expect(state.reactions[btc.id]).toMatchObject({
      symbol: 'BTCUSDT',
      verdict: 'CONFIRMED',
      after: { m15: expect.closeTo(1.5, 9), h1: expect.closeTo(2, 9), h4: expect.closeTo(3, 9) }
    })
    const kept = readFileSync(join(rig.dir, 'news', 'reactions-2026-10.jsonl'), 'utf-8').trim().split('\n')
    expect(kept).toHaveLength(1)
    expect(JSON.parse(kept[0])).toMatchObject({ storyId: btc.id, eventType: 'ETF' })
    expect(state.impact).toEqual([{ eventType: 'ETF', stories: 1, enough: false, medianPct: null, shareUp1h: null, excursions: null }])
    // The delisting is measured too; the older story names no coin.
    expect(rig.requests.some((request) => request.startsWith('PEPEUSDT 1m'))).toBe(true)
  })

  it('reads the stories on file over a span, as marks, from the months it covers and no further back than 35 days', async () => {
    const SEPT_AT = Date.parse('2026-09-20T00:00:00Z') / 1000
    const AUG_AT = Date.parse('2026-08-25T00:00:00Z') / 1000
    const at = (title: string, when: number, month: string): FeedStory => {
      const story = toStory({ title, link: `https://www.coindesk.com/${when}`, guid: `g-${when}`, pubDate: new Date(when * 1000).toUTCString(), description: '' }, FEED_SOURCES[0], when) as FeedStory
      writeFileSync(join(rig.dir, 'news', `feed-${month}.jsonl`), `${JSON.stringify(story)}
`)
      return story
    }
    const sept = at('Hackers drain a SOL bridge', SEPT_AT, '2026-09')
    const aug = at('Bitcoin ETF approved', AUG_AT, '2026-08')
    const marks = await newsHistory(NOW - 3 * 86_400, NOW)
    // The SOL story once: its second source is a record on it, not a story of its own.
    expect(marks.map((mark) => [mark.publishedAt, mark.tickers, mark.eventType])).toEqual([
      [OLD_AT, [], 'OTHER'],
      [BTC_AT, ['BTC'], 'ETF'],
      [SOL_AT, ['SOL'], 'LISTING']
    ])
    // Back into September: that month's file is read too, and nothing older than 35 days.
    const longer = await newsHistory(AUG_AT - 60, NOW)
    expect(longer.map((mark) => mark.id)).toContain(sept.id)
    expect(longer.find((mark) => mark.id === sept.id)).toMatchObject({ tickers: ['SOL'], eventType: 'HACK', stale: false })
    expect(longer.map((mark) => mark.id)).not.toContain(aug.id)
    expect((await newsHistory(AUG_AT - 60, AUG_AT + 60)).map((mark) => mark.id)).toEqual([aug.id])
    // Anything that is not two times in order reads as nothing.
    expect(await newsHistory(NOW, NOW - 1)).toEqual([])
    expect(await newsHistory('then', NOW)).toEqual([])
    expect(await newsHistory(Number.NaN, NOW)).toEqual([])
  })

  it("opens a story's link only on https and on a feed's own host", async () => {
    expect(await openStoryLink('https://www.coindesk.com/sol-futures')).toBe(true)
    expect(await openStoryLink('http://www.coindesk.com/sol-futures')).toBe(false)
    expect(await openStoryLink('https://coindesk.example.com/x')).toBe(false)
    expect(await openStoryLink('file:///C:/Windows')).toBe(false)
    expect(await openStoryLink('not a link')).toBe(false)
    expect(await openStoryLink(42)).toBe(false)
    expect(rig.opened).toEqual(['https://www.coindesk.com/sol-futures'])
  })
})

describe('the reads', () => {
  it("reads every minute, asks a feed only for what changed since, and measures the stories' prices every three minutes", async () => {
    const coindesk = 'https://www.coindesk.com/arc/outboundfeeds/rss'
    const stories = getNewsFeedState().stories.map((story) => story.id)
    const measured = rig.requests.length
    // A minute on the clock, and the read it starts done: its files are written in real time.
    const minuteOn = async (sec: number): Promise<void> => {
      await vi.advanceTimersByTimeAsync(60_000)
      await vi.waitFor(() => expect(getNewsFeedState().sources[0].lastReadAt).toBe(sec))
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
    rig.asked.length = 0
    await minuteOn(NOW + 60)
    // A minute on: every feed read again, CoinDesk with the ETag it gave, answering 304 and read as before.
    expect(rig.asked.map((ask) => ask.url)).toEqual(FEED_SOURCES.map((source) => source.url))
    expect(rig.asked.find((ask) => ask.url === coindesk)?.headers['If-None-Match']).toBe('"cd-1"')
    expect(rig.asked.find((ask) => ask.url === 'https://decrypt.co/feed')?.headers['If-None-Match']).toBeUndefined()
    expect(getNewsFeedState().sources.find((source) => source.id === 'coindesk')).toMatchObject({ ok: true, items: 2, error: null, lastReadAt: NOW + 60 })
    expect(getNewsFeedState().stories.map((story) => story.id)).toEqual(stories)
    // The prices around the stories wait their three minutes.
    expect(rig.requests).toHaveLength(measured)
    await minuteOn(NOW + 120)
    expect(rig.requests).toHaveLength(measured)
    await minuteOn(NOW + 180)
    await vi.waitFor(() => expect(rig.requests.length).toBeGreaterThan(measured))
  })
})

describe('the feeds dead', () => {
  it('is told once every feed has failed for half an hour, and not while one still answers', async () => {
    told.length = 0
    for (const url of Object.keys(rig.feeds)) rig.feeds[url] = { status: 503, body: '' }
    // Reads a minute apart: those under half an hour since the last good read tell nothing.
    await vi.advanceTimersByTimeAsync(27 * 60_000)
    expect(told).toEqual([])
    await vi.advanceTimersByTimeAsync(6 * 60_000)
    expect(told).toHaveLength(1)
    expect(told[0]).toMatchObject({ title: 'The news feeds cannot be read', extra: { kind: 'SYSTEM_FAILURE', thread: 'feed' } })
    await vi.advanceTimersByTimeAsync(6 * 60_000)
    expect(told).toHaveLength(1)
  })
})
