import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Candle } from '../shared/ipc'
import {
  NEWS_RECORD_RULES,
  NEWS_RECORD_RULE_ORDER,
  NEWS_RECORD_SINCE,
  healNewsRecordRow,
  mergeRecordRows,
  parseUpbitNotices,
  recordEntries,
  scoredRow,
  summariseNewsRecord,
  upbitRecordEntries,
  type NewsRecordRow
} from '../shared/newsRecord'
import { fillMinutes, scoreBracketShort, scoreHeldShort } from '../shared/newsRules'

// The record of what the two news rules would have made since the study ended, and of the two near
// misses beside them (shared/newsRecord.ts, electron/services/newsRecordService.ts). Binance's and
// Upbit's lists are faked at fetch, and the candles at the one market function the record reads
// them through; the record's file is real, in a scratch folder.

vi.mock('electron', () => ({ app: { getPath: () => process.env.NEWS_RECORD_USER_DATA } }))

const market = vi.hoisted(() => ({ candles: new Map<string, Candle[]>(), calls: [] as string[], failing: new Set<string>(), unlisted: new Set<string>() }))
vi.mock('../electron/services/marketService', () => ({
  fetchHistoricalRange: async (_exchange: string, symbol: string, _interval: string, startSec: number, endSec: number) => {
    market.calls.push(symbol)
    if (market.failing.has(symbol)) throw new Error('binance.com klines request failed: 503')
    // What electron/services/exchanges/binance.ts throws for a symbol Binance does not list.
    if (market.unlisted.has(symbol)) throw new Error('binance.com klines request failed: 400 Bad Request')
    return { candles: (market.candles.get(symbol) ?? []).filter((bar) => bar.time >= startSec && bar.time <= endSec), cancelled: false }
  }
}))

/** A delisting of AAA and ZZZ and a tag of BBB on Binance, a week after the record began, and
 * Upbit's caution on CCC an hour before them. */
const R = NEWS_RECORD_SINCE + 7 * 86_400 + 8 * 3600
const U = R - 3600

interface UpbitNotice {
  id: number
  title: string
  first_listed_at: string
  listed_at: string
}

const kst = (sec: number): string => new Date((sec + 9 * 3600) * 1000).toISOString().slice(0, 19) + '+09:00'
const notice = (id: number, title: string, firstSec: number, listedSec = firstSec): UpbitNotice => ({ id, title, first_listed_at: kst(firstSec), listed_at: kst(listedSec) })

const lists = vi.hoisted(() => ({
  binanceCalls: [] as string[],
  upbitCalls: [] as string[],
  failing: false,
  upbitFailing: false,
  articles: new Map<number, { id: number; title: string; releaseDate: number }[]>(),
  upbitPages: new Map<number, unknown[]>()
}))

async function fakeFetch(url: string): Promise<Response> {
  const json = (body: unknown): Response => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })
  if (url.startsWith('https://api-manager.upbit.com/')) {
    lists.upbitCalls.push(url)
    if (lists.upbitFailing) return new Response('Too Many Requests', { status: 429 })
    const page = Number(/[?&]page=(\d+)/.exec(url)?.[1])
    return json({ success: true, data: { total_pages: lists.upbitPages.size, notices: lists.upbitPages.get(page) ?? [] } })
  }
  lists.binanceCalls.push(url)
  if (lists.failing) return new Response('busy', { status: 503 })
  const catalog = Number(/catalogId=(\d+)/.exec(url)?.[1])
  return json({ code: '000000', data: { catalogs: [{ catalogId: catalog, articles: lists.articles.get(catalog) ?? [], total: 9 }] } })
}

/** Thirteen hours before to five after an announcement, drifting down after it. */
function minutes(base: number, at = R): Candle[] {
  const bars: Candle[] = []
  for (let t = at - 13 * 3600; t <= at + 5 * 3600; t += 60) {
    const k = (t - at) / 60
    const price = base * (1 + 0.004 * Math.sin(k / 5)) * (k > 0 ? 1 - k * 0.0002 : 1)
    bars.push({ time: t, open: price, high: price * 1.002, low: price * 0.998, close: price, volume: 1 })
  }
  return bars
}

