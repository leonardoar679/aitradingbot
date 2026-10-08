import { app } from 'electron'
import { mkdir, readFile } from 'fs/promises'
import { join } from 'path'
import type { SymbolInfo } from '../../shared/ipc'
import { stampedConfig } from '../../shared/configMigration'
import { readConfigFile } from './configFiles'
import {
  EVENT_BAR_SECONDS,
  EVENT_COOLDOWN_SECONDS,
  EVENT_LOOKBACK_BARS,
  candidateScore,
  detectEvents,
  isAtLeast,
  marketMoveOf,
  raisesEvent,
  rankCandidates,
  readEventAt,
  toMarketEvent,
  toNewsEvent,
  type EventBand,
  type EventReading,
  type MarketEvent,
  type RaisedEvent
} from '../../shared/marketEvent'
import { MARKET_REFERENCE_SYMBOLS } from '../../shared/aiEventMarket'
import {
  DEFAULT_SCANNER_CONFIG,
  SCANNER_EXCHANGE,
  SCAN_HISTORY_MAX_DAYS,
  SCAN_HISTORY_MAX_PAIRS,
  eventMonthKey,
  isScannerUniverseSize,
  matchesMarketEventFilter,
  nextPassDelayMs,
  parseMarketEventLines,
  pickUniverse,
  spreadPct,
  type MarketEventFilter,
  type MarketEventPage,
  type ScanHistoryProgress,
  type ScanHistoryRequest,
  type ScanHistoryResult,
  type ScannerConfig,
  type ScannerConfigPatch,
  type ScannerPair,
  type ScannerState
} from '../../shared/marketScanner'
import type { NewsItem } from '../../shared/news'
import { newsEventKind } from '../../shared/newsActions'
import { writeJsonAtomic } from './atomicWrite'
import { appendJsonLine, listMonthFiles } from './jsonlStore'
import { cancelHistoricalRangeFetch, fetchHistoricalRange, listSymbols, scanSourceFor } from './marketService'
import { systemFailureNotice } from '../../shared/notices'
import { tell } from './noticeService'

// The market scanner: once a minute, read every watched pair and say what is moving.
//
// IT READS PUBLIC MARKET DATA AND NOTHING ELSE. No key, no model, no order. It lives in the main
// process for the reason the live loops do -- it should not depend on which page is open -- but
// unlike them it touches no money, and leaving it on costs only requests: one for each watched
// pair a minute, a few hundred of the six thousand request-weight an exchange allows.
//
// WHAT IT KEEPS. Every event it raises is appended to marketEvents/events-YYYY-MM.jsonl and never
// rewritten. What followed an event is not stored: it is worked out from candles whenever it is
// looked at, like every other outcome in this app.
//
// ONE PASS AT A TIME. A pass that is still running when the next is due is not joined by a second
// one: the next is scheduled only when this one ends, so a slow exchange makes the scanner late,
// never doubled.

interface WatchedPair extends SymbolInfo {
  quoteVolume24h: number
}

/** The watched set is re-picked this often. Which pairs are the most traded changes by the hour,
 * not by the minute. */
const UNIVERSE_MAX_AGE_SEC = 60 * 60
/** Requests in the air at once within a pass. */
const FETCH_CONCURRENCY = 6
/** Twelve hours of completed bars, the one still forming, and one to spare. */
const CANDLES_PER_READ = EVENT_LOOKBACK_BARS + 2
const RECENT_EVENTS_KEPT = 200
const HISTORY_CONCURRENCY = 3
/** A scan of history starts this far before its first event: the bars the first reading needs,
 * and the cooldown before it, so that a pump already under way when the window opens is not
 * raised as though it had just begun. */
const HISTORY_LEAD_BARS = EVENT_LOOKBACK_BARS + EVENT_COOLDOWN_SECONDS / EVENT_BAR_SECONDS
const EVENT_FILE_PATTERN = /^events-(\d{4}-\d{2})\.jsonl$/
const DEFAULT_EVENT_LIMIT = 200
const MAX_EVENT_LIMIT = 5000

