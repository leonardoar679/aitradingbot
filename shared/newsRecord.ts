import type { ListedArticle } from './news'
import type { RuleScore } from './newsRules'
import { classifyTitle } from './newsTitles'

// What the two rules that passed research/NEWS.md would have made since the study ended: every
// delisting and every coin added to the Monitoring Tag Binance has announced from 1 October 2026,
// each scored as its rule trades it (shared/newsRules.ts) on the coin's own candles, whether or
// not the app's paper short was switched on, or the app was even open. The main process reads
// Binance's lists and the candles (electron/services/newsRecordService.ts); this is the pure half.
//
// IT IS A RECORD, NOT A SIGNAL. Nothing is opened, sold or asked because of it. It is there so
// that whether the two edges hold up after the study can be seen before anyone relies on them.

/** The record starts where the study's held-out half ended. */
export const NEWS_RECORD_SINCE = Date.parse('2026-10-01T00:00:00Z') / 1000

/** The lists the two kinds are announced in: Binance's delistings, and its news. */
export const NEWS_RECORD_CATALOGS = [161, 49] as const

export type NewsRecordCategory = 'DELISTING' | 'MONITORING_TAG'

export interface NewsRecordRow {
  /** One coin of one announcement: `${articleId}:${ticker}`. */
  key: string
  articleId: number
  category: NewsRecordCategory
  ticker: string
  releaseSec: number
  title: string
  /** Scored: the rule's trade is over and was worked out. Waiting: it is not over yet. Unscored:
   * its candles could not be read, and `note` says why; it is tried again the next time. */
  status: 'scored' | 'waiting' | 'unscored'
  /** The rule's net, short, in percent after fees and slippage. Null unless scored. */
  netPct: number | null
  /** The pair it was scored on. */
  symbol: string | null
  note: string | null
}

export interface NewsRecord {
  since: number
  /** When Binance's lists were last read for it. Null before they have been. */
  listedAt: number | null
  /** Why the lists could not be read, the last time they were tried; null when they could. */
  error: string | null
  /** Newest release first. */
  rows: NewsRecordRow[]
}

/** The coins of the two kinds an article names, one entry each, when it was released since the
 * record began. Sorted by the patterns the study measured with. */
export function recordEntries(article: ListedArticle): { key: string; category: NewsRecordCategory; ticker: string }[] {
  if (article.releaseSec < NEWS_RECORD_SINCE) return []
  const news = classifyTitle(article.title)
  if (news === null || (news.category !== 'DELISTING' && news.category !== 'MONITORING_TAG')) return []
  const category = news.category
  return news.tickers.map((ticker) => ({ key: `${article.id}:${ticker}`, category, ticker }))
}

/** A row for a rule's score, or for why there is none. */
export function scoredRow(base: Omit<NewsRecordRow, 'status' | 'netPct' | 'symbol' | 'note'>, symbol: string, score: RuleScore): NewsRecordRow {
  return 'netPct' in score
    ? { ...base, status: 'scored', netPct: score.netPct, symbol, note: null }
    : { ...base, status: 'unscored', netPct: null, symbol, note: `Not scored: ${score.skipped}.` }
}

export interface NewsRecordSummary {
  scored: number
  /** Of those, the ones the rule's short made money on, after costs. */
  ahead: number
  /** Per coin, in percent; null with none scored. */
  meanPct: number | null
  worstPct: number | null
  waiting: number
  unscored: number
}

export function summariseNewsRecord(rows: NewsRecordRow[], category: NewsRecordCategory): NewsRecordSummary {
  const own = rows.filter((row) => row.category === category)
  const scored = own.filter((row) => row.status === 'scored' && row.netPct !== null).map((row) => row.netPct as number)
  return {
    scored: scored.length,
    ahead: scored.filter((net) => net > 0).length,
    meanPct: scored.length === 0 ? null : scored.reduce((sum, net) => sum + net, 0) / scored.length,
    worstPct: scored.length === 0 ? null : Math.min(...scored),
    waiting: own.filter((row) => row.status === 'waiting').length,
    unscored: own.filter((row) => row.status === 'unscored').length
  }
}

/** What each rule did on the study's held-out half (January 2025 to September 2026), per coin, to
 * set the record beside: research/NEWS.md, research/.news-study-heldout.out. */
export const NEWS_RULE_STUDY: Record<NewsRecordCategory, { rule: string; meanPct: number; ahead: number; of: number }> = {
  DELISTING: { rule: 'held short four hours', meanPct: 15.51, ahead: 75, of: 87 },
  MONITORING_TAG: { rule: 'shorted with a stop and a target', meanPct: 0.6, ahead: 59, of: 103 }
}

/** The record's rows by key, newest release first, with a row kept from before in place of a new
 * one -- a score is worked out once, and a coin's candles may be gone from the exchange since. */
export function mergeRecordRows(fresh: NewsRecordRow[], kept: ReadonlyMap<string, NewsRecordRow>): NewsRecordRow[] {
  const byKey = new Map<string, NewsRecordRow>()
  for (const row of kept.values()) byKey.set(row.key, row)
  for (const row of fresh) if (!(byKey.get(row.key)?.status === 'scored')) byKey.set(row.key, row)
  return [...byKey.values()].sort((a, b) => b.releaseSec - a.releaseSec || b.articleId - a.articleId || a.ticker.localeCompare(b.ticker))
}

/** Whether a stored row reads as one: a file written by this app, healed rather than obeyed. */
export function isNewsRecordRow(value: unknown): value is NewsRecordRow {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const row = value as Record<string, unknown>
  return (
    typeof row.key === 'string' &&
    typeof row.articleId === 'number' &&
    (row.category === 'DELISTING' || row.category === 'MONITORING_TAG') &&
    typeof row.ticker === 'string' &&
    typeof row.releaseSec === 'number' &&
    typeof row.title === 'string' &&
    row.status === 'scored' &&
    typeof row.netPct === 'number' &&
    Number.isFinite(row.netPct) &&
    (row.symbol === null || typeof row.symbol === 'string')
  )
}
