import { createReconnectingSocket } from './reconnectingSocket'
import type { ExchangeAdapter } from './types'
import { INTERVAL_SECONDS, type Candle, type Interval, type SymbolInfo, type Ticker24h } from '../../../shared/ipc'

export interface RestEndpoint {
  name: string
  restRoot: string
  wsBase: string
}

// Binance's global site geo-blocks some regions (mainly the US). Binance.US mirrors the
// same REST/WS API shape, so it's a drop-in fallback for whichever endpoint is actually
// reachable from wherever this app runs.
//
// TRADING AND MARKET DATA RESOLVE SEPARATELY, and the split is a safety property rather than a
// tidiness one. Both lists below start with the same two hosts; only the data list may grow.
const TRADING_ENDPOINTS: RestEndpoint[] = [
  { name: 'binance.com', restRoot: 'https://api.binance.com/api/v3', wsBase: 'wss://stream.binance.com:9443/ws' },
  { name: 'binance.us', restRoot: 'https://api.binance.us/api/v3', wsBase: 'wss://stream.binance.us:9443/ws' }
]

// data-api.binance.vision is Binance's PUBLIC MARKET DATA mirror. It serves klines, exchangeInfo
// and ticker for the full 1,358-symbol TRADING universe, it is not geo-blocked, and it is the host
// every candle file in .candles/ was fetched from -- so all of this repository's research already
// runs against it.
//
// It has NO SIGNED ROUTES AT ALL: /api/v3/account returns 404, and so would /order. That is exactly
// why it is listed here and deliberately absent from TRADING_ENDPOINTS. Appending it to a single
// shared list would have been the obvious one-line version of this fix and would have been a real
// hazard: in a region where binance.com is geo-blocked (451) and binance.us is unreachable, a
// shared resolver memoises the data host, and the next REAL order placed by liveOrderService would
// be signed, sent to a host with no /order route, and fail as a 404 that reads like a bad API key.
// Live trading must never reach a host that cannot trade.
//
// ORDER MATTERS HERE, AND NOT FOR SPEED. Measured in the running app's main process, one fetch
// after another, on a connection where binance.com is geo-blocked:
//
//     api.binance.com            1,222ms   451        (geo-blocked, answers immediately)
//     api.binance.us            10,451ms   fetch failed
//     api.binance.com          10,645ms   fetch failed   <- was 451 a moment earlier
//     data-api.binance.vision  10,655ms   fetch failed   <- returns 200 in ~2s if probed FIRST
//
// Attempting api.binance.us does not merely time out: every subsequent HTTPS request from that
// process fails too, including hosts that answered a second earlier. So a list that probes
// binance.us before the host it actually needs can never fail over -- the act of trying the second
// host destroys the connection the third would have used. That is why the mirror is placed BEFORE
// binance.us rather than appended, which was the obvious placement and is the broken one.
const DATA_ENDPOINTS: RestEndpoint[] = [
  TRADING_ENDPOINTS[0],
  {
    name: 'data-api.binance.vision',
    restRoot: 'https://data-api.binance.vision/api/v3',
    wsBase: 'wss://data-stream.binance.vision/ws'
  },
  TRADING_ENDPOINTS[1]
]

let resolvedDataEndpoint: RestEndpoint | null = null
let resolvedTradingEndpoint: RestEndpoint | null = null

interface BinanceSymbolInfo {
  symbol: string
  baseAsset: string
  quoteAsset: string
  status: string
}

interface BinanceKlineRow {
  0: number // open time (ms)
  1: string // open
  2: string // high
  3: string // low
  4: string // close
  5: string // volume
}

interface BinanceKlineMessage {
  k: { t: number; o: string; h: string; l: string; c: string; v: string }
}

interface BinanceTicker24hRest {
  lastPrice: string
  priceChange: string
  priceChangePercent: string
  highPrice: string
  lowPrice: string
  volume: string
  quoteVolume: string
}

interface BinanceTicker24hMessage {
  s: string
  c: string
  p: string
  P: string
  h: string
  l: string
  v: string
  q: string
}

const PROBE_TIMEOUT_MS = 6_000

