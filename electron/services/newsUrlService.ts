import { app } from 'electron'
import { createHash } from 'crypto'
import { readFile } from 'fs/promises'
import { join } from 'path'
import type { ExtractedArticle } from '../../shared/articleExtract'
import { binanceAnnouncementCodeOf, credibilityOf } from '../../shared/articleCredibility'
import { publicationTimeOf, xPostOf } from '../../shared/articleTime'
import type { Candle, Exchange, SymbolInfo } from '../../shared/ipc'
import { NEWS_CATALOGS, newsListUrl, parseArticleList, type ListedArticle } from '../../shared/news'
import { COIN_NAMES, assetDictionary, eventTypeOf, storyAssets, titleSimilarity, SAME_STORY_SIMILARITY, SAME_STORY_SECONDS, type ReadStory } from '../../shared/newsFeed'
import { classifyTitle } from '../../shared/newsTitles'
import { NEWS_URL_LINES, URL_RECORD_VERSION, archiveNote, archiveStampSec, closeBefore, foldUrlRecords, reactionOf, urlRecordId, type Retrieval, type TrailEntry, type UrlCoin, type UrlLookups, type UrlReaction, type UrlRecord, type UrlRejectedCoin } from '../../shared/newsUrl'
import { sanitizeUrl } from '../../shared/urlSafety'
import { appendJsonLine, listMonthFiles } from './jsonlStore'
import { fetchHistoricalRange, fetchTicker24h, listSymbols } from './marketService'
import { getNewsFeedState } from './newsFeedService'
import { getSettings } from './settingsService'
import { notePastedCoins, notePastedDelisting, primaryCallState } from './primaryCallService'
import { runInWorker } from './taskWorkerService'
import { fetchPage } from './urlFetchService'

// NEWS URLS (V8 Stage 4, 26 October 2026; shared/newsUrl.ts). A link a person pastes is cut down and read safely
// (urlFetchService.ts); its page is read as text in a worker (shared/articleExtract.ts); where the page cannot be read
// its text is had from the news feed's own copy, then from Binance's list, then from what the person supplied, and the
// record says which. Its publication time is read with care (shared/articleTime.ts) -- a Binance announcement's from
// Binance's own list, which also verifies it; its source is classed by host (shared/articleCredibility.ts); its coins
// are read from its title (direct) and its body (indirect) against Binance's and Bitget's USDT pairs, those under a
// day's floor of volume refused; each coin's price is read on its one-minute bars from a day before publication to
// four hours after, and read again until that span has passed; and the verdict is the primary call's -- a pasted
// Binance delisting within its rule's window is weighed as the reader's would be -- or none, with why. Everything is
// measured from the paste and kept in news/urls-YYYY-MM.jsonl, one line a change. Public data only: no key, no model,
// no order. A model's reading of the article is a click of its own (V8 Stage 5): asked by aiArticleService.ts, which reads
// a record here and notes its reading on it; this file imports nothing of it.

