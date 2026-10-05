import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Candle } from '../shared/ipc'
import {
  NEWS_RECORD_SINCE,
  isNewsRecordRow,
  mergeRecordRows,
  recordEntries,
  scoredRow,
  summariseNewsRecord,
  type NewsRecordRow
} from '../shared/newsRecord'
import { fillMinutes, scoreDelistingRule, scoreTagRule } from '../shared/newsRules'

// The record of what the two news rules would have made since the study ended
// (shared/newsRecord.ts, electron/services/newsRecordService.ts). Binance's lists are faked at
// fetch, and the candles at the one market function the record reads them through; the record's
// file is real, in a scratch folder.

vi.mock('electron', () => ({ app: { getPath: () => process.env.NEWS_RECORD_USER_DATA } }))

const market = vi.hoisted(() => ({ candles: new Map<string, Candle[]>(), calls: [] as string[], failing: new Set<string>() }))
vi.mock('../electron/services/marketService', () => ({
  fetchHistoricalRange: async (_exchange: string, symbol: string, _interval: string, startSec: number, endSec: number) => {
    market.calls.push(symbol)
    if (market.failing.has(symbol)) throw new Error('binance.com klines request failed: 503')
    return { candles: (market.candles.get(symbol) ?? []).filter((bar) => bar.time >= startSec && bar.time <= endSec), cancelled: false }
  }
}))

/** A delisting of AAA and ZZZ, and a tag of BBB, a week after the record began. */
const R = NEWS_RECORD_SINCE + 7 * 86_400 + 8 * 3600
const lists = vi.hoisted(() => ({ calls: [] as string[], failing: false, articles: new Map<number, { id: number; title: string; releaseDate: number }[]>() }))

async function fakeFetch(url: string): Promise<Response> {
  lists.calls.push(url)
  if (lists.failing) return new Response('busy', { status: 503 })
  const catalog = Number(/catalogId=(\d+)/.exec(url)?.[1])
  return new Response(JSON.stringify({ code: '000000', data: { catalogs: [{ catalogId: catalog, articles: lists.articles.get(catalog) ?? [], total: 9 }] } }), {
    status: 200,
    headers: { 'content-type': 'application/json' }
  })
}

/** Thirteen hours before to five after, drifting down after the announcement. */
function minutes(base: number): Candle[] {
  const bars: Candle[] = []
  for (let t = R - 13 * 3600; t <= R + 5 * 3600; t += 60) {
    const k = (t - R) / 60
    const price = base * (1 + 0.004 * Math.sin(k / 5)) * (k > 0 ? 1 - k * 0.0002 : 1)
    bars.push({ time: t, open: price, high: price * 1.002, low: price * 0.998, close: price, volume: 1 })
  }
  return bars
}

let dir: string

beforeEach(() => {
  vi.resetModules()
  dir = mkdtempSync(join(tmpdir(), 'news-record-'))
  process.env.NEWS_RECORD_USER_DATA = dir
  lists.calls = []
  lists.failing = false
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
  market.candles = new Map([
    ['AAAUSDT', minutes(10)],
    ['BBBUSDT', minutes(2)],
    ['OLDUSDT', minutes(1)]
  ])
  market.calls = []
  market.failing = new Set()
  vi.stubGlobal('fetch', vi.fn(fakeFetch))
})

afterEach(() => vi.unstubAllGlobals())

async function service() {
  return import('../electron/services/newsRecordService')
}

describe('the rows of the record', () => {
  it('are the coins of the two kinds announced since the study ended, one each', () => {
    expect(recordEntries({ id: 1, title: 'Binance Will Delist AAA, ZZZ on 2026-10-20', releaseSec: R })).toEqual([
      { key: '1:AAA', category: 'DELISTING', ticker: 'AAA' },
      { key: '1:ZZZ', category: 'DELISTING', ticker: 'ZZZ' }
    ])
    expect(recordEntries({ id: 2, title: 'Binance Will Extend the Monitoring Tag to Include BBB & AEUR on 2026-10-08', releaseSec: R })).toEqual([
      { key: '2:BBB', category: 'MONITORING_TAG', ticker: 'BBB' }
    ])
    expect(recordEntries({ id: 3, title: 'Binance Will Delist AAA on 2026-09-30', releaseSec: NEWS_RECORD_SINCE - 1 })).toEqual([])
    expect(recordEntries({ id: 4, title: 'Binance Futures Will Launch USDⓈ-Margined CTUSDT Perpetual Contract', releaseSec: R })).toEqual([])
  })

  it('add up per kind, with what is not over yet and what could not be scored counted apart', () => {
    const base = { articleId: 1, ticker: 'X', releaseSec: R, title: 't', symbol: 'XUSDT', note: null }
    const rows: NewsRecordRow[] = [
      { ...base, key: 'a', category: 'DELISTING', status: 'scored', netPct: 12 },
      { ...base, key: 'b', category: 'DELISTING', status: 'scored', netPct: -40 },
      { ...base, key: 'c', category: 'DELISTING', status: 'scored', netPct: 4 },
      { ...base, key: 'd', category: 'DELISTING', status: 'waiting', netPct: null },
      { ...base, key: 'e', category: 'MONITORING_TAG', status: 'unscored', netPct: null }
    ]
    expect(summariseNewsRecord(rows, 'DELISTING')).toEqual({ scored: 3, ahead: 2, meanPct: -8, worstPct: -40, waiting: 1, unscored: 0 })
    expect(summariseNewsRecord(rows, 'MONITORING_TAG')).toEqual({ scored: 0, ahead: 0, meanPct: null, worstPct: null, waiting: 0, unscored: 1 })
  })

  it('keep a score once it is made, newest release first, and store only scores', () => {
    const base = { articleId: 1, category: 'DELISTING' as const, ticker: 'X', title: 't', note: null }
    const kept = scoredRow({ ...base, key: 'k', releaseSec: R }, 'XUSDT', { netPct: 3 })
    const later = { ...base, key: 'k', releaseSec: R, status: 'unscored' as const, netPct: null, symbol: null, note: 'Not scored.' }
    const newer = { ...base, key: 'n', articleId: 2, releaseSec: R + 60, status: 'waiting' as const, netPct: null, symbol: null }
    expect(mergeRecordRows([later, newer], new Map([['k', kept]]))).toEqual([newer, kept])
    expect(scoredRow({ ...base, key: 'k', releaseSec: R }, 'XUSDT', { skipped: 'no candle at the announcement minute' })).toMatchObject({
      status: 'unscored',
      netPct: null,
      note: 'Not scored: no candle at the announcement minute.'
    })
    expect(isNewsRecordRow(kept)).toBe(true)
    expect(isNewsRecordRow(later)).toBe(false)
    expect(isNewsRecordRow({ ...kept, netPct: Number.NaN })).toBe(false)
    // A row on file is a score, and nothing else, whatever figure it carries.
    expect(isNewsRecordRow({ ...kept, status: 'waiting' })).toBe(false)
  })
})

