import type { ListedArticle } from './news'
import type { RuleScore, RuleTrade } from './newsRules'
import { classifyTitle } from './newsTitles'
import { classifyUpbitTitle } from './upbitTitles'

// What the two rules that passed research/NEWS.md would have made since the study ended: every
// delisting and every coin added to the Monitoring Tag Binance has announced from 1 October 2026,
// each scored as its rule trades it (shared/newsRules.ts) on the coin's own candles, whether or not
// the app's paper short was switched on, or the app was even open.
//
// Beside them, the two trades that came nearest without passing are kept on record the same way:
// a tagged coin held short four hours (research/NEWS.md), and a coin Upbit designates for caution
// held short four hours on its Binance pair (research/UPBIT.md). Both started a slow fall in their
// studies and missed the bar they were held to; the record shows whether that fall goes on.
//
// The main process reads the lists and the candles (electron/services/newsRecordService.ts); this
// is the pure half.
//
// IT IS A RECORD, NOT A SIGNAL. Nothing is opened, sold or asked because of it -- because of a near
// miss least of all. It is there so that whether the edges hold up after the studies can be seen
// before anyone relies on them.

/** The record starts where the studies' held-out halves ended. */
export const NEWS_RECORD_SINCE = Date.parse('2026-10-01T00:00:00Z') / 1000

/** Binance's lists the two kinds are announced in: its delistings, and its news. */
export const NEWS_RECORD_CATALOGS = [161, 49] as const

/** What an announcement is: Binance's delisting or Monitoring Tag, or Upbit's caution. */
export type NewsRecordCategory = 'DELISTING' | 'MONITORING_TAG' | 'UPBIT_CAUTION'

/** The trades kept on record. */
export type NewsRecordRule = 'DELISTING_HOLD' | 'TAG_BRACKET' | 'TAG_HOLD' | 'UPBIT_CAUTION_HOLD'

export interface NewsRecordRuleInfo {
  category: NewsRecordCategory
  trade: RuleTrade
  /** Whether it passed its study's bar. One that did not is a near miss. */
  passed: boolean
  /** The trade, in words. */
  rule: string
  /** What it made on its study's held-out half (January 2025 to September 2026), per coin. */
  study: { meanPct: number; ahead: number; of: number }
}

/** Each trade on record, in the order it is shown, beside what its study's held-out half made:
 * research/NEWS.md's and research/UPBIT.md's tables, per coin. */
export const NEWS_RECORD_RULES: Record<NewsRecordRule, NewsRecordRuleInfo> = {
  DELISTING_HOLD: { category: 'DELISTING', trade: 'hold', passed: true, rule: 'held short four hours', study: { meanPct: 15.51, ahead: 75, of: 87 } },
  TAG_BRACKET: { category: 'MONITORING_TAG', trade: 'bracket', passed: true, rule: 'shorted with a stop and a target', study: { meanPct: 0.6, ahead: 59, of: 103 } },
  TAG_HOLD: { category: 'MONITORING_TAG', trade: 'hold', passed: false, rule: 'held short four hours', study: { meanPct: 6.66, ahead: 82, of: 103 } },
  UPBIT_CAUTION_HOLD: { category: 'UPBIT_CAUTION', trade: 'hold', passed: false, rule: 'held short four hours', study: { meanPct: 3.93, ahead: 18, of: 24 } }
}

export const NEWS_RECORD_RULE_ORDER = Object.keys(NEWS_RECORD_RULES) as NewsRecordRule[]

export const NEWS_RECORD_KIND_LABEL: Record<NewsRecordCategory, string> = {
  DELISTING: 'Delisting',
  MONITORING_TAG: 'Monitoring Tag',
  UPBIT_CAUTION: 'Upbit caution'
}