let config: ScannerConfig | null = null
let universe: WatchedPair[] = []
let universeAt = 0
/** The size the watched set was picked for. An exchange can list fewer pairs than were asked
 * for, so the set's own length does not say whether the setting has changed since. */
let universeSize = 0
const pairs = new Map<string, ScannerPair>()
/** Newest first. */
let recentEvents: MarketEvent[] = []
/** The read of what is on file, shared by everyone who asks while it is under way. */
let recentLoading: Promise<void> | null = null
const raised = new Map<string, RaisedEvent[]>()
let lastPassAt: number | null = null
let lastPassMs: number | null = null
let nextPassAt: number | null = null
let failed = 0
let error: string | null = null
let timer: ReturnType<typeof setTimeout> | null = null
/** Passes failing in a row before it is told. */
const FAILING_PASSES_TOLD = 3
let failingPasses = 0
let passInFlight = false
/** The pass started by switching the scanner on, which nothing waits for. */
let background: Promise<unknown> = Promise.resolve()
const listeners = new Set<(state: ScannerState) => void>()

function configPath(): string {
  return join(app.getPath('userData'), 'scanner.json')
}

function eventsDir(): string {
  return join(app.getPath('userData'), 'marketEvents')
}

function sig(value: number): number {
  return Number.isFinite(value) ? Number(value.toPrecision(6)) : 0
}

async function loadConfig(): Promise<ScannerConfig> {
  if (config) return config
  // Read once, through the migration steps it is behind (configFiles.ts).
  const raw = (await readConfigFile('scanner')) as Partial<ScannerConfig>
  // A file holding something unusable is healed rather than obeyed: the scanner is on by default
  // (shared/marketScanner.ts, since 8 October 2026), so only `false` switches it off, and only a
  // size it knows is a size.
  config = {
    enabled: raw.enabled !== false,
    universeSize: isScannerUniverseSize(raw.universeSize) ? raw.universeSize : DEFAULT_SCANNER_CONFIG.universeSize
  }
  return config
}

async function persistConfig(): Promise<void> {
  await mkdir(app.getPath('userData'), { recursive: true })
  await writeJsonAtomic(configPath(), config === null ? config : stampedConfig(config))
}

function snapshot(current: ScannerConfig): ScannerState {
  return {
    config: { ...current },
    exchange: SCANNER_EXCHANGE,
    lastPassAt,
    lastPassMs,
    nextPassAt,
    failed,
    error,
    pairs: [...pairs.values()].sort((a, b) => b.score - a.score || a.symbol.localeCompare(b.symbol)),
    recentEvents: [...recentEvents]
  }
}

function notify(current: ScannerConfig): void {
  const state = snapshot(current)
  for (const listener of listeners) listener(state)
}

