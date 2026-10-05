import { app } from 'electron'
import { mkdir, readFile } from 'fs/promises'
import { join } from 'path'
import { EVENT_LOOKBACK_BARS } from '../../shared/marketEvent'
import { parseArticleList, type ListedArticle } from '../../shared/news'
import {
  NEWS_RECORD_CATALOGS,
  NEWS_RECORD_SINCE,
  isNewsRecordRow,
  mergeRecordRows,
  recordEntries,
  scoredRow,
  type NewsRecord,
  type NewsRecordRow
} from '../../shared/newsRecord'
import { HOLD_EXIT_BARS, fillMinutes, ruleReadyAt, scoreDelistingRule, scoreTagRule, spotSymbolCandidates } from '../../shared/newsRules'
import { writeJsonAtomic } from './atomicWrite'
import { fetchHistoricalRange } from './marketService'

// The record of what the two news rules would have made since the study ended (shared/newsRecord.ts):
// Binance's delisting and news lists read back to 1 October 2026, and each delisting and each coin
// added to the Monitoring Tag scored on its own 1-minute candles, by the study's own arithmetic.
//
// IT READS PUBLIC DATA AND NOTHING ELSE: the announcement lists and the candles, with no key, no
// model and no order. It reads only when it is asked -- Discovery's card asks when it is shown --
// and reads the lists at most once in ten minutes. It is independent of the news reader's switch:
// the record is of what Binance announced, not of what this app happened to read.
//
// A SCORE IS KEPT ONCE IT IS MADE, in news/record.json: a coin Binance has delisted soon has no
// candles to read again. A coin that could not be scored is tried again the next time.

const LIST_PAGE_SIZE = 50
/** Enough pages of each list to reach back months; a list is read only until it passes the start. */
const LIST_PAGES_MOST = 10
const LIST_FRESH_MS = 10 * 60_000
const READ_TIMEOUT_MS = 15_000

let listed: { at: number; articles: ListedArticle[] } | null = null
let lastError: string | null = null
/** The one build under way, which everyone who asks meanwhile waits for. */
let working: Promise<NewsRecord> | null = null

function recordPath(): string {
  return join(app.getPath('userData'), 'news', 'record.json')
}

export function recordListUrl(catalog: number, pageNo: number): string {
  return `https://www.binance.com/bapi/composite/v1/public/cms/article/list/query?type=1&catalogId=${catalog}&pageNo=${pageNo}&pageSize=${LIST_PAGE_SIZE}`
}

async function fetchList(url: string): Promise<unknown> {
  const response = await fetch(url, { headers: { 'User-Agent': 'TraderSpider', Accept: 'application/json' }, signal: AbortSignal.timeout(READ_TIMEOUT_MS) })
  if (!response.ok) throw new Error(`Binance's announcement list answered ${response.status}`)
  return response.json()
}

/** Every article of the two lists released since the record began, each once. */
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

async function loadKept(): Promise<Map<string, NewsRecordRow>> {
  const kept = new Map<string, NewsRecordRow>()
  try {
    const raw = JSON.parse(await readFile(recordPath(), 'utf-8')) as { rows?: unknown }
    for (const row of Array.isArray(raw.rows) ? raw.rows : []) if (isNewsRecordRow(row)) kept.set(row.key, row)
  } catch {
    // No record yet, or one that does not read: it is built again from the lists.
  }
  return kept
}

/** One coin of one announcement, scored on its spot USDT pair, or said why not. */
async function score(base: Omit<NewsRecordRow, 'status' | 'netPct' | 'symbol' | 'note'>): Promise<NewsRecordRow> {
  const minute = Math.floor(base.releaseSec / 60) * 60
  // Twelve hours and a half before -- the tag's stop and target are read from the twelve before
  // the announcement -- to four hours and a few minutes after: everything either rule reads.
  const startSec = minute - (EVENT_LOOKBACK_BARS + 30) * 60
  const endSec = minute + (HOLD_EXIT_BARS + 5) * 60
  let problem = 'it has no USDT spot pair'
  for (const symbol of spotSymbolCandidates(base.ticker)) {
    try {
      const { candles } = await fetchHistoricalRange('binance', symbol, '1m', startSec, endSec, `news-record:${base.key}:${symbol}`, () => undefined)
      if (candles.length === 0) {
        problem = `${symbol} has no candles around it`
        continue
      }
      const { bars } = fillMinutes(candles, minute)
      return scoredRow(base, symbol, base.category === 'DELISTING' ? scoreDelistingRule(bars, base.releaseSec) : scoreTagRule(bars, base.releaseSec))
    } catch (failure) {
      problem = `the candles of ${symbol} could not be read (${failure instanceof Error ? failure.message : String(failure)})`
    }
  }
  return { ...base, status: 'unscored', netPct: null, symbol: null, note: `Not scored: ${problem}.` }
}

async function build(nowMs: number): Promise<NewsRecord> {
  const nowSec = Math.floor(nowMs / 1000)
  const kept = await loadKept()
  if (listed === null || nowMs - listed.at >= LIST_FRESH_MS) {
    try {
      listed = { at: nowMs, articles: await readLists() }
      lastError = null
    } catch (failure) {
      lastError = `Binance's announcement lists could not be read: ${failure instanceof Error ? failure.message : String(failure)}`
    }
  }
  const fresh: NewsRecordRow[] = []
  let added = false
  for (const article of listed?.articles ?? []) {
    for (const entry of recordEntries(article)) {
      if (kept.has(entry.key)) continue
      const base = { key: entry.key, articleId: article.id, category: entry.category, ticker: entry.ticker, releaseSec: article.releaseSec, title: article.title }
      if (nowSec < ruleReadyAt(entry.category, article.releaseSec)) {
        fresh.push({ ...base, status: 'waiting', netPct: null, symbol: null, note: null })
        continue
      }
      const row = await score(base)
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
  return { since: NEWS_RECORD_SINCE, listedAt: listed === null ? null : Math.floor(listed.at / 1000), error: lastError, rows: mergeRecordRows(fresh, kept) }
}

/** The record as it stands: the lists read if they have not been in ten minutes, and every coin
 * whose rule's trade is over and is not yet scored, scored. */
export function getNewsRecord(nowMs: number = Date.now()): Promise<NewsRecord> {
  if (working === null) {
    working = build(nowMs).finally(() => {
      working = null
    })
  }
  return working
}
