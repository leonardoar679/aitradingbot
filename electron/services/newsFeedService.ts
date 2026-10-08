import { app, shell } from 'electron'
import { readFile } from 'fs/promises'
import { join } from 'path'
import type { NewsItem } from '../../shared/news'
import {
  BINANCE_SOURCE,
  FEED_HOSTS,
  FEED_KEEP_SECONDS,
  FEED_READ_MS,
  FEED_SOURCES,
  NEWS_FEED_VERSION,
  REACTION_FINAL_SECONDS,
  STORY_HISTORY_MAX_SECONDS,
  assetDictionary,
  foldSameStories,
  impactByType,
  parseRss,
  readStory,
  storyMark,
  storyReaction,
  toStory,
  type AssetDictionary,
  type FeedSourceStatus,
  type FeedStory,
  type NewsFeedState,
  type ReadStory,
  type StoryMark,
  type StoryReaction
} from '../../shared/newsFeed'
import { appendJsonLine, listMonthFiles } from './jsonlStore'
import { listSymbols, scanSourceFor } from './marketService'
import { getNewsState, onNewsUpdate } from './newsService'
import { singleFlight } from './singleFlight'
import { systemFailureNotice } from '../../shared/notices'
import { tell } from './noticeService'

// THE NEWS FEED: FOUR FREE MEDIA FEEDS AND BINANCE'S OWN ANNOUNCEMENTS, AS STORIES (the second V3
// document, §11-14; the arithmetic is shared/newsFeed.ts).
//
// Every three minutes it reads CoinDesk, The Block, Cointelegraph and Decrypt -- public RSS, no key,
// no cost -- keeps each new item once in news/feed-YYYY-MM.jsonl, and sets Binance's announcements,
// as the news reader holds them, beside them. Then, for each story that names a coin traded on
// Binance, it reads that coin's minutes to say what the price did around it; a reaction measured to
// its end (four hours) is kept in news/reactions-YYYY-MM.jsonl, and what each kind of news did is
// worked out from those once there are enough.
//
// IT READS PUBLIC DATA AND NOTHING ELSE: no key, no model, no order. A story's link is opened in the
// browser only on https and only on the feeds' own hosts.

const FEED_FILE = /^feed-(\d{4}-\d{2})\.jsonl$/
const REACTION_FILE = /^reactions-(\d{4}-\d{2})\.jsonl$/
const SOURCE_TIMEOUT_MS = 15_000
const STORIES_SHOWN = 300
/** Coins' minutes read in one pass, at most. */
const REACTION_READS = 20
/** A story older than this when first measured is left unmeasured: its minutes are too far back. */
const REACTION_OLDEST_SECONDS = 12 * 3600

let raw: FeedStory[] = []
const seen = new Set<string>()
let finalReactions: StoryReaction[] = []
const finalIds = new Set<string>()
const liveReactions = new Map<string, StoryReaction>()
let dictionary: AssetDictionary | null = null
let pairByBase = new Map<string, string>()
/** No feed read for this long is the feeds dead. */
const FEEDS_DEAD_SECONDS = 30 * 60
let lastAnyRead: number | null = Math.floor(Date.now() / 1000)
let feedsDeadTold = false
let sources: FeedSourceStatus[] = FEED_SOURCES.map((source) => ({ id: source.id, name: source.name, lastReadAt: null, ok: null, error: null, items: 0 }))
let state: NewsFeedState = { version: NEWS_FEED_VERSION, sources, stories: [], reactions: {}, impact: [], measured: 0, updatedAt: null }
const listeners = new Set<(state: NewsFeedState) => void>()
let started = false

function newsDir(): string {
  return join(app.getPath('userData'), 'news')
}

const monthKey = (sec: number): string => new Date(sec * 1000).toISOString().slice(0, 7)
const describeFailure = (error: unknown): string => (error instanceof Error ? error.message : String(error))

export function onNewsFeedUpdate(listener: (state: NewsFeedState) => void): () => void {
  listeners.add(listener)
  return () => void listeners.delete(listener)
}

export function getNewsFeedState(): NewsFeedState {
  return state
}

function isStory(value: unknown): value is FeedStory {
  const row = value as Partial<FeedStory> | null
  return (
    typeof row === 'object' &&
    row !== null &&
    typeof row.id === 'string' &&
    typeof row.title === 'string' &&
    typeof row.url === 'string' &&
    typeof row.source === 'string' &&
    typeof row.publishedAt === 'number' &&
    Number.isFinite(row.publishedAt)
  )
}

function isReaction(value: unknown): value is StoryReaction {
  const row = value as Partial<StoryReaction> | null
  return typeof row === 'object' && row !== null && typeof row.storyId === 'string' && typeof row.eventType === 'string' && typeof row.after === 'object' && row.after !== null
}

async function readLines(name: string): Promise<unknown[]> {
  try {
    return (await readFile(join(newsDir(), name), 'utf-8'))
      .split('\n')
      .filter((line) => line.trim() !== '')
      .flatMap((line) => {
        try {
          return [JSON.parse(line) as unknown]
        } catch {
          return []
        }
      })
  } catch {
    return []
  }
}

