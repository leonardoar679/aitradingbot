import { btcMoveAgainst } from './aiWatchPaper'
import type { Candle, ExecutorSide, PositionExecutorParams } from './ipc'
import { spreadPct } from './marketScanner'

// LIVE PRICES: WHAT A PAIR TRADES AT NOW, AS AGAINST WHAT ITS LAST CANDLE CLOSED AT.
//
// The second V3 document (§7, §8, §25, §42): candles are context, the stream is current reality,
// and a recommendation is checked against the live price before anything follows it. The main
// process's liveMarketService.ts holds one public socket to Binance's market-data host, and this
// file is the arithmetic on what it holds: the spread, how old a price is, how good the conditions
// are to execute in (a score from 0 to 100, with its reasons), and whether a recommendation can be
// entered now, has to wait for its range, or no longer stands.
//
// THE MODELS' QUESTION IS NOT CHANGED BY IT. That question is built from completed candles only,
// so that a benchmark replaying an old event asks exactly what the watch asked live; a live bid and
// ask cannot be had for a replay. The live price is used after the answer instead: here, and where
// the watch decides whether to open a paper trade on it (src/agents/watchPaperTrade.ts).
//
// IT READS. Nothing here places, sizes or arms anything.

export const LIVE_MARKET_VERSION = 'live-v1'
/** The widest spread a trade is entered at: the document's default for a conservative product. */
export const MAX_SPREAD_PCT = 0.1
/** A spread this tight or tighter scores full marks: what the most liquid pairs quote. */
export const TIGHT_SPREAD_PCT = 0.02
/** A price older than this is not the price now. */
export const STALE_PRICE_MS = 10_000
/** Prices younger than this score full marks for freshness. */
const FRESH_PRICE_MS = 2_000
/** How often what the stream holds is sent to the window: four times a second at most. */
export const LIVE_PUSH_MS = 250
/** Pairs whose five best levels are read; the rest have the best bid and ask only. */
export const LIVE_MAX_DEPTH_PAIRS = 5
/** Pairs the window may ask the stream for at once, besides Bitcoin and ether. */
export const LIVE_MAX_INTEREST = 12

export interface LiveBook {
  symbol: string
  bid: number
  bidQty: number
  ask: number
  askQty: number
  /** When it was received, in milliseconds. */
  updatedAt: number
  /** From the stream, or read once from the data host because the stream did not have it yet. */
  source: 'stream' | 'rest'
}

export interface LiveDepth {
  symbol: string
  /** Price and quantity, best first. */
  bids: [number, number][]
  asks: [number, number][]
  updatedAt: number
}

/** A 1-minute candle from the stream: the minutes that closed, and the one forming. */
export interface LiveMinute extends Candle {
  closed: boolean
}

export interface LiveConnection {
  /** Whether the socket is open now. */
  open: boolean
  connects: number
  /** Times the socket closed or stopped answering while it was wanted. */
  drops: number
  /** When the last message arrived, in milliseconds. Null before the first. */
  lastMessageAt: number | null
  /** Stretches with no message for more than a minute while streams were wanted, oldest first:
   * from and to, in seconds. The last may still be open (`to` null). */
  gaps: { from: number; to: number | null }[]
  /** The data host the socket is on, by name; null before one is opened. */
  host: string | null
  /** Times the socket was moved to another host because it could not connect. */
  hostSwitches: number
  /** Times the data host for REST requests moved, in the main process, since the app started. */
  dataHostSwitches: number
}

export interface LiveState {
  books: Record<string, LiveBook>
  depth: Record<string, LiveDepth>
  /** The last ten minutes of each pair streamed, oldest first. */
  minutes: Record<string, LiveMinute[]>
  /** Bitcoin's minutes over the last two hours, for how far it has moved since an event. */
  btcMinutes: LiveMinute[]
  connection: LiveConnection
}

export function emptyLiveState(): LiveState {
  return { books: {}, depth: {}, minutes: {}, btcMinutes: [], connection: { open: false, connects: 0, drops: 0, lastMessageAt: null, gaps: [], host: null, hostSwitches: 0, dataHostSwitches: 0 } }
}

export function bookSpreadPct(book: Pick<LiveBook, 'bid' | 'ask'>): number | null {
  return spreadPct(book.bid, book.ask)
}

export function priceAgeMs(book: Pick<LiveBook, 'updatedAt'>, nowMs: number): number {
  return Math.max(0, nowMs - book.updatedAt)
}

export function isStale(book: Pick<LiveBook, 'updatedAt'>, nowMs: number): boolean {
  return priceAgeMs(book, nowMs) > STALE_PRICE_MS
}

/** What a market fill on `side` pays: the ask for a buy, the bid for a sell. */
export function fillPrice(book: Pick<LiveBook, 'bid' | 'ask'>, side: ExecutorSide): number {
  return side === 'buy' ? book.ask : book.bid
}

const clamp01 = (value: number): number => Math.min(1, Math.max(0, value))