describe('the record', () => {
  it('waits for a rule whose trade is not over, and reads no candles for it', async () => {
    const { getNewsRecord } = await service()
    const record = await getNewsRecord((R + 60) * 1000)
    expect(record.error).toBeNull()
    expect(record.rows.map((row) => [row.key, row.status])).toEqual([
      ['601:BBB', 'waiting'],
      ['501:AAA', 'waiting'],
      ['501:ZZZ', 'waiting']
    ])
    expect(market.calls).toEqual([])
    // Both lists, one page each: neither was full.
    expect(lists.calls.map((url) => /catalogId=(\d+)&pageNo=(\d+)&pageSize=(\d+)/.exec(url)?.slice(1).join('/'))).toEqual(['161/1/50', '49/1/50'])
  })

  it("scores each rule's trade once it is over, by the study's arithmetic, and keeps the scores", async () => {
    const { getNewsRecord } = await service()
    const record = await getNewsRecord((R + 300 * 60) * 1000)
    const minute = Math.floor(R / 60) * 60
    const aaa = scoreDelistingRule(fillMinutes(minutes(10), minute).bars, R)
    const bbb = scoreTagRule(fillMinutes(minutes(2), minute).bars, R)
    expect(record.rows).toEqual([
      expect.objectContaining({ key: '601:BBB', category: 'MONITORING_TAG', status: 'scored', symbol: 'BBBUSDT', netPct: (bbb as { netPct: number }).netPct }),
      expect.objectContaining({ key: '501:AAA', category: 'DELISTING', status: 'scored', symbol: 'AAAUSDT', netPct: (aaa as { netPct: number }).netPct }),
      expect.objectContaining({ key: '501:ZZZ', status: 'unscored', netPct: null, note: 'Not scored: ZZZUSDT has no candles around it.' })
    ])
    // The coins drift down after the announcement: a short is ahead on both.
    expect((aaa as { netPct: number }).netPct).toBeGreaterThan(0)
    // Only the scores are kept on file; the one with nothing to score is not.
    const file = JSON.parse(readFileSync(join(dir, 'news', 'record.json'), 'utf-8')) as { rows: NewsRecordRow[] }
    expect(file.rows.map((row) => row.key).sort()).toEqual(['501:AAA', '601:BBB'])
  })

  it('reads the lists at most once in ten minutes, a kept score never again, and tries an unscored coin again', async () => {
    const { getNewsRecord } = await service()
    await getNewsRecord((R + 300 * 60) * 1000)
    expect(market.calls.sort()).toEqual(['AAAUSDT', 'BBBUSDT', 'ZZZUSDT'])
    market.calls = []
    await getNewsRecord((R + 305 * 60) * 1000)
    expect(lists.calls).toHaveLength(2)
    expect(market.calls).toEqual(['ZZZUSDT'])
    await getNewsRecord((R + 311 * 60) * 1000)
    expect(lists.calls).toHaveLength(4)
  })

  it('keeps its scores across a restart, and says when the lists cannot be read', async () => {
    await (await service()).getNewsRecord((R + 300 * 60) * 1000)
    vi.resetModules()
    lists.failing = true
    market.calls = []
    const record = await (await service()).getNewsRecord((R + 400 * 60) * 1000)
    expect(record.error).toMatch(/^Binance's announcement lists could not be read/)
    expect(record.rows.map((row) => [row.key, row.status])).toEqual([
      ['601:BBB', 'scored'],
      ['501:AAA', 'scored']
    ])
    expect(market.calls).toEqual([])
    // The lists answer again: the error is gone with the next read of them.
    lists.failing = false
    expect((await (await service()).getNewsRecord((R + 411 * 60) * 1000)).error).toBeNull()
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

  it('reads no article from before the study ended, and no further back than that', async () => {
    const { getNewsRecord } = await service()
    const record = await getNewsRecord((R + 300 * 60) * 1000)
    expect(record.rows.some((row) => row.ticker === 'OLD')).toBe(false)
    expect(market.calls).not.toContain('OLDUSDT')
  })
})
