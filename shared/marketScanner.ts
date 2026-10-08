import type { Exchange, SymbolInfo, Ticker24h } from './ipc'
import { EVENT_STATUSES, isAtLeast, isScannablePair, type EventBand, type EventDirection, type EventLife, type EventStatusLine, type MarketEvent, type MarketEventType } from './marketEvent'

// What the scanner watches and what it reports. The detection itself is shared/marketEvent.ts;
// the loop that fetches the candles is electron/services/marketScannerService.ts. This file is
// the part both sides of the bridge need: the settings, the shape of a pass's result, and the few
// decisions that are arithmetic rather than I/O.
//
// THE SCANNER READS PUBLIC MARKET DATA AND NOTHING ELSE. It holds no key, asks no model and
// places nothing. Leaving it on costs requests to an exchange, which are free and counted.

/** The one exchange whose whole market can be read in a request or two. */
export const SCANNER_EXCHANGE: Exchange = 'binance'
/** Every watched pair is quoted in this, so that their volumes can be ranked against each other. */
export const SCANNER_QUOTE_ASSET = 'USDT'

export const SCANNER_UNIVERSE_SIZES = [20, 40, 60, 100] as const
export const DEFAULT_SCANNER_UNIVERSE = 60

/** How long after a minute closes the scanner waits before reading it. An exchange needs a moment
 * to finish the bar; read too early, the "last completed bar" is the one before. */
export const SCANNER_SETTLE_MS = 5_000

export interface ScannerConfig {
  enabled: boolean
  /** How many pairs are watched: the most traded ones, by the last 24 hours. */
  universeSize: number
}

export interface ScannerConfigPatch {
  enabled?: boolean
  universeSize?: number
}

/** On from the first launch since 8 October 2026 (the V5 document, §130: abnormal moves are
 * detected by themselves): it reads public data, costs no money and asks nothing; the watch, which
 * asks, is a switch of its own and stays off. Only `false` in the file switches it off. */
export const DEFAULT_SCANNER_CONFIG: ScannerConfig = { enabled: true, universeSize: DEFAULT_SCANNER_UNIVERSE }

export function isScannerUniverseSize(value: unknown): value is (typeof SCANNER_UNIVERSE_SIZES)[number] {
  return (SCANNER_UNIVERSE_SIZES as readonly unknown[]).includes(value)
}

/** One watched pair as of the last pass that read it. */
export interface ScannerPair {
  symbol: string
  baseAsset: string
  quoteAsset: string
  /** Open time of the bar the reading was taken at. A pair whose last request failed keeps its
   * previous reading, and this is how that shows. */
  barTime: number
  price: number
  returnsPct: { m5: number; m15: number; h1: number; h4: number }
  volumeRatio: number | null
  score: number
  band: EventBand
  type: MarketEventType | null
  direction: EventDirection
  quoteVolume24h: number | null
  spreadPct: number | null
}

export interface ScannerState {
  config: ScannerConfig
  exchange: Exchange
  /** Wall-clock seconds when the last pass finished, and how long it took. Null before the first. */
  lastPassAt: number | null
  lastPassMs: number | null
  /** Wall-clock seconds when the next pass is due. Null while the scanner is off. */
  nextPassAt: number | null
  /** Pairs the last pass could not read. They keep their previous reading. */
  failed: number
  /** Why the last pass could not run at all, or null when it did. */
  error: string | null
  /** Strongest first. */
  pairs: ScannerPair[]
  /** Newest first: what this session has raised, and what was on file when it started. */
  recentEvents: MarketEvent[]
  /** Where each recent event stands in its life (shared/marketEvent.ts nextEventLife), by id; an
   * event raised more than two hours ago is no longer listed. Since 8 October 2026. */
  lives: Record<string, EventLife>
}

export interface MarketEventFilter {
  /** Events at or after this time. */
  sinceSec?: number
  symbol?: string
  minBand?: EventBand
  limit?: number
}

export interface MarketEventPage {
  rows: MarketEvent[]
  /** Lines that could not be read. Reported rather than swallowed, like the call ledger's. */
  skippedLines: number
}

export interface ScanHistoryRequest {
  requestId: string
  pairs: SymbolInfo[]
  /** Events whose call would execute in [startSec, endSec). */
  startSec: number
  endSec: number
  /** The lowest band raised. Absent means candidate, which is what the live scanner raises. */
  floor?: EventBand
}

export interface ScanHistoryProgress {
  requestId: string
  pairsDone: number
  pairsTotal: number
  /** The pair being read, and how far its candles have got. */
  symbol: string
  candlesDone: number
  candlesTotal: number
}

export interface ScanHistoryResult {
  /** Oldest first. `live` is null on every one: none of them was raised by a running scanner. */
  events: MarketEvent[]
  cancelled: boolean
  /** Pairs whose history could not be read, each with why. The others are still scanned. */
  failed: { symbol: string; error: string }[]
}

/** The longest stretch one history scan covers, and the most pairs. A scan is free, but it is
 * forty-four requests a pair a month, and an unbounded one is an afternoon of them. */