export interface ExecutionQuality {
  /** 0 to 100: the spread's half, the depth's three tenths and freshness's fifth. */
  score: number
  spreadPct: number | null
  /** What the side a fill would take holds, in the quote: the five best levels where they are
   * read, the best one otherwise. */
  depthQuote: number | null
  ageMs: number | null
  /** What held it down, in words; empty at full marks. */
  reasons: string[]
}

const short = (value: number): string => Number(value.toPrecision(4)).toLocaleString('en-US')

/** How good the conditions are to execute in, now, for a stake of `stakeQuote` on `side`. */
export function executionQuality(input: { book: LiveBook | null; depth?: LiveDepth | null; side: ExecutorSide; stakeQuote: number; nowMs: number }): ExecutionQuality {
  const { book } = input
  if (book === null) return { score: 0, spreadPct: null, depthQuote: null, ageMs: null, reasons: ['no live price'] }
  const reasons: string[] = []
  const spread = bookSpreadPct(book)
  // Full marks up to a tight spread, nothing at the line a trade is entered at, straight between.
  const spreadPart = spread === null ? 0 : clamp01(1 - (spread - TIGHT_SPREAD_PCT) / (MAX_SPREAD_PCT - TIGHT_SPREAD_PCT))
  if (spread === null) reasons.push('the book is one-sided or crossed')
  else if (spread > MAX_SPREAD_PCT / 2) reasons.push(`spread ${spread.toFixed(3)}%${spread > MAX_SPREAD_PCT ? `, over the ${MAX_SPREAD_PCT}% a trade is entered at` : ''}`)
  const levels = input.depth === undefined || input.depth === null ? null : input.side === 'buy' ? input.depth.asks : input.depth.bids
  const depthQuote =
    levels !== null && levels.length > 0
      ? levels.reduce((sum, [price, qty]) => sum + price * qty, 0)
      : input.side === 'buy'
        ? book.ask * book.askQty
        : book.bid * book.bidQty
  // Ten stakes on the side a fill would take is plenty; one stake is the least worth trading into.
  const depthPart = input.stakeQuote > 0 ? clamp01(depthQuote / (input.stakeQuote * 10)) : 1
  if (depthPart < 1) reasons.push(`${short(depthQuote)} on offer${levels === null ? ' at the best price' : ' in the five best levels'}, against a stake of ${short(input.stakeQuote)}`)
  const ageMs = priceAgeMs(book, input.nowMs)
  const freshPart = ageMs <= FRESH_PRICE_MS ? 1 : clamp01(1 - (ageMs - FRESH_PRICE_MS) / (STALE_PRICE_MS - FRESH_PRICE_MS))
  if (freshPart < 1) reasons.push(`price ${Math.round(ageMs / 1000)} s old`)
  return { score: Math.round(100 * (0.5 * spreadPart + 0.3 * depthPart + 0.2 * freshPart)), spreadPct: spread, depthQuote, ageMs, reasons }
}

export type LiveVerdict =
  /** Its fill price is inside the entry range, the spread is within the line and the price is fresh. */
  | { state: 'enterable'; price: number; reasons: [] }
  /** Nothing has ended it, but the price is outside its range: it enters only if the price comes
   * back into the range before the entry expires. */
  | { state: 'waiting'; price: number; reasons: string[] }
  /** It no longer stands, or cannot be judged: expired, Bitcoin against it by the watch's
   * safeguard, a spread over the line, or no fresh price. */
  | { state: 'invalidated'; price: number | null; reasons: string[] }

function utcClock(sec: number): string {
  return new Date(sec * 1000).toISOString().slice(11, 16)
}

/** Bitcoin's minutes with the price now as the last one, for btcMoveAgainst: the rule the watch
 * drops a waiting paper trade by, read from the stream instead of from a fetch. */
function btcWithNow(btcMinutes: LiveMinute[], btcPrice: number | null, nowSec: number): Candle[] {
  const closed = btcMinutes.filter((minute) => minute.closed && minute.time + 60 <= nowSec)
  if (btcPrice === null) return closed
  const minute = Math.floor(nowSec / 60) * 60
  return [...closed.filter((bar) => bar.time < minute), { time: minute, open: btcPrice, high: btcPrice, low: btcPrice, close: btcPrice, volume: 0 }]
}

/** Whether a recommendation can be entered now, at the live price: the document's "never trade from
 * an old candle price". `btcLimitPct` is the watch's safeguard (0: Bitcoin's move is not checked). */