const netOf = (score: ReturnType<typeof scoreHeldShort>): number => (score as { netPct: number }).netPct

let dir: string

beforeEach(() => {
  vi.resetModules()
  dir = mkdtempSync(join(tmpdir(), 'news-record-'))
  process.env.NEWS_RECORD_USER_DATA = dir
  lists.binanceCalls = []
  lists.upbitCalls = []
  lists.failing = false
  lists.upbitFailing = false
  lists.articles = new Map([
    [
      161,
      [
        { id: 501, title: 'Binance Will Delist AAA, ZZZ on 2026-10-20', releaseDate: R * 1000 },
        { id: 499, title: 'Binance Will Delist OLD on 2026-09-30', releaseDate: (NEWS_RECORD_SINCE - 86_400) * 1000 }
      ]
    ],
    [49, [{ id: 601, title: 'Binance Will Extend the Monitoring Tag to Include BBB on 2026-10-08', releaseDate: R * 1000 }]]
  ])
  lists.upbitPages = new Map([
    [
      1,
      [
        notice(7002, '돌핀(POD) 신규 거래지원 안내 (KRW, BTC, USDT 마켓)', U + 60),
        notice(7001, '씨씨씨(CCC) 거래 유의 종목 지정 안내', U),
        notice(6990, '올드(OLDU) 거래 유의 종목 지정 안내', NEWS_RECORD_SINCE - 86_400)
      ]
    ]
  ])
  market.candles = new Map([
    ['AAAUSDT', minutes(10)],
    ['BBBUSDT', minutes(2)],
    ['CCCUSDT', minutes(5, U)],
    ['OLDUSDT', minutes(1)],
    ['OLDUUSDT', minutes(1)],
    ['PODUSDT', minutes(1)]
  ])
  market.calls = []
  market.failing = new Set()
  market.unlisted = new Set()
  vi.stubGlobal('fetch', vi.fn(fakeFetch))
})

afterEach(() => vi.unstubAllGlobals())

async function service() {
  return import('../electron/services/newsRecordService')
}