async function probe(endpoints: RestEndpoint[], purpose: string): Promise<RestEndpoint> {
  for (const endpoint of endpoints) {
    try {
      // Bounded, because an unreachable host here is black-holed rather than refused: it hangs
      // for ten seconds before the OS gives up, and every probe after it in the same process
      // inherits that failure. The timeout does not prevent that -- ordering does -- but it stops
      // one dead host from costing ten seconds of the user's first paint.
      const response = await fetch(`${endpoint.restRoot}/klines?symbol=BTCUSDT&interval=1m&limit=1`, {
        signal: AbortSignal.timeout(PROBE_TIMEOUT_MS)
      })
      const data: unknown = await response.json().catch(() => null)
      if (response.ok && Array.isArray(data)) {
        console.log(`Using Binance ${purpose} endpoint: ${endpoint.name}`)
        return endpoint
      }
      console.warn(`Binance endpoint ${endpoint.name} unavailable:`, data)
    } catch (error) {
      console.warn(`Binance endpoint ${endpoint.name} unreachable:`, error)
    }
  }
  throw new Error(
    `No reachable Binance ${purpose} endpoint (tried: ${endpoints.map((e) => e.name).join(', ')})`
  )
}

/** Host for candles, symbols and tickers. May be the public data mirror. */
export async function resolveEndpoint(): Promise<RestEndpoint> {
  if (resolvedDataEndpoint) return resolvedDataEndpoint
  resolvedDataEndpoint = await probe(DATA_ENDPOINTS, 'market data')
  return resolvedDataEndpoint
}

/** Host for SIGNED requests -- balances, orders, cancels. Restricted to hosts that actually
 * implement the trading routes, so a region where only the data mirror is reachable fails loudly
 * here instead of signing a real order and sending it somewhere it cannot execute. */
export async function resolveTradingEndpoint(): Promise<RestEndpoint> {
  if (resolvedTradingEndpoint) return resolvedTradingEndpoint
  resolvedTradingEndpoint = await probe(TRADING_ENDPOINTS, 'trading')
  return resolvedTradingEndpoint
}

/** Test seam. The two memos are module-level, so a suite that exercises failover would otherwise
 * see whatever the previous test resolved. */
export function resetResolvedEndpoints(): void {
  resolvedDataEndpoint = null
  resolvedTradingEndpoint = null
}

export const ENDPOINTS_FOR_TEST = { DATA_ENDPOINTS, TRADING_ENDPOINTS }

async function listSymbols(): Promise<SymbolInfo[]> {
  const endpoint = await resolveEndpoint()
  const response = await fetch(`${endpoint.restRoot}/exchangeInfo`)
  if (!response.ok) throw new Error(`${endpoint.name} exchangeInfo request failed: ${response.status}`)
  const data = (await response.json()) as { symbols: BinanceSymbolInfo[] }
  return data.symbols
    .filter((s) => s.status === 'TRADING')
    .map((s) => ({ symbol: s.symbol, baseAsset: s.baseAsset, quoteAsset: s.quoteAsset }))
}

async function fetchHistoricalCandles(symbol: string, interval: Interval, limit = 500): Promise<Candle[]> {
  const endpoint = await resolveEndpoint()
  const url = `${endpoint.restRoot}/klines?symbol=${symbol.toUpperCase()}&interval=${interval}&limit=${limit}`
  const response = await fetch(url)
  if (!response.ok) {
    throw new Error(`${endpoint.name} klines request failed: ${response.status} ${response.statusText}`)
  }
  const rows = (await response.json()) as BinanceKlineRow[]
  return rows.map((row) => ({
    time: Math.floor(Number(row[0]) / 1000),
    open: Number(row[1]),
    high: Number(row[2]),
    low: Number(row[3]),
    close: Number(row[4]),
    volume: Number(row[5])
  }))
}

