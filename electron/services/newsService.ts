import { app } from 'electron'
import { mkdir, readFile } from 'fs/promises'
import { join } from 'path'
import {
  NEWS_CATALOGS,
  applyNewsConfigPatch,
  byNewestRelease,
  healNewsConfig,
  matchesNewsFilter,
  newsListUrl,
  newsMonthKey,
  nextNewsReadDelayMs,
  parseArticleList,
  parseNewsLines,
  toNewsItem,
  type NewsConfig,
  type NewsConfigPatch,
  type NewsFilter,
  type NewsItem,
  type NewsPage,
  type NewsState
} from '../../shared/news'
import { shouldRaiseDelisting } from '../../shared/newsActions'
import { writeJsonAtomic } from './atomicWrite'
import { appendJsonLine, listMonthFiles } from './jsonlStore'
import { raiseNewsEvent } from './marketScannerService'

// Binance's own announcements, read once a minute while the reader is on (research/NEWS.md says
// what they did to prices, and why they are read).
//
// IT READS ONE PUBLIC LIST AND NOTHING ELSE. Two requests a minute -- Binance's delisting list and
// its listing list -- with no key, no model and no order. A delisting released minutes ago is
// raised as an event through the scanner (raiseNewsEvent), which reads the coin's public candles,
// when the user has that switched on; the watch, if it is on, then puts it to its models. Each article is kept once, by its id, in
// news/news-YYYY-MM.jsonl, sorted by the patterns the study measured with (shared/newsTitles.ts).
// It decides nothing about one. They are shown on Discovery, and what a delisting does -- a notice
// to someone holding the coin, the rule's paper short -- is done in the window
// (src/news/NewsScheduler.tsx), each part as it is switched on in this setting.
//
// It is off until it is switched on under Settings › Market, and stays as it was left across
// restarts. One read at a time, as the scanner: the next is scheduled when this one ends.

const READ_TIMEOUT_MS = 15_000
const RECENT_KEPT = 200
const FILE_PATTERN = /^news-(\d{4}-\d{2})\.jsonl$/
const DEFAULT_LIMIT = 100
const MAX_LIMIT = 2000

let config: NewsConfig | null = null
/** Newest release first. */
let recent: NewsItem[] = []
/** Every article id on file, so that none is kept twice. */
const known = new Set<number>()
/** The read of what is on file, shared by everyone who asks while it is under way. */
let loading: Promise<void> | null = null
let lastReadAt: number | null = null
let nextReadAt: number | null = null
let error: string | null = null
let timer: ReturnType<typeof setTimeout> | null = null
let readInFlight = false
/** The read started by switching the reader on, which nothing waits for. */
let background: Promise<unknown> = Promise.resolve()
const listeners = new Set<(state: NewsState) => void>()

function configPath(): string {
  return join(app.getPath('userData'), 'news.json')
}

function newsDir(): string {
  return join(app.getPath('userData'), 'news')
}

async function loadConfig(): Promise<NewsConfig> {
  if (config) return config
  let raw: unknown = {}
  try {
    raw = JSON.parse(await readFile(configPath(), 'utf-8'))
  } catch {
    raw = {}
  }
  // Only `true` switches anything on: a file holding anything else is healed, not obeyed.
  config = healNewsConfig(raw)
  return config
}

async function persistConfig(): Promise<void> {
  await mkdir(app.getPath('userData'), { recursive: true })
  await writeJsonAtomic(configPath(), config)
}

function snapshot(current: NewsConfig): NewsState {
  return { config: { ...current, paperShort: { ...current.paperShort } }, lastReadAt, nextReadAt, error, recent: [...recent] }
}

function notify(current: NewsConfig): void {
  const state = snapshot(current)
  for (const listener of listeners) listener(state)
}

