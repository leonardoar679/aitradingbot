import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_NEWS_CONFIG, matchesNewsFilter, newsListUrl, nextNewsReadDelayMs, parseArticleList, parseNewsLines, toNewsItem, type NewsItem } from '../shared/news'

// The news reader (electron/services/newsService.ts): Binance's three announcement lists, read once
// a minute while it is on, each article kept once and sorted by shared/newsTitles.ts. Binance is
// faked at the one seam the reader reaches it through, fetch; the files are real, in a scratch
// folder.

vi.mock('electron', () => ({ app: { getPath: () => process.env.NEWS_TEST_USER_DATA } }))

// The scanner, at the one function the reader reaches it through: raising an announcement as an event.
const raised = vi.hoisted(() => ({ calls: [] as { id: number; ticker: string }[], fail: false }))
vi.mock('../electron/services/marketScannerService', () => ({
  raiseNewsEvent: async (item: { id: number }, ticker: string) => {
    raised.calls.push({ id: item.id, ticker })
    if (raised.fail) throw new Error('its candles could not be read')
    return null
  }
}))

// The notices, at the one function the reader tells them through (V8 Stage 9: when it stops itself).
const told = vi.hoisted(() => [] as { title: string; body: string }[])
vi.mock('../electron/services/noticeService', async () => {
  const { ENGLISH } = await import('../shared/i18n/translate')
  return {
    tell: (notice: unknown) => {
      told.push((typeof notice === 'function' ? (notice as (i18n: unknown) => { title: string; body: string })(ENGLISH) : notice) as { title: string; body: string })
    }
  }
})

const T = Date.parse('2026-10-05T06:00:00Z')

