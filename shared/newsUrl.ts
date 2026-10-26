import type { PublicationTime } from './articleTime'
import type { CredibilityClass } from './articleCredibility'
import type { Candle } from './ipc'
import type { NewsEventType, Relationship } from './newsFeed'

// A PASTED NEWS LINK, ON FILE (V8 Stage 4, 26 October 2026). The News URLs page reads a link a person pastes -- or,
// passively, an announcement or a story of impact 70 or more the app already has -- and keeps what it found as one
// record: the link as cut down and the hash of what was pasted; how its text was had (read from the page, the news
// feed's copy, Binance's list, or text the person supplied, said as such); when it was published and how sure that is;
// who says it; the coins it names in its title and in its body, those refused and why; what each coin's price did from a
// day before it to four hours after, measured until that span has passed; the verdict at the paste -- a card where a
// measured source has one, otherwise "No profitable opportunity identified" -- and every prediction and paper trade a
// person made from it; with a trail of what happened when. One line a change, the last for an id the record's state
// (news/urls-YYYY-MM.jsonl, never swept). Arithmetic and types: nothing here fetches or places anything.

export const URL_RECORD_VERSION = 'url-record-v1'

export const NEWS_URL_LINES = {
  version: URL_RECORD_VERSION,
  /** The coins kept, direct ones first. */
  maxCoins: 5,
  /** A coin's pair must have traded this much in a day, in USDT, to be read. */
  minDayQuote: 1_000_000,
  /** The price is read from a day before publication to four hours after, and the record is final two minutes past. */
  beforeSec: 86_400,
  afterSec: 4 * 3600,
  finalGraceSec: 120,
  /** The worker's deadline for reading a page's HTML. */
  extractTimeoutMs: 5000,
  /** A story of the app's own feed is recorded passively at this impact or more, naming a coin directly. */
  passiveImpact: 70
} as const

export type UrlOrigin = 'manual' | 'automatic'
export type Retrieval = 'fetched' | 'feed' | 'announcement' | 'supplied' | 'x-post' | 'none'

export type UrlStatus = 'refused' | 'read' | 'not-read' | 'extracted' | 'timed' | 'coins' | 'priced' | 'final' | 'pasted-again' | 'view' | 'discovered' | 'looked-up'

export interface TrailEntry {
  at: number
  status: UrlStatus
  note: string
}

export interface UrlCoin {
  ticker: string
  relationship: Relationship
  pair: string
  venue: 'binance' | 'bitget'
}

export interface UrlRejectedCoin {
  ticker: string
  why: 'no-pair' | 'thin' | 'over-cap'
}

/** What a coin's price did around the publication: from a day before it, and to each mark after it, signed, in
 * percent from the last close before it; final once the four hours have passed and been read. */
export interface UrlReaction {
  pair: string
  refPrice: number | null
  beforePct: number | null
  afterPct: { m5: number | null; m15: number | null; h1: number | null; h4: number | null }
  final: boolean
}

export interface UrlRecord {
  v: typeof URL_RECORD_VERSION
  id: string
  origin: UrlOrigin
  /** When it was first pasted (or discovered), in seconds. */
  at: number
  url: string
  originalHash: string
  host: string
  credibility: CredibilityClass
  /** A Binance announcement verified in Binance's own list: its id, title and release. */
  binance: { code: string; articleId: number; title: string; releaseSec: number; delisting: boolean } | null
  retrieval: Retrieval
  readFailure: string | null
  finalUrl: string | null
  readAt: number | null
  title: string | null
  siteName: string | null
  author: string | null
  canonical: string | null
  /** The hash of the text read, and the text in numbered snippets, kept for a reading of it. */
  bodyHash: string | null
  snippets: { n: number; text: string }[]
  time: PublicationTime | null
  kind: NewsEventType
  /** Other stories of the feed telling the same thing, and their sources. */
  corroboration: { stories: number; sources: string[] }
  coins: UrlCoin[]
  rejected: UrlRejectedCoin[]
  reactions: UrlReaction[]
  /** The verdict at the paste: the cards of its coins, or none and why. */
  verdict: { cards: string[]; none: string | null }
  /** The predictions and paper trades a person made from it. */
  predictionIds: string[]
  executorIds: string[]
  /** A reading of it by a model (V8 Stage 5), by id. */
  analysisId: string | null
  /** The lookups made after the paste (V8 Stage 5): the Internet Archive's first capture of the link, an upper bound on
   * its publication; and a post on X's author from X's own embed endpoint. Absent on a record made before them. */
  lookups?: UrlLookups
  trail: TrailEntry[]
}