export function onNewsUpdate(listener: (state: NewsState) => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/** Every article on file: its id, so none is kept twice, and the newest for the page. Every caller
 * waits for the same read; one that fails is logged and tried again by the next caller. */
async function loadKnown(): Promise<void> {
  if (loading === null) {
    loading = (async (): Promise<void> => {
      const all: NewsItem[] = []
      for (const { name } of await listMonthFiles(newsDir(), FILE_PATTERN)) {
        all.push(...parseNewsLines(await readFile(join(newsDir(), name), 'utf-8')).rows)
      }
      for (const item of all) known.add(item.id)
      recent = all.sort(byNewestRelease).slice(0, RECENT_KEPT)
    })().catch((failure: unknown) => {
      loading = null
      console.error('The news on file could not be read:', failure)
    })
  }
  return loading
}

async function fetchList(url: string): Promise<unknown> {
  const response = await fetch(url, {
    headers: { 'User-Agent': 'TraderSpider', Accept: 'application/json' },
    signal: AbortSignal.timeout(READ_TIMEOUT_MS)
  })
  if (!response.ok) throw new Error(`Binance's announcement list answered ${response.status}`)
  return response.json()
}

/** One read of both lists: every article not seen before is sorted and kept.
 *
 * Returns without reading while another read is running. `nowMs` is the clock an article is
 * stamped as seen by; it is a parameter so that a test can say what time it is. */
export async function readNewsOnce(nowMs: number = Date.now()): Promise<NewsState> {
  const current = await loadConfig()
  if (readInFlight) return snapshot(current)
  readInFlight = true
  try {
    await loadKnown()
    const seenAt = Math.floor(nowMs / 1000)
    const failures: string[] = []
    const fresh: NewsItem[] = []
    for (const catalog of NEWS_CATALOGS) {
      try {
        for (const article of parseArticleList(await fetchList(newsListUrl(catalog)))) {
          // An article in both lists is kept once, under the first.
          if (known.has(article.id)) continue
          known.add(article.id)
          fresh.push(toNewsItem(article, catalog, seenAt))
        }
      } catch (failure) {
        failures.push(failure instanceof Error ? failure.message : String(failure))
      }
    }
    // Oldest first, so a month file reads in the order Binance released them.
    fresh.sort((a, b) => byNewestRelease(b, a))
    for (const item of fresh) await appendJsonLine(join(newsDir(), `news-${newsMonthKey(item.releaseSec)}.jsonl`), item)
    if (fresh.length > 0) recent = [...fresh, ...recent].sort(byNewestRelease).slice(0, RECENT_KEPT)
    // A delisting released minutes ago is raised as an event for each coin it names, for the watch
    // to put to its models -- when that is switched on (shared/newsActions.ts). The watch's own
    // switch, limits and the day's budget still decide whether anything is asked.
    const setting = config ?? current
    if (setting.enabled && setting.askModels) {
      for (const item of fresh.filter((entry) => shouldRaiseDelisting(entry, seenAt))) {
        for (const ticker of item.tickers) {
          try {
            await raiseNewsEvent(item, ticker, nowMs)
          } catch (failure) {
            console.error(`The delisting of ${ticker} could not be raised as an event:`, failure)
          }
        }
      }
    }
    error =
      failures.length === 0
        ? null
        : failures.length === NEWS_CATALOGS.length
          ? `Binance's announcement lists could not be read: ${failures[0]}`
          : `One of Binance's two announcement lists could not be read: ${failures[0]}`
  } catch (failure) {
    error = failure instanceof Error ? failure.message : String(failure)
  } finally {
    readInFlight = false
    lastReadAt = Math.floor(Date.now() / 1000)
  }
  // The setting as it is now: it may have been changed while the lists were being read.
  const latest = config ?? current
  notify(latest)
  return snapshot(latest)
}

function schedule(): void {
  if (timer !== null) return
  const delay = nextNewsReadDelayMs(Date.now())
  nextReadAt = Math.floor((Date.now() + delay) / 1000)
  timer = setTimeout(() => {
    timer = null
    void readNewsOnce()
      .catch((failure) => console.error('Reading the news failed:', failure))
      .finally(() => {
        // Read again rather than captured: the reader may have been switched off mid-read.
        if (config?.enabled) schedule()
        else nextReadAt = null
        if (config) notify(config)
      })
  }, delay)
}

function unschedule(): void {
  if (timer !== null) clearTimeout(timer)
  timer = null
  nextReadAt = null
}

/** Called once at startup. Starts the loop only if it was left switched on. */
export async function startNewsReader(): Promise<void> {
  const current = await loadConfig()
  if (current.enabled) schedule()
}

export async function getNewsState(): Promise<NewsState> {
  const current = await loadConfig()
  await loadKnown()
  return snapshot(current)
}

export async function setNewsConfig(patch: NewsConfigPatch): Promise<NewsState> {
  const next = applyNewsConfigPatch(await loadConfig(), patch ?? {})
  if (typeof next === 'string') throw new Error(next)
  config = next
  const current = next
  const switchedOn = current.enabled && timer === null
  await persistConfig()
  if (current.enabled) schedule()
  else unschedule()
  await loadKnown()
  notify(current)
  // Switched on by a person looking at an empty list: read now rather than at the minute.
  if (switchedOn) background = readNewsOnce().catch((failure) => console.error('Reading the news failed:', failure))
  return snapshot(current)
}

/** Test seam: resolves once the read that switching on started has finished. */
export async function whenNewsSettled(): Promise<void> {
  await background
}

/** This app's own record of one article, or null when it has read no such article. What a question
 * about an announcement's event is checked against (electron/services/aiSignalService.ts). */
export async function findNewsItem(id: number): Promise<NewsItem | null> {
  if (!Number.isSafeInteger(id)) return null
  await loadKnown()
  const kept = recent.find((item) => item.id === id)
  if (kept !== undefined) return kept
  for (const { name } of await listMonthFiles(newsDir(), FILE_PATTERN)) {
    const found = parseNewsLines(await readFile(join(newsDir(), name), 'utf-8')).rows.find((item) => item.id === id)
    if (found !== undefined) return found
  }
  return null
}

/** Articles on file, newest release first, reading month files backwards and stopping when enough
 * are found. */
export async function listNews(filter: NewsFilter): Promise<NewsPage> {
  const requested = Math.floor(filter.limit ?? DEFAULT_LIMIT)
  const limit = Math.min(MAX_LIMIT, Math.max(1, Number.isFinite(requested) ? requested : DEFAULT_LIMIT))
  const oldestMonth = filter.sinceSec !== undefined ? newsMonthKey(filter.sinceSec) : null
  const rows: NewsItem[] = []
  let skippedLines = 0
  for (const { name, month } of await listMonthFiles(newsDir(), FILE_PATTERN)) {
    if (oldestMonth !== null && month < oldestMonth) break
    const parsed = parseNewsLines(await readFile(join(newsDir(), name), 'utf-8'))
    skippedLines += parsed.skipped
    for (const item of parsed.rows.sort(byNewestRelease)) {
      if (!matchesNewsFilter(item, filter)) continue
      rows.push(item)
      if (rows.length >= limit) return { rows, skippedLines }
    }
  }
  return { rows, skippedLines }
}
