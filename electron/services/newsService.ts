import { app } from 'electron'
import { mkdir, readFile } from 'fs/promises'
import { join } from 'path'
import { stampedConfig } from '../../shared/configMigration'
import { readConfigFile } from './configFiles'
import {
  NEWS_CATALOGS,
  NEWS_READER_FAILURES_TO_STOP,
  NEWS_READER_RETRY_MS,
  applyNewsConfigPatch,
  byNewestRelease,
  copyNewsConfig,
  healNewsConfig,
  matchesNewsFilter,
  newsListUrl,
  newsActionsFor,
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
import { shouldRaiseNewsEvent } from '../../shared/newsActions'
import { systemFailureNotice, systemRecoveredNotice } from '../../shared/notices'
import { writeJsonAtomic } from './atomicWrite'
import { appendJsonLine, listMonthFiles } from './jsonlStore'
import { raiseNewsEvent } from './marketScannerService'
import { tell } from './noticeService'

// Binance's own announcements, read once a minute while the reader is on (research/NEWS.md says
// what they did to prices, and why they are read).
//
// IT READS ONE PUBLIC LIST AND NOTHING ELSE. Three requests a minute -- Binance's delisting list,
// its listing list and its news -- with no key, no model and no order. A delisting released minutes ago is
// raised as an event through the scanner (raiseNewsEvent), which reads the coin's public candles,
// when the user has that switched on; the watch, if it is on, then puts it to its models. Each article is kept once, by its id, in
// news/news-YYYY-MM.jsonl, sorted by the patterns the study measured with (shared/newsTitles.ts).
// It decides nothing about one. They are shown on Discovery, and what a delisting does -- a notice
// to someone holding the coin, the rule's paper short -- is done in the window
// (src/news/NewsScheduler.tsx), each part as it is switched on in this setting.
//
// It is off until it is switched on under Settings › Market, and stays as it was left across
// restarts. One read at a time, as the scanner: the next is scheduled when this one ends.
//
// ITS HEALTH IS KEPT (V8 Stage 9): the reads in a row that read none of the lists. Three, and the reader switches
// itself off and says so in a notice, rather than go on reading nothing every minute while it is relied on -- paper
// testing's news book reads it. Switched on again, it starts counting again.

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
let failuresInRow = 0
/** Paused after reads in a row that read nothing: it tries again every NEWS_READER_RETRY_MS until one reads. */
let paused: { at: number; reason: string } | null = null
/** The latest read nothing waits for: the one switching the reader on starts, or its own on the minute. */
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
  // Read once, through the migration steps it is behind (configFiles.ts). Only `true` switches
  // anything on: a file holding anything else is healed, not obeyed.
  config = healNewsConfig(await readConfigFile('news'))
  return config
}

async function persistConfig(): Promise<void> {
  await mkdir(app.getPath('userData'), { recursive: true })
  await writeJsonAtomic(configPath(), config === null ? config : stampedConfig(config))
}

