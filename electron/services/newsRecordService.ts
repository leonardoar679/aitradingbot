import { app } from 'electron'
import { mkdir, readFile } from 'fs/promises'
import { join } from 'path'
import { EVENT_LOOKBACK_BARS } from '../../shared/marketEvent'
import { parseArticleList, type ListedArticle } from '../../shared/news'
import {
  NEWS_RECORD_CATALOGS,
  NEWS_RECORD_RULES,
  NEWS_RECORD_SINCE,
  healNewsRecordRow,
  mergeRecordRows,
  parseUpbitNotices,
  recordEntries,
  scoredRow,
  upbitRecordEntries,
  type NewsRecord,
  type NewsRecordEntry,
  type NewsRecordRow
} from '../../shared/newsRecord'
import { HOLD_EXIT_BARS, fillMinutes, scoreBracketShort, scoreHeldShort, spotSymbolCandidates, tradeReadyAt } from '../../shared/newsRules'
import { writeJsonAtomic } from './atomicWrite'
import { fetchHistoricalRange } from './marketService'

// The record of what the two news rules would have made since the study ended, and of the two
// trades that came nearest (shared/newsRecord.ts): Binance's delisting and news lists, and Upbit's
// list of trading notices, read back to 1 October 2026, and each coin scored on its own 1-minute
// candles on Binance, by the studies' own arithmetic.
//
// IT READS PUBLIC DATA AND NOTHING ELSE: the announcement lists and the candles, with no key, no
// model and no order. It reads only when it is asked -- Discovery's card asks when it is shown --
// and reads each list at most once in ten minutes. It is independent of the news reader's switch:
// the record is of what was announced, not of what this app happened to read.
//
// A SCORE IS KEPT ONCE IT IS MADE, in news/record.json: a coin Binance has delisted soon has no
// candles to read again. A coin that could not be scored is tried again the next time.

const LIST_PAGE_SIZE = 50
/** Enough pages of each list to reach back months; a list is read only until it passes the start. */
const LIST_PAGES_MOST = 10
/** Upbit answers no larger page, and answers 429 to its list read fast, so its pages are read a
 * second apart. Twenty notices are about five weeks of them. */
const UPBIT_PAGE_SIZE = 20
const UPBIT_PAGES_MOST = 10
const UPBIT_PAGE_PAUSE_MS = 1000
const LIST_FRESH_MS = 10 * 60_000
const READ_TIMEOUT_MS = 15_000

interface Listed {
  at: number
  articles: ListedArticle[]
}

let binanceListed: Listed | null = null
let upbitListed: Listed | null = null
let binanceError: string | null = null
let upbitError: string | null = null
/** The one build under way, which everyone who asks meanwhile waits for. */
let working: Promise<NewsRecord> | null = null

function recordPath(): string {
  return join(app.getPath('userData'), 'news', 'record.json')
}

export function recordListUrl(catalog: number, pageNo: number): string {
  return `https://www.binance.com/bapi/composite/v1/public/cms/article/list/query?type=1&catalogId=${catalog}&pageNo=${pageNo}&pageSize=${LIST_PAGE_SIZE}`
}

export function upbitListUrl(pageNo: number): string {
  return `https://api-manager.upbit.com/api/v1/announcements?os=web&page=${pageNo}&per_page=${UPBIT_PAGE_SIZE}&category=trade`
}

async function fetchList(url: string): Promise<unknown> {
  const response = await fetch(url, { headers: { 'User-Agent': 'TraderSpider', Accept: 'application/json' }, signal: AbortSignal.timeout(READ_TIMEOUT_MS) })
  if (!response.ok) throw new Error(`it answered ${response.status}`)
  return response.json()
}

function describeFailure(failure: unknown): string {
  return failure instanceof Error ? failure.message : String(failure)
}

