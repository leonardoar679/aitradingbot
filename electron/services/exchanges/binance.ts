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
const ENDPOINTS: RestEndpoint[] = [
  { name: 'binance.com', restRoot: 'https://api.binance.com/api/v3', wsBase: 'wss://stream.binance.com:9443/ws' },
  { name: 'binance.us', restRoot: 'https://api.binance.us/api/v3', wsBase: 'wss://stream.binance.us:9443/ws' }
]

let resolvedEndpoint: RestEndpoint | null = null

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

export async function resolveEndpoint(): Promise<RestEndpoint> {
  if (resolvedEndpoint) return resolvedEndpoint

  for (const endpoint of ENDPOINTS) {
    try {
      const response = await fetch(`${endpoint.restRoot}/klines?symbol=BTCUSDT&interval=1m&limit=1`)
      const data: unknown = await response.json().catch(() => null)
      if (response.ok && Array.isArray(data)) {
        console.log(`Using Binance endpoint: ${endpoint.name}`)
        resolvedEndpoint = endpoint
        return endpoint
      }
      console.warn(`Binance endpoint ${endpoint.name} unavailable:`, data)
    } catch (error) {
      console.warn(`Binance endpoint ${endpoint.name} unreachable:`, error)
    }
  }
  throw new Error(`No reachable Binance endpoint (tried: ${ENDPOINTS.map((e) => e.name).join(', ')})`)
}

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