/** What the service reads the world through: a test hands in its own. */
export const newsUrlSeam = {
  dir: (): string => join(app.getPath('userData'), 'news'),
  now: (): number => Math.floor(Date.now() / 1000),
  fetch: fetchPage,
  extract: async (html: string): Promise<ExtractedArticle> => {
    const outcome = await runInWorker('extractArticle', html, { timeoutMs: NEWS_URL_LINES.extractTimeoutMs })
    if (!outcome.ok) throw new Error(outcome.reason === 'timeout' ? 'the page took too long to read' : outcome.reason === 'memory' ? 'the page was too large to read' : outcome.message)
    return outcome.result as ExtractedArticle
  },
  symbols: (venue: 'binance' | 'bitget'): Promise<SymbolInfo[]> => listSymbols(venue),
  dayQuote: async (venue: 'binance' | 'bitget', pair: string): Promise<number> => (await fetchTicker24h(venue as Exchange, pair)).quoteVolume,
  /** Binance's lists of announcements, the first page of each catalog: what verifies a pasted Binance link. */
  announcements: async (): Promise<ListedArticle[]> => {
    const out: ListedArticle[] = []
    for (const catalog of NEWS_CATALOGS) {
      const response = await fetch(newsListUrl(catalog), { signal: AbortSignal.timeout(15_000) })
      if (!response.ok) throw new Error(`Binance's list answered ${response.status}`)
      out.push(...parseArticleList(await response.json()))
    }
    return out
  },
  feed: (): ReadStory[] => getNewsFeedState().stories,
  bars: async (venue: 'binance' | 'bitget', pair: string, fromSec: number, toSec: number): Promise<Candle[]> =>
    (await fetchHistoricalRange(venue as Exchange, pair, '1m', fromSec, toSec, `url:${pair}:${fromSec}`, () => undefined)).candles,
  cardsFor: (pairs: readonly string[]): string[] => primaryCallState().cards.filter((card) => pairs.includes(card.pair)).map((card) => card.predictionId),
  pastedDelisting: notePastedDelisting,
  pastedCoins: notePastedCoins,
  /** "Analyze discovered news automatically": off unless a person switched it on. */
  autoAnalyze: async (): Promise<boolean> => (await getSettings()).newsUrls?.autoAnalyze === true,
  /** Whether the lookups follow a paste of themselves (a test runs them by hand). */
  lookUpAfterPaste: true,
  /** Whether a pasted link is put to the Internet Archive: on unless a person switched it off (V8 Stage 5). */
  archiveOn: async (): Promise<boolean> => (await getSettings()).newsUrls?.archive !== false,
  /** The Internet Archive's first capture of a link with a 200 answer, in seconds; null where it holds none. */
  archiveFirst: async (url: string): Promise<number | null> => {
    const api = `https://web.archive.org/cdx/search/cdx?url=${encodeURIComponent(url)}&output=json&limit=1&fl=timestamp&filter=statuscode:200`
    const response = await fetch(api, { signal: AbortSignal.timeout(10_000) })
    if (!response.ok) throw new Error(`the Internet Archive answered ${response.status}`)
    const rows = (await response.json()) as unknown
    const stamp = Array.isArray(rows) && Array.isArray(rows[1]) ? String(rows[1][0]) : null
    return stamp === null ? null : archiveStampSec(stamp)
  },
  /** A post on X's author from X's own embed endpoint: the post itself is never fetched. */
  xAuthor: async (url: string): Promise<{ name: string | null; url: string | null }> => {
    const response = await fetch(`https://publish.twitter.com/oembed?url=${encodeURIComponent(url)}&omit_script=1&dnt=true`, { signal: AbortSignal.timeout(10_000) })
    if (!response.ok) throw new Error(`X answered ${response.status}`)
    const body = (await response.json()) as { author_name?: unknown; author_url?: unknown }
    return {
      name: typeof body.author_name === 'string' ? body.author_name.slice(0, 120) : null,
      url: typeof body.author_url === 'string' && body.author_url.startsWith('https://') ? body.author_url.slice(0, 300) : null
    }
  }
}

const sha256 = (text: string): string => createHash('sha256').update(text).digest('hex')
const monthOf = (seconds: number): string => new Date(seconds * 1000).toISOString().slice(0, 7)
const urlsFile = (seconds: number): string => join(newsUrlSeam.dir(), `urls-${monthOf(seconds)}.jsonl`)

let records: Map<string, UrlRecord> | null = null
/** The first read of the files, while it runs: two callers at a start share it, rather than each reading the files and
 * the later one's map replacing a record the earlier had kept meanwhile (found with the writes' turn, V8 Stage 5). */
let loading: Promise<Map<string, UrlRecord>> | null = null
const listeners = new Set<(record: UrlRecord) => void>()
let timer: ReturnType<typeof setInterval> | null = null

/** Tells a listener each record as it changes. */
export function onUrlRecord(listener: (record: UrlRecord) => void): () => void {
  listeners.add(listener)
  return () => void listeners.delete(listener)
}

