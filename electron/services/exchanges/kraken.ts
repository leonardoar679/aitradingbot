import { createReconnectingSocket } from './reconnectingSocket'
import type { ExchangeAdapter } from './types'
import type { Candle, Interval, SymbolInfo, Ticker24h } from '../../../shared/ipc'

const REST_ROOT = 'https://api.kraken.com/0/public'
const WS_URL = 'wss://ws.kraken.com'

// Kraken's OHLC interval is minutes; verified live that 1/15/60/240/1440/10080 all return
// real, distinct data.
const NATIVE_INTERVAL_MINUTES: Record<Interval, number> = {
  '1m': 1,
  '15m': 15,
  '1h': 60,
  '4h': 240,
  '1d': 1440,
  '1w': 10080
}

interface KrakenAssetPair {
  wsname?: string
  base: string
  quote: string
  status: string
}

interface KrakenErrorEnvelope {
  error: string[]
}

interface KrakenAssetPairsResponse extends KrakenErrorEnvelope {
  result: Record<string, KrakenAssetPair>
}

// [time, open, high, low, close, vwap, volume, count]
type KrakenOhlcRow = [number, string, string, string, string, string, string, number]

interface KrakenOhlcResponse extends KrakenErrorEnvelope {
  result: Record<string, KrakenOhlcRow[] | number>
}

interface KrakenTickerData {
  c: [string, string] // last trade [price, lot volume]
  o: string // today's opening price (REST only gives a single value, not [today, 24h])
  h: [string, string] // high [today, 24h]
  l: [string, string] // low [today, 24h]
  v: [string, string] // volume [today, 24h]
}

interface KrakenTickerResponse extends KrakenErrorEnvelope {
  result: Record<string, KrakenTickerData>
}

interface KrakenWsTickerPayload {
  c: [string, string]
  o: [string, string] // WS ticker gives a true rolling [today, 24h] pair, unlike REST
  h: [string, string]
  l: [string, string]
  v: [string, string]
}

function assertNoError(envelope: KrakenErrorEnvelope, context: string): void {
  if (envelope.error.length > 0) {
    throw new Error(`Kraken ${context} error: ${envelope.error.join(', ')}`)
  }
}

/** Kraken prefixes some legacy asset codes with X (crypto) or Z (fiat), e.g. XXBT, ZUSD. */
function normalizeAssetCode(code: string): string {
  if (code.length === 4 && (code.startsWith('X') || code.startsWith('Z'))) return code.slice(1)
  return code
}

/** REST endpoints reject the 'wsname' pair format ('XBT/USD') used for WS subscriptions —
 * they want it without the slash ('XBTUSD', Kraken's 'altname'), which is reliably just
 * wsname with '/' removed. */
function toRestPair(symbol: string): string {
  return symbol.replace('/', '')
}

async function listSymbols(): Promise<SymbolInfo[]> {
  const response = await fetch(`${REST_ROOT}/AssetPairs`)
  if (!response.ok) throw new Error(`Kraken AssetPairs request failed: ${response.status}`)
  const data = (await response.json()) as KrakenAssetPairsResponse
  assertNoError(data, 'AssetPairs')
  return Object.values(data.result)
    .filter((pair) => pair.wsname && pair.status === 'online')
    .map((pair) => ({
      symbol: pair.wsname as string,
      baseAsset: normalizeAssetCode(pair.base),
      quoteAsset: normalizeAssetCode(pair.quote)
    }))
}