const lists = vi.hoisted(() => ({
  articles: new Map<number, { id: number; code: string; title: string; type: number; releaseDate: number }[]>(),
  failing: new Set<number>(),
  /** When set, every list answers this instead. */
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
  raised.calls = []
  raised.fail = false
  told.length = 0
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
    expect(parseArticleList(body)).toEqual([{ id: 301, title: 'Binance Will Delist ICX, SCRT, STORJ on 2026-09-03', releaseSec: T / 1000, code: 'code301' }])
  })

  it("keeps an article's code where the list gives one, for a pasted link to be checked by (V8 Stage 4)", () => {
    const code = '0123456789abcdef0123456789abcdef'
    const body = { data: { catalogs: [{ articles: [{ id: 5, code, title: 'Binance Will Delist ABC on 2026-11-02', releaseDate: T }, { id: 6, code: 'bad code!', title: 'A title', releaseDate: T }] }] } }
    expect(parseArticleList(body)).toEqual([
      { id: 5, title: 'Binance Will Delist ABC on 2026-11-02', releaseSec: T / 1000, code },
      { id: 6, title: 'A title', releaseSec: T / 1000 }
    ])
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
    expect(lists.calls.map((url) => /catalogId=(\d+)/.exec(url)?.[1])).toEqual(['161', '48', '49'])
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

  it('keeps an article that is in two lists once', async () => {
    lists.articles.get(48)?.push(article(301, 'Binance Will Delist ICX, SCRT, STORJ on 2026-09-03', T - 60_000))
    const state = await (await reader()).readNewsOnce(T)
    expect(state.recent.filter((item) => item.id === 301)).toEqual([expect.objectContaining({ catalog: 161 })])
  })

  it("reads Binance's news, where coins are added to the Monitoring Tag", async () => {
    lists.articles.set(49, [
      article(401, 'Binance Will Extend the Monitoring Tag to Include AVA, GNS, SCR & TOWNS on 2026-10-05', T - 30_000),
      article(400, 'Binance Will Support the Ethereum Network Upgrade', T - 7_200_000)
    ])
    const state = await (await reader()).readNewsOnce(T)
    expect(state.recent.map((item) => item.id)).toEqual([401, 301, 201, 400, 300, 200])
    expect(state.recent[0]).toMatchObject({ catalog: 49, category: 'MONITORING_TAG', tickers: ['AVA', 'GNS', 'SCR', 'TOWNS'] })
    expect(state.recent.find((item) => item.id === 400)).toMatchObject({ catalog: 49, category: null, tickers: [] })
  })

  it('says when a list cannot be read, and keeps what the others gave', async () => {
    lists.failing.add(48)
    const { readNewsOnce } = await reader()
    const one = await readNewsOnce(T)
    expect(one.error).toBe("1 of Binance's 3 announcement lists could not be read: Binance's announcement list answered 503")
    expect(one.recent.map((item) => item.id)).toEqual([301, 300])

    lists.failing.add(161)
    expect((await readNewsOnce(T + 30_000)).error).toMatch(/^2 of Binance's 3 announcement lists could not be read/)
    lists.failing.add(49)
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

describe('a delisting, or a tag, put to the models', () => {
  // An hour after the articles above, so that none of them is news.
  const LATER = T + 3_600_000
  const fresh = article(310, 'Binance Will Delist FIO, FUN on 2026-10-20', LATER - 2_000)

  it('raises each coin of a delisting released minutes ago, once the reader is on', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(LATER + 3_000)
    lists.articles.get(161)?.unshift(fresh)
    const { setNewsConfig, whenNewsSettled } = await reader()
    await setNewsConfig({ enabled: true })
    await whenNewsSettled()
    // Only the fresh one: the rest were released an hour or more ago.
    expect(raised.calls).toEqual([
      { id: 310, ticker: 'FIO' },
      { id: 310, ticker: 'FUN' }
    ])
    await setNewsConfig({ enabled: false })
  })

  it('raises nothing when that is switched off, or for a delisting read too long after its release', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(LATER + 3_000)
    lists.articles.get(161)?.unshift(fresh)
    const { setNewsConfig, whenNewsSettled } = await reader()
    await setNewsConfig({ enabled: true, delisting: { askModels: false } })
    await whenNewsSettled()
    expect(raised.calls).toEqual([])

    vi.resetModules()
    const later = await reader()
    lists.articles.get(161)?.unshift(article(311, 'Binance Will Delist COS on 2026-10-20', LATER - 6 * 60_000))
    // Switched back on, it reads at once -- and keeps 311, which is six minutes old: history.
    await later.setNewsConfig({ delisting: { askModels: true } })
    await later.whenNewsSettled()
    expect((await later.getNewsState()).recent.map((item) => item.id)).toContain(311)
    expect(raised.calls).toEqual([])
    await setNewsConfig({ enabled: false })
    await later.setNewsConfig({ enabled: false })
  })

  it('goes on reading when a coin cannot be raised', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(LATER + 3_000)
    raised.fail = true
    lists.articles.get(161)?.unshift(fresh)
    const { setNewsConfig, whenNewsSettled, getNewsState } = await reader()
    await setNewsConfig({ enabled: true })
    await whenNewsSettled()
    expect(raised.calls).toHaveLength(2)
    const state = await getNewsState()
    expect(state.error).toBeNull()
    expect(state.recent[0].id).toBe(310)
    await setNewsConfig({ enabled: false })
  })
  it('raises a coin added to the Monitoring Tag when that is switched on for the tag, and only then', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(LATER + 3_000)
    lists.articles.get(161)?.unshift(fresh)
    lists.articles.set(49, [article(410, 'Binance Will Extend the Monitoring Tag to Include ACX & LSK on 2026-10-05', LATER - 2_000)])
    const { setNewsConfig, whenNewsSettled } = await reader()
    // The delisting's models off, the tag's on: only the tag is raised.
    await setNewsConfig({ enabled: true, delisting: { askModels: false } })
    await whenNewsSettled()
    expect(raised.calls).toEqual([
      { id: 410, ticker: 'ACX' },
      { id: 410, ticker: 'LSK' }
    ])
    await setNewsConfig({ enabled: false })
  })
})

describe('its health', () => {
  it('pauses after three reads in a row that read nothing, says so, tries again every five minutes, and is back by itself', async () => {
    // Its own minute's read never comes between the reads made here.
    vi.useFakeTimers()
    lists.failing = new Set([161, 48, 49])
    const { setNewsConfig, whenNewsSettled, readNewsOnce, getNewsState } = await reader()
    await setNewsConfig({ enabled: true })
    await whenNewsSettled()
    await readNewsOnce(T + 60_000)
    expect((await getNewsState()).health).toEqual({ failuresInRow: 2, pausedAt: null, pausedReason: null })
    expect(told).toEqual([])
    await readNewsOnce(T + 120_000)
    const state = await getNewsState()
    // Paused, not switched off (20 November 2026: a three-minute outage had switched it off for the rest of a run).
    expect(state.config.enabled).toBe(true)
    expect(JSON.parse(readFileSync(join(dir, 'news.json'), 'utf-8')).enabled).toBe(true)
    expect(state.health).toMatchObject({ failuresInRow: 3, pausedReason: expect.stringMatching(/^Binance's announcement lists could not be read: /) })
    expect(state.health.pausedAt).not.toBeNull()
    expect(told).toHaveLength(1)
    expect(told[0].title).toBe('The announcement reader cannot read')
    expect(told[0].body).toMatch(/^Three reads in a row of Binance's announcement lists failed \(Binance's announcement lists could not be read: .+\): the reader tries again every five minutes by itself, and says so when it reads again\. Nothing was placed; what is open keeps its stops\.$/)
    // Its own read at the minute still reads nothing: told once, and the next read five minutes on.
    await vi.advanceTimersByTimeAsync(61_000)
    await whenNewsSettled()
    const waiting = await getNewsState()
    expect(waiting.health.failuresInRow).toBe(4)
    expect(told).toHaveLength(1)
    expect((waiting.nextReadAt ?? 0) - (waiting.lastReadAt ?? 0)).toBeGreaterThanOrEqual(299)
    expect((waiting.nextReadAt ?? 0) - (waiting.lastReadAt ?? 0)).toBeLessThanOrEqual(301)
    // The lists answer again: back at the next try, with a silent notice, and every minute from then.
    lists.failing = new Set()
    await vi.advanceTimersByTimeAsync(301_000)
    await whenNewsSettled()
    const back = await getNewsState()
    expect(back.health).toEqual({ failuresInRow: 0, pausedAt: null, pausedReason: null })
    expect(told).toHaveLength(2)
    expect(told[1].title).toBe('The announcement reader reads again')
    expect(told[1].body).toMatch(/^Binance's announcement lists were read again, \d+ minutes after the reader paused: it reads every minute again\.$/)
    expect((back.nextReadAt ?? 0) - (back.lastReadAt ?? 0)).toBeLessThanOrEqual(64)
    // A read of part of the lists is not one that read nothing; and switched off by hand, it is off, not paused.
    lists.failing = new Set([48])
    await readNewsOnce(T + 600_000)
    expect((await getNewsState()).health.failuresInRow).toBe(0)
    lists.failing = new Set([161, 48, 49])
    for (const at of [T + 660_000, T + 720_000, T + 780_000]) await readNewsOnce(at)
    expect((await getNewsState()).health.pausedAt).not.toBeNull()
    expect((await setNewsConfig({ enabled: false })).health).toMatchObject({ pausedAt: null, pausedReason: null })
    expect((await getNewsState()).nextReadAt).toBeNull()
    vi.useRealTimers()
  })

  it('stops nothing while it is off, however often a read reads nothing', async () => {
    lists.failing = new Set([161, 48, 49])
    const { readNewsOnce, getNewsState } = await reader()
    for (const at of [T, T + 60_000, T + 120_000, T + 180_000]) await readNewsOnce(at)
    expect((await getNewsState()).health).toEqual({ failuresInRow: 4, pausedAt: null, pausedReason: null })
    expect(told).toEqual([])
    // A read of any list is not one that read nothing: the count starts again.
    lists.failing = new Set([48])
    await readNewsOnce(T + 240_000)
    expect((await getNewsState()).health.failuresInRow).toBe(0)
  })
})

describe('its setting', () => {
  it('is off until switched on, and reads nothing at launch while off', async () => {
    vi.useFakeTimers()
    const { startNewsReader, getNewsState } = await reader()
    await startNewsReader()
    expect(vi.getTimerCount()).toBe(0)
    const state = await getNewsState()
    expect(state.config).toEqual(DEFAULT_NEWS_CONFIG)
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
    expect(lists.calls).toHaveLength(3)
    expect((await getNewsState()).recent).toHaveLength(4)
    // Written by this app, the file carries its version (shared/configMigration.ts).
    expect(JSON.parse(readFileSync(join(dir, 'news.json'), 'utf-8'))).toEqual({ ...DEFAULT_NEWS_CONFIG, enabled: true, configVersion: 1 })
    // Saying "on" again while it is on starts nothing more.
    await setNewsConfig({ enabled: true })
    await whenNewsSettled()
    expect(lists.calls).toHaveLength(3)

    vi.resetModules()
    const relaunched = await reader()
    await relaunched.startNewsReader()
    expect(vi.getTimerCount()).toBe(2)
    const off = await relaunched.setNewsConfig({ enabled: false })
    expect(off.nextReadAt).toBeNull()
    expect(JSON.parse(readFileSync(join(dir, 'news.json'), 'utf-8'))).toEqual({ ...DEFAULT_NEWS_CONFIG, configVersion: 1 })
  })

  it('refuses anything but on or off, and heals a file holding something else', async () => {
    const { setNewsConfig } = await reader()
    await expect(setNewsConfig({ enabled: 'yes' as never })).rejects.toThrow('The news reader is either on or off')
    await expect(setNewsConfig({ monitoringTag: { paperShort: { stakeQuote: 7 } } })).rejects.toThrow('A paper short stakes 25, 50, 100, 250, 500, 1000')
    writeFileSync(join(dir, 'news.json'), JSON.stringify({ enabled: 'true', paperShort: { enabled: 'yes' } }))
    vi.resetModules()
    expect((await (await reader()).getNewsState()).config).toEqual(DEFAULT_NEWS_CONFIG)
  })
})