/** Every article of Binance's two lists released since the record began, each once. */
async function readLists(): Promise<ListedArticle[]> {
  const byId = new Map<number, ListedArticle>()
  for (const catalog of NEWS_RECORD_CATALOGS) {
    for (let page = 1; page <= LIST_PAGES_MOST; page++) {
      const articles = parseArticleList(await fetchList(recordListUrl(catalog, page)))
      for (const article of articles) if (article.releaseSec >= NEWS_RECORD_SINCE && !byId.has(article.id)) byId.set(article.id, article)
      if (articles.length < LIST_PAGE_SIZE || articles.some((article) => article.releaseSec < NEWS_RECORD_SINCE)) break
    }
  }
  return [...byId.values()]
}

/** Every Upbit trading notice first posted since the record began, each once. Upbit orders its list
 * by the time it dates each notice, which an edit moves on, so the list is read until a page holds
 * one dated before the start. */
async function readUpbitList(): Promise<ListedArticle[]> {
  const byId = new Map<number, ListedArticle>()
  for (let page = 1; page <= UPBIT_PAGES_MOST; page++) {
    if (page > 1) await new Promise((resolve) => setTimeout(resolve, UPBIT_PAGE_PAUSE_MS))
    const notices = parseUpbitNotices(await fetchList(upbitListUrl(page)))
    for (const { id, title, releaseSec } of notices) if (releaseSec >= NEWS_RECORD_SINCE && !byId.has(id)) byId.set(id, { id, title, releaseSec })
    if (notices.length < UPBIT_PAGE_SIZE || notices.some((notice) => notice.listedSec < NEWS_RECORD_SINCE)) break
  }
  return [...byId.values()]
}

/** Each list read again once ten minutes have passed since it last was, or at once if it never
 * has; one that cannot be read keeps what it last gave, and says why. */
async function refreshLists(nowMs: number): Promise<void> {
  if (binanceListed === null || nowMs - binanceListed.at >= LIST_FRESH_MS) {
    try {
      binanceListed = { at: nowMs, articles: await readLists() }
      binanceError = null
    } catch (failure) {
      binanceError = `Binance's announcement lists could not be read: ${describeFailure(failure)}.`
    }
  }
  if (upbitListed === null || nowMs - upbitListed.at >= LIST_FRESH_MS) {
    try {
      upbitListed = { at: nowMs, articles: await readUpbitList() }
      upbitError = null
    } catch (failure) {
      upbitError = `Upbit's notice list could not be read: ${describeFailure(failure)}.`
    }
  }
}

async function loadKept(): Promise<Map<string, NewsRecordRow>> {
  const kept = new Map<string, NewsRecordRow>()
  try {
    const raw = JSON.parse(await readFile(recordPath(), 'utf-8')) as { rows?: unknown }
    for (const value of Array.isArray(raw.rows) ? raw.rows : []) {
      const row = healNewsRecordRow(value)
      if (row !== null) kept.set(row.key, row)
    }
  } catch {
    // No record yet, or one that does not read: it is built again from the lists.
  }
  return kept
}

/** One coin of one announcement, each of its trades that is over scored on its spot USDT pair, or
 * said why not: the candles are read once for all of them. */
