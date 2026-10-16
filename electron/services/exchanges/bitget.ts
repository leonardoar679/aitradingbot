import WebSocket from 'ws'
import { createReconnectingSocket } from './reconnectingSocket'
import type { BookTicker, ExchangeAdapter } from './types'
import { INTERVAL_SECONDS, type Candle, type Interval, type SymbolInfo, type Ticker24h } from '../../../shared/ipc'

// BITGET, PUBLIC MARKET DATA (V7.1 Stage 6, 16 October 2026). Spot pairs, candles, tickers, the book
// and the trades from Bitget's unified (UTA, v3) market endpoints, and its v3 public stream -- every
// host, path and spelling below was read from the live answers on 16 October 2026 (the session's
// fixtures, tests/bitgetAdapter.test.ts) and pinned here. Nothing in this file signs a request: the
// keys, the account and any order live elsewhere (Stages 7-9), and a host for them is resolved there.
//
// What was measured, and shapes this file:
// - the v3 whole-market ticker list (every spot pair in one answer) took 9 to 40 seconds from this
//   machine; v2's took 2, so the whole-market reads a scanner makes go to v2's path, the rest to v3;
// - a candle request answers the NEWEST `limit` bars inside (startTime, endTime] -- the bar opening
//   at startTime left out, the one at endTime counted in -- ascending, and a window wider than
//   ninety days is cut to ninety from its start: so a range is read in windows that one page holds
//   whole, each asked from a millisecond before its first bar, never by asking for everything after
//   a start;
// - the stream's candle topic is "kline" with an interval of its own spelling ("5m", "1H"), and the
//   first push of a subscription is a snapshot of recent bars, the pushes after it the bar forming;
// - the gateway answers the word "ping" with "pong", and the v2 documentation closes a connection
//   two minutes without one, so one is sent every thirty seconds beside the protocol's own.
// - two in three of its 3,496 spot instruments are tokenized stocks (symbolType "stock"); they are
//   marked as Binance's are, so the scanner and the forecast leave them out.

export const BITGET = {
  restRoot: 'https://api.bitget.com',
  wsPublic: 'wss://ws.bitget.com/v3/ws/public',
  paths: {
    time: '/api/v3/market/time',
    instruments: '/api/v3/market/instruments?category=SPOT',
    tickers: '/api/v3/market/tickers?category=SPOT',
    candles: '/api/v3/market/candles?category=SPOT',
    orderbook: '/api/v3/market/orderbook?category=SPOT',
    fills: '/api/v3/market/fills?category=SPOT',
    /** Every spot pair's ticker, with its best bid and ask: v2's, for the time it takes (above). */
    marketTickers: '/api/v2/spot/market/tickers'
  }
} as const

/** Bitget's spelling of each interval, on REST and on the stream alike. `1W` is not in the v3 list
 * of intervals but answered with weekly bars on 16 October 2026. */
export const BITGET_INTERVAL: Record<Interval, string> = { '1m': '1m', '15m': '15m', '1h': '1H', '4h': '4H', '1d': '1D', '1w': '1W' }

/** Bars one candle request gives at most (the documented maximum). */
export const BITGET_PAGE = 1000
/** Days a candle window may span before Bitget cuts it from its start (measured). */
const WINDOW_DAYS = 90
const REQUEST_TIMEOUT_MS = 20_000
/** A scanner's request that has not answered in this long is given up on (as binance.ts). */
const SCAN_TIMEOUT_MS = 8_000
/** How often the word "ping" is sent on an open stream. */
const TEXT_PING_MS = 30_000
const SUCCESS = '00000'

interface Envelope<T> {
  code: string
  msg: string
  data: T
}

/** One public request, its envelope opened: the data, or an error naming Bitget's code and message.
 * A 4xx/5xx and a 200 whose code is not success are refused alike. */
async function ask<T>(path: string, what: string, timeoutMs = REQUEST_TIMEOUT_MS): Promise<T> {
  const response = await fetch(`${BITGET.restRoot}${path}`, { signal: AbortSignal.timeout(timeoutMs) })
  const body = (await response.json().catch(() => null)) as Envelope<T> | null
  if (!response.ok || body === null || body.code !== SUCCESS) {
    throw new Error(`Bitget ${what} failed: ${response.status}${body === null ? '' : ` ${body.code} ${body.msg}`}`)
  }
  return body.data
}

const symbolParam = (symbol: string): string => encodeURIComponent(symbol.toUpperCase())

interface Instrument {
  symbol: string
  baseCoin: string
  quoteCoin: string
  /** "crypto", "stock" or "metal" on 16 October 2026. */
  symbolType?: string
  /** "online" trades; "limit_open" and "listed" do not yet. */
  status: string
}