function snapshot(current: NewsConfig): NewsState {
  return { config: copyNewsConfig(current), lastReadAt, nextReadAt, error, recent: [...recent], health: { failuresInRow, pausedAt: paused?.at ?? null, pausedReason: paused?.reason ?? null } }
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

/** One read of every list: every article not seen before is sorted and kept.
 *
 * Returns without reading while another read is running. `nowMs` is the clock an article is
 * stamped as seen by; it is a parameter so that a test can say what time it is. */
export async function readNewsOnce(nowMs: number = Date.now()): Promise<NewsState> {
  const current = await loadConfig()
  if (readInFlight) return snapshot(current)
  readInFlight = true
  let readNothing = false
  try {
    await loadKnown()
    const seenAt = Math.floor(nowMs / 1000)
    const failures: string[] = []
    const fresh: NewsItem[] = []
    for (const catalog of NEWS_CATALOGS) {
      try {
        for (const article of parseArticleList(await fetchList(newsListUrl(catalog)))) {
          // An article in two lists is kept once, under the first.
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
    // A delisting or a tag released minutes ago is raised as an event for each coin it names, for
    // the watch to put to its models -- when that is switched on for its kind
    // (shared/newsActions.ts). The watch's own switch, limits and the day's budget still decide
    // whether anything is asked.
    const setting = config ?? current
    if (setting.enabled) {
      for (const item of fresh.filter((entry) => shouldRaiseNewsEvent(entry, seenAt) && newsActionsFor(setting, entry.category)?.askModels === true)) {
        for (const ticker of item.tickers) {
          try {
            await raiseNewsEvent(item, ticker, nowMs)
          } catch (failure) {
            console.error(`The announcement about ${ticker} could not be raised as an event:`, failure)
          }
        }
      }
    }
    readNothing = failures.length === NEWS_CATALOGS.length
    error =
      failures.length === 0
        ? null
        : readNothing
          ? `Binance's announcement lists could not be read: ${failures[0]}`
          : `${failures.length} of Binance's ${NEWS_CATALOGS.length} announcement lists could not be read: ${failures[0]}`
  } catch (failure) {
    readNothing = true
    error = failure instanceof Error ? failure.message : String(failure)
  } finally {
    readInFlight = false
    lastReadAt = Math.floor(Date.now() / 1000)
  }
  failuresInRow = readNothing ? failuresInRow + 1 : 0
  // Three reads in a row of nothing, while it is on: it pauses, says why, and tries again by itself (it was switched off
  // until 20 November 2026, when a three-minute outage stopped it for the rest of a 30-day run). A read that reads: back.
  if (readNothing && failuresInRow >= NEWS_READER_FAILURES_TO_STOP && (config ?? current).enabled && paused === null) pauseForFailures(error ?? 'nothing could be read')
  if (!readNothing && paused !== null) resumeAfterFailures()
  // The setting as it is now: it may have been changed while the lists were being read.
  const latest = config ?? current
  notify(latest)
  return snapshot(latest)
}

/** The reader paused after reads in a row that read nothing, with a notice that says so: its switch is left as it is, and
 * it tries again every NEWS_READER_RETRY_MS (the next read is scheduled so). */
function pauseForFailures(reason: string): void {
  paused = { at: Math.floor(Date.now() / 1000), reason }
  tell((i18n) =>
    systemFailureNotice(
      'announcements',
      i18n.t("Three reads in a row of Binance's announcement lists failed ({error}): the reader tries again every five minutes by itself, and says so when it reads again.", { error: reason }),
      i18n
    )
  )
}

/** A paused reader that reads again: back to every minute, with a notice that says so. */
function resumeAfterFailures(): void {
  const since = paused?.at ?? Math.floor(Date.now() / 1000)
  paused = null
  const minutes = Math.max(1, Math.round((Date.now() / 1000 - since) / 60))
  tell((i18n) =>
    systemRecoveredNotice(
      'announcements',
      i18n.t("Binance's announcement lists were read again, {count} minutes after the reader paused: it reads every minute again.", { count: minutes }),
      i18n
    )
  )
}

function schedule(): void {
  if (timer !== null) return
  const delay = paused === null ? nextNewsReadDelayMs(Date.now()) : NEWS_READER_RETRY_MS
  nextReadAt = Math.floor((Date.now() + delay) / 1000)
  timer = setTimeout(() => {
    timer = null
    background = readNewsOnce()
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
  // Switched on again, it counts its failures from nothing; switched off, it is no longer paused but off.
  failuresInRow = current.enabled ? 0 : failuresInRow
  paused = null
  await persistConfig()
  if (current.enabled) schedule()
  else unschedule()
  await loadKnown()
  notify(current)
  // Switched on by a person looking at an empty list: read now rather than at the minute.
  if (switchedOn) background = readNewsOnce().catch((failure) => console.error('Reading the news failed:', failure))
  return snapshot(current)
}

/** Test seam: resolves once the latest read nothing waits for (switching on started it, or the minute) has finished. */
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