function loaded(): Promise<Map<string, UrlRecord>> {
  if (records !== null) return Promise.resolve(records)
  loading ??= readRecords().finally(() => {
    loading = null
  })
  return loading
}

async function readRecords(): Promise<Map<string, UrlRecord>> {
  const lines: unknown[] = []
  for (const { name } of await listMonthFiles(newsUrlSeam.dir(), /^urls-(\d{4}-\d{2})\.jsonl$/)) {
    let text = ''
    try {
      text = await readFile(join(newsUrlSeam.dir(), name), 'utf-8')
    } catch {
      continue
    }
    for (const line of text.split('\n')) {
      if (line.trim() === '') continue
      try {
        lines.push(JSON.parse(line))
      } catch {
        // A torn last line is skipped.
      }
    }
  }
  records = new Map(foldUrlRecords(lines).map((record) => [record.id, record]))
  return records
}

/** A record's change: written as its whole state, filed under the month it was first pasted, and told. */
async function save(record: UrlRecord): Promise<UrlRecord> {
  const held = await loaded()
  held.set(record.id, record)
  await appendJsonLine(urlsFile(record.at), record)
  for (const listener of listeners) {
    try {
      listener(record)
    } catch (error) {
      console.error('A news-URL listener failed:', error)
    }
  }
  return record
}

const step = (record: UrlRecord, status: TrailEntry['status'], note: string): void => {
  record.trail = [...record.trail, { at: newsUrlSeam.now(), status, note }]
}

let writing: Promise<unknown> = Promise.resolve()

/** One write at a time, in the order asked. */
function inTurn<T>(work: () => Promise<T>): Promise<T> {
  const run = writing.then(work, work)
  writing = run.catch(() => undefined)
  return run
}

/** A change to a record on file, made one at a time and to the record as it stands when it is made: what a slow step
 * read before it -- the Archive, a venue's bars -- is applied to the newest state, so that two steps finishing out of
 * order lose neither's change. Found by V8 Stage 5's in-app check: the Archive's answer, asked before an article
 * reading was noted, was saved over the note. `apply` returns the record changed, or null to leave it as it is. */
function change(id: string, apply: (record: UrlRecord) => UrlRecord | null): Promise<UrlRecord | null> {
  return inTurn(async () => {
    const held = (await loaded()).get(id)
    if (held === undefined) return null
    const next = apply({ ...held, trail: [...held.trail] })
    return next === null ? held : save(next)
  })
}

/** A new record kept, in turn with every change: a link recorded twice at once is kept once, the first. */
function insert(record: UrlRecord): Promise<UrlRecord> {
  return inTurn(async () => (await loaded()).get(record.id) ?? save(record))
}

/** Every record on file, newest paste first. */
export async function urlRecords(): Promise<UrlRecord[]> {
  return [...(await loaded()).values()].sort((a, b) => b.at - a.at)
}

/** A record on file by its id; null for none. */
export async function urlRecordOf(id: string): Promise<UrlRecord | null> {
  return (await loaded()).get(id) ?? null
}

/** A coin's price now on its venue: the close of its last one-minute bar, no more than five minutes stale; null where
 * none is read. */
export async function livePriceOf(coin: Pick<UrlCoin, 'pair' | 'venue'>): Promise<number | null> {
  const now = newsUrlSeam.now()
  try {
    return closeBefore(await newsUrlSeam.bars(coin.venue, coin.pair, now - 900, now), now)
  } catch {
    return null
  }
}

/** A model's reading of a record, noted on it (V8 Stage 5): its ledger row's id once answered, the size calls recorded
 * from it, and a step of the trail. */
export async function noteArticleReading(id: string, note: { analysisId: string | null; predictionIds: readonly string[]; text: string }): Promise<UrlRecord | null> {
  return change(id, (next) => {
    if (note.analysisId !== null) next.analysisId = note.analysisId
    const added = note.predictionIds.filter((predictionId) => !next.predictionIds.includes(predictionId))
    if (added.length > 0) next.predictionIds = [...next.predictionIds, ...added]
    step(next, 'reading', note.text)
    return next
  })
}