/** [timestamp ms, open, high, low, close, base volume, quote turnover], every one a string. */
type CandleRow = [string, string, string, string, string, string, string]

interface TickerRow {
  symbol: string
  lastPrice: string
  openPrice24h: string
  highPrice24h: string
  lowPrice24h: string
  volume24h: string
  turnover24h: string
  /** A fraction: "0.00545" is up 0.545%. */
  price24hPcnt: string
  bid1Price?: string
  ask1Price?: string
  ts?: string
}

/** v2's ticker, the whole market's. */
interface MarketTickerRow {
  symbol: string
  lastPr: string
  open: string
  high24h: string
  low24h: string
  baseVolume: string
  quoteVolume: string
  change24h: string
  bidPr: string
  askPr: string
}

function candleOf(row: CandleRow): Candle {
  return {
    time: Math.floor(Number(row[0]) / 1000),
    open: Number(row[1]),
    high: Number(row[2]),
    low: Number(row[3]),
    close: Number(row[4]),
    volume: Number(row[5])
  }
}

function tickerOf(symbol: string, row: TickerRow): Ticker24h {
  const last = Number(row.lastPrice)
  const open = Number(row.openPrice24h)
  return {
    symbol,
    lastPrice: last,
    priceChange: last - open,
    priceChangePercent: Number(row.price24hPcnt) * 100,
    highPrice: Number(row.highPrice24h),
    lowPrice: Number(row.lowPrice24h),
    volume: Number(row.volume24h),
    quoteVolume: Number(row.turnover24h)
  }
}

async function listSymbols(): Promise<SymbolInfo[]> {
  const rows = await ask<Instrument[]>(BITGET.paths.instruments, 'instruments')
  return rows
    .filter((row) => row.status === 'online')
    .map((row) => ({ symbol: row.symbol, baseAsset: row.baseCoin, quoteAsset: row.quoteCoin, ...(row.symbolType === 'stock' ? { stockToken: true } : {}) }))
}

async function fetchCandlePage(symbol: string, interval: Interval, query: string, timeoutMs: number): Promise<Candle[]> {
  const rows = await ask<CandleRow[]>(`${BITGET.paths.candles}&symbol=${symbolParam(symbol)}&interval=${BITGET_INTERVAL[interval]}${query}`, `candles ${symbol}`, timeoutMs)
  return rows.map(candleOf).sort((a, b) => a.time - b.time)
}

async function fetchHistoricalCandles(symbol: string, interval: Interval, limit = 500): Promise<Candle[]> {
  return fetchCandlePage(symbol, interval, `&limit=${Math.min(limit, BITGET_PAGE)}`, REQUEST_TIMEOUT_MS)
}

/** Covers [startSec, endSec) in windows of one bar under a page each, oldest first, each asked from
 * the millisecond before its first bar (Bitget leaves the bar at startTime out): a window then holds
 * exactly a page of bars at most, what one request answers whole, so the newest-first cut of a wider
 * window (above) never skips the start. A bar at a window's end is left to the next window, which
 * starts there. An empty window (a pair listed later, a gap) is stepped over, not taken for the end. */
async function fetchHistoricalRange(
  symbol: string,
  interval: Interval,
  startSec: number,
  endSec: number,
  onProgress: (done: number, total: number) => void,
  isCancelled: () => boolean
): Promise<Candle[]> {
  const intervalMs = INTERVAL_SECONDS[interval] * 1000
  const windowMs = Math.min((BITGET_PAGE - 1) * intervalMs, WINDOW_DAYS * 86_400_000)
  const total = Math.max(1, Math.ceil(((endSec - startSec) * 1000) / intervalMs))
  const endMs = endSec * 1000
  let cursorMs = startSec * 1000
  const collected: Candle[] = []
  while (cursorMs < endMs) {
    if (isCancelled()) break
    const windowEnd = Math.min(endMs, cursorMs + windowMs)
    const page = await fetchCandlePage(symbol, interval, `&startTime=${Math.max(0, cursorMs - 1)}&endTime=${windowEnd}&limit=${BITGET_PAGE}`, REQUEST_TIMEOUT_MS)
    for (const candle of page) {
      const timeMs = candle.time * 1000
      if (timeMs >= cursorMs && timeMs < windowEnd) collected.push(candle)
    }
    onProgress(Math.min(collected.length, total), total)
    cursorMs = windowEnd
  }
  return collected
}

async function fetchTicker24h(symbol: string): Promise<Ticker24h> {
  const rows = await ask<TickerRow[]>(`${BITGET.paths.tickers}&symbol=${symbolParam(symbol)}`, `ticker ${symbol}`)
  const row = rows[0]
  if (row === undefined) throw new Error(`Bitget ticker returned no data for ${symbol}`)
  return tickerOf(symbol.toUpperCase(), row)
}