describe('the rows of the record', () => {
  it("are the coins of Binance's two kinds announced since the study ended, a tagged coin twice: its rule and its near miss", () => {
    expect(recordEntries({ id: 1, title: 'Binance Will Delist AAA, ZZZ on 2026-10-20', releaseSec: R })).toEqual([
      { key: '1:AAA', category: 'DELISTING', rule: 'DELISTING_HOLD', ticker: 'AAA' },
      { key: '1:ZZZ', category: 'DELISTING', rule: 'DELISTING_HOLD', ticker: 'ZZZ' }
    ])
    expect(recordEntries({ id: 2, title: 'Binance Will Extend the Monitoring Tag to Include BBB & AEUR on 2026-10-08', releaseSec: R })).toEqual([
      { key: '2:BBB', category: 'MONITORING_TAG', rule: 'TAG_BRACKET', ticker: 'BBB' },
      { key: '2:BBB:hold', category: 'MONITORING_TAG', rule: 'TAG_HOLD', ticker: 'BBB' }
    ])
    expect(recordEntries({ id: 3, title: 'Binance Will Delist AAA on 2026-09-30', releaseSec: NEWS_RECORD_SINCE - 1 })).toEqual([])
    expect(recordEntries({ id: 4, title: 'Binance Futures Will Launch USDⓈ-Margined CTUSDT Perpetual Contract', releaseSec: R })).toEqual([])
  })

  it("and the coins Upbit designates for caution since then, and nothing else of Upbit's", () => {
    expect(upbitRecordEntries({ id: 6637, title: '블라스트(BLAST) 거래 유의 종목 지정 안내', releaseSec: R })).toEqual([
      { key: 'upbit:6637:BLAST', category: 'UPBIT_CAUTION', rule: 'UPBIT_CAUTION_HOLD', ticker: 'BLAST' }
    ])
    for (const title of ['돌핀(POD) 신규 거래지원 안내 (KRW, BTC, USDT 마켓)', '아이콘(ICX) 거래지원 종료 안내 (10/19 15:00)', '샌드박스(SAND) 거래 유의 종목 지정 해제 안내']) {
      expect(upbitRecordEntries({ id: 1, title, releaseSec: R }), title).toEqual([])
    }
    expect(upbitRecordEntries({ id: 1, title: '블라스트(BLAST) 거래 유의 종목 지정 안내', releaseSec: NEWS_RECORD_SINCE - 1 })).toEqual([])
  })

  it("read Upbit's list as it gives it, by when each notice was first posted", () => {
    const first = Date.parse('2026-10-03T01:30:00+09:00') / 1000
    expect(
      parseUpbitNotices({
        success: true,
        data: {
          notices: [
            { id: 6637, title: ' 블라스트(BLAST)  거래 유의 종목 지정 안내', first_listed_at: '2026-10-03T01:30:00+09:00', listed_at: '2026-10-04T09:00:00+09:00' },
            { id: 'six', title: 't', first_listed_at: '2026-10-03T01:30:00+09:00' },
            { id: 5, title: ' ', first_listed_at: '2026-10-03T01:30:00+09:00' },
            { id: 6, title: 't', first_listed_at: 'not a time' },
            { id: 7, title: 't', first_listed_at: '2026-10-03T01:30:00+09:00' },
            null
          ]
        }
      })
    ).toEqual([
      { id: 6637, title: '블라스트(BLAST) 거래 유의 종목 지정 안내', releaseSec: first, listedSec: Date.parse('2026-10-04T09:00:00+09:00') / 1000 },
      { id: 7, title: 't', releaseSec: first, listedSec: first }
    ])
    for (const body of [{ success: false, data: { notices: [] } }, { success: true, data: {} }, null, 'busy']) {
      expect(() => parseUpbitNotices(body), JSON.stringify(body)).toThrow('Upbit answered without a notice list')
    }
  })

  it('add up per trade, with what is not over yet and what could not be scored counted apart', () => {
    const base = { articleId: 1, ticker: 'X', releaseSec: R, title: 't', symbol: 'XUSDT', note: null }
    const rows: NewsRecordRow[] = [
      { ...base, key: 'a', category: 'DELISTING', rule: 'DELISTING_HOLD', status: 'scored', netPct: 12 },
      { ...base, key: 'b', category: 'DELISTING', rule: 'DELISTING_HOLD', status: 'scored', netPct: -40 },
      { ...base, key: 'c', category: 'DELISTING', rule: 'DELISTING_HOLD', status: 'scored', netPct: 4 },
      { ...base, key: 'd', category: 'DELISTING', rule: 'DELISTING_HOLD', status: 'waiting', netPct: null },
      { ...base, key: 'e', category: 'MONITORING_TAG', rule: 'TAG_BRACKET', status: 'unscored', netPct: null },
      { ...base, key: 'e:hold', category: 'MONITORING_TAG', rule: 'TAG_HOLD', status: 'scored', netPct: 6 }
    ]
    expect(summariseNewsRecord(rows, 'DELISTING_HOLD')).toEqual({ scored: 3, ahead: 2, meanPct: -8, worstPct: -40, waiting: 1, unscored: 0 })
    expect(summariseNewsRecord(rows, 'TAG_BRACKET')).toEqual({ scored: 0, ahead: 0, meanPct: null, worstPct: null, waiting: 0, unscored: 1 })
    expect(summariseNewsRecord(rows, 'TAG_HOLD')).toEqual({ scored: 1, ahead: 1, meanPct: 6, worstPct: 6, waiting: 0, unscored: 0 })
    expect(summariseNewsRecord(rows, 'UPBIT_CAUTION_HOLD')).toEqual({ scored: 0, ahead: 0, meanPct: null, worstPct: null, waiting: 0, unscored: 0 })
  })

  it("set each trade beside its study's held-out half, the rules that passed first", () => {
    expect(NEWS_RECORD_RULE_ORDER).toEqual(['DELISTING_HOLD', 'TAG_BRACKET', 'TAG_HOLD', 'UPBIT_CAUTION_HOLD'])
    expect(NEWS_RECORD_RULE_ORDER.map((rule) => [NEWS_RECORD_RULES[rule].trade, NEWS_RECORD_RULES[rule].passed])).toEqual([
      ['hold', true],
      ['bracket', true],
      ['hold', false],
      ['hold', false]
    ])
    expect(NEWS_RECORD_RULES.UPBIT_CAUTION_HOLD.study).toEqual({ meanPct: 3.93, ahead: 18, of: 24 })
    expect(NEWS_RECORD_RULES.TAG_HOLD.study).toEqual({ meanPct: 6.66, ahead: 82, of: 103 })
  })

  it('keep a score once it is made, newest release first and a coin its trades in order, and store only scores', () => {
    const base = { articleId: 1, category: 'DELISTING' as const, rule: 'DELISTING_HOLD' as const, ticker: 'X', title: 't', note: null }
    const kept = scoredRow({ ...base, key: 'k', releaseSec: R }, 'XUSDT', { netPct: 3 })
    const later = { ...base, key: 'k', releaseSec: R, status: 'unscored' as const, netPct: null, symbol: null, note: 'Not scored.' }
    const newer = { ...base, key: 'n', articleId: 2, releaseSec: R + 60, status: 'waiting' as const, netPct: null, symbol: null }
    expect(mergeRecordRows([later, newer], new Map([['k', kept]]))).toEqual([newer, kept])
    const tag = { ...base, articleId: 3, category: 'MONITORING_TAG' as const, releaseSec: R - 60, status: 'waiting' as const, netPct: null, symbol: null }
    const hold = { ...tag, key: '3:X:hold', rule: 'TAG_HOLD' as const }
    const bracket = { ...tag, key: '3:X', rule: 'TAG_BRACKET' as const }
    expect(mergeRecordRows([hold, bracket], new Map()).map((row) => row.key)).toEqual(['3:X', '3:X:hold'])
    expect(scoredRow({ ...base, key: 'k', releaseSec: R }, 'XUSDT', { skipped: 'no candle at the announcement minute' })).toMatchObject({
      status: 'unscored',
      netPct: null,
      note: 'Not scored: no candle at the announcement minute.'
    })
  })

  it('heal a stored row: a score and nothing else, one kept before the near misses read as its rule that passed', () => {
    const kept = scoredRow({ key: 'k', articleId: 1, category: 'DELISTING', rule: 'DELISTING_HOLD', ticker: 'X', releaseSec: R, title: 't' }, 'XUSDT', { netPct: 3 })
    expect(healNewsRecordRow(kept)).toEqual(kept)
    expect(healNewsRecordRow({ ...kept, status: 'unscored', netPct: null })).toBeNull()
    expect(healNewsRecordRow({ ...kept, netPct: Number.NaN })).toBeNull()
    // A row on file is a score, and nothing else, whatever figure it carries.
    expect(healNewsRecordRow({ ...kept, status: 'waiting' })).toBeNull()
    const before: Record<string, unknown> = { ...kept }
    delete before.rule
    expect(healNewsRecordRow(before)).toEqual(kept)
    expect(healNewsRecordRow({ ...before, key: 't', category: 'MONITORING_TAG' })).toMatchObject({ key: 't', rule: 'TAG_BRACKET' })
    // An Upbit row always says its rule, and a rule of another kind, or none at all, is not one.
    expect(healNewsRecordRow({ ...before, category: 'UPBIT_CAUTION' })).toBeNull()
    expect(healNewsRecordRow({ ...kept, rule: 'TAG_HOLD' })).toBeNull()
    expect(healNewsRecordRow({ ...kept, rule: 'toString' })).toBeNull()
    expect(healNewsRecordRow({ ...kept, category: 'FUTURES_LAUNCH' })).toBeNull()
    expect(healNewsRecordRow([kept])).toBeNull()
  })
})