/** The coins a text names: direct in its title, indirect in its body, matched against Binance's and Bitget's USDT
 * pairs; those under the floor of a day's volume refused, five at most. */
async function coinsOf(title: string, body: string): Promise<{ coins: UrlCoin[]; rejected: UrlRejectedCoin[] }> {
  const pairs = new Map<string, { pair: string; venue: 'binance' | 'bitget' }>()
  for (const venue of ['bitget', 'binance'] as const) {
    try {
      for (const info of await newsUrlSeam.symbols(venue)) if (info.quoteAsset === 'USDT' && info.stockToken !== true) pairs.set(info.baseAsset.toUpperCase(), { pair: info.symbol, venue })
    } catch {
      // A venue's list unread: its pairs are not offered.
    }
  }
  const dictionary = assetDictionary([...pairs.keys()])
  const named = storyAssets({ title, summary: body, tickers: [] }, dictionary)
  const coins: UrlCoin[] = []
  const rejected: UrlRejectedCoin[] = []
  for (const asset of named) {
    const held = pairs.get(asset.ticker)
    if (held === undefined) {
      rejected.push({ ticker: asset.ticker, why: 'no-pair' })
      continue
    }
    if (coins.length >= NEWS_URL_LINES.maxCoins) {
      rejected.push({ ticker: asset.ticker, why: 'over-cap' })
      continue
    }
    const quote = await newsUrlSeam.dayQuote(held.venue, held.pair).catch(() => null)
    if (quote === null || quote < NEWS_URL_LINES.minDayQuote) {
      rejected.push({ ticker: asset.ticker, why: 'thin' })
      continue
    }
    coins.push({ ticker: asset.ticker, relationship: asset.relationship, pair: held.pair, venue: held.venue })
  }
  return { coins, rejected }
}

/** Each coin's price around the publication, read again until it is final. */
async function priced(record: UrlRecord): Promise<boolean> {
  const published = record.time?.sec ?? null
  if (published === null || record.coins.length === 0) return false
  const now = newsUrlSeam.now()
  let changed = false
  const reactions: UrlReaction[] = []
  for (const coin of record.coins) {
    const before = record.reactions.find((reaction) => reaction.pair === coin.pair)
    if (before?.final === true) {
      reactions.push(before)
      continue
    }
    try {
      const bars = await newsUrlSeam.bars(coin.venue, coin.pair, published - NEWS_URL_LINES.beforeSec - 600, Math.min(now, published + NEWS_URL_LINES.afterSec + 60))
      const reaction = reactionOf(coin.pair, published, bars, now)
      reactions.push(reaction)
      changed = changed || JSON.stringify(reaction) !== JSON.stringify(before)
    } catch {
      if (before !== undefined) reactions.push(before)
    }
  }
  record.reactions = reactions
  return changed
}