interface StreamMessage {
  event?: string
  code?: number
  msg?: string
  action?: 'snapshot' | 'update'
  data?: unknown[]
}

/** One subscription on the public stream, reconnecting as every stream here does: the request sent
 * at each open, the word "ping" every thirty seconds while it is open, "pong" and the subscription's
 * own acknowledgement dropped, a refusal said, and every push's rows handed on with its action. */
function subscribe(args: Record<string, string>, label: string, onPush: (action: 'snapshot' | 'update', rows: unknown[]) => void): () => void {
  let stopPing: (() => void) | null = null
  const stop = createReconnectingSocket(BITGET.wsPublic, {
    onOpen: (socket) => {
      socket.send(JSON.stringify({ op: 'subscribe', args: [args] }))
      stopPing?.()
      const timer = setInterval(() => {
        if (socket.readyState === WebSocket.OPEN) socket.send('ping')
      }, TEXT_PING_MS)
      stopPing = (): void => clearInterval(timer)
      socket.on('close', (): void => clearInterval(timer))
    },
    onMessage: (raw) => {
      const text = raw.toString()
      if (text === 'pong') return
      let parsed: StreamMessage
      try {
        parsed = JSON.parse(text)
      } catch {
        return
      }
      if (parsed.event === 'error') {
        console.error(`Bitget ${label} stream refused the subscription: ${parsed.code} ${parsed.msg}`)
        return
      }
      if ((parsed.action === 'snapshot' || parsed.action === 'update') && Array.isArray(parsed.data)) onPush(parsed.action, parsed.data)
    },
    onError: (error) => console.error(`Bitget ${label} socket error: ${error.message}`)
  })
  return () => {
    stopPing?.()
    stopPing = null
    stop()
  }
}

interface StreamBar {
  start: string
  open: string
  high: string
  low: string
  close: string
  volume: string
}

const streamBarOf = (bar: StreamBar): Candle => ({
  time: Math.floor(Number(bar.start) / 1000),
  open: Number(bar.open),
  high: Number(bar.high),
  low: Number(bar.low),
  close: Number(bar.close),
  volume: Number(bar.volume)
})

/** A subscription's first push is a snapshot of recent bars; only its newest, the bar forming, is
 * handed on. Every bar of an update is. */
async function subscribeCandles(symbol: string, interval: Interval, onUpdate: (candle: Candle) => void): Promise<() => void> {
  return subscribe({ instType: 'spot', topic: 'kline', symbol: symbol.toUpperCase(), interval: BITGET_INTERVAL[interval] }, 'candle', (action, rows) => {
    const bars = (rows as StreamBar[]).filter((bar) => typeof bar?.start === 'string').map(streamBarOf)
    if (bars.length === 0) return
    if (action === 'snapshot') onUpdate(bars[bars.length - 1])
    else for (const bar of bars) onUpdate(bar)
  })
}

async function subscribeTicker(symbol: string, onUpdate: (ticker: Ticker24h) => void): Promise<() => void> {
  const upper = symbol.toUpperCase()
  return subscribe({ instType: 'spot', topic: 'ticker', symbol: upper }, 'ticker', (_action, rows) => {
    for (const row of rows as TickerRow[]) if (typeof row?.lastPrice === 'string') onUpdate(tickerOf(upper, row))
  })
}

// ---------------------------------------------------------------------------------------------
// Whole-market reads, for a scanner (marketService.ts scanSourceFor): the v2 ticker list, which
// carries every pair's best bid and ask beside its day, so the two reads are one request's shape.

async function fetchMarketTickers(): Promise<MarketTickerRow[]> {
  return ask<MarketTickerRow[]>(BITGET.paths.marketTickers, 'tickers', SCAN_TIMEOUT_MS * 2)
}

async function fetchAllTickers24h(): Promise<Ticker24h[]> {
  return (await fetchMarketTickers()).map((row) => {
    const last = Number(row.lastPr)
    return {
      symbol: row.symbol,
      lastPrice: last,
      priceChange: last - Number(row.open),
      priceChangePercent: Number(row.change24h) * 100,
      highPrice: Number(row.high24h),
      lowPrice: Number(row.low24h),
      volume: Number(row.baseVolume),
      quoteVolume: Number(row.quoteVolume)
    }
  })
}

async function fetchBookTickers(): Promise<BookTicker[]> {
  return (await fetchMarketTickers()).map((row) => ({ symbol: row.symbol, bidPrice: Number(row.bidPr), askPrice: Number(row.askPr) }))
}

