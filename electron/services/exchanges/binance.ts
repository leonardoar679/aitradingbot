import { createReconnectingSocket } from './reconnectingSocket'
import type { BookTicker, ExchangeAdapter } from './types'
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
// binanceFutures.ts already reached this conclusion and states it in almost these words -- futures
// is deliberately not routed through this resolver, because "a shared resolver would silently send
// these requests somewhere that answers 404 and report it as a bad API key". Spot trading was the
// path that had not been given the same treatment; this makes the two consistent.
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
  /** The groups of accounts allowed to trade it. */
  permissionSets?: string[][]
}

/** The trading group Binance keeps its stock tokens in -- the tokens that track a US stock or fund,
 * NVDAB, SPYB, CRCLB and the rest -- and nothing else. Nothing else in a pair's listing tells one
 * apart: they all end in "B", and so do BNB, SHIB and ARB. Read from the listing on 6 October 2026:
 * all 87 stock tokens are in this group, and none of the 415 other USDT pairs. */
const STOCK_TOKEN_GROUP = 'TRD_GRP_261'

function isStockToken(pair: BinanceSymbolInfo): boolean {
  return (pair.permissionSets ?? []).some((set) => Array.isArray(set) && set.includes(STOCK_TOKEN_GROUP))
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
  partnerFailedAt = -Infinity
  dataHostSwitches = 0
  dataHostListeners.clear()
}

// ---------------------------------------------------------------------------------------------
// WHEN THE DATA HOST STOPS ANSWERING MID-SESSION. The data host is chosen once, at the first request,
// and kept. In a one-hour run of the app on 6 October 2026 api.binance.com stopped accepting
// connections for six minutes, while its stream and the mirror were fine, and every candle request in
// those minutes failed: paper trades went unsettled and the exit check could not look.
//
// AND THE STREAM HAS TO FOLLOW. In a 24-hour run on 7 October 2026 REST moved to the mirror at 15:44
// UTC while the live-price socket, opened on binance.com at launch, kept dialling stream.binance.com
// every fifteen seconds for as long as the run lasted: the host's name resolved to addresses that were
// not Binance's at all. So a move is told to whoever listens (onDataHostChange), and a socket that
// cannot connect can ask for the partner to be probed (probeDataPartner). Both move only to a host
// that answers with data, and never to binance.us.

/** binance.com's two hosts for public market data, its REST host and its public mirror, serve the
 * same market, so each can stand in for the other. binance.us is a different market, with its own
 * symbols and history, and a host whose silence can take the process's other requests down with it
 * (above): it is never tried once a session has begun. */
function dataPartnerOf(endpoint: RestEndpoint): RestEndpoint | null {
  if (endpoint.name === DATA_ENDPOINTS[0].name) return DATA_ENDPOINTS[1]
  if (endpoint.name === DATA_ENDPOINTS[1].name) return DATA_ENDPOINTS[0]
  return null
}

/** How long the partner is given, when the request named no deadline of its own. */
const PARTNER_TIMEOUT_MS = 15_000
/** Once the partner has failed too, it is not asked again for this long: through an outage of both,
 * a request fails in the time one host takes, not two. */
const PARTNER_COOL_DOWN_MS = 60_000
let partnerFailedAt = -Infinity
/** Times the data host has moved this session. */
let dataHostSwitches = 0
const dataHostListeners = new Set<(to: RestEndpoint, from: RestEndpoint) => void>()

/** Tells a listener each time the data host moves mid-session: the live-price socket follows it. */
export function onDataHostChange(listener: (to: RestEndpoint, from: RestEndpoint) => void): () => void {
  dataHostListeners.add(listener)
  return () => void dataHostListeners.delete(listener)
}

/** The data host as it stands, without a probe; null before the first request resolved one. */
export function currentDataEndpoint(): RestEndpoint | null {
  return resolvedDataEndpoint
}

/** How many times the data host has moved this session. */
export function dataHostSwitchCount(): number {
  return dataHostSwitches
}