async function fetchHistoricalCandles(symbol: string, interval: Interval, limit = 500): Promise<Candle[]> {
  const minutes = NATIVE_INTERVAL_MINUTES[interval]
  const response = await fetch(
    `${REST_ROOT}/OHLC?pair=${encodeURIComponent(toRestPair(symbol))}&interval=${minutes}`
  )
  if (!response.ok) throw new Error(`Kraken OHLC request failed: ${response.status} ${response.statusText}`)
  const data = (await response.json()) as KrakenOhlcResponse
  assertNoError(data, 'OHLC')
  const resultKey = Object.keys(data.result).find((key) => key !== 'last')
  const rows = resultKey ? (data.result[resultKey] as KrakenOhlcRow[]) : []
  return rows.slice(-limit).map(([time, open, high, low, close, , volume]) => ({
    time,
    open: Number(open),
    high: Number(high),
    low: Number(low),
    close: Number(close),
    volume: Number(volume)
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
  const minutes = NATIVE_INTERVAL_MINUTES[interval]
  const intervalSec = minutes * 60
  const total = Math.max(1, Math.ceil((endSec - startSec) / intervalSec))
  let since = startSec
  const collected: Candle[] = []

  while (since < endSec) {
    if (isCancelled()) break
    const response = await fetch(
      `${REST_ROOT}/OHLC?pair=${encodeURIComponent(toRestPair(symbol))}&interval=${minutes}&since=${since}`
    )
    if (!response.ok) throw new Error(`Kraken OHLC request failed: ${response.status} ${response.statusText}`)
    const data = (await response.json()) as KrakenOhlcResponse
    assertNoError(data, 'OHLC')
    const resultKey = Object.keys(data.result).find((key) => key !== 'last')
    const rows = resultKey ? (data.result[resultKey] as KrakenOhlcRow[]) : []
    if (rows.length === 0) break
    for (const [time, open, high, low, close, , volume] of rows) {
      if (time > endSec) continue
      collected.push({ time, open: Number(open), high: Number(high), low: Number(low), close: Number(close), volume: Number(volume) })
    }
    onProgress(Math.min(collected.length, total), total)
    const last = Number(data.result.last)
    if (last <= since || rows[rows.length - 1][0] >= endSec) break
    since = last
  }
  return collected
}

async function fetchTicker24h(symbol: string): Promise<Ticker24h> {
  const response = await fetch(`${REST_ROOT}/Ticker?pair=${encodeURIComponent(toRestPair(symbol))}`)
  if (!response.ok) throw new Error(`Kraken Ticker request failed: ${response.status} ${response.statusText}`)
  const data = (await response.json()) as KrakenTickerResponse
  assertNoError(data, 'Ticker')
  const resultKey = Object.keys(data.result)[0]
  const t = data.result[resultKey]
  const lastPrice = Number(t.c[0])
  // Kraken's REST ticker only exposes today's (UTC) open, not a strict rolling 24h open —
  // close enough for an initial snapshot; the WS stream below uses the true rolling value.
  const open = Number(t.o)
  const priceChange = lastPrice - open
  const volume = Number(t.v[1])
  return {
    symbol,
    lastPrice,
    priceChange,
    priceChangePercent: open ? (priceChange / open) * 100 : 0,
    highPrice: Number(t.h[1]),
    lowPrice: Number(t.l[1]),
    volume,
    quoteVolume: volume * lastPrice
  }
}

async function subscribeCandles(
  symbol: string,
  interval: Interval,
  onUpdate: (candle: Candle) => void
): Promise<() => void> {
  const minutes = NATIVE_INTERVAL_MINUTES[interval]
  return createReconnectingSocket(WS_URL, {
    onOpen: (socket) => {
      socket.send(
        JSON.stringify({ event: 'subscribe', pair: [symbol], subscription: { name: 'ohlc', interval: minutes } })
      )
    },
    onMessage: (raw) => {
      let msg: unknown
      try {
        msg = JSON.parse(raw.toString())
      } catch {
        return
      }
      if (!Array.isArray(msg)) return // ignore event/heartbeat/status objects
      const payload = msg[1]
      if (!Array.isArray(payload)) return
      const [time, , open, high, low, close, , volume] = payload as string[]
      onUpdate({
        time: Math.floor(Number(time)),
        open: Number(open),
        high: Number(high),
        low: Number(low),
        close: Number(close),
        volume: Number(volume)
      })
    },
    onError: (error) => console.error('Kraken candle socket error:', error)
  })
}

async function subscribeTicker(symbol: string, onUpdate: (ticker: Ticker24h) => void): Promise<() => void> {
  return createReconnectingSocket(WS_URL, {
    onOpen: (socket) => {
      socket.send(JSON.stringify({ event: 'subscribe', pair: [symbol], subscription: { name: 'ticker' } }))
    },
    onMessage: (raw) => {
      let msg: unknown
      try {
        msg = JSON.parse(raw.toString())
      } catch {
        return
      }
      if (!Array.isArray(msg)) return
      const payload = msg[1] as KrakenWsTickerPayload | undefined
      if (!payload || !payload.c) return
      const lastPrice = Number(payload.c[0])
      const open = Number(payload.o[1])
      const priceChange = lastPrice - open
      const volume = Number(payload.v[1])
      onUpdate({
        symbol,
        lastPrice,
        priceChange,
        priceChangePercent: open ? (priceChange / open) * 100 : 0,
        highPrice: Number(payload.h[1]),
        lowPrice: Number(payload.l[1]),
        volume,
        quoteVolume: volume * lastPrice
      })
    },
    onError: (error) => console.error('Kraken ticker socket error:', error)
  })
}

export const krakenAdapter: ExchangeAdapter = {
  listSymbols,
  fetchHistoricalCandles,
  fetchHistoricalRange,
  fetchTicker24h,
  subscribeCandles,
  subscribeTicker
}