async function fetchRecentCandles(symbol: string, interval: Interval, limit: number): Promise<Candle[]> {
  return fetchCandlePage(symbol, interval, `&limit=${Math.min(limit, BITGET_PAGE)}`, SCAN_TIMEOUT_MS)
}

// ---------------------------------------------------------------------------------------------
// The book and the trades, for the comparison with Binance (Stage 6's card) and, later, a fill's
// judgement. Public, unsigned.

export interface BitgetBook {
  /** Best first; [price, size] in the base coin. */
  bids: [number, number][]
  asks: [number, number][]
  /** The book's own time, ms. */
  ts: number
}

interface OrderbookData {
  a: [number, number][]
  b: [number, number][]
  ts: string
}

export async function fetchBitgetBook(symbol: string, limit = 50): Promise<BitgetBook> {
  const data = await ask<OrderbookData>(`${BITGET.paths.orderbook}&symbol=${symbolParam(symbol)}&limit=${limit}`, `book ${symbol}`)
  const level = (row: [number, number]): [number, number] => [Number(row[0]), Number(row[1])]
  return { bids: (data.b ?? []).map(level), asks: (data.a ?? []).map(level), ts: Number(data.ts) }
}

export interface BitgetFill {
  price: number
  size: number
  side: 'buy' | 'sell'
  ts: number
}

interface FillRow {
  price: string
  size: string
  side: string
  ts: string
}

export async function fetchBitgetFills(symbol: string, limit = 50): Promise<BitgetFill[]> {
  const rows = await ask<FillRow[]>(`${BITGET.paths.fills}&symbol=${symbolParam(symbol)}&limit=${limit}`, `fills ${symbol}`)
  return rows.map((row) => ({ price: Number(row.price), size: Number(row.size), side: row.side === 'sell' ? 'sell' : 'buy', ts: Number(row.ts) }))
}

/** What an order on a pair must keep to, from the pair's instrument (V7.1 Stage 8): the smallest
 * order in the quote currency, the quantity's and the price's decimals as steps. Read once in ten
 * minutes a pair. */
export interface BitgetSymbolRules {
  minNotional: number
  minQty: number
  stepSize: string
  tickSize: string
  /** The pair as Bitget lists it; refused when it does not. */
  status: string
}

const RULES_TTL_MS = 10 * 60_000
const rulesCache = new Map<string, { at: number; rules: BitgetSymbolRules }>()

interface InstrumentRules extends Instrument {
  pricePrecision?: string
  quantityPrecision?: string
  minOrderAmount?: string
  minOrderQty?: string
}

/** A step of so many decimals, as the exchange writes it: "0.000001" for six. */
export function stepOfDecimals(decimals: number): string {
  const places = Math.max(0, Math.min(18, Math.floor(decimals)))
  return places === 0 ? '1' : `0.${'0'.repeat(places - 1)}1`
}

export async function fetchBitgetSymbolRules(symbol: string): Promise<BitgetSymbolRules> {
  const upper = symbol.toUpperCase()
  const cached = rulesCache.get(upper)
  if (cached !== undefined && Date.now() - cached.at < RULES_TTL_MS) return cached.rules
  const rows = await ask<InstrumentRules[]>(`${BITGET.paths.instruments}&symbol=${symbolParam(upper)}`, `instrument ${upper}`)
  const row = rows.find((entry) => entry.symbol === upper)
  if (row === undefined) throw new Error(`Bitget does not list ${upper}`)
  const rules: BitgetSymbolRules = {
    minNotional: Number(row.minOrderAmount ?? 0),
    minQty: Number(row.minOrderQty ?? 0),
    stepSize: stepOfDecimals(Number(row.quantityPrecision ?? 8)),
    tickSize: stepOfDecimals(Number(row.pricePrecision ?? 8)),
    status: row.status
  }
  rulesCache.set(upper, { at: Date.now(), rules })
  return rules
}

/** Test seam. */
export function resetBitgetRules(): void {
  rulesCache.clear()
}

/** Bitget's clock, ms, and how long the request took: the health probe's figures for this host. */
export async function fetchBitgetTime(): Promise<{ serverTime: number; latencyMs: number }> {
  const sentAt = Date.now()
  const data = await ask<{ serverTime: string }>(BITGET.paths.time, 'time', 10_000)
  return { serverTime: Number(data.serverTime), latencyMs: Date.now() - sentAt }
}

export const bitgetAdapter: ExchangeAdapter = {
  listSymbols,
  fetchHistoricalCandles,
  fetchHistoricalRange,
  fetchTicker24h,
  subscribeCandles,
  subscribeTicker,
  scan: { fetchAllTickers24h, fetchBookTickers, fetchRecentCandles }
}