async function scoreCoin(article: ListedArticle, ticker: string, entries: NewsRecordEntry[]): Promise<NewsRecordRow[]> {
  const base = (entry: NewsRecordEntry): Omit<NewsRecordRow, 'status' | 'netPct' | 'symbol' | 'note'> => ({
    key: entry.key,
    articleId: article.id,
    category: entry.category,
    rule: entry.rule,
    ticker,
    releaseSec: article.releaseSec,
    title: article.title
  })
  const minute = Math.floor(article.releaseSec / 60) * 60
  // Twelve hours and a half before -- the bracket's stop and target are read from the twelve before
  // the announcement -- to four hours and a few minutes after: everything either trade reads.
  const startSec = minute - (EVENT_LOOKBACK_BARS + 30) * 60
  const endSec = minute + (HOLD_EXIT_BARS + 5) * 60
  let problem = 'it has no USDT spot pair'
  for (const symbol of spotSymbolCandidates(ticker)) {
    try {
      const { candles } = await fetchHistoricalRange('binance', symbol, '1m', startSec, endSec, `news-record:${entries[0].key}:${symbol}`, () => undefined)
      if (candles.length === 0) {
        problem = `${symbol} has no candles around it`
        continue
      }
      const { bars } = fillMinutes(candles, minute)
      return entries.map((entry) =>
        scoredRow(base(entry), symbol, NEWS_RECORD_RULES[entry.rule].trade === 'hold' ? scoreHeldShort(bars, article.releaseSec) : scoreBracketShort(bars, article.releaseSec))
      )
    } catch (failure) {
      // Binance answers 400 to a symbol it does not list (electron/services/exchanges/binance.ts
      // says so in the message): a coin Upbit names that Binance has no spot pair for.
      const message = describeFailure(failure)
      problem = /klines request failed: 400\b/.test(message) ? `${symbol} is not a Binance spot pair` : `the candles of ${symbol} could not be read (${message})`
    }
  }
  return entries.map((entry) => ({ ...base(entry), status: 'unscored', netPct: null, symbol: null, note: `Not scored: ${problem}.` }))
}

async function build(nowMs: number): Promise<NewsRecord> {
  const nowSec = Math.floor(nowMs / 1000)
  const kept = await loadKept()
  await refreshLists(nowMs)

  // Each coin of each announcement once, with the trades it is on record for.
  const coins = new Map<string, { article: ListedArticle; ticker: string; entries: NewsRecordEntry[] }>()
  const add = (source: 'binance' | 'upbit', article: ListedArticle, entries: NewsRecordEntry[]): void => {
    for (const entry of entries) {
      const id = `${source}:${article.id}:${entry.ticker}`
      const coin = coins.get(id) ?? { article, ticker: entry.ticker, entries: [] }
      coin.entries.push(entry)
      coins.set(id, coin)
    }
  }
  for (const article of binanceListed?.articles ?? []) add('binance', article, recordEntries(article))
  for (const notice of upbitListed?.articles ?? []) add('upbit', notice, upbitRecordEntries(notice))

  const fresh: NewsRecordRow[] = []
  let added = false
  for (const { article, ticker, entries } of coins.values()) {
    const ready: NewsRecordEntry[] = []
    for (const entry of entries) {
      if (kept.has(entry.key)) continue
      if (nowSec >= tradeReadyAt(NEWS_RECORD_RULES[entry.rule].trade, article.releaseSec)) ready.push(entry)
      else {
        fresh.push({ key: entry.key, articleId: article.id, category: entry.category, rule: entry.rule, ticker, releaseSec: article.releaseSec, title: article.title, status: 'waiting', netPct: null, symbol: null, note: null })
      }
    }
    if (ready.length === 0) continue
    for (const row of await scoreCoin(article, ticker, ready)) {
      fresh.push(row)
      if (row.status === 'scored') {
        kept.set(row.key, row)
        added = true
      }
    }
  }
  if (added) {
    await mkdir(join(app.getPath('userData'), 'news'), { recursive: true })
    await writeJsonAtomic(recordPath(), { rows: [...kept.values()] })
  }
  const errors = [binanceError, upbitError].filter((error): error is string => error !== null)
  const readAt = Math.max(binanceListed?.at ?? -1, upbitListed?.at ?? -1)
  return {
    since: NEWS_RECORD_SINCE,
    listedAt: readAt < 0 ? null : Math.floor(readAt / 1000),
    error: errors.length === 0 ? null : errors.join(' '),
    rows: mergeRecordRows(fresh, kept)
  }
}

/** The record as it stands: each list read if it has not been in ten minutes, and every trade that
 * is over and is not yet scored, scored. */
export function getNewsRecord(nowMs: number = Date.now()): Promise<NewsRecord> {
  if (working === null) {
    working = build(nowMs).finally(() => {
      working = null
    })
  }
  return working
}