export function revalidate(input: {
  side: ExecutorSide
  entryMin: number
  entryMax: number
  expiresAt: number
  eventTime: number
  book: LiveBook | null
  btcMinutes: LiveMinute[]
  btcPrice: number | null
  btcLimitPct: number
  nowMs: number
}): LiveVerdict {
  const nowSec = Math.floor(input.nowMs / 1000)
  const reasons: string[] = []
  if (nowSec >= input.expiresAt) reasons.push(`its entry expired at ${utcClock(input.expiresAt)} UTC`)
  const move = btcMoveAgainst({ side: input.side, eventTime: input.eventTime, btc: btcWithNow(input.btcMinutes, input.btcPrice, nowSec), limitPct: input.btcLimitPct })
  if (move !== null) reasons.push(`Bitcoin ${move < 0 ? 'fell' : 'rose'} ${Math.abs(move).toFixed(2)}% since the event`)
  const { book } = input
  if (book === null) reasons.push('no live price')
  else if (isStale(book, input.nowMs)) reasons.push(`the price is ${Math.round(priceAgeMs(book, input.nowMs) / 1000)} s old`)
  const spread = book === null ? null : bookSpreadPct(book)
  if (book !== null && spread === null) reasons.push('the book is one-sided or crossed')
  if (spread !== null && spread > MAX_SPREAD_PCT) reasons.push(`the spread is ${spread.toFixed(3)}%, over the ${MAX_SPREAD_PCT}% a trade is entered at`)
  const price = book === null ? null : fillPrice(book, input.side)
  if (reasons.length > 0 || price === null) return { state: 'invalidated', price, reasons }
  if (price < input.entryMin) return { state: 'waiting', price, reasons: [`${input.side === 'buy' ? 'the ask' : 'the bid'} ${short(price)} is under the range`] }
  if (price > input.entryMax) return { state: 'waiting', price, reasons: [`${input.side === 'buy' ? 'the ask' : 'the bid'} ${short(price)} is over the range`] }
  return { state: 'enterable', price, reasons: [] }
}

/** Why a paper trade the watch would open now is refused on the live price, or null: no fresh price
 * to know the market by, or a spread over the line. Only ever opens less. */
export function livePaperBlock(book: LiveBook | null, nowMs: number): string | null {
  if (book === null) return 'The live price could not be read, so the market it would enter is not known.'
  if (isStale(book, nowMs)) return `The live price is ${Math.round(priceAgeMs(book, nowMs) / 1000)} seconds old, so the market it would enter is not known.`
  const spread = bookSpreadPct(book)
  if (spread === null) return 'The book is one-sided or crossed, so no fill price can be known.'
  if (spread > MAX_SPREAD_PCT) return `The spread is ${spread.toFixed(3)}%, over the ${MAX_SPREAD_PCT}% a trade is entered at.`
  return null
}

/** Why a paper trade the watch would open now is refused on the book behind it, or null: the best
 * level a fill would take (the ask for a buy, the bid for a sell) worth less, in the quote, than the
 * stake. A liquid pair's best level holds thousands; a thin one can hold less than one small trade,
 * and a fill there would go through the levels after it (the document's §25, "book liquidity
 * disappeared"). With no book, livePaperBlock has said so. Only ever opens less. */
export function thinBookBlock(book: LiveBook | null, side: ExecutorSide, amountQuote: number): string | null {
  if (book === null) return null
  const price = fillPrice(book, side)
  const held = price * (side === 'buy' ? book.askQty : book.bidQty)
  if (!Number.isFinite(held) || held >= amountQuote) return null
  return `The ${side === 'buy' ? 'ask' : 'bid'} holds ${short(held)} in the quote, less than the ${short(amountQuote)} it would take, so a fill would go through the book.`
}

/** The fill a paper trade takes from the live book the second it is made, or null: the ask (for a
 * buy) or the bid (for a sell), when the book is fresh and within the line (livePaperBlock) and that
 * price is inside the recommendation's entry range. Null, and the trade waits by its range on minute
 * bars as before: a price outside the range is neither chased nor bought from its far side. The
 * document's §41: a paper trade filled where the market was, not at the next minute's bar. */
export function streamedEntry(book: LiveBook | null, params: Pick<PositionExecutorParams, 'side' | 'entryRange'>, nowMs: number): { price: number; at: number } | null {
  if (book === null || params.entryRange === undefined || params.entryRange === null || livePaperBlock(book, nowMs) !== null) return null
  const price = fillPrice(book, params.side)
  if (!(price >= params.entryRange.min && price <= params.entryRange.max)) return null
  return { price, at: Math.floor(nowMs / 1000) }
}

/** The 1-minute candles kept for a pair, with one from the stream folded in: the minute replaced if
 * it is there, added if it is new; the last `keep` kept. */
export function foldMinute(minutes: LiveMinute[], minute: LiveMinute, keep: number): LiveMinute[] {
  const rest = minutes.filter((entry) => entry.time !== minute.time)
  return [...rest, minute].sort((a, b) => a.time - b.time).slice(-keep)
}

/** A pair's moves over the last minute and five, in percent, from its stream minutes and the price
 * now; null where the minutes do not reach back. */
export function liveReturns(minutes: LiveMinute[], price: number | null, nowSec: number): { m1: number | null; m5: number | null } {
  if (price === null) return { m1: null, m5: null }
  const at = (secondsBack: number): number | null => {
    const minute = Math.floor((nowSec - secondsBack) / 60) * 60
    const bar = minutes.find((entry) => entry.time === minute)
    return bar === undefined || !(bar.open > 0) ? null : bar.open
  }
  const back = (seconds: number): number | null => {
    const from = at(seconds)
    return from === null ? null : (price / from - 1) * 100
  }
  return { m1: back(60), m5: back(300) }
}