export function onScannerUpdate(listener: (state: ScannerState) => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

function remember(event: MarketEvent): void {
  const earlier = (raised.get(event.symbol) ?? []).filter((entry) => event.time - entry.time < EVENT_COOLDOWN_SECONDS)
  earlier.push({ time: event.time, band: event.band })
  raised.set(event.symbol, earlier)
}

/** What is on file from before this session: the newest events for the page, and the last half
 * hour's for the cooldown, so that restarting the app in the middle of a pump does not raise it
 * a second time.
 *
 * EVERY CALLER WAITS FOR THE SAME READ. A flag set before the read had finished handed anyone who
 * asked in the meantime the empty list -- and Overview asks from two cards in the same moment as
 * it opens, so one of them showed no events, and with the scanner off nothing ever corrected it.
 * A read that fails is logged and tried again by the next caller, rather than leaving the page
 * without its history for the rest of the session. */
async function loadRecent(): Promise<void> {
  if (recentLoading === null) {
    recentLoading = listMarketEvents({ limit: RECENT_EVENTS_KEPT }).then(
      (page) => {
        recentEvents = page.rows
        for (const event of [...page.rows].reverse()) remember(event)
      },
      (failure: unknown) => {
        recentLoading = null
        console.error('The market events on file could not be read:', failure)
      }
    )
  }
  return recentLoading
}

async function inBatches<T>(items: T[], concurrency: number, work: (item: T) => Promise<void>): Promise<void> {
  let next = 0
  const worker = async (): Promise<void> => {
    for (;;) {
      const item = items[next++]
      if (item === undefined) return
      await work(item)
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, () => worker()))
}

function pairState(pair: WatchedPair, reading: EventReading, spread: number | null): ScannerPair {
  return {
    symbol: pair.symbol,
    baseAsset: pair.baseAsset,
    quoteAsset: pair.quoteAsset,
    barTime: reading.barTime,
    price: reading.price,
    returnsPct: { m5: sig(reading.returnsPct.m5), m15: sig(reading.returnsPct.m15), h1: sig(reading.returnsPct.h1), h4: sig(reading.returnsPct.h4) },
    volumeRatio: reading.volumeRatio === null ? null : sig(reading.volumeRatio),
    score: sig(reading.score),
    band: reading.band,
    type: reading.type,
    direction: reading.direction,
    quoteVolume24h: pair.quoteVolume24h,
    spreadPct: spread === null ? null : sig(spread)
  }
}

/** One pass: read every watched pair, update what is shown, and raise what qualifies.
 *
 * Returns without doing anything while another pass is running. `nowMs` is the clock the pass
 * reads the market against; it is a parameter so that a test can say what time it is. */
export async function scanOnce(nowMs: number = Date.now()): Promise<ScannerState> {
  const current = await loadConfig()
  if (passInFlight) return snapshot(current)
  passInFlight = true
  const started = Date.now()
  try {
    const source = scanSourceFor(SCANNER_EXCHANGE)
    const nowSec = Math.floor(nowMs / 1000)
    await loadRecent()

    if (universeSize !== current.universeSize || nowSec - universeAt >= UNIVERSE_MAX_AGE_SEC) {
      const [symbols, tickers] = await Promise.all([listSymbols(SCANNER_EXCHANGE), source.fetchAllTickers24h()])
      universe = pickUniverse(symbols, tickers, current.universeSize)
      universeAt = nowSec
      universeSize = current.universeSize
      const watched = new Set(universe.map((pair) => pair.symbol))
      for (const symbol of [...pairs.keys()]) if (!watched.has(symbol)) pairs.delete(symbol)
    }

    // A spread is a gate on a candidate, not something a reading needs: a pass that cannot get
    // the book still reads every pair, and ranks without it.
    const spreads = new Map<string, number | null>()
    try {
      for (const book of await source.fetchBookTickers()) spreads.set(book.symbol, spreadPct(book.bidPrice, book.askPrice))
    } catch {
      spreads.clear()
    }

    const currentMinute = Math.floor(nowSec / EVENT_BAR_SECONDS) * EVENT_BAR_SECONDS
    const fresh: { pair: WatchedPair; reading: EventReading }[] = []
    let failures = 0
    let lastFailure = ''
    await inBatches(universe, FETCH_CONCURRENCY, async (pair) => {
      try {
        const candles = await source.fetchRecentCandles(pair.symbol, '1m', CANDLES_PER_READ)
        // The newest bar an exchange returns is still forming. Its close is not yet a fact.
        const completed = candles.filter((candle) => candle.time + EVENT_BAR_SECONDS <= nowSec)
        const reading = readEventAt(completed, completed.length - 1)
        if (reading === null) {
          failures++
          lastFailure = `${pair.symbol} has no unbroken twelve hours of candles`
          return
        }
        pairs.set(pair.symbol, pairState(pair, reading, spreads.get(pair.symbol) ?? null))
        // A reading of an older minute is still worth showing. It is not worth raising: a call on
        // it would execute on a bar that has already gone.
        if (reading.time === currentMinute) fresh.push({ pair, reading })
      } catch (failure) {
        failures++
        lastFailure = failure instanceof Error ? failure.message : String(failure)
      }
    })

    const candidates = fresh
      .filter(({ pair, reading }) => raisesEvent(reading, raised.get(pair.symbol) ?? []))
      .map(({ pair, reading }) => ({
        symbol: pair.symbol,
        pair,
        reading,
        candidateScore: candidateScore(reading.score, pair.quoteVolume24h, spreads.get(pair.symbol) ?? null)
      }))

    // A MARKET-WIDE MOVE IS ONE EVENT (shared/marketEvent.ts marketMoveOf): raised on Bitcoin's pair
    // from its own reading, ranked first, with the pairs that moved its way written on it; those are
    // still raised and recorded, marked as part of it, and the watch asks about the move alone.
    // Bitcoin's own event, where this pass raised one, becomes the move. One move per cooldown, like
    // any event of Bitcoin's; inside it the pairs are raised as they always were.
    const btc = fresh.find(({ pair }) => pair.symbol === MARKET_REFERENCE_SYMBOLS.btc) ?? null
    const move = marketMoveOf(
      candidates.map((entry) => ({ symbol: entry.symbol, direction: entry.reading.direction, band: entry.reading.band, score: entry.reading.score, returnM15Pct: entry.reading.returnsPct.m15, volumeRatio: entry.reading.volumeRatio })),
      btc === null ? null : { symbol: btc.pair.symbol, returnM15Pct: btc.reading.returnsPct.m15 }
    )
    const btcEarlier = raised.get(MARKET_REFERENCE_SYMBOLS.btc) ?? []
    const moveAllowed = move !== null && btc !== null && !btcEarlier.some((entry) => btc.reading.time - entry.time < EVENT_COOLDOWN_SECONDS && isAtLeast(entry.band, move.band))
    const detectedAt = Math.floor(Date.now() / 1000)
    const liveOf = (pair: WatchedPair, score: number, rank: number): NonNullable<MarketEvent['live']> => {
      const spread = spreads.get(pair.symbol) ?? null
      return { detectedAt, quoteVolume24h: Math.round(pair.quoteVolume24h), spreadPct: spread === null ? null : sig(spread), candidateScore: sig(score), rank }
    }
    const record = async (event: MarketEvent): Promise<void> => {
      remember(event)
      recentEvents = [event, ...recentEvents].slice(0, RECENT_EVENTS_KEPT)
      await appendJsonLine(join(eventsDir(), `events-${eventMonthKey(event.time)}.jsonl`), event)
    }
    let marketEventId: string | null = null
    if (moveAllowed && move !== null && btc !== null) {
      const event = toMarketEvent(
        { ...btc.reading, type: 'market_move', direction: move.direction, band: move.band },
        { exchange: SCANNER_EXCHANGE, symbol: btc.pair.symbol, baseAsset: btc.pair.baseAsset, quoteAsset: btc.pair.quoteAsset },
        { ...liveOf(btc.pair, candidateScore(btc.reading.score, btc.pair.quoteVolume24h, spreads.get(btc.pair.symbol) ?? null), 1), members: move.members }
      )
      await record(event)
      marketEventId = event.id
    }
    const members = new Set(marketEventId === null || move === null ? [] : move.members.map((member) => member.symbol))
    const rest = marketEventId === null ? candidates : candidates.filter((entry) => entry.symbol !== MARKET_REFERENCE_SYMBOLS.btc)
    for (const entry of rankCandidates(rest)) {
      const live = liveOf(entry.pair, entry.candidateScore, marketEventId === null ? entry.rank : entry.rank + 1)
      const event = toMarketEvent(
        entry.reading,
        { exchange: SCANNER_EXCHANGE, symbol: entry.pair.symbol, baseAsset: entry.pair.baseAsset, quoteAsset: entry.pair.quoteAsset },
        marketEventId !== null && members.has(entry.symbol) ? { ...live, marketMove: marketEventId } : live
      )
      await record(event)
    }

    failed = failures
    error = universe.length > 0 && failures === universe.length ? `No pair could be read. ${lastFailure}` : null
  } catch (failure) {
    error = failure instanceof Error ? failure.message : String(failure)
  } finally {
    passInFlight = false
    lastPassAt = Math.floor(Date.now() / 1000)
    lastPassMs = Date.now() - started
  }
  // Three passes failing running are told once (SYSTEM_FAILURE); one pass is the market's noise.
  failingPasses = error === null ? 0 : failingPasses + 1
  if (failingPasses === FAILING_PASSES_TOLD) tell(systemFailureNotice('scanner', `${error ?? 'The pass failed.'} Three passes running; the next is tried as usual.`))
  notify(current)
  return snapshot(current)
}

function schedule(): void {
  if (timer !== null) return
  const delay = nextPassDelayMs(Date.now())
  nextPassAt = Math.floor((Date.now() + delay) / 1000)
  timer = setTimeout(() => {
    timer = null
    void scanOnce()
      .catch((failure) => console.error('Market scanner pass failed:', failure))
      .finally(() => {
        // Read again rather than captured: the scanner may have been switched off mid-pass.
        if (config?.enabled) schedule()
        else nextPassAt = null
        // The pass told its listeners what it read before the next one had a time. Tell them
        // that too, or the page counts down to a moment already gone.
        if (config) notify(config)
      })
  }, delay)
}

function unschedule(): void {
  if (timer !== null) clearTimeout(timer)
  timer = null
  nextPassAt = null
}

/** Raises the event a delisting announcement makes for one coin it names (shared/marketEvent.ts,
 * toNewsEvent), the way a pass raises its own: kept in the events file, put first among the recent
 * ones, and passed to everyone listening -- which is how the watch hears of it. Its reading is the
 * coin's market at the minute the announcement was read, read from the coin's own candles here.
 *
 * Called by the news reader only (electron/services/newsService.ts), from an announcement it read
 * itself, and whatever the scanner's own switch says. Null when there is nothing to raise: the coin
 * has no USDT pair, its candles do not make a reading, or an event of that coin at that minute has
 * already been raised. It counts toward the coin's cooldown like any event: one move, one event. */
export async function raiseNewsEvent(item: NewsItem, ticker: string, nowMs: number = Date.now()): Promise<MarketEvent | null> {
  const type = newsEventKind(item)
  if (type === null) return null
  const current = await loadConfig()
  await loadRecent()
  const symbol = `${ticker}USDT`
  const pair = (await listSymbols(SCANNER_EXCHANGE)).find((entry) => entry.symbol === symbol)
  if (pair === undefined) return null
  const nowSec = Math.floor(nowMs / 1000)
  const candles = await scanSourceFor(SCANNER_EXCHANGE).fetchRecentCandles(symbol, '1m', CANDLES_PER_READ)
  // The newest bar an exchange returns is still forming, as in a pass.
  const completed = candles.filter((candle) => candle.time + EVENT_BAR_SECONDS <= nowSec)
  const reading = readEventAt(completed, completed.length - 1)
  if (reading === null) return null
  const event = toNewsEvent(
    reading,
    { exchange: SCANNER_EXCHANGE, symbol, baseAsset: pair.baseAsset, quoteAsset: pair.quoteAsset },
    { detectedAt: nowSec, quoteVolume24h: null, spreadPct: null, candidateScore: sig(reading.score), rank: 1 },
    { articleId: item.id, title: item.title, releaseSec: item.releaseSec },
    type
  )
  if (recentEvents.some((existing) => existing.id === event.id)) return null
  remember(event)
  recentEvents = [event, ...recentEvents].slice(0, RECENT_EVENTS_KEPT)
  await appendJsonLine(join(eventsDir(), `events-${eventMonthKey(event.time)}.jsonl`), event)
  notify(current)
  return event
}

/** Called once at startup. Starts the loop only if it was left switched on. */
export async function startMarketScanner(): Promise<void> {
  const current = await loadConfig()
  if (current.enabled) schedule()
}

export async function getScannerState(): Promise<ScannerState> {
  const current = await loadConfig()
  await loadRecent()
  return snapshot(current)
}

export async function setScannerConfig(patch: ScannerConfigPatch): Promise<ScannerState> {
  const current = await loadConfig()
  if (patch.universeSize !== undefined) {
    if (!isScannerUniverseSize(patch.universeSize)) throw new Error('The scanner watches 20, 40, 60 or 100 pairs')
    current.universeSize = patch.universeSize
  }
  if (patch.enabled !== undefined) {
    if (typeof patch.enabled !== 'boolean') throw new Error('The scanner is either on or off')
    current.enabled = patch.enabled
  }
  const switchedOn = current.enabled && timer === null
  await persistConfig()
  if (current.enabled) schedule()
  else unschedule()
  await loadRecent()
  notify(current)
  // Switched on by a person looking at an empty table: read the market now rather than leave
  // them waiting for the minute to end. The passes after it keep to the clock.
  if (switchedOn) background = scanOnce().catch((failure) => console.error('Market scanner pass failed:', failure))
  return snapshot(current)
}

/** Test seam: resolves once the pass that switching on started has finished. */
export async function whenScannerSettled(): Promise<void> {
  await background
}

/** The pairs a scan of history would cover: the `size` most traded now. Two public requests,
 * and nothing is kept: the running scanner picks its own set, on its own clock. */
export async function pickScannerUniverse(size: number): Promise<WatchedPair[]> {
  if (!Number.isInteger(size) || size < 1 || size > SCAN_HISTORY_MAX_PAIRS) {
    throw new Error(`A scan covers between 1 and ${SCAN_HISTORY_MAX_PAIRS} pairs`)
  }
  const source = scanSourceFor(SCANNER_EXCHANGE)
  const [symbols, tickers] = await Promise.all([listSymbols(SCANNER_EXCHANGE), source.fetchAllTickers24h()])
  return pickUniverse(symbols, tickers, size)
}

/** Events on file, newest first, reading month files backwards and stopping when enough are found. */
export async function listMarketEvents(filter: MarketEventFilter): Promise<MarketEventPage> {
  const requested = Math.floor(filter.limit ?? DEFAULT_EVENT_LIMIT)
  const limit = Math.min(MAX_EVENT_LIMIT, Math.max(1, Number.isFinite(requested) ? requested : DEFAULT_EVENT_LIMIT))
  const oldestMonth = filter.sinceSec !== undefined ? eventMonthKey(filter.sinceSec) : null
  const rows: MarketEvent[] = []
  let skippedLines = 0
  for (const { name, month } of await listMonthFiles(eventsDir(), EVENT_FILE_PATTERN)) {
    if (oldestMonth !== null && month < oldestMonth) break
    const parsed = parseMarketEventLines(await readFile(join(eventsDir(), name), 'utf-8'))
    skippedLines += parsed.skipped
    for (let i = parsed.rows.length - 1; i >= 0; i--) {
      if (!matchesMarketEventFilter(parsed.rows[i], filter)) continue
      rows.push(parsed.rows[i])
      if (rows.length >= limit) return { rows, skippedLines }
    }
  }
  return { rows, skippedLines }
}

// ---------------------------------------------------------------------------------------------
// A scan of history: the events a running scanner would have raised over a stretch of the past.
// Free, like everything here, and bounded, because it is forty-four requests a pair a month.

const HISTORY_FLOORS: readonly EventBand[] = ['watch', 'candidate', 'urgent']
/** A scan in progress: whether it has been told to stop, and the candle fetches it has in the air. */
const historyScans = new Map<string, { cancelled: boolean; fetches: Set<string> }>()

function isPair(value: unknown): value is SymbolInfo {
  if (typeof value !== 'object' || value === null) return false
  const pair = value as Record<string, unknown>
  return typeof pair.symbol === 'string' && pair.symbol !== '' && typeof pair.baseAsset === 'string' && typeof pair.quoteAsset === 'string'
}

export async function scanHistory(request: ScanHistoryRequest, onProgress: (progress: ScanHistoryProgress) => void): Promise<ScanHistoryResult> {
  if (typeof request?.requestId !== 'string' || request.requestId === '') throw new Error('A history scan needs an id')
  if (!Array.isArray(request.pairs) || request.pairs.length === 0 || !request.pairs.every(isPair)) throw new Error('A history scan needs at least one pair')
  if (request.pairs.length > SCAN_HISTORY_MAX_PAIRS) throw new Error(`A history scan covers at most ${SCAN_HISTORY_MAX_PAIRS} pairs`)
  const nowSec = Math.floor(Date.now() / 1000)
  const { startSec, endSec } = request
  if (!Number.isFinite(startSec) || !Number.isFinite(endSec) || !(startSec < endSec)) throw new Error('A history scan needs a start before its end')
  if (endSec - startSec > SCAN_HISTORY_MAX_DAYS * 86_400) throw new Error(`A history scan covers at most ${SCAN_HISTORY_MAX_DAYS} days`)
  if (endSec > nowSec) throw new Error('A history scan cannot end in the future')
  const floor = request.floor ?? 'candidate'
  if (!HISTORY_FLOORS.includes(floor)) throw new Error('A history scan raises events at watch, candidate or urgent')

  const scan = { cancelled: false, fetches: new Set<string>() }
  historyScans.set(request.requestId, scan)
  const events: MarketEvent[] = []
  const failures: { symbol: string; error: string }[] = []
  let pairsDone = 0
  try {
    await inBatches(request.pairs, HISTORY_CONCURRENCY, async (pair) => {
      if (scan.cancelled) return
      const fetchId = `${request.requestId}:${pair.symbol}`
      scan.fetches.add(fetchId)
      const report = (candlesDone: number, candlesTotal: number): void =>
        onProgress({ requestId: request.requestId, pairsDone, pairsTotal: request.pairs.length, symbol: pair.symbol, candlesDone, candlesTotal })
      try {
        const fetched = await fetchHistoricalRange(
          SCANNER_EXCHANGE,
          pair.symbol,
          '1m',
          startSec - HISTORY_LEAD_BARS * EVENT_BAR_SECONDS,
          endSec,
          fetchId,
          report
        )
        // A cancelled fetch is a prefix of what was asked for. Scanning it would report a
        // stretch with fewer events than it had, as though that were the whole answer.
        if (fetched.cancelled || scan.cancelled) return
        const completed = fetched.candles.filter((candle) => candle.time + EVENT_BAR_SECONDS <= nowSec)
        for (const reading of detectEvents(completed, { from: startSec, to: endSec, floor })) {
          events.push(toMarketEvent(reading, { exchange: SCANNER_EXCHANGE, symbol: pair.symbol, baseAsset: pair.baseAsset, quoteAsset: pair.quoteAsset }))
        }
      } catch (failure) {
        failures.push({ symbol: pair.symbol, error: failure instanceof Error ? failure.message : String(failure) })
      } finally {
        scan.fetches.delete(fetchId)
        pairsDone++
        report(0, 0)
      }
    })
  } finally {
    historyScans.delete(request.requestId)
  }
  events.sort((a, b) => a.time - b.time || a.symbol.localeCompare(b.symbol))
  return { events, cancelled: scan.cancelled, failed: failures }
}

export function cancelScanHistory(requestId: string): void {
  const scan = historyScans.get(requestId)
  if (!scan) return
  scan.cancelled = true
  for (const fetchId of scan.fetches) cancelHistoricalRangeFetch(fetchId)
}
