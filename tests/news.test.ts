import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { matchesNewsFilter, newsListUrl, nextNewsReadDelayMs, parseArticleList, parseNewsLines, toNewsItem, type NewsItem } from '../shared/news'

// The news reader (electron/services/newsService.ts): Binance's two announcement lists, read once
// a minute while it is on, each article kept once and sorted by shared/newsTitles.ts. Binance is
// faked at the one seam the reader reaches it through, fetch; the files are real, in a scratch
// folder.

vi.mock('electron', () => ({ app: { getPath: () => process.env.NEWS_TEST_USER_DATA } }))

const T = Date.parse('2026-10-05T06:00:00Z')

const lists = vi.hoisted(() => ({
  articles: new Map<number, { id: number; code: string; title: string; type: number; releaseDate: number }[]>(),
  failing: new Set<number>(),
  /** When set, both lists answer this instead. */
  answer: null as unknown,
  calls: [] as string[]
}))

function article(id: number, title: string, releaseMs: number) {
  return { id, code: `code${id}`, title, type: 1, releaseDate: releaseMs }
}

async function fakeFetch(url: string): Promise<Response> {
  lists.calls.push(url)
  const catalog = Number(/catalogId=(\d+)/.exec(url)?.[1])
  if (lists.failing.has(catalog)) return new Response('busy', { status: 503 })
  const body = lists.answer ?? { code: '000000', data: { catalogs: [{ catalogId: catalog, articles: lists.articles.get(catalog) ?? [], total: 99 }] } }
  return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })
}

async function reader() {
  return import('../electron/services/newsService')
}

let dir: string

