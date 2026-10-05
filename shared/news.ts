import { classifyTitle, type NewsCategory } from './newsTitles'

// Binance's own announcements, as the app reads them: its two public lists, once a minute while the
// reader is on, sorted by the patterns research/news.ts measured with (shared/newsTitles.ts). The
// types and the pure half of the reader (electron/services/newsService.ts): what an answer from
// the list holds, what is kept of each article, and what the page says about each kind.
//
// THE READER ONLY READS. research/NEWS.md found that a delisting, held short for four hours, paid on
// the held-out half, and on 2026-10-05 the user chose what one does: a notice to someone holding the
// coin, and a PAPER short by the rule (shared/newsActions.ts, done in src/news/), each switched on
// here. Nothing real is placed or sold because of an announcement.

export type { NewsCategory }

/** Binance's two lists: delistings, and new listings (which is where futures launches go too). */
export const NEWS_CATALOGS = [161, 48] as const
export type NewsCatalog = (typeof NEWS_CATALOGS)[number]

/** Articles asked for from each list a read: more than are ever released in a minute, and enough
 * for the page to have something to show the first time the reader is switched on. */
export const NEWS_PAGE_SIZE = 20

/** How long after a minute begins the lists are read. Binance releases announcements on the
 * minute, so a read a few seconds in finds one within seconds of its release. */
export const NEWS_READ_OFFSET_MS = 3_000

/** Milliseconds from `nowMs` to the next read: the next time a minute is a few seconds in, which
 * is this minute's if that has not come yet. */
export function nextNewsReadDelayMs(nowMs: number): number {
  const into = ((nowMs % 60_000) + 60_000) % 60_000
  return into < NEWS_READ_OFFSET_MS ? NEWS_READ_OFFSET_MS - into : 60_000 - into + NEWS_READ_OFFSET_MS
}

export function newsListUrl(catalog: NewsCatalog): string {
  return `https://www.binance.com/bapi/composite/v1/public/cms/article/list/query?type=1&catalogId=${catalog}&pageNo=1&pageSize=${NEWS_PAGE_SIZE}`
}

export interface NewsItem {
  /** Binance's article id. One article is kept once. */
  id: number
  catalog: NewsCatalog
  title: string
  /** When Binance released it, Unix seconds. */
  releaseSec: number
  /** When this app first read it. Articles read the first time the reader is switched on can be
   * weeks old; one read after that is a minute or so old at most. */
  seenAt: number
  /** Null for a title that is none of the three kinds. */
  category: NewsCategory | null
  tickers: string[]
}

/** What one of the rule's paper shorts stakes: the same choices as the watch's paper trades. */
export const NEWS_SHORT_STAKES = [25, 50, 100, 250, 500, 1000] as const
export const NEWS_SHORT_DEFAULT_STAKE = 100

export function isNewsShortStake(value: unknown): value is number {
  return (NEWS_SHORT_STAKES as readonly unknown[]).includes(value)
}

export interface NewsConfig {
  /** The reader itself. Nothing below happens while it is off. */
  enabled: boolean
  /** A desktop notice when Binance will delist a coin held, on Binance or on paper. */
  notifyHeld: boolean
  /** A paper short on each coin Binance will delist, by the rule research/NEWS.md measured. */
  paperShort: { enabled: boolean; stakeQuote: number }
}

export interface NewsConfigPatch {
  enabled?: boolean
  notifyHeld?: boolean
  paperShort?: { enabled?: boolean; stakeQuote?: number }
}

export const DEFAULT_NEWS_CONFIG: NewsConfig = { enabled: false, notifyHeld: true, paperShort: { enabled: false, stakeQuote: NEWS_SHORT_DEFAULT_STAKE } }

/** A config read from a file, healed rather than obeyed: only `true` switches anything on, and only
 * a stake it offers is a stake. */
export function healNewsConfig(raw: unknown): NewsConfig {
  const value = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>
  const short = (typeof value.paperShort === 'object' && value.paperShort !== null ? value.paperShort : {}) as Record<string, unknown>
  return {
    enabled: value.enabled === true,
    notifyHeld: value.notifyHeld !== false,
    paperShort: { enabled: short.enabled === true, stakeQuote: isNewsShortStake(short.stakeQuote) ? short.stakeQuote : NEWS_SHORT_DEFAULT_STAKE }
  }
}

/** A patch applied to a config, or why it cannot be. */
export function applyNewsConfigPatch(current: NewsConfig, patch: NewsConfigPatch): NewsConfig | string {
  const next: NewsConfig = { ...current, paperShort: { ...current.paperShort } }
  if (patch.enabled !== undefined) {
    if (typeof patch.enabled !== 'boolean') return 'The news reader is either on or off'
    next.enabled = patch.enabled
  }
  if (patch.notifyHeld !== undefined) {
    if (typeof patch.notifyHeld !== 'boolean') return 'The notice to holders is either on or off'
    next.notifyHeld = patch.notifyHeld
  }
  if (patch.paperShort !== undefined) {
    if (typeof patch.paperShort !== 'object' || patch.paperShort === null) return 'Not a setting for the paper short'
    if (patch.paperShort.enabled !== undefined) {
      if (typeof patch.paperShort.enabled !== 'boolean') return 'The paper short is either on or off'
      next.paperShort.enabled = patch.paperShort.enabled
    }
    if (patch.paperShort.stakeQuote !== undefined) {
      if (!isNewsShortStake(patch.paperShort.stakeQuote)) return `A paper short stakes ${NEWS_SHORT_STAKES.join(', ')}`
      next.paperShort.stakeQuote = patch.paperShort.stakeQuote
    }
  }
  return next
}

