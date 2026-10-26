import { classifyTitle, type NewsCategory } from './newsTitles'

// Binance's own announcements, as the app reads them: its three public lists, once a minute while
// the reader is on, sorted by the patterns research/news.ts measured with (shared/newsTitles.ts).
// The types and the pure half of the reader (electron/services/newsService.ts): what an answer from
// the list holds, what is kept of each article, and what the page says about each kind.
//
// THE READER ONLY READS. research/NEWS.md found that two kinds paid on the held-out half -- a
// delisting held short four hours, and a short with a stop and a target after Binance adds a coin
// to its Monitoring Tag -- and on 2026-10-05 the user chose what each does: a notice to someone
// holding the coin, a PAPER short by the kind's rule (shared/newsActions.ts, done in src/news/),
// and a question to the watch's models, each switched on here, kind by kind. Nothing real is placed
// or sold because of an announcement.

export type { NewsCategory }

/** Binance's three lists: delistings, new listings (which is where futures launches go too), and
 * its news, where coins are added to the Monitoring Tag. */
export const NEWS_CATALOGS = [161, 48, 49] as const
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
  /** Null for a title that is none of the four kinds. */
  category: NewsCategory | null
  tickers: string[]
}

/** What one of the rule's paper shorts stakes: the same choices as the watch's paper trades. */
export const NEWS_SHORT_STAKES = [25, 50, 100, 250, 500, 1000] as const
export const NEWS_SHORT_DEFAULT_STAKE = 100

export function isNewsShortStake(value: unknown): value is number {
  return (NEWS_SHORT_STAKES as readonly unknown[]).includes(value)
}

/** What one kind of news does, each part as it is switched on. */
export interface NewsKindActions {
  /** A desktop notice when Binance announces it of a coin held, on Binance or on paper. */
  notifyHeld: boolean
  /** A paper short on each coin it names, by the kind's rule research/NEWS.md measured. */
  paperShort: { enabled: boolean; stakeQuote: number }
  /** Each coin it names raised as an event, which the watch puts to its models when the watch is
   * on -- within the watch's own limits and the day's AI budget. */
  askModels: boolean
}

/** The kinds that do anything: the two that passed on the held-out half (research/NEWS.md). */
export type ActedNewsCategory = 'DELISTING' | 'MONITORING_TAG'

export function isActedNewsCategory(category: NewsCategory | null): category is ActedNewsCategory {
  return category === 'DELISTING' || category === 'MONITORING_TAG'
}

export interface NewsConfig {
  /** The reader itself. Nothing below happens while it is off. */
  enabled: boolean
  /** What a delisting does. */
  delisting: NewsKindActions
  /** What Binance adding a coin to its Monitoring Tag does. */
  monitoringTag: NewsKindActions
}

export interface NewsKindActionsPatch {
  notifyHeld?: boolean
  paperShort?: { enabled?: boolean; stakeQuote?: number }
  askModels?: boolean
}

export interface NewsConfigPatch {
  enabled?: boolean
  delisting?: NewsKindActionsPatch
  monitoringTag?: NewsKindActionsPatch
}

/** What a kind does by default once the reader is on: the notice and the models, not the short. */
const DEFAULT_KIND_ACTIONS: NewsKindActions = { notifyHeld: true, paperShort: { enabled: false, stakeQuote: NEWS_SHORT_DEFAULT_STAKE }, askModels: true }

export const DEFAULT_NEWS_CONFIG: NewsConfig = {
  enabled: false,
  delisting: { ...DEFAULT_KIND_ACTIONS, paperShort: { ...DEFAULT_KIND_ACTIONS.paperShort } },
  monitoringTag: { ...DEFAULT_KIND_ACTIONS, paperShort: { ...DEFAULT_KIND_ACTIONS.paperShort } }
}

/** What one kind does, as the config says; null for a kind that does nothing. */
export function newsActionsFor(config: NewsConfig, category: NewsCategory | null): NewsKindActions | null {
  return category === 'DELISTING' ? config.delisting : category === 'MONITORING_TAG' ? config.monitoringTag : null
}

/** A copy that shares nothing with the one it was made from. */
export function copyNewsConfig(config: NewsConfig): NewsConfig {
  const kind = (actions: NewsKindActions): NewsKindActions => ({ ...actions, paperShort: { ...actions.paperShort } })
  return { enabled: config.enabled, delisting: kind(config.delisting), monitoringTag: kind(config.monitoringTag) }
}

