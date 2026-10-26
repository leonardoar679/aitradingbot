import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { extractArticle } from '../shared/articleExtract'
import type { Candle } from '../shared/ipc'
import type { ListedArticle, NewsItem } from '../shared/news'
import type { ReadStory } from '../shared/newsFeed'

// NEWS URLS (electron/services/newsUrlService.ts; V8 Stage 4): a pasted link read through every step and kept -- its
// text and where that came from, its time, its source, its coins and their prices, the verdict -- the same link one
// record, a Binance announcement verified in Binance's list and weighed as a delisting, a post on X never fetched, the
// feed's stories of impact 70 or more recorded passively, and a person's own view linked to its record.

vi.mock('electron', () => ({ app: { getPath: () => tmpdir() } }))
vi.mock('../electron/services/marketService', () => ({ listSymbols: async () => [], fetchTicker24h: async () => ({ quoteVolume: 0 }), fetchHistoricalRange: async () => ({ candles: [], cancelled: false }) }))
vi.mock('../electron/services/newsFeedService', () => ({ getNewsFeedState: () => ({ stories: [] }) }))
vi.mock('../electron/services/primaryCallService', () => ({ notePastedCoins: () => undefined, notePastedDelisting: () => undefined, primaryCallState: () => ({ cards: [] }) }))
vi.mock('../electron/services/taskWorkerService', () => ({ runInWorker: async () => ({ ok: false, reason: 'error', message: 'no worker in a test' }) }))
vi.mock('../electron/services/urlFetchService', () => ({ fetchPage: async () => ({ ok: false, failure: 'network', reason: 'no network in a test', redirects: [] }) }))
vi.mock('../electron/services/settingsService', () => ({ getSettings: async () => ({}) }))

const NOW = 1_793_030_400 // 16:00 UTC
const PUBLISHED = NOW - 2 * 3600
const CODE = '0123456789abcdef0123456789abcdef'

let dir = ''
let clock = NOW
let fetched: string[] = []
let delistings: NewsItem[] = []
let lanes: string[][] = []
let feed: ReadStory[] = []
let list: ListedArticle[] = []
let quotes: Record<string, number> = {}

const page = (title: string, body: string, published = '2026-10-26T14:00:00Z'): string =>
  `<html><head><title>${title}</title><script type="application/ld+json">{"@type":"NewsArticle","headline":"${title}","datePublished":"${published}"}</script></head><body><article><p>${body}</p></article></body></html>`

/** One-minute bars from a day before publication to now, flat at 2 until publication and at 1.8 after it. */
function bars(fromSec: number, toSec: number): Candle[] {
  const out: Candle[] = []
  for (let t = Math.floor(fromSec / 60) * 60; t + 60 <= toSec; t += 60) {
    const close = t + 60 <= PUBLISHED ? (t < PUBLISHED - 86_400 ? 1.9 : 2) : 1.8
    out.push({ time: t, open: close, high: close, low: close, close, volume: 1 })
  }
  return out
}

beforeEach(() => {
  vi.resetModules()
  dir = mkdtempSync(join(tmpdir(), 'urls-'))
  clock = NOW
  fetched = []
  delistings = []
  lanes = []
  feed = []
  list = []
  quotes = { ABCUSDT: 5_000_000, BTCUSDT: 1e9, THINUSDT: 10_000 }
})