describe('the record', () => {
  it('waits for a trade that is not over, and reads no candles for it', async () => {
    const { getNewsRecord } = await service()
    const record = await getNewsRecord((R + 60) * 1000)
    expect(record.error).toBeNull()
    expect(record.rows.map((row) => [row.key, row.status])).toEqual([
      ['601:BBB', 'waiting'],
      ['601:BBB:hold', 'waiting'],
      ['501:AAA', 'waiting'],
      ['501:ZZZ', 'waiting'],
      ['upbit:7001:CCC', 'waiting']
    ])
    expect(market.calls).toEqual([])
    // Each list, one page: none was full.
    expect(lists.binanceCalls.map((url) => /catalogId=(\d+)&pageNo=(\d+)&pageSize=(\d+)/.exec(url)?.slice(1).join('/'))).toEqual(['161/1/50', '49/1/50'])
    expect(lists.upbitCalls).toEqual(['https://api-manager.upbit.com/api/v1/announcements?os=web&page=1&per_page=20&category=trade'])
  })

  it("scores each trade once it is over, by the studies' arithmetic, a coin's candles read once, and keeps the scores", async () => {
    const { getNewsRecord } = await service()
    const record = await getNewsRecord((R + 300 * 60) * 1000)
    const minute = Math.floor(R / 60) * 60
    const aaa = scoreHeldShort(fillMinutes(minutes(10), minute).bars, R)
    const bbbBracket = scoreBracketShort(fillMinutes(minutes(2), minute).bars, R)
    const bbbHold = scoreHeldShort(fillMinutes(minutes(2), minute).bars, R)
    const ccc = scoreHeldShort(fillMinutes(minutes(5, U), Math.floor(U / 60) * 60).bars, U)
    expect(record.rows).toEqual([
      expect.objectContaining({ key: '601:BBB', category: 'MONITORING_TAG', rule: 'TAG_BRACKET', status: 'scored', symbol: 'BBBUSDT', netPct: netOf(bbbBracket) }),
      expect.objectContaining({ key: '601:BBB:hold', category: 'MONITORING_TAG', rule: 'TAG_HOLD', status: 'scored', symbol: 'BBBUSDT', netPct: netOf(bbbHold) }),
      expect.objectContaining({ key: '501:AAA', category: 'DELISTING', rule: 'DELISTING_HOLD', status: 'scored', symbol: 'AAAUSDT', netPct: netOf(aaa) }),
      expect.objectContaining({ key: '501:ZZZ', status: 'unscored', netPct: null, note: 'Not scored: ZZZUSDT has no candles around it.' }),
      expect.objectContaining({ key: 'upbit:7001:CCC', category: 'UPBIT_CAUTION', rule: 'UPBIT_CAUTION_HOLD', status: 'scored', symbol: 'CCCUSDT', netPct: netOf(ccc), title: '씨씨씨(CCC) 거래 유의 종목 지정 안내' })
    ])
    // The coins drift down after the announcement: a short is ahead, and the hold is not the bracket.
    expect(netOf(aaa)).toBeGreaterThan(0)
    expect(netOf(ccc)).toBeGreaterThan(0)
    expect(netOf(bbbHold)).not.toBe(netOf(bbbBracket))
    // The tag's two trades are one read of its candles; Upbit's listing is not on record.
    expect(market.calls.sort()).toEqual(['AAAUSDT', 'BBBUSDT', 'CCCUSDT', 'ZZZUSDT'])
    // Only the scores are kept on file; the one with nothing to score is not.
    const file = JSON.parse(readFileSync(join(dir, 'news', 'record.json'), 'utf-8')) as { rows: NewsRecordRow[] }
    expect(file.rows.map((row) => row.key).sort()).toEqual(['501:AAA', '601:BBB', '601:BBB:hold', 'upbit:7001:CCC'])
  })

  it("scores a tag's bracket once its hour is over, and its hold when the four hours are", async () => {
    const { getNewsRecord } = await service()
    const early = await getNewsRecord((R + 70 * 60) * 1000)
    expect(early.rows.filter((row) => row.ticker === 'BBB').map((row) => [row.key, row.status])).toEqual([
      ['601:BBB', 'scored'],
      ['601:BBB:hold', 'waiting']
    ])
    expect(market.calls).toEqual(['BBBUSDT'])
    const late = await getNewsRecord((R + 245 * 60) * 1000)
    expect(late.rows.filter((row) => row.ticker === 'BBB').map((row) => [row.key, row.status])).toEqual([
      ['601:BBB', 'scored'],
      ['601:BBB:hold', 'scored']
    ])
    // The bracket was not scored again: only the hold read the candles a second time.
    expect(market.calls.filter((symbol) => symbol === 'BBBUSDT')).toHaveLength(2)
  })

  it('reads each list at most once in ten minutes, a kept score never again, and tries an unscored coin again', async () => {
    const { getNewsRecord } = await service()
    await getNewsRecord((R + 300 * 60) * 1000)
    market.calls = []
    await getNewsRecord((R + 305 * 60) * 1000)
    expect(lists.binanceCalls).toHaveLength(2)
    expect(lists.upbitCalls).toHaveLength(1)
    expect(market.calls).toEqual(['ZZZUSDT'])
    const record = await getNewsRecord((R + 311 * 60) * 1000)
    expect(lists.binanceCalls).toHaveLength(4)
    expect(lists.upbitCalls).toHaveLength(2)
    expect(record.listedAt).toBe(R + 311 * 60)
  })

  it('keeps its scores across a restart, and says which lists cannot be read', async () => {
    await (await service()).getNewsRecord((R + 300 * 60) * 1000)
    vi.resetModules()
    lists.failing = true
    lists.upbitFailing = true
    market.calls = []
    const record = await (await service()).getNewsRecord((R + 400 * 60) * 1000)
    expect(record.error).toBe("Binance's announcement lists could not be read: it answered 503. Upbit's notice list could not be read: it answered 429.")
    expect(record.listedAt).toBeNull()
    expect(record.rows.map((row) => [row.key, row.status])).toEqual([
      ['601:BBB', 'scored'],
      ['601:BBB:hold', 'scored'],
      ['501:AAA', 'scored'],
      ['upbit:7001:CCC', 'scored']
    ])
    expect(market.calls).toEqual([])
    // The lists answer again: the errors are gone with the next read of them.
    lists.failing = false
    lists.upbitFailing = false
    expect((await (await service()).getNewsRecord((R + 411 * 60) * 1000)).error).toBeNull()
  })

  it("goes on with Binance's lists when Upbit's cannot be read, and the other way round", async () => {
    lists.upbitFailing = true
    const { getNewsRecord } = await service()
    const record = await getNewsRecord((R + 300 * 60) * 1000)
    expect(record.error).toBe("Upbit's notice list could not be read: it answered 429.")
    expect(record.rows.find((row) => row.key === '501:AAA')).toMatchObject({ status: 'scored' })
    expect(record.rows.some((row) => row.category === 'UPBIT_CAUTION')).toBe(false)
    // Upbit is tried again at once, having never been read; Binance not for ten minutes.
    lists.upbitFailing = false
    lists.failing = true
    const again = await getNewsRecord((R + 301 * 60) * 1000)
    expect(again.error).toBeNull()
    expect(again.rows.find((row) => row.key === 'upbit:7001:CCC')).toMatchObject({ status: 'scored' })
    expect(lists.binanceCalls).toHaveLength(2)
    // The card says when a list was last read: the later of the two.
    expect(again.listedAt).toBe(R + 301 * 60)
  })

  it("reads a kept score from before the near misses as its rule's, and reads no candles for it", async () => {
    mkdirSync(join(dir, 'news'), { recursive: true })
    const old = { key: '501:AAA', articleId: 501, category: 'DELISTING', ticker: 'AAA', releaseSec: R, title: 'Binance Will Delist AAA, ZZZ on 2026-10-20', status: 'scored', netPct: 9.5, symbol: 'AAAUSDT', note: null }
    writeFileSync(join(dir, 'news', 'record.json'), JSON.stringify({ rows: [old] }))
    const record = await (await service()).getNewsRecord((R + 300 * 60) * 1000)
    expect(record.rows.find((row) => row.key === '501:AAA')).toEqual({ ...old, rule: 'DELISTING_HOLD' })
    expect(market.calls).not.toContain('AAAUSDT')
  })

  it('says so when Binance has no spot pair for a coin Upbit names, and tries it again on the next look', async () => {
    market.unlisted.add('CCCUSDT')
    const { getNewsRecord } = await service()
    const first = await getNewsRecord((R + 300 * 60) * 1000)
    expect(first.rows.find((row) => row.key === 'upbit:7001:CCC')).toMatchObject({ status: 'unscored', symbol: null, note: 'Not scored: CCCUSDT is not a Binance spot pair.' })
    // Binance lists it later: it is scored then.
    market.unlisted.clear()
    const second = await getNewsRecord((R + 302 * 60) * 1000)
    expect(second.rows.find((row) => row.key === 'upbit:7001:CCC')).toMatchObject({ status: 'scored', symbol: 'CCCUSDT' })
  })

  it('does not keep a coin whose candles could not be read, and scores it once they can be', async () => {
    market.failing.add('AAAUSDT')
    const { getNewsRecord } = await service()
    const first = await getNewsRecord((R + 300 * 60) * 1000)
    expect(first.rows.find((row) => row.key === '501:AAA')).toMatchObject({ status: 'unscored', note: expect.stringContaining('could not be read') })
    market.failing.clear()
    const second = await getNewsRecord((R + 302 * 60) * 1000)
    expect(second.rows.find((row) => row.key === '501:AAA')).toMatchObject({ status: 'scored' })
  })

  it('reads nothing from before the study ended, from either exchange', async () => {
    const { getNewsRecord } = await service()
    const record = await getNewsRecord((R + 300 * 60) * 1000)
    expect(record.rows.some((row) => row.ticker === 'OLD' || row.ticker === 'OLDU')).toBe(false)
    expect(market.calls).not.toContain('OLDUSDT')
    expect(market.calls).not.toContain('OLDUUSDT')
  })

  it("reads Upbit's list a page a second until one holds a notice dated before the start", async () => {
    // A full first page: nineteen listings since the start, and a caution first posted before it
    // but edited since, which moved it up the list. Its coin is not on record, and paging goes on.
    const listings = (from: number, count: number) => Array.from({ length: count }, (_, k) => notice(from + k, `리스팅${k}(L${k}) 신규 거래지원 안내 (KRW 마켓)`, U + 120 + k))
    lists.upbitPages = new Map([
      [1, [...listings(8000, 19), notice(6995, '에디트(EDIT) 거래 유의 종목 지정 안내', NEWS_RECORD_SINCE - 3600, U)]],
      // As full, ending where the list's dates pass the start: the last page read.
      [2, [...listings(8100, 18), notice(7001, '씨씨씨(CCC) 거래 유의 종목 지정 안내', U), notice(6990, '올드(OLDU) 거래 유의 종목 지정 안내', NEWS_RECORD_SINCE - 86_400)]],
      [3, [notice(6000, '쓰리(THREE) 거래 유의 종목 지정 안내', U)]]
    ])
    const started = Date.now()
    const record = await (await service()).getNewsRecord((R + 300 * 60) * 1000)
    expect(lists.upbitCalls.map((url) => /[?&]page=(\d+)/.exec(url)?.[1])).toEqual(['1', '2'])
    expect(Date.now() - started).toBeGreaterThanOrEqual(900)
    expect(record.rows.filter((row) => row.category === 'UPBIT_CAUTION').map((row) => row.key)).toEqual(['upbit:7001:CCC'])
  })
})