export interface NewsRecordRow {
  /** One trade on one coin of one announcement: `${articleId}:${ticker}` for the two rules that
   * passed, as the record first kept them; with `:hold` after it for the tag's hold; and
   * `upbit:${id}:${ticker}` for Upbit's caution. */
  key: string
  /** The announcement's id in its own list, Binance's or Upbit's. */
  articleId: number
  category: NewsRecordCategory
  rule: NewsRecordRule
  ticker: string
  releaseSec: number
  title: string
  /** Scored: the trade is over and was worked out. Waiting: it is not over yet. Unscored: its
   * candles could not be read, and `note` says why; it is tried again the next time. */
  status: 'scored' | 'waiting' | 'unscored'
  /** The trade's net, short, in percent after fees and slippage. Null unless scored. */
  netPct: number | null
  /** The pair it was scored on. */
  symbol: string | null
  note: string | null
}

export interface NewsRecord {
  since: number
  /** When the lists were last read for it. Null before they have been. */
  listedAt: number | null
  /** Why a list could not be read, the last time it was tried; null when every one could. */
  error: string | null
  /** Newest release first. */
  rows: NewsRecordRow[]
}

/** One trade on one coin an announcement names. */
export interface NewsRecordEntry {
  key: string
  category: NewsRecordCategory
  rule: NewsRecordRule
  ticker: string
}

/** The trades a Binance article's coins are on record for, when it was released since the record
 * began: a delisting's hold, and a tag's bracket and hold. Sorted by the patterns the study
 * measured with. */
export function recordEntries(article: ListedArticle): NewsRecordEntry[] {
  if (article.releaseSec < NEWS_RECORD_SINCE) return []
  const news = classifyTitle(article.title)
  if (news?.category === 'DELISTING') {
    return news.tickers.map((ticker): NewsRecordEntry => ({ key: `${article.id}:${ticker}`, category: 'DELISTING', rule: 'DELISTING_HOLD', ticker }))
  }
  if (news?.category === 'MONITORING_TAG') {
    return news.tickers.flatMap((ticker): NewsRecordEntry[] => [
      { key: `${article.id}:${ticker}`, category: 'MONITORING_TAG', rule: 'TAG_BRACKET', ticker },
      { key: `${article.id}:${ticker}:hold`, category: 'MONITORING_TAG', rule: 'TAG_HOLD', ticker }
    ])
  }
  return []
}

/** The same for an Upbit notice: the coins it designates for caution, by the patterns the Upbit
 * study measured with (shared/upbitTitles.ts). Its listings and delistings are not on record:
 * neither came near its bar. */
export function upbitRecordEntries(notice: ListedArticle): NewsRecordEntry[] {
  if (notice.releaseSec < NEWS_RECORD_SINCE) return []
  const read = classifyUpbitTitle(notice.title)
  if (read?.category !== 'CAUTION') return []
  return read.tickers.map((ticker): NewsRecordEntry => ({ key: `upbit:${notice.id}:${ticker}`, category: 'UPBIT_CAUTION', rule: 'UPBIT_CAUTION_HOLD', ticker }))
}

/** An Upbit notice as its list gives it. `listedSec` is the time the list dates it by, which moves
 * when a notice is edited; `releaseSec` is when it was first posted. */
export interface UpbitListedNotice extends ListedArticle {
  listedSec: number
}

/** The notices in one answer from Upbit's list of trading notices. A row it cannot read is left
 * out rather than guessed at; an answer with no list in it is an error. */
export function parseUpbitNotices(body: unknown): UpbitListedNotice[] {
  const answer = body as { success?: unknown; data?: { notices?: unknown } } | null
  const notices = answer?.success === true ? answer.data?.notices : undefined
  if (!Array.isArray(notices)) throw new Error('Upbit answered without a notice list')
  const out: UpbitListedNotice[] = []
  for (const notice of notices) {
    if (typeof notice !== 'object' || notice === null) continue
    const row = notice as Record<string, unknown>
    const id = Number(row.id)
    const first = typeof row.first_listed_at === 'string' ? Date.parse(row.first_listed_at) : NaN
    const listed = typeof row.listed_at === 'string' ? Date.parse(row.listed_at) : NaN
    if (!Number.isSafeInteger(id) || id <= 0 || typeof row.title !== 'string' || row.title.trim() === '' || !Number.isFinite(first)) continue
    out.push({
      id,
      title: row.title.replace(/\s+/g, ' ').trim(),
      releaseSec: Math.floor(first / 1000),
      listedSec: Math.floor((Number.isFinite(listed) ? listed : first) / 1000)
    })
  }
  return out
}