export interface NewsState {
  config: NewsConfig
  lastReadAt: number | null
  nextReadAt: number | null
  error: string | null
  /** Newest release first. */
  recent: NewsItem[]
}

export interface NewsFilter {
  /** Newest release first, at most this many. */
  limit?: number
  /** Only articles released at or after this time. */
  sinceSec?: number
  category?: NewsCategory
}

export interface NewsPage {
  rows: NewsItem[]
  skippedLines: number
}

export interface ListedArticle {
  id: number
  title: string
  releaseSec: number
}

/** The articles in one answer from a list. A row it cannot read is left out rather than guessed
 * at; an answer with no list in it at all is an error, since that is how a change of format, or a
 * page of something else in its place, would show. */
export function parseArticleList(body: unknown): ListedArticle[] {
  const catalogs = (body as { data?: { catalogs?: unknown } } | null)?.data?.catalogs
  const articles = Array.isArray(catalogs) && catalogs.length > 0 ? (catalogs[0] as { articles?: unknown }).articles : undefined
  if (!Array.isArray(articles)) throw new Error('Binance answered without an announcement list')
  const out: ListedArticle[] = []
  for (const article of articles) {
    if (typeof article !== 'object' || article === null) continue
    const row = article as Record<string, unknown>
    const id = Number(row.id)
    const release = Number(row.releaseDate)
    if (!Number.isSafeInteger(id) || id <= 0 || typeof row.title !== 'string' || row.title.trim() === '' || !Number.isFinite(release) || release <= 0) continue
    out.push({ id, title: row.title.replace(/\s+/g, ' ').trim(), releaseSec: Math.floor(release / 1000) })
  }
  return out
}

export function toNewsItem(article: ListedArticle, catalog: NewsCatalog, seenAt: number): NewsItem {
  const news = classifyTitle(article.title)
  return {
    id: article.id,
    catalog,
    title: article.title,
    releaseSec: article.releaseSec,
    seenAt,
    category: news?.category ?? null,
    tickers: news?.tickers ?? []
  }
}

/** `2026-10`, the UTC month an article is filed under, by its release. */
export function newsMonthKey(unixSeconds: number): string {
  return new Date(unixSeconds * 1000).toISOString().slice(0, 7)
}

const CATEGORIES: readonly (string | null)[] = ['DELISTING', 'FUTURES_LAUNCH', 'SPOT_LISTING', null]

export function isNewsItem(value: unknown): value is NewsItem {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const row = value as Record<string, unknown>
  return (
    typeof row.id === 'number' &&
    (row.catalog === 161 || row.catalog === 48) &&
    typeof row.title === 'string' &&
    typeof row.releaseSec === 'number' &&
    typeof row.seenAt === 'number' &&
    CATEGORIES.includes(row.category as string | null) &&
    Array.isArray(row.tickers) &&
    row.tickers.every((ticker) => typeof ticker === 'string')
  )
}

/** A news file's text, in file order. A line that does not read is counted and skipped, as the
 * other stores of lines do. */
export function parseNewsLines(text: string): { rows: NewsItem[]; skipped: number } {
  const rows: NewsItem[] = []
  let skipped = 0
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue
    try {
      const parsed: unknown = JSON.parse(line)
      if (isNewsItem(parsed)) rows.push(parsed)
      else skipped++
    } catch {
      skipped++
    }
  }
  return { rows, skipped }
}

export function matchesNewsFilter(item: NewsItem, filter: NewsFilter): boolean {
  if (filter.sinceSec !== undefined && item.releaseSec < filter.sinceSec) return false
  if (filter.category !== undefined && item.category !== filter.category) return false
  return true
}

/** Newest release first; the same minute in Binance's own order, by id. */
export function byNewestRelease(a: NewsItem, b: NewsItem): number {
  return b.releaseSec - a.releaseSec || b.id - a.id
}

const CATEGORY_LABEL: Record<NewsCategory, string> = {
  DELISTING: 'Delisting',
  FUTURES_LAUNCH: 'Futures launch',
  SPOT_LISTING: 'Spot listing'
}

export function describeNewsCategory(category: NewsCategory): string {
  return CATEGORY_LABEL[category]
}

/** What research/NEWS.md found each kind did on its held-out half, January 2025 to September 2026.
 * What the price did, measured from the first minute an app reading once a minute could act; not
 * advice, and nothing in the app acts on it. */
export const NEWS_FINDINGS: Record<NewsCategory, string> = {
  DELISTING:
    'Four hours after the first minute an app like this could act, the coin was on average 13% lower: 75 of 87 coins were lower, and two rose 73% and 84% instead.',
  FUTURES_LAUNCH: "The coin's spot price jumped 12% on average, nearly all of it before an app reading once a minute could act. After that, it did nothing that paid.",
  SPOT_LISTING:
    'A coin that already had a perpetual jumped 16.5% on average, nearly all of it before an app reading once a minute could act. After that, it did nothing that paid.'
}