/** Reads a pasted link through every step, or returns its record where the link is on file already. */
export async function analyzeUrl(input: { raw: string; origin?: 'manual' | 'automatic'; supplied?: string | null }): Promise<UrlRecord | { refused: string }> {
  const sanitized = sanitizeUrl(input.raw)
  if (!sanitized.ok) return { refused: sanitized.reason }
  const held = await loaded()
  const id = urlRecordId(sanitized.url, sha256)
  const existing = held.get(id)
  if (existing !== undefined) {
    const again = await change(id, (next) => {
      step(next, 'pasted-again', 'The link was pasted again; its record is the one on file.')
      return next
    })
    return again ?? existing
  }
  const now = newsUrlSeam.now()
  const record: UrlRecord = {
    v: URL_RECORD_VERSION,
    id,
    origin: input.origin ?? 'manual',
    at: now,
    url: sanitized.url,
    originalHash: sha256(input.raw.trim()),
    host: sanitized.host,
    credibility: credibilityOf(sanitized.host),
    binance: null,
    retrieval: 'none',
    readFailure: null,
    finalUrl: null,
    readAt: null,
    title: null,
    siteName: null,
    author: null,
    canonical: null,
    bodyHash: null,
    snippets: [],
    time: null,
    kind: 'OTHER',
    corroboration: { stories: 0, sources: [] },
    coins: [],
    rejected: [],
    reactions: [],
    verdict: { cards: [], none: null },
    predictionIds: [],
    executorIds: [],
    analysisId: null,
    trail: []
  }
  if (sanitized.removedFields.length > 0) step(record, 'read', `Dropped from the link: ${sanitized.removedFields.join(', ')}.`)

  // A Binance announcement is verified in Binance's own list, which holds its time.
  const code = binanceAnnouncementCodeOf(sanitized.url)
  let listed: ListedArticle | null = null
  if (code !== null) {
    listed = await newsUrlSeam
      .announcements()
      .then((list) => list.find((article) => article.code === code) ?? null)
      .catch(() => null)
    if (listed !== null) {
      const delisting = classifyTitle(listed.title)?.category === 'DELISTING'
      record.binance = { code, articleId: listed.id, title: listed.title, releaseSec: listed.releaseSec, delisting }
    } else {
      step(record, 'read', "The link looks like a Binance announcement, but its code is not in Binance's list: it is read as an exchange's page.")
    }
  }

  // The text: the page, else the feed's copy, else Binance's list, else what the person supplied.
  const feed = newsUrlSeam.feed()
  const sameInFeed = feed.find((story) => sanitizeUrl(story.url).ok && (sanitizeUrl(story.url) as { url: string }).url === sanitized.url) ?? null
  const xPost = xPostOf(sanitized.url)
  let article: ExtractedArticle | null = null
  let retrieval: Retrieval = 'none'
  if (xPost !== null) {
    retrieval = input.supplied ? 'supplied' : 'x-post'
    step(record, 'read', `A post on X is not fetched: its time is read from its id, its author from its link (@${xPost.handle}).`)
    record.author = `@${xPost.handle}`
  } else {
    const page = await newsUrlSeam.fetch(input.raw)
    if (page.ok) {
      record.finalUrl = page.finalUrl
      record.readAt = page.fetchedAt
      step(record, 'read', `Read ${page.bytes.toLocaleString('en-US')} bytes from ${page.finalUrl}${page.redirects.length > 0 ? ` after ${page.redirects.length} redirect(s)` : ''}.`)
      try {
        article = await newsUrlSeam.extract(page.html)
        retrieval = 'fetched'
        step(record, 'extracted', `${article.snippets.length} snippets of text read.`)
      } catch (error) {
        record.readFailure = `The page could not be read as text: ${error instanceof Error ? error.message : String(error)}`
        step(record, 'not-read', record.readFailure)
      }
    } else {
      record.readFailure = page.reason
      step(record, 'not-read', page.reason)
    }
    if (article === null) {
      if (sameInFeed !== null) retrieval = 'feed'
      else if (listed !== null) retrieval = 'announcement'
      else if (input.supplied) retrieval = 'supplied'
    }
  }
  record.retrieval = retrieval
  const supplied = (input.supplied ?? '').trim().slice(0, 8000)
  const title = article?.title ?? sameInFeed?.title ?? listed?.title ?? (retrieval === 'supplied' ? supplied.split('\n')[0].slice(0, 200) : null)
  const body = article?.text ?? (sameInFeed?.summary ?? (retrieval === 'supplied' ? supplied : ''))
  record.title = title
  record.siteName = article?.siteName ?? null
  record.author = article?.author ?? record.author
  record.canonical = article?.canonical ?? null
  record.snippets = article?.snippets ?? (body === '' ? [] : body.split('\n').filter((line) => line.trim() !== '').slice(0, 20).map((text, index) => ({ n: index + 1, text: text.slice(0, 400) })))
  record.bodyHash = body === '' ? null : sha256(body)
  if (retrieval === 'supplied') step(record, 'read', 'The text is what the person supplied, not retrieved from the page.')
  if (retrieval === 'feed') step(record, 'read', "The text is the news feed's own copy of the story.")
  if (retrieval === 'announcement') step(record, 'read', "The text is Binance's own list's title for the announcement.")

  // When it was published.
  const check = record.binance !== null ? { source: 'announcement' as const, sec: record.binance.releaseSec } : sameInFeed !== null ? { source: 'feed' as const, sec: sameInFeed.publishedAt } : null
  record.time =
    xPost !== null
      ? { sec: xPost.sec, source: 'x-id', field: 'id', candidates: [], future: [], disagree: false, check: null }
      : publicationTimeOf({ candidates: [...(article?.published ?? [])], readAt: record.readAt ?? now, check })
  step(record, 'timed', record.time.sec === null ? 'No publication time could be read.' : `Published ${new Date(record.time.sec * 1000).toISOString().slice(0, 16).replace('T', ' ')} UTC, read from ${record.time.source}${record.time.disagree ? '; the page\'s times disagree by more than an hour' : ''}${record.time.check !== null && !record.time.check.agrees ? `; the ${record.time.check.source}'s time disagrees` : ''}.`)

  // Its kind is read as the feed reads a story's: from its title and its summary, not from every word of its body.
  const summary = article?.description ?? article?.snippets[0]?.text ?? sameInFeed?.summary ?? (retrieval === 'supplied' ? supplied.slice(0, 400) : '')
  await complete(record, { title, body, summary, sameInFeed, feed, now })
  const saved = await insert(record)
  if (newsUrlSeam.lookUpAfterPaste) void lookUp(saved.id).catch((error) => console.error("A news link's lookups failed:", error))
  return saved
}

/** THE LOOKUPS (V8 Stage 5), made once a pasted link's record is kept, each named on its page: the Internet Archive's
 * first capture of the link -- an upper bound on its publication, said where the page was there an hour or more before
 * the time it states -- unless switched off; and a post on X's author from X's own embed endpoint. */
export async function lookUp(id: string): Promise<UrlRecord | null> {
  const held = (await loaded()).get(id)
  if (held === undefined) return null
  // Asked outside the turn, which a slow answer would hold up; applied in it, to the record as it is then.
  const lookups: UrlLookups = { archive: null, x: null }
  let firstSec: number | null = null
  if (await newsUrlSeam.archiveOn().catch(() => true)) {
    try {
      firstSec = await newsUrlSeam.archiveFirst(held.url)
      lookups.archive = { status: firstSec === null ? 'none' : 'found', firstSec, note: null }
    } catch (error) {
      lookups.archive = { status: 'failed', firstSec: null, note: error instanceof Error ? error.message : String(error) }
    }
  } else {
    lookups.archive = { status: 'off', firstSec: null, note: null }
  }
  if (xPostOf(held.url) !== null) {
    try {
      lookups.x = { status: 'found', ...(await newsUrlSeam.xAuthor(held.url)) }
    } catch {
      lookups.x = { status: 'failed', name: null, url: null }
    }
  }
  return change(id, (next) => {
    const archive = lookups.archive as NonNullable<UrlLookups['archive']>
    if (archive.status === 'found') archive.note = archiveNote(firstSec, next.time?.sec ?? null)
    next.lookups = lookups
    step(
      next,
      'looked-up',
      archive.status === 'found'
        ? `The Internet Archive first captured it ${new Date((archive.firstSec as number) * 1000).toISOString().slice(0, 16).replace('T', ' ')} UTC.${archive.note === null ? '' : ` ${archive.note}`}`
        : archive.status === 'none'
          ? 'The Internet Archive holds no capture of it.'
          : archive.status === 'off'
            ? 'The Internet Archive was not asked: switched off.'
            : `The Internet Archive could not be asked: ${archive.note}.`
    )
    return next
  })
}

/** What every record is given once its text and time are had: its kind, who else told it, its coins and its source's
 * class now that they are known, a pasted or discovered Binance delisting weighed as the reader's would be, the coins'
 * books read on demand, each coin's price, and the verdict. */
async function complete(record: UrlRecord, input: { title: string | null; body: string; summary: string; sameInFeed: ReadStory | null; feed: readonly ReadStory[]; now: number }): Promise<void> {
  const { title, body, summary, sameInFeed, feed, now } = input
  record.kind = eventTypeOf({ title: title ?? '', summary, binanceCategory: record.binance !== null ? (classifyTitle(record.binance.title)?.category ?? null) : null })
  if (title !== null && record.time?.sec != null) {
    const sec = record.time.sec
    const others = feed.filter((story) => story !== sameInFeed && Math.abs(story.publishedAt - sec) <= SAME_STORY_SECONDS && titleSimilarity(story.title, title) >= SAME_STORY_SIMILARITY)
    record.corroboration = { stories: others.length, sources: [...new Set(others.map((story) => story.source))] }
  }
  const { coins, rejected } = await coinsOf(title ?? '', body)
  record.coins = coins
  record.rejected = rejected
  record.credibility = credibilityOf(record.host, coins.flatMap((coin) => [coin.ticker, ...(COIN_NAMES[coin.ticker] ?? [])]))
  step(record, 'coins', coins.length === 0 ? 'It names no coin with a USDT pair that trades enough.' : `It names ${coins.map((coin) => `${coin.ticker} (${coin.relationship.toLowerCase()})`).join(', ')}.`)
  if (record.binance !== null && record.binance.delisting) {
    const item = { id: record.binance.articleId, catalog: 161 as const, title: record.binance.title, releaseSec: record.binance.releaseSec, seenAt: now, category: 'DELISTING' as const, tickers: classifyTitle(record.binance.title)?.tickers ?? [] }
    newsUrlSeam.pastedDelisting(item)
  }
  newsUrlSeam.pastedCoins(coins.map((coin) => coin.pair), now + 3600)
  await priced(record)
  if (record.reactions.length > 0) step(record, 'priced', "Each coin's price read from a day before publication to now.")
  const cards = newsUrlSeam.cardsFor(coins.map((coin) => coin.pair))
  record.verdict = {
    cards,
    none:
      cards.length > 0
        ? null
        : coins.length === 0
          ? 'No coin it names can be weighed here.'
          : record.binance?.delisting === true
            ? "A Binance delisting is a card only within its rule's five minutes, on a fresh book that holds the stake."
            : `No measured source calls a way for news of this kind (${record.kind.toLowerCase().replace(/_/g, ' ')}).`
  }
}

/** DISCOVERED NEWS (V8 Stage 4): each story of the app's own feed -- Binance's announcements among them -- of impact
 * 70 or more naming a coin directly gets a record of its own, passively: its text is the feed's, nothing is fetched and
 * no model asked. With "Analyze discovered news automatically" switched on (off unless a person sets it), its page is
 * read as a pasted link's would be. */
export async function discoverFromFeed(autoAnalyze: boolean): Promise<number> {
  const held = await loaded()
  const feed = newsUrlSeam.feed()
  let made = 0
  for (const story of feed) {
    if (story.impact < NEWS_URL_LINES.passiveImpact || !story.assets.some((asset) => asset.relationship === 'DIRECT')) continue
    const sanitized = sanitizeUrl(story.url)
    if (!sanitized.ok || held.has(urlRecordId(sanitized.url, sha256))) continue
    if (autoAnalyze) {
      const done = await analyzeUrl({ raw: sanitized.url, origin: 'automatic' })
      if (!('refused' in done)) made++
      continue
    }
    const now = newsUrlSeam.now()
    const fromBinance = story.source === 'binance'
    const articleId = fromBinance ? Number(/^binance:(\d+)$/.exec(story.id)?.[1] ?? Number.NaN) : Number.NaN
    const record: UrlRecord = {
      v: URL_RECORD_VERSION,
      id: urlRecordId(sanitized.url, sha256),
      origin: 'automatic',
      at: now,
      url: sanitized.url,
      originalHash: sha256(story.url.trim()),
      host: sanitized.host,
      credibility: credibilityOf(sanitized.host),
      binance:
        fromBinance && Number.isSafeInteger(articleId)
          ? { code: binanceAnnouncementCodeOf(sanitized.url) ?? '', articleId, title: story.title, releaseSec: story.publishedAt, delisting: story.binanceCategory === 'DELISTING' }
          : null,
      retrieval: fromBinance ? 'announcement' : 'feed',
      readFailure: null,
      finalUrl: null,
      readAt: null,
      title: story.title,
      siteName: story.sourceName,
      author: null,
      canonical: null,
      bodyHash: story.summary === '' ? null : sha256(story.summary),
      snippets: story.summary === '' ? [] : [{ n: 1, text: story.summary }],
      time: publicationTimeOf({ candidates: [], readAt: now, check: { source: fromBinance ? 'announcement' : 'feed', sec: story.publishedAt } }),
      kind: 'OTHER',
      corroboration: { stories: 0, sources: [] },
      coins: [],
      rejected: [],
      reactions: [],
      verdict: { cards: [], none: null },
      predictionIds: [],
      executorIds: [],
      analysisId: null,
      trail: []
    }
    step(record, 'discovered', `Discovered in the app's own feed (${story.sourceName}, impact ${story.impact}): nothing fetched, no model asked.`)
    await complete(record, { title: story.title, body: story.summary, summary: story.summary, sameInFeed: story, feed, now })
    await insert(record)
    made++
  }
  return made
}

/** A person's own view, recorded from a record (V8 Stage 4): its prediction's id, and the paper trade's once placed. */
export async function linkUrlRecord(id: string, link: { predictionId?: string; executorId?: string }): Promise<UrlRecord | null> {
  return change(id, (next) => {
    if (typeof link.predictionId === 'string' && !next.predictionIds.includes(link.predictionId)) next.predictionIds = [...next.predictionIds, link.predictionId]
    if (typeof link.executorId === 'string' && !next.executorIds.includes(link.executorId)) next.executorIds = [...next.executorIds, link.executorId]
    step(next, 'view', `A view of the person's own recorded${link.predictionId ? ` (${link.predictionId})` : ''}.`)
    return next
  })
}

/** Reads each record's price again until it is final: every five minutes. */
export async function refreshUrlPrices(): Promise<void> {
  for (const record of await urlRecords()) {
    if (record.reactions.length === 0 || record.reactions.every((reaction) => reaction.final)) continue
    // The bars read outside the turn, on a copy; the prices applied in it, to the record as it is then.
    const read = { ...record, trail: [...record.trail] }
    if (!(await priced(read))) continue
    await change(record.id, (next) => {
      next.reactions = read.reactions
      if (next.reactions.every((reaction) => reaction.final)) step(next, 'final', "Each coin's price read to four hours after publication.")
      return next
    })
  }
}

/** Every five minutes: each record's price read again until final, and the feed's stories of impact 70 or more naming
 * a coin directly recorded (and, with the switch on, read). */
async function tick(): Promise<void> {
  await refreshUrlPrices().catch((error) => console.error("A news link's prices could not be read again:", error))
  await discoverFromFeed(await newsUrlSeam.autoAnalyze().catch(() => false)).catch((error) => console.error('Discovered news could not be recorded:', error))
}

export function startNewsUrls(): void {
  if (timer !== null) return
  timer = setInterval(() => void tick(), 5 * 60_000)
}

/** Test seam: as a new session finds it. */
export function resetNewsUrls(): void {
  records = null
  loading = null
  writing = Promise.resolve()
  listeners.clear()
  if (timer !== null) clearInterval(timer)
  timer = null
}