/** The one place the data host moves mid-session: it is counted, said, and told to the listeners. */
function moveDataHost(from: RestEndpoint, to: RestEndpoint, why: string): void {
  resolvedDataEndpoint = to
  dataHostSwitches += 1
  console.warn(`Binance market data: ${from.name} ${why}, so ${to.name} is used from now on.`)
  for (const listener of dataHostListeners) {
    try {
      listener(to, from)
    } catch (error) {
      console.error('A data-host listener failed:', error)
    }
  }
}

/** A public market-data request, `path` from the REST root on ("/klines?symbol=..."): to the data
 * host, and, when that host does not answer at all or answers with a server error, once to its
 * partner. A partner that answers with data is the data host from then on.
 *
 * ONLY DATA, AND ONLY A HOST THAT WORKS. Signed requests resolve their own host and never come here.
 * The partner is moved to only when it answers with data: the mirror's partner is binance.com, which
 * some regions refuse with a 451, and that is not a host to move to. A 4xx from the data host itself
 * is its answer and is not asked again elsewhere: a rate limit is not a reason to ask another host. */
export async function fetchMarketData(path: string, timeoutMs: number | null = null): Promise<{ response: Response; endpoint: RestEndpoint }> {
  const endpoint = await resolveEndpoint()
  let answered: Response | null = null
  let failure: unknown = null
  try {
    answered = await fetch(`${endpoint.restRoot}${path}`, timeoutMs === null ? undefined : { signal: AbortSignal.timeout(timeoutMs) })
    if (answered.status < 500) return { response: answered, endpoint }
  } catch (error) {
    failure = error
  }
  const partner = dataPartnerOf(endpoint)
  if (partner !== null && Date.now() - partnerFailedAt >= PARTNER_COOL_DOWN_MS) {
    try {
      const response = await fetch(`${partner.restRoot}${path}`, { signal: AbortSignal.timeout(timeoutMs ?? PARTNER_TIMEOUT_MS) })
      if (response.ok) {
        if (resolvedDataEndpoint === endpoint) moveDataHost(endpoint, partner, answered === null ? 'did not answer' : `answered ${answered.status}`)
        return { response, endpoint: partner }
      }
    } catch {
      // The partner did not answer either.
    }
    partnerFailedAt = Date.now()
  }
  if (answered !== null) return { response: answered, endpoint }
  throw failure
}

/** The data host's partner, probed once with one small request, for a caller whose own connection
 * to the host is failing: the live-price socket after three connects in a row that never opened. As
 * for a request, the partner is moved to only when it answers with data, and its silence puts it on
 * the same cool-down. Null when there is no partner (a session on binance.us), the cool-down has not
 * passed, or the partner did not answer; the partner itself when it did, whether or not the host had
 * to move for it (it may have moved already, for a request). */
export async function probeDataPartner(why: string): Promise<RestEndpoint | null> {
  const endpoint = await resolveEndpoint()
  const partner = dataPartnerOf(endpoint)
  if (partner === null || Date.now() - partnerFailedAt < PARTNER_COOL_DOWN_MS) return null
  try {
    const response = await fetch(`${partner.restRoot}/klines?symbol=BTCUSDT&interval=1m&limit=1`, { signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) })
    const data: unknown = await response.json().catch(() => null)
    if (response.ok && Array.isArray(data)) {
      if (resolvedDataEndpoint === endpoint) moveDataHost(endpoint, partner, why)
      return partner
    }
  } catch {
    // The partner did not answer either.
  }
  partnerFailedAt = Date.now()
  return null
}

export const ENDPOINTS_FOR_TEST = { DATA_ENDPOINTS, TRADING_ENDPOINTS }

async function listSymbols(): Promise<SymbolInfo[]> {
  const { response, endpoint } = await fetchMarketData('/exchangeInfo')
  if (!response.ok) throw new Error(`${endpoint.name} exchangeInfo request failed: ${response.status}`)
  const data = (await response.json()) as { symbols: BinanceSymbolInfo[] }
  return data.symbols
    .filter((s) => s.status === 'TRADING')
    .map((s) => ({ symbol: s.symbol, baseAsset: s.baseAsset, quoteAsset: s.quoteAsset, ...(isStockToken(s) ? { stockToken: true } : {}) }))
}