async function service(pages: Record<string, string> = {}) {
  const module = await import('../electron/services/newsUrlService')
  module.resetNewsUrls()
  Object.assign(module.newsUrlSeam, {
    dir: () => dir,
    now: () => clock,
    fetch: async (raw: string) => {
      fetched.push(raw)
      const url = raw.split('?')[0]
      const html = pages[url]
      return html === undefined
        ? { ok: false, failure: 'status', reason: 'The page answered 404.', redirects: [] }
        : { ok: true, url, finalUrl: url, redirects: [], status: 200, contentType: 'text/html', html, bytes: html.length, fetchedAt: clock, address: '93.184.216.34' }
    },
    extract: async (html: string) => extractArticle(html),
    symbols: async (venue: string) =>
      venue === 'binance'
        ? [
            { symbol: 'ABCUSDT', baseAsset: 'ABC', quoteAsset: 'USDT' },
            { symbol: 'BTCUSDT', baseAsset: 'BTC', quoteAsset: 'USDT' },
            { symbol: 'THINUSDT', baseAsset: 'THIN', quoteAsset: 'USDT' }
          ]
        : [{ symbol: 'ABCUSDT', baseAsset: 'ABC', quoteAsset: 'USDT' }],
    dayQuote: async (_venue: string, pair: string) => quotes[pair] ?? 0,
    announcements: async () => list,
    feed: () => feed,
    bars: async (_venue: string, _pair: string, fromSec: number, toSec: number) => bars(fromSec, toSec),
    cardsFor: () => [],
    pastedDelisting: (item: NewsItem) => void delistings.push(item),
    pastedCoins: (pairs: readonly string[]) => void lanes.push([...pairs]),
    autoAnalyze: async () => false
  })
  return module
}