export const SCAN_HISTORY_MAX_DAYS = 90
export const SCAN_HISTORY_MAX_PAIRS = 100

/** Requests a history scan will make: one per thousand 1-minute candles, per pair. Shown before
 * it starts, so that "free" is not mistaken for "instant". */
export function scanHistoryRequests(pairs: number, startSec: number, endSec: number, lookbackBars: number): number {
  const bars = Math.max(0, Math.ceil((endSec - startSec) / 60)) + lookbackBars
  return pairs * Math.ceil(bars / 1000)
}

/** The watched set: the `size` most traded pairs quoted in USDT that are not pegged to anything and
 * do not track a stock (isScannablePair). Ties are broken by name, so the same tickers always give
 * the same set. */
export function pickUniverse(symbols: SymbolInfo[], tickers: Ticker24h[], size: number): (SymbolInfo & { quoteVolume24h: number })[] {
  const volumeBySymbol = new Map(tickers.map((ticker) => [ticker.symbol, ticker.quoteVolume]))
  return symbols
    .filter((pair) => isScannablePair(pair, SCANNER_QUOTE_ASSET))
    .map((pair) => ({ ...pair, quoteVolume24h: volumeBySymbol.get(pair.symbol) ?? NaN }))
    .filter((pair) => Number.isFinite(pair.quoteVolume24h) && pair.quoteVolume24h > 0)
    .sort((a, b) => b.quoteVolume24h - a.quoteVolume24h || a.symbol.localeCompare(b.symbol))
    .slice(0, Math.max(0, Math.floor(size)))
}

/** Best ask over best bid, in percent of the mid. Null for a book with a side missing or crossed,
 * which is a book that says nothing about what a fill would cost. */
export function spreadPct(bidPrice: number, askPrice: number): number | null {
  if (!(bidPrice > 0) || !(askPrice > 0) || askPrice < bidPrice) return null
  return ((askPrice - bidPrice) / ((askPrice + bidPrice) / 2)) * 100
}

/** Milliseconds from `nowMs` until the next pass is due: the settle time after the next minute
 * closes. Never less than the settle time itself, so a pass that ends one second before a minute
 * boundary does not read that minute a second later. */
export function nextPassDelayMs(nowMs: number): number {
  const intoMinute = nowMs % 60_000
  return 60_000 - intoMinute + SCANNER_SETTLE_MS
}

/** `2026-10`, the UTC month an event is filed under. */
export function eventMonthKey(unixSeconds: number): string {
  return new Date(unixSeconds * 1000).toISOString().slice(0, 7)
}

const BANDS: readonly string[] = ['quiet', 'watch', 'candidate', 'urgent']

export function isMarketEvent(value: unknown): value is MarketEvent {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const row = value as Record<string, unknown>
  return (
    typeof row.id === 'string' &&
    typeof row.symbol === 'string' &&
    typeof row.time === 'number' &&
    typeof row.type === 'string' &&
    typeof row.band === 'string' &&
    BANDS.includes(row.band) &&
    typeof row.score === 'number' &&
    typeof row.price === 'number' &&
    typeof row.components === 'object' &&
    row.components !== null
  )
}

/** Reads an events file's text, oldest first. A line that does not parse is counted and skipped,
 * never thrown on: the realistic cause is one torn final line, and refusing the file for it would
 * hide every event above it. */
export function parseMarketEventLines(text: string): { rows: MarketEvent[]; skipped: number } {
  const rows: MarketEvent[] = []
  let skipped = 0
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue
    try {
      const parsed: unknown = JSON.parse(line)
      if (isMarketEvent(parsed)) rows.push(parsed)
      else skipped++
    } catch {
      skipped++
    }
  }
  return { rows, skipped }
}

/** Reads a status file's text (marketEvents/status-YYYY-MM.jsonl), oldest first, skipping what
 * does not parse, as the events file is read. */
export function parseEventStatusLines(text: string): EventStatusLine[] {
  const out: EventStatusLine[] = []
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue
    try {
      const row = JSON.parse(line) as Partial<EventStatusLine> | null
      if (
        row !== null &&
        typeof row === 'object' &&
        row.kind === 'status' &&
        typeof row.eventId === 'string' &&
        typeof row.status === 'string' &&
        (EVENT_STATUSES as readonly string[]).includes(row.status) &&
        typeof row.at === 'number' &&
        typeof row.score === 'number' &&
        typeof row.m15Pct === 'number'
      ) {
        out.push({ kind: 'status', eventId: row.eventId, status: row.status, passes: typeof row.passes === 'number' ? row.passes : 0, at: row.at, score: row.score, m15Pct: row.m15Pct })
      }
    } catch {
      // A torn line, skipped like an event's.
    }
  }
  return out
}

export function matchesMarketEventFilter(event: MarketEvent, filter: MarketEventFilter): boolean {
  if (filter.sinceSec !== undefined && event.time < filter.sinceSec) return false
  if (filter.symbol !== undefined && event.symbol.toUpperCase() !== filter.symbol.toUpperCase()) return false
  if (filter.minBand !== undefined && !isAtLeast(event.band, filter.minBand)) return false
  return true
}
