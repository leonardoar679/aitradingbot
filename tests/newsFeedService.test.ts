import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import type { Candle } from '../shared/ipc'
import { FEED_SOURCES, toStory, type FeedStory } from '../shared/newsFeed'

// electron/services/newsFeedService.ts, driven with its feeds, Binance's pairs, the coins' candles
// and the news reader faked, and its two files in a folder of its own: what a read keeps, once;
// what it says of a feed that fails; the same story folded; and what the price did, measured and,
// once four hours have passed, kept.

const NOW = Date.parse('2026-10-06T12:00:00Z') / 1000
const rig = vi.hoisted(() => ({
  dir: '',
  opened: [] as string[],
  feeds: {} as Record<string, { status: number; body: string }>,
  candles: {} as Record<string, Candle[]>,
  requests: [] as string[]
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
vi.mock('../electron/services/noticeService', () => ({
  tell: (notice: { title: string; body: string; extra: { kind: string; thread?: string } }) => void told.push(notice),
  tellNotice: async () => true
}))
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
  vi.stubGlobal('fetch', async (url: string) => {
    const feed = rig.feeds[url]
    return { ok: feed !== undefined && feed.status === 200, status: feed?.status ?? 404, text: async () => feed?.body ?? '' }
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
    // Written once each: the new three beside the one already on file, which is not written again.
    const lines = readFileSync(join(rig.dir, 'news', 'feed-2026-10.jsonl'), 'utf-8').split('\n').filter((line) => line.trim() !== '' && line !== 'not json')
    expect(lines.map((line) => (JSON.parse(line) as FeedStory).title)).toEqual([
      'An older story',
      'Coinbase will list SOL futures for US traders',
      'Coinbase will list SOL futures for traders in the US',
      'Bitcoin ETF inflows jump'
    ])
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
    expect(state.impact).toEqual([{ eventType: 'ETF', stories: 1, enough: false, medianPct: null, shareUp1h: null }])
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
    expect(marks.map((mark) => [mark.publishedAt, mark.tickers, mark.eventType])).toEqual([
      [OLD_AT, [], 'OTHER'],
      [BTC_AT, ['BTC'], 'ETF'],
      [SOL_AT, ['SOL'], 'LISTING'],
      [SOL_AT + 300, ['SOL'], 'LISTING']
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

describe('the feeds dead', () => {
  it('is told once every feed has failed for half an hour, and not while one still answers', async () => {
    told.length = 0
    for (const url of Object.keys(rig.feeds)) rig.feeds[url] = { status: 503, body: '' }
    // Ten reads, three minutes apart: the first nine are under half an hour since the last good read.
    await vi.advanceTimersByTimeAsync(27 * 60_000)
    expect(told).toEqual([])
    await vi.advanceTimersByTimeAsync(6 * 60_000)
    expect(told).toHaveLength(1)
    expect(told[0]).toMatchObject({ title: 'The news feeds cannot be read', extra: { kind: 'SYSTEM_FAILURE', thread: 'feed' } })
    await vi.advanceTimersByTimeAsync(6 * 60_000)
    expect(told).toHaveLength(1)
  })
})