async function load(): Promise<void> {
  const nowSec = Math.floor(Date.now() / 1000)
  for (const { name } of (await listMonthFiles(newsDir(), FEED_FILE)).slice(0, 2)) {
    for (const row of await readLines(name)) {
      if (!isStory(row) || seen.has(row.id)) continue
      seen.add(row.id)
      if (nowSec - row.publishedAt <= FEED_KEEP_SECONDS) raw.push(row)
    }
  }
  for (const { name } of await listMonthFiles(newsDir(), REACTION_FILE)) {
    for (const row of await readLines(name)) {
      if (!isReaction(row) || finalIds.has(row.storyId)) continue
      finalIds.add(row.storyId)
      finalReactions.push(row)
    }
  }
}

async function ensureDictionary(): Promise<void> {
  if (dictionary !== null) return
  const pairs = (await listSymbols('binance')).filter((pair) => pair.quoteAsset === 'USDT')
  pairByBase = new Map(pairs.map((pair) => [pair.baseAsset.toUpperCase(), pair.symbol]))
  dictionary = assetDictionary([...pairByBase.keys()])
}

/** Binance's announcements as the news reader holds them, as stories. They have no page of their
 * own the app knows the address of, so their link is the list they were published in. */
function announcementStories(items: NewsItem[]): FeedStory[] {
  return items.map((item) => ({
    id: `binance:${item.id}`,
    source: BINANCE_SOURCE.id,
    sourceName: BINANCE_SOURCE.name,
    sourceClass: BINANCE_SOURCE.sourceClass,
    title: item.title,
    url: `https://www.binance.com/en/support/announcement/list/${item.catalog}`,
    publishedAt: item.releaseSec,
    seenAt: item.seenAt,
    summary: '',
    tickers: item.tickers,
    binanceCategory: item.category
  }))
}

async function rebuild(): Promise<void> {
  if (dictionary === null) return
  const nowSec = Math.floor(Date.now() / 1000)
  raw = raw.filter((story) => nowSec - story.publishedAt <= FEED_KEEP_SECONDS)
  let announcements: FeedStory[] = []
  try {
    announcements = announcementStories((await getNewsState()).recent).filter((story) => nowSec - story.publishedAt <= FEED_KEEP_SECONDS)
  } catch {
    announcements = []
  }
  const credibility = new Map<string, number>([...FEED_SOURCES.map((source) => [source.id, source.credibility] as [string, number]), [BINANCE_SOURCE.id, BINANCE_SOURCE.credibility]])
  const read = [...raw, ...announcements].map((story) => readStory(story, dictionary as AssetDictionary, credibility.get(story.source) ?? 0.5, nowSec))
  const stories: ReadStory[] = foldSameStories(read).slice(0, STORIES_SHOWN)
  const reactions: Record<string, StoryReaction> = {}
  for (const reaction of finalReactions) reactions[reaction.storyId] = reaction
  for (const [id, reaction] of liveReactions) reactions[id] = reaction
  state = { version: NEWS_FEED_VERSION, sources, stories, reactions, impact: impactByType(finalReactions), measured: finalReactions.length, updatedAt: nowSec }
  for (const listener of listeners) {
    try {
      listener(state)
    } catch (error) {
      console.error('A news feed listener failed:', error)
    }
  }
}

/** What the price did around each story that names a coin traded on Binance, read from its minutes. */
async function measureReactions(): Promise<void> {
  const nowSec = Math.floor(Date.now() / 1000)
  const due = state.stories.filter(
    (story) =>
      !finalIds.has(story.id) &&
      nowSec - story.publishedAt >= 5 * 60 &&
      nowSec - story.publishedAt <= REACTION_OLDEST_SECONDS &&
      story.assets.some((asset) => asset.relationship === 'DIRECT' && pairByBase.has(asset.ticker))
  )
  let changed = false
  for (const story of due.slice(0, REACTION_READS)) {
    const asset = story.assets.find((entry) => entry.relationship === 'DIRECT' && pairByBase.has(entry.ticker))
    if (asset === undefined) continue
    const symbol = pairByBase.get(asset.ticker) as string
    try {
      const minutes = Math.min(1000, Math.ceil((nowSec - story.publishedAt) / 60) + 75)
      const bars = await scanSourceFor('binance').fetchRecentCandles(symbol, '1m', minutes)
      const reaction = storyReaction({ storyId: story.id, ticker: asset.ticker, symbol, eventType: story.eventType, publishedAt: story.publishedAt, bars, nowSec })
      changed = true
      if (reaction.after.h4 !== null && nowSec - story.publishedAt >= REACTION_FINAL_SECONDS) {
        finalReactions = [...finalReactions, reaction]
        finalIds.add(story.id)
        liveReactions.delete(story.id)
        await appendJsonLine(join(newsDir(), `reactions-${monthKey(story.publishedAt)}.jsonl`), reaction)
      } else liveReactions.set(story.id, reaction)
    } catch (error) {
      // Tried again at the next pass.
      console.warn(`News feed: ${symbol}'s minutes around a story could not be read:`, describeFailure(error))
    }
  }
  if (changed) await rebuild()
}