export interface UrlLookups {
  archive: { status: 'found' | 'none' | 'off' | 'failed'; firstSec: number | null; note: string | null } | null
  x: { status: 'found' | 'failed'; name: string | null; url: string | null } | null
}

/** An Internet Archive capture's timestamp, YYYYMMDDhhmmss in UTC, as Unix seconds; null where it is not one. */
export function archiveStampSec(stamp: string): number | null {
  const match = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})$/.exec(stamp)
  if (match === null) return null
  const [, y, mo, d, h, mi, s] = match.map(Number)
  const ms = Date.UTC(y, mo - 1, d, h, mi, s)
  return Number.isFinite(ms) ? Math.floor(ms / 1000) : null
}

/** What the Archive's first capture says of a stated publication time: none to say, or that the page was there an hour
 * or more before the time it states (its stated time a later edit's, or wrong). */
export function archiveNote(firstSec: number | null, publishedSec: number | null): string | null {
  if (firstSec === null || publishedSec === null) return null
  return firstSec < publishedSec - 3600 ? "The Internet Archive captured the page before the time it states: its stated time may be a later edit's." : null
}

/** A record's id: the first sixteen hex characters of its link's SHA-256, so that the same link is one record. */
export const urlRecordId = (url: string, sha256: (text: string) => string): string => sha256(url).slice(0, 16)

/** The close of the one-minute bar that closed at or before `atSec`; null where the bars do not reach it. */
export function closeBefore(bars: readonly Candle[], atSec: number): number | null {
  let best: Candle | null = null
  for (const bar of bars) {
    if (bar.time + 60 <= atSec && (best === null || bar.time > best.time) && bar.close > 0) best = bar
  }
  // A close more than five minutes before is not the price at the moment.
  return best !== null && atSec - (best.time + 60) <= 300 ? best.close : null
}

/** A coin's price around a publication, from its one-minute bars. */
export function reactionOf(pair: string, publishedSec: number, bars: readonly Candle[], nowSec: number, lines: typeof NEWS_URL_LINES = NEWS_URL_LINES): UrlReaction {
  const ref = closeBefore(bars, publishedSec)
  const pct = (atSec: number): number | null => {
    if (ref === null || atSec > nowSec) return null
    const close = closeBefore(bars, atSec)
    return close === null ? null : (close / ref - 1) * 100
  }
  const dayBefore = closeBefore(bars, publishedSec - lines.beforeSec)
  const afterPct = { m5: pct(publishedSec + 300), m15: pct(publishedSec + 900), h1: pct(publishedSec + 3600), h4: pct(publishedSec + lines.afterSec) }
  return {
    pair,
    refPrice: ref,
    beforePct: ref === null || dayBefore === null ? null : (ref / dayBefore - 1) * 100,
    afterPct,
    final: nowSec >= publishedSec + lines.afterSec + lines.finalGraceSec && afterPct.h4 !== null
  }
}

/** A stored line read as a record; null for a line this version does not know. */
export function readUrlRecord(value: unknown): UrlRecord | null {
  if (typeof value !== 'object' || value === null) return null
  const line = value as Partial<UrlRecord>
  if (line.v !== URL_RECORD_VERSION || typeof line.id !== 'string' || typeof line.url !== 'string' || !Array.isArray(line.trail)) return null
  return line as UrlRecord
}

/** The records from their lines, each id's last line its state, newest paste first. */
export function foldUrlRecords(lines: readonly unknown[]): UrlRecord[] {
  const byId = new Map<string, UrlRecord>()
  for (const raw of lines) {
    const record = readUrlRecord(raw)
    if (record !== null) byId.set(record.id, record)
  }
  return [...byId.values()].sort((a, b) => b.at - a.at)
}