async function fetchHistoricalCandles(symbol: string, interval: Interval, limit = 500): Promise<Candle[]> {
  const { response, endpoint } = await fetchMarketData(`/klines?symbol=${symbol.toUpperCase()}&interval=${interval}&limit=${limit}`)
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
  const intervalMs = INTERVAL_SECONDS[interval] * 1000
  const total = Math.max(1, Math.ceil(((endSec - startSec) * 1000) / intervalMs))
  const endMs = endSec * 1000
  let cursorMs = startSec * 1000
  const collected: Candle[] = []

  while (cursorMs < endMs) {
    if (isCancelled()) break
    const { response, endpoint } = await fetchMarketData(`/klines?symbol=${symbol.toUpperCase()}&interval=${interval}&startTime=${cursorMs}&endTime=${endMs}&limit=1000`)
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
  const { response, endpoint } = await fetchMarketData(`/ticker/24hr?symbol=${symbol.toUpperCase()}`)
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

// ---------------------------------------------------------------------------------------------
// Whole-market reads, for the scanner (marketScannerService.ts). All three go to the DATA host:
// they are public market data, and the mirror serves every one of them.

/** A scanner's request that has not answered in this long is given up on. The pass it belongs to
 * runs once a minute; a request still open when the next one starts is worth nothing. */
const SCAN_TIMEOUT_MS = 8_000

interface BinanceBookTickerRest {
  symbol: string
  bidPrice: string
  askPrice: string
}

/** Every pair's 24-hour statistics in one request (weight 80). */
async function fetchAllTickers24h(): Promise<Ticker24h[]> {
  const { response, endpoint } = await fetchMarketData('/ticker/24hr', SCAN_TIMEOUT_MS * 2)
  if (!response.ok) throw new Error(`${endpoint.name} ticker request failed: ${response.status} ${response.statusText}`)
  const rows = (await response.json()) as (BinanceTicker24hRest & { symbol: string })[]
  return rows.map((raw) => ({
    symbol: raw.symbol,
    lastPrice: Number(raw.lastPrice),
    priceChange: Number(raw.priceChange),
    priceChangePercent: Number(raw.priceChangePercent),
    highPrice: Number(raw.highPrice),
    lowPrice: Number(raw.lowPrice),
    volume: Number(raw.volume),
    quoteVolume: Number(raw.quoteVolume)
  }))
}

/** Every pair's best bid and ask in one request (weight 4). */
async function fetchBookTickers(): Promise<BookTicker[]> {
  const { response, endpoint } = await fetchMarketData('/ticker/bookTicker', SCAN_TIMEOUT_MS)
  if (!response.ok) throw new Error(`${endpoint.name} book ticker request failed: ${response.status} ${response.statusText}`)
  const rows = (await response.json()) as BinanceBookTickerRest[]
  return rows.map((raw) => ({ symbol: raw.symbol, bidPrice: Number(raw.bidPrice), askPrice: Number(raw.askPrice) }))
}

/** fetchHistoricalCandles with a deadline, and a symbol that is safe to put in a URL: Binance
 * lists pairs whose names are not ASCII. */
async function fetchRecentCandles(symbol: string, interval: Interval, limit: number): Promise<Candle[]> {
  const { response, endpoint } = await fetchMarketData(`/klines?symbol=${encodeURIComponent(symbol)}&interval=${interval}&limit=${limit}`, SCAN_TIMEOUT_MS)
  if (!response.ok) throw new Error(`${endpoint.name} klines request failed: ${response.status} ${response.statusText}`)
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

export const binanceAdapter: ExchangeAdapter = {
  listSymbols,
  fetchHistoricalCandles,
  fetchHistoricalRange,
  fetchTicker24h,
  subscribeCandles,
  subscribeTicker,
  scan: { fetchAllTickers24h, fetchBookTickers, fetchRecentCandles }
}