function healKindActions(raw: unknown): NewsKindActions {
  const value = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>
  const short = (typeof value.paperShort === 'object' && value.paperShort !== null ? value.paperShort : {}) as Record<string, unknown>
  return {
    notifyHeld: value.notifyHeld !== false,
    paperShort: { enabled: short.enabled === true, stakeQuote: isNewsShortStake(short.stakeQuote) ? short.stakeQuote : NEWS_SHORT_DEFAULT_STAKE },
    askModels: value.askModels !== false
  }
}

/** A config read from a file, healed rather than obeyed: only `true` switches anything on, and only
 * a stake it offers is a stake. A file written before the Monitoring Tag was read held a
 * delisting's switches at its top level; they are read as the delisting's. */
export function healNewsConfig(raw: unknown): NewsConfig {
  const value = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>
  const delisting = typeof value.delisting === 'object' && value.delisting !== null ? value.delisting : { notifyHeld: value.notifyHeld, paperShort: value.paperShort, askModels: value.askModels }
  return { enabled: value.enabled === true, delisting: healKindActions(delisting), monitoringTag: healKindActions(value.monitoringTag) }
}

function applyKindPatch(actions: NewsKindActions, patch: NewsKindActionsPatch): string | null {
  if (typeof patch !== 'object' || patch === null) return 'Not a setting for what an announcement does'
  if (patch.notifyHeld !== undefined) {
    if (typeof patch.notifyHeld !== 'boolean') return 'The notice to holders is either on or off'
    actions.notifyHeld = patch.notifyHeld
  }
  if (patch.askModels !== undefined) {
    if (typeof patch.askModels !== 'boolean') return 'Putting it to the models is either on or off'
    actions.askModels = patch.askModels
  }
  if (patch.paperShort !== undefined) {
    if (typeof patch.paperShort !== 'object' || patch.paperShort === null) return 'Not a setting for the paper short'
    if (patch.paperShort.enabled !== undefined) {
      if (typeof patch.paperShort.enabled !== 'boolean') return 'The paper short is either on or off'
      actions.paperShort.enabled = patch.paperShort.enabled
    }
    if (patch.paperShort.stakeQuote !== undefined) {
      if (!isNewsShortStake(patch.paperShort.stakeQuote)) return `A paper short stakes ${NEWS_SHORT_STAKES.join(', ')}`
      actions.paperShort.stakeQuote = patch.paperShort.stakeQuote
    }
  }
  return null
}

/** A patch applied to a config, or why it cannot be. */
export function applyNewsConfigPatch(current: NewsConfig, patch: NewsConfigPatch): NewsConfig | string {
  const next = copyNewsConfig(current)
  if (patch.enabled !== undefined) {
    if (typeof patch.enabled !== 'boolean') return 'The news reader is either on or off'
    next.enabled = patch.enabled
  }
  if (patch.delisting !== undefined) {
    const problem = applyKindPatch(next.delisting, patch.delisting)
    if (problem !== null) return problem
  }
  if (patch.monitoringTag !== undefined) {
    const problem = applyKindPatch(next.monitoringTag, patch.monitoringTag)
    if (problem !== null) return problem
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
  /** The code its page's link ends in, where the list gives one (V8 Stage 4: a pasted Binance link is checked by it). */
  code?: string
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
    const code = typeof row.code === 'string' && /^[A-Za-z0-9-]{4,200}$/.test(row.code) ? row.code : undefined
    out.push({ id, title: row.title.replace(/\s+/g, ' ').trim(), releaseSec: Math.floor(release / 1000), ...(code === undefined ? {} : { code }) })
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

const CATEGORIES: readonly (string | null)[] = ['DELISTING', 'FUTURES_LAUNCH', 'SPOT_LISTING', 'MONITORING_TAG', null]

export function isNewsItem(value: unknown): value is NewsItem {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const row = value as Record<string, unknown>
  return (
    typeof row.id === 'number' &&
    (NEWS_CATALOGS as readonly unknown[]).includes(row.catalog) &&
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
  SPOT_LISTING: 'Spot listing',
  MONITORING_TAG: 'Monitoring Tag'
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
    'A coin that already had a perpetual jumped 16.5% on average, nearly all of it before an app reading once a minute could act. After that, it did nothing that paid.',
  MONITORING_TAG:
    'The coin fell about 5% before an app like this could act, and 12% within the day. From the first minute it could act, a short with a stop and a target made 0.35% a trade after costs: a small edge. 84 of 97 tagged coins were later delisted.'
}