const readFeeds = singleFlight(async (): Promise<void> => {
  try {
    await ensureDictionary()
  } catch (error) {
    console.warn("News feed: Binance's pairs could not be read, so coins cannot be matched yet:", describeFailure(error))
    return
  }
  const next: FeedSourceStatus[] = []
  for (const source of FEED_SOURCES) {
    const nowSec = Math.floor(Date.now() / 1000)
    try {
      const response = await fetch(source.url, { signal: AbortSignal.timeout(SOURCE_TIMEOUT_MS), headers: { 'User-Agent': 'Mozilla/5.0 (TraderSpider news reader)' } })
      if (!response.ok) throw new Error(`it answered ${response.status}`)
      const items = parseRss(await response.text())
      for (const item of items) {
        const story = toStory(item, source, nowSec)
        if (story === null || seen.has(story.id)) continue
        seen.add(story.id)
        raw.push(story)
        await appendJsonLine(join(newsDir(), `feed-${monthKey(story.publishedAt)}.jsonl`), story)
      }
      next.push({ id: source.id, name: source.name, lastReadAt: nowSec, ok: true, error: null, items: items.length })
    } catch (error) {
      const before = sources.find((entry) => entry.id === source.id)
      next.push({ id: source.id, name: source.name, lastReadAt: nowSec, ok: false, error: `${source.name} could not be read: ${describeFailure(error)}`, items: before?.items ?? 0 })
    }
  }
  sources = next
  // Every feed failing for half an hour is told once (SYSTEM_FAILURE); one feed down is the usual.
  const readSec = Math.floor(Date.now() / 1000)
  if (next.some((entry) => entry.ok)) lastAnyRead = readSec
  else if (lastAnyRead !== null && readSec - lastAnyRead >= FEEDS_DEAD_SECONDS && !feedsDeadTold) {
    feedsDeadTold = true
    tell(systemFailureNotice('feed', `None of the ${next.length} feeds has been read for ${Math.round((readSec - lastAnyRead) / 60)} minutes: ${next[0]?.error ?? 'they could not be read'}.`))
  }
  if (next.some((entry) => entry.ok)) feedsDeadTold = false
  await rebuild()
  await measureReactions()
}, () => undefined)

/** The media feeds' stories published between `fromSec` and `toSec` (at most
 * STORY_HISTORY_MAX_SECONDS, the newest kept), read from the files on disk with the coin dictionary,
 * as marks: for measuring what news did (shared/aiHelp.ts). Anything that is not two times in order
 * reads as nothing. It reads; nothing acts on it. */
export async function newsHistory(fromSec: unknown, toSec: unknown): Promise<StoryMark[]> {
  if (typeof fromSec !== 'number' || typeof toSec !== 'number' || !Number.isFinite(fromSec) || !Number.isFinite(toSec) || toSec < fromSec) return []
  const from = Math.max(fromSec, toSec - STORY_HISTORY_MAX_SECONDS)
  try {
    await ensureDictionary()
  } catch {
    return []
  }
  const credibility = new Map<string, number>(FEED_SOURCES.map((source) => [source.id, source.credibility]))
  const marks: StoryMark[] = []
  const kept = new Set<string>()
  for (const { name, month } of await listMonthFiles(newsDir(), FEED_FILE)) {
    if (month < monthKey(from) || month > monthKey(toSec)) continue
    for (const row of await readLines(name)) {
      if (!isStory(row) || kept.has(row.id) || row.publishedAt < from || row.publishedAt > toSec) continue
      kept.add(row.id)
      const seenAt = typeof row.seenAt === 'number' && Number.isFinite(row.seenAt) ? row.seenAt : row.publishedAt
      marks.push(storyMark(readStory({ ...row, seenAt }, dictionary as AssetDictionary, credibility.get(row.source) ?? 0.5, seenAt)))
    }
  }
  return marks.sort((a, b) => a.publishedAt - b.publishedAt || a.id.localeCompare(b.id))
}

/** Opens a story's link in the browser: https, on a feed's own host, and nothing else. */
export async function openStoryLink(url: unknown): Promise<boolean> {
  if (typeof url !== 'string') return false
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return false
  }
  if (parsed.protocol !== 'https:' || !FEED_HOSTS.includes(parsed.hostname)) return false
  await shell.openExternal(parsed.toString())
  return true
}

/** Loads what was read before, reads the feeds, and starts their clock. Called once, from
 * electron/main.ts. */
export async function startNewsFeed(): Promise<void> {
  if (started) return
  started = true
  await load()
  onNewsUpdate(() => void rebuild().catch(() => undefined))
  void readFeeds().catch((error) => console.error('The news feed could not be read:', error))
  setInterval(() => void readFeeds().catch((error) => console.error('The news feed could not be read:', error)), FEED_READ_MS)
}