beforeEach(() => {
  vi.resetModules()
  dir = mkdtempSync(join(tmpdir(), 'news-'))
  process.env.NEWS_TEST_USER_DATA = dir
  lists.articles = new Map([
    [
      161,
      [
        article(301, 'Binance Will Delist ICX, SCRT, STORJ on 2026-09-03', T - 60_000),
        article(300, 'Notice of Removal of Spot Trading Pairs - 2026-10-02', T - 86_400_000)
      ]
    ],
    [
      48,
      [
        article(201, 'Binance Futures Will Launch USDⓈ-Margined CTUSDT Perpetual Contract (2026-10-01)', T - 3_600_000),
        article(200, 'Binance Will List Hyperliquid (HYPE) with Seed Tag Applied', T - 40 * 86_400_000)
      ]
    ]
  ])
  lists.failing = new Set()
  lists.answer = null
  lists.calls = []
  vi.stubGlobal('fetch', vi.fn(fakeFetch))
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('an answer from a list', () => {
  it('reads each article, and leaves out a row it cannot read', () => {
    const body = {
      data: {
        catalogs: [
          {
            articles: [
              article(301, '  Binance Will Delist ICX, SCRT,   STORJ on 2026-09-03 ', T),
              { id: 'x', title: 'no id', releaseDate: T },
              { id: 7, title: '', releaseDate: T },
              { id: 8, title: 'no date' },
              null
            ]
          }
        ]
      }
    }
    expect(parseArticleList(body)).toEqual([{ id: 301, title: 'Binance Will Delist ICX, SCRT, STORJ on 2026-09-03', releaseSec: T / 1000 }])
  })

  it('is an error when there is no list in it at all', () => {
    for (const body of [null, {}, { data: null }, { data: { catalogs: [] } }, '<html>blocked</html>']) {
      expect(() => parseArticleList(body), JSON.stringify(body)).toThrow('Binance answered without an announcement list')
    }
  })

  it('sorts an article by its title, as the study did', () => {
    expect(toNewsItem({ id: 301, title: 'Binance Will Delist ICX, SCRT, STORJ on 2026-09-03', releaseSec: 100 }, 161, 160)).toEqual({
      id: 301,
      catalog: 161,
      title: 'Binance Will Delist ICX, SCRT, STORJ on 2026-09-03',
      releaseSec: 100,
      seenAt: 160,
      category: 'DELISTING',
      tickers: ['ICX', 'SCRT', 'STORJ']
    })
    expect(toNewsItem({ id: 300, title: 'Notice of Removal of Spot Trading Pairs - 2026-10-02', releaseSec: 100 }, 161, 160)).toMatchObject({ category: null, tickers: [] })
  })

  it('asks each list for its newest page', () => {
    expect(newsListUrl(161)).toBe('https://www.binance.com/bapi/composite/v1/public/cms/article/list/query?type=1&catalogId=161&pageNo=1&pageSize=20')
  })

  it('reads a few seconds into the minute, this minute if that is still to come', () => {
    expect(nextNewsReadDelayMs(T)).toBe(3_000)
    expect(nextNewsReadDelayMs(T + 1_000)).toBe(2_000)
    expect(nextNewsReadDelayMs(T + 3_000)).toBe(60_000)
    expect(nextNewsReadDelayMs(T + 10_000)).toBe(53_000)
  })
})

describe('a news file', () => {
  it('skips a line it cannot read, and counts it', () => {
    const good: NewsItem = { id: 1, catalog: 161, title: 't', releaseSec: 1, seenAt: 2, category: 'DELISTING', tickers: ['A'] }
    const text = [JSON.stringify(good), '{"id":2,"catalog":161', JSON.stringify({ ...good, id: 3, category: 'RUMOUR' }), JSON.stringify({ ...good, id: 4, catalog: 9 }), ''].join('\n')
    expect(parseNewsLines(text)).toEqual({ rows: [good], skipped: 3 })
  })

  it('filters by kind and by release', () => {
    const item: NewsItem = { id: 1, catalog: 48, title: 't', releaseSec: 1000, seenAt: 1000, category: 'FUTURES_LAUNCH', tickers: ['CT'] }
    expect(matchesNewsFilter(item, {})).toBe(true)
    expect(matchesNewsFilter(item, { category: 'FUTURES_LAUNCH', sinceSec: 1000 })).toBe(true)
    expect(matchesNewsFilter(item, { category: 'DELISTING' })).toBe(false)
    expect(matchesNewsFilter(item, { sinceSec: 1001 })).toBe(false)
  })
})

describe('the reader', () => {
  it('keeps each new article once, newest release first, filed by the month it was released', async () => {
    const { readNewsOnce } = await reader()
    const state = await readNewsOnce(T + 5_000)
    expect(state.error).toBeNull()
    expect(state.recent.map((item) => item.id)).toEqual([301, 201, 300, 200])
    expect(state.recent[0]).toMatchObject({ category: 'DELISTING', tickers: ['ICX', 'SCRT', 'STORJ'], seenAt: T / 1000 + 5 })
    expect(lists.calls.map((url) => /catalogId=(\d+)/.exec(url)?.[1])).toEqual(['161', '48'])
    // Oldest first in each file, as Binance released them.
    const october = readFileSync(join(dir, 'news', 'news-2026-10.jsonl'), 'utf-8').trim().split('\n').map((line) => JSON.parse(line).id)
    expect(october).toEqual([300, 201, 301])
    expect(readFileSync(join(dir, 'news', 'news-2026-08.jsonl'), 'utf-8').trim().split('\n').map((line) => JSON.parse(line).id)).toEqual([200])

    // A minute later, one new article: only it is added.
    lists.articles.get(161)?.unshift(article(302, 'Binance Will Delist COS, D, HIGH, MBOX on 2026-06-19', T + 30_000))
    const next = await readNewsOnce(T + 65_000)
    expect(next.recent.map((item) => item.id)).toEqual([302, 301, 201, 300, 200])
    expect(readFileSync(join(dir, 'news', 'news-2026-10.jsonl'), 'utf-8').trim().split('\n')).toHaveLength(4)
  })

  it('remembers what it has kept across a restart', async () => {
    await (await reader()).readNewsOnce(T)
    vi.resetModules()
    const restarted = await reader()
    expect((await restarted.getNewsState()).recent.map((item) => item.id)).toEqual([301, 201, 300, 200])
    await restarted.readNewsOnce(T + 60_000)
    expect(readFileSync(join(dir, 'news', 'news-2026-10.jsonl'), 'utf-8').trim().split('\n')).toHaveLength(3)
  })

  it('keeps an article that is in both lists once', async () => {
    lists.articles.get(48)?.push(article(301, 'Binance Will Delist ICX, SCRT, STORJ on 2026-09-03', T - 60_000))
    const state = await (await reader()).readNewsOnce(T)
    expect(state.recent.filter((item) => item.id === 301)).toEqual([expect.objectContaining({ catalog: 161 })])
  })

  it('says when a list cannot be read, and keeps what the other gave', async () => {
    lists.failing.add(48)
    const { readNewsOnce } = await reader()
    const one = await readNewsOnce(T)
    expect(one.error).toBe("One of Binance's two announcement lists could not be read: Binance's announcement list answered 503")
    expect(one.recent.map((item) => item.id)).toEqual([301, 300])

    lists.failing.add(161)
    expect((await readNewsOnce(T + 60_000)).error).toMatch(/^Binance's announcement lists could not be read/)

    lists.failing.clear()
    lists.answer = { data: { notTheList: true } }
    expect((await readNewsOnce(T + 120_000)).error).toMatch(/Binance answered without an announcement list/)

    // Back to normal: the missing list's articles are kept, and the error clears.
    lists.answer = null
    const recovered = await readNewsOnce(T + 180_000)
    expect(recovered.error).toBeNull()
    expect(recovered.recent.map((item) => item.id)).toEqual([301, 201, 300, 200])
  })

  it('lists what it has kept by kind and by release, newest first', async () => {
    const { readNewsOnce, listNews } = await reader()
    await readNewsOnce(T)
    expect((await listNews({ category: 'DELISTING' })).rows.map((item) => item.id)).toEqual([301])
    expect((await listNews({ sinceSec: (T - 2 * 3_600_000) / 1000 })).rows.map((item) => item.id)).toEqual([301, 201])
    expect((await listNews({ limit: 3 })).rows.map((item) => item.id)).toEqual([301, 201, 300])
    expect((await listNews({})).rows.map((item) => item.id)).toEqual([301, 201, 300, 200])
  })
})

describe('its setting', () => {
  it('is off until switched on, and reads nothing at launch while off', async () => {
    vi.useFakeTimers()
    const { startNewsReader, getNewsState } = await reader()
    await startNewsReader()
    expect(vi.getTimerCount()).toBe(0)
    const state = await getNewsState()
    expect(state.config).toEqual({ enabled: false })
    expect(state.nextReadAt).toBeNull()
    expect(lists.calls).toEqual([])
  })

  it('reads at once when switched on, then on the minute, and remembers it was left on', async () => {
    vi.useFakeTimers()
    const { setNewsConfig, whenNewsSettled, getNewsState } = await reader()
    const on = await setNewsConfig({ enabled: true })
    await whenNewsSettled()
    expect(on.nextReadAt).not.toBeNull()
    expect(vi.getTimerCount()).toBe(1)
    expect(lists.calls).toHaveLength(2)
    expect((await getNewsState()).recent).toHaveLength(4)
    expect(JSON.parse(readFileSync(join(dir, 'news.json'), 'utf-8'))).toEqual({ enabled: true })
    // Saying "on" again while it is on starts nothing more.
    await setNewsConfig({ enabled: true })
    await whenNewsSettled()
    expect(lists.calls).toHaveLength(2)

    vi.resetModules()
    const relaunched = await reader()
    await relaunched.startNewsReader()
    expect(vi.getTimerCount()).toBe(2)
    const off = await relaunched.setNewsConfig({ enabled: false })
    expect(off.nextReadAt).toBeNull()
    expect(JSON.parse(readFileSync(join(dir, 'news.json'), 'utf-8'))).toEqual({ enabled: false })
  })

  it('refuses anything but on or off, and heals a file holding something else', async () => {
    const { setNewsConfig } = await reader()
    await expect(setNewsConfig({ enabled: 'yes' as never })).rejects.toThrow('The news reader is either on or off')
    writeFileSync(join(dir, 'news.json'), JSON.stringify({ enabled: 'true' }))
    vi.resetModules()
    expect((await (await reader()).getNewsState()).config).toEqual({ enabled: false })
  })
})