async function fetchHistoricalRange(
  symbol: string,
  interval: Interval,
  startSec: number,
  endSec: number,
  onProgress: (done: number, total: number) => void,
  isCancelled: () => boolean
): Promise<Candle[]> {
  const endpoint = await resolveEndpoint()
  const intervalMs = INTERVAL_SECONDS[interval] * 1000
  const total = Math.max(1, Math.ceil(((endSec - startSec) * 1000) / intervalMs))
  const endMs = endSec * 1000
  let cursorMs = startSec * 1000
  const collected: Candle[] = []

  while (cursorMs < endMs) {
    if (isCancelled()) break
    const url = `${endpoint.restRoot}/klines?symbol=${symbol.toUpperCase()}&interval=${interval}&startTime=${cursorMs}&endTime=${endMs}&limit=1000`
    const response = await fetch(url)
    if (!response.ok) {
      throw new Error(`${endpoint.name} klines request failed: ${response.status} ${response.statusText}`)
    }
    const rows = (await response.json()) as BinanceKlineRow[]
    if (rows.length === 0) break
    for (const row of rows) {
      collected.push({
        time: Math.floor(Number(row[0]) / 1000),
        open: Number(row[1]),
        high: Number(row[2]),
        low: Number(row[3]),
        close: Number(row[4]),
        volume: Number(row[5])
      })
    }
    onProgress(Math.min(collected.length, total), total)
    const nextCursorMs = Number(rows[rows.length - 1][0]) + intervalMs
    if (nextCursorMs <= cursorMs || rows.length < 1000) break
    cursorMs = nextCursorMs
  }
  return collected
}

async function fetchTicker24h(symbol: string): Promise<Ticker24h> {
  const endpoint = await resolveEndpoint()
  const url = `${endpoint.restRoot}/ticker/24hr?symbol=${symbol.toUpperCase()}`
  const response = await fetch(url)
  if (!response.ok) {
    throw new Error(`${endpoint.name} ticker request failed: ${response.status} ${response.statusText}`)
  }
  const raw = (await response.json()) as BinanceTicker24hRest
  return {
    symbol: symbol.toUpperCase(),
    lastPrice: Number(raw.lastPrice),
    priceChange: Number(raw.priceChange),
    priceChangePercent: Number(raw.priceChangePercent),
    highPrice: Number(raw.highPrice),
    lowPrice: Number(raw.lowPrice),
    volume: Number(raw.volume),
    quoteVolume: Number(raw.quoteVolume)
  }
}

async function subscribeCandles(
  symbol: string,
  interval: Interval,
  onUpdate: (candle: Candle) => void
): Promise<() => void> {
  const endpoint = await resolveEndpoint()
  const key = `${symbol.toLowerCase()}@kline_${interval}`
  return createReconnectingSocket(`${endpoint.wsBase}/${key}`, {
    onMessage: (raw) => {
      let parsed: BinanceKlineMessage
      try {
        parsed = JSON.parse(raw.toString())
      } catch {
        return
      }
      const k = parsed.k
      onUpdate({
        time: Math.floor(k.t / 1000),
        open: Number(k.o),
        high: Number(k.h),
        low: Number(k.l),
        close: Number(k.c),
        volume: Number(k.v)
      })
    },
    onError: (error) => console.error(`${endpoint.name} candle socket error:`, error)
  })
}

async function subscribeTicker(symbol: string, onUpdate: (ticker: Ticker24h) => void): Promise<() => void> {
  const endpoint = await resolveEndpoint()
  const key = `${symbol.toLowerCase()}@ticker`
  return createReconnectingSocket(`${endpoint.wsBase}/${key}`, {
    onMessage: (raw) => {
      let parsed: BinanceTicker24hMessage
      try {
        parsed = JSON.parse(raw.toString())
      } catch {
        return
      }
      onUpdate({
        symbol: parsed.s,
        lastPrice: Number(parsed.c),
        priceChange: Number(parsed.p),
        priceChangePercent: Number(parsed.P),
        highPrice: Number(parsed.h),
        lowPrice: Number(parsed.l),
        volume: Number(parsed.v),
        quoteVolume: Number(parsed.q)
      })
    },
    onError: (error) => console.error(`${endpoint.name} ticker socket error:`, error)
  })
}

export const binanceAdapter: ExchangeAdapter = {
  listSymbols,
  fetchHistoricalCandles,
  fetchHistoricalRange,
  fetchTicker24h,
  subscribeCandles,
  subscribeTicker
}