describe('a pasted link', () => {
  it('is read through every step and kept: its text, time, source, coins, prices and verdict', async () => {
    const urls = await service({ 'https://www.coindesk.com/markets/abc-story': page('ABC hacked: attacker drains the bridge', 'The ABC team said its bridge was exploited; BTC was unaffected and THIN fell too.') })
    const record = await urls.analyzeUrl({ raw: 'https://www.coindesk.com/markets/abc-story?utm_source=x' })
    if ('refused' in record) throw new Error(record.refused)
    expect(record).toMatchObject({
      origin: 'manual',
      url: 'https://www.coindesk.com/markets/abc-story',
      host: 'www.coindesk.com',
      credibility: 'outlet',
      retrieval: 'fetched',
      title: 'ABC hacked: attacker drains the bridge',
      kind: 'HACK',
      binance: null
    })
    expect(record.time).toMatchObject({ sec: PUBLISHED, source: 'jsonld' })
    expect(record.coins).toEqual([
      { ticker: 'ABC', relationship: 'DIRECT', pair: 'ABCUSDT', venue: 'binance' },
      { ticker: 'BTC', relationship: 'INDIRECT', pair: 'BTCUSDT', venue: 'binance' }
    ])
    expect(record.rejected).toEqual([{ ticker: 'THIN', why: 'thin' }])
    const abc = record.reactions.find((reaction) => reaction.pair === 'ABCUSDT')!
    expect(abc.refPrice).toBe(2)
    expect(abc.beforePct).toBeCloseTo((2 / 1.9 - 1) * 100, 9)
    expect(abc.afterPct.h1).toBeCloseTo(-10, 9)
    expect(abc.afterPct.h4).toBeNull()
    expect(abc.final).toBe(false)
    expect(record.verdict).toEqual({ cards: [], none: 'No measured source calls a way for news of this kind (hack).' })
    expect(lanes).toEqual([['ABCUSDT', 'BTCUSDT']])
    expect(record.trail.map((entry) => entry.status)).toEqual(['read', 'read', 'extracted', 'timed', 'coins', 'priced'])
    const file = join(dir, `urls-${new Date(NOW * 1000).toISOString().slice(0, 7)}.jsonl`)
    expect(JSON.parse(readFileSync(file, 'utf-8').trim().split('\n').pop()!)).toEqual(record)
    expect(await urls.urlRecords()).toEqual([record])
  })

  it("is of the kind its title and summary say, as the feed reads a story, not of a word deep in its body", async () => {
    const urls = await service({
      'https://www.coindesk.com/rules': page('Canada drafts stablecoin rules and a ban on yield', 'The regulator published draft rules for issuers of BTC-backed and other tokens.</p><p>A later paragraph recalls an exploit at an unrelated protocol last year, long enough to be read.')
    })
    const record = await urls.analyzeUrl({ raw: 'https://www.coindesk.com/rules' })
    if ('refused' in record) throw new Error(record.refused)
    expect(record.kind).toBe('REGULATION')
  })

  it('is one record however often it is pasted', async () => {
    const urls = await service({ 'https://www.coindesk.com/a': page('BTC rises', 'Long enough body text about BTC for the record to have its snippet.') })
    const first = await urls.analyzeUrl({ raw: 'https://www.coindesk.com/a' })
    const again = await urls.analyzeUrl({ raw: 'https://www.coindesk.com/a#more' })
    if ('refused' in first || 'refused' in again) throw new Error('refused')
    expect(again.id).toBe(first.id)
    expect(again.trail.at(-1)?.status).toBe('pasted-again')
    expect(fetched).toHaveLength(1)
  })

  it('is refused, saying why, where it is not a link to read', async () => {
    const urls = await service()
    expect(await urls.analyzeUrl({ raw: 'http://example.com/a' })).toEqual({ refused: 'Only https links are read.' })
    expect(fetched).toEqual([])
  })

  it("falls back to the feed's own copy, then to text a person supplied, and says so", async () => {
    feed = [{ id: 'coindesk:1', source: 'coindesk', sourceName: 'CoinDesk', sourceClass: 'media', title: 'ABC listed on a new venue', url: 'https://www.coindesk.com/gone', publishedAt: PUBLISHED, seenAt: PUBLISHED, summary: 'ABC was listed today on a venue of its own choosing, the team said.', assets: [{ ticker: 'ABC', relationship: 'DIRECT' }], marketWide: false, eventType: 'LISTING', credibility: 0.85, impact: 60, stale: false, alsoIn: [], sources: [] }]
    const urls = await service()
    const fromFeed = await urls.analyzeUrl({ raw: 'https://www.coindesk.com/gone' })
    if ('refused' in fromFeed) throw new Error('refused')
    expect(fromFeed).toMatchObject({ retrieval: 'feed', title: 'ABC listed on a new venue', readFailure: 'The page answered 404.' })
    expect(fromFeed.time).toMatchObject({ sec: PUBLISHED, source: 'feed' })
    const supplied = await urls.analyzeUrl({ raw: 'https://unknown.example.org/post', supplied: 'ABC partners with a bank\nThe ABC project said it is partnering with a bank in a long statement.' })
    if ('refused' in supplied) throw new Error('refused')
    expect(supplied).toMatchObject({ retrieval: 'supplied', title: 'ABC partners with a bank', credibility: 'unknown' })
    expect(supplied.time).toMatchObject({ sec: null })
    expect(supplied.reactions).toEqual([])
    expect(supplied.trail.map((entry) => entry.note)).toContain('The text is what the person supplied, not retrieved from the page.')
  })

  it("verifies a Binance announcement in Binance's own list, takes its time from it, and weighs a delisting", async () => {
    list = [{ id: 4242, title: 'Binance Will Delist ABC on 2026-11-02', releaseSec: NOW - 120, code: CODE }]
    const urls = await service()
    const record = await urls.analyzeUrl({ raw: `https://www.binance.com/en/support/announcement/detail/${CODE}` })
    if ('refused' in record) throw new Error('refused')
    expect(record).toMatchObject({ credibility: 'exchange', retrieval: 'announcement', title: 'Binance Will Delist ABC on 2026-11-02', kind: 'DELISTING' })
    expect(record.binance).toEqual({ code: CODE, articleId: 4242, title: 'Binance Will Delist ABC on 2026-11-02', releaseSec: NOW - 120, delisting: true })
    expect(record.time).toMatchObject({ sec: NOW - 120, source: 'announcement' })
    expect(delistings).toEqual([{ id: 4242, catalog: 161, title: 'Binance Will Delist ABC on 2026-11-02', releaseSec: NOW - 120, seenAt: NOW, category: 'DELISTING', tickers: ['ABC'] }])
    expect(record.verdict.none).toMatch(/only within its rule's five minutes/)
    clock += 15
    const unknown = await urls.analyzeUrl({ raw: 'https://www.binance.com/en/support/announcement/detail/ffffffffffffffffffffffffffffffff' })
    if ('refused' in unknown) throw new Error('refused')
    expect(unknown.binance).toBeNull()
    expect(unknown.trail.map((entry) => entry.note).join(' ')).toMatch(/not in Binance's list/)
  })

  it('never fetches a post on X: its time is in its id, its author in its link', async () => {
    const urls = await service()
    const ms = BigInt(PUBLISHED * 1000) - 1_288_834_974_657n
    const record = await urls.analyzeUrl({ raw: `https://x.com/abc_project/status/${ms << 22n}` })
    if ('refused' in record) throw new Error('refused')
    expect(fetched).toEqual([])
    expect(record).toMatchObject({ retrieval: 'x-post', author: '@abc_project', credibility: 'social' })
    expect(record.time).toMatchObject({ sec: PUBLISHED, source: 'x-id' })
  })

  it("links a person's own view to its record", async () => {
    const urls = await service({ 'https://www.coindesk.com/v': page('ABC up', 'A body long enough to be read as the text of the page about ABC.') })
    const record = await urls.analyzeUrl({ raw: 'https://www.coindesk.com/v' })
    if ('refused' in record) throw new Error('refused')
    const linked = await urls.linkUrlRecord(record.id, { predictionId: 'user:ABCUSDT:1' })
    expect(linked?.predictionIds).toEqual(['user:ABCUSDT:1'])
    expect(linked?.trail.at(-1)?.status).toBe('view')
    expect(await urls.linkUrlRecord('0000000000000000', { predictionId: 'x' })).toBeNull()
  })

  it('reads its prices again until they are final', async () => {
    const urls = await service({ 'https://www.coindesk.com/p': page('ABC news', 'A body long enough to be read as the text of the page about ABC.') })
    const record = await urls.analyzeUrl({ raw: 'https://www.coindesk.com/p' })
    if ('refused' in record) throw new Error('refused')
    expect(record.reactions[0].final).toBe(false)
    clock = PUBLISHED + 4 * 3600 + 180
    await urls.refreshUrlPrices()
    const [after] = await urls.urlRecords()
    expect(after.reactions[0]).toMatchObject({ final: true })
    expect(after.reactions[0].afterPct.h4).toBeCloseTo(-10, 9)
    expect(after.trail.at(-1)?.status).toBe('final')
  })
})

describe('discovered news', () => {
  const story = (over: Partial<ReadStory>): ReadStory => ({
    id: 'binance:777',
    source: 'binance',
    sourceName: 'Binance',
    sourceClass: 'exchange',
    title: 'Binance Will Delist ABC on 2026-11-02',
    url: `https://www.binance.com/en/support/announcement/detail/${CODE}`,
    publishedAt: PUBLISHED,
    seenAt: PUBLISHED,
    summary: '',
    tickers: ['ABC'],
    binanceCategory: 'DELISTING',
    assets: [{ ticker: 'ABC', relationship: 'DIRECT' }],
    marketWide: false,
    eventType: 'DELISTING',
    credibility: 1,
    impact: 85,
    stale: false,
    alsoIn: [],
    sources: [],
    ...over
  })
  it('records each story of impact 70 or more naming a coin directly, passively: nothing fetched', async () => {
    feed = [story({}), story({ id: 'coindesk:2', source: 'coindesk', url: 'https://www.coindesk.com/low', impact: 60 }), story({ id: 'coindesk:3', source: 'coindesk', url: 'https://www.coindesk.com/market', impact: 90, assets: [] })]
    const urls = await service()
    expect(await urls.discoverFromFeed(false)).toBe(1)
    expect(fetched).toEqual([])
    const [record] = await urls.urlRecords()
    expect(record).toMatchObject({ origin: 'automatic', retrieval: 'announcement', kind: 'DELISTING', binance: { articleId: 777, delisting: true, releaseSec: PUBLISHED } })
    expect(record.time).toMatchObject({ sec: PUBLISHED, source: 'announcement' })
    expect(record.trail[0].status).toBe('discovered')
    expect(await urls.discoverFromFeed(false)).toBe(0)
  })
  it('reads the page too only with its switch on', async () => {
    feed = [story({ id: 'coindesk:9', source: 'coindesk', sourceName: 'CoinDesk', url: 'https://www.coindesk.com/hot', binanceCategory: null })]
    const urls = await service({ 'https://www.coindesk.com/hot': page('ABC hot', 'A body long enough to be read as the text of the page about ABC.') })
    expect(await urls.discoverFromFeed(true)).toBe(1)
    expect(fetched).toEqual(['https://www.coindesk.com/hot'])
    expect((await urls.urlRecords())[0]).toMatchObject({ origin: 'automatic', retrieval: 'fetched' })
  })
})