/** A row for a trade's score, or for why there is none. */
export function scoredRow(base: Omit<NewsRecordRow, 'status' | 'netPct' | 'symbol' | 'note'>, symbol: string, score: RuleScore): NewsRecordRow {
  return 'netPct' in score
    ? { ...base, status: 'scored', netPct: score.netPct, symbol, note: null }
    : { ...base, status: 'unscored', netPct: null, symbol, note: `Not scored: ${score.skipped}.` }
}

export interface NewsRecordSummary {
  scored: number
  /** Of those, the ones the short made money on, after costs. */
  ahead: number
  /** Per coin, in percent; null with none scored. */
  meanPct: number | null
  worstPct: number | null
  waiting: number
  unscored: number
}

export function summariseNewsRecord(rows: NewsRecordRow[], rule: NewsRecordRule): NewsRecordSummary {
  const own = rows.filter((row) => row.rule === rule)
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

/** The record's rows by key, newest release first and a coin's trades in the order they are shown,
 * with a row kept from before in place of a new one -- a score is worked out once, and a coin's
 * candles may be gone from the exchange since. */
export function mergeRecordRows(fresh: NewsRecordRow[], kept: ReadonlyMap<string, NewsRecordRow>): NewsRecordRow[] {
  const byKey = new Map<string, NewsRecordRow>()
  for (const row of kept.values()) byKey.set(row.key, row)
  for (const row of fresh) if (!(byKey.get(row.key)?.status === 'scored')) byKey.set(row.key, row)
  const order = (row: NewsRecordRow): number => NEWS_RECORD_RULE_ORDER.indexOf(row.rule)
  return [...byKey.values()].sort(
    (a, b) => b.releaseSec - a.releaseSec || b.articleId - a.articleId || a.ticker.localeCompare(b.ticker) || order(a) - order(b)
  )
}

/** A stored row, read as one: a file written by this app, healed rather than obeyed. Only scores
 * are stored. A row kept before the near misses were has no rule; it is its kind's rule that
 * passed. */
export function healNewsRecordRow(value: unknown): NewsRecordRow | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
  const row = value as Record<string, unknown>
  const category = row.category
  if (category !== 'DELISTING' && category !== 'MONITORING_TAG' && category !== 'UPBIT_CAUTION') return null
  const rule = row.rule ?? (category === 'DELISTING' ? 'DELISTING_HOLD' : category === 'MONITORING_TAG' ? 'TAG_BRACKET' : null)
  const known = NEWS_RECORD_RULE_ORDER.find((name) => name === rule)
  if (known === undefined || NEWS_RECORD_RULES[known].category !== category) return null
  if (
    typeof row.key !== 'string' ||
    typeof row.articleId !== 'number' ||
    typeof row.ticker !== 'string' ||
    typeof row.releaseSec !== 'number' ||
    typeof row.title !== 'string' ||
    row.status !== 'scored' ||
    typeof row.netPct !== 'number' ||
    !Number.isFinite(row.netPct) ||
    !(row.symbol === null || typeof row.symbol === 'string')
  ) {
    return null
  }
  return {
    key: row.key,
    articleId: row.articleId,
    category,
    rule: known,
    ticker: row.ticker,
    releaseSec: row.releaseSec,
    title: row.title,
    status: 'scored',
    netPct: row.netPct,
    symbol: row.symbol,
    note: null
  }
}
