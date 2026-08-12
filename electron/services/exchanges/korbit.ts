import { bucketTimeFor } from './aggregate'
import { createReconnectingSocket } from './reconnectingSocket'
import type { ExchangeAdapter } from './types'
import { INTERVAL_SECONDS, type Candle, type Interval, type SymbolInfo, type Ticker24h } from '../../../shared/ipc'

// Korbit's v2 candle interval values are minutes as strings, plus '1D'/'1W' — verified live
// that 1/15/60/240/1D/1W all return real, distinct data. No aggregation needed.
const NATIVE_INTERVAL: Record<Interval, string> = {
  '1m': '1',
  '15m': '15',
  '1h': '60',
  '4h': '240',
  '1d': '1D',
  '1w': '1W'
}
const MAX_CANDLES_PER_PAGE = 200
const REST_ROOT = 'https://api.korbit.co.kr/v2'
const WS_URL = 'wss://ws-api.korbit.co.kr/v2/public'

interface KorbitEnvelope<T> {
  success: boolean
  data?: T
  error?: { code: number; message: string }
}

interface KorbitPair {
  symbol: string
  status: string
}

interface KorbitCandleRow {
  timestamp: number
  open: string
  high: string
  low: string
  close: string
  volume: string
}

interface KorbitTickerData {
  symbol: string
  open: string
  high: string
  low: string
  close: string
  priceChange: string
  priceChangePercent: string
  volume: string
  quoteVolume: string
}

interface KorbitWsTickerData {
  open: string
  high: string
  low: string
  close: string
  priceChange: string
  priceChangePercent: string
  volume: string
  quoteVolume: string
}

interface KorbitWsTradeItem {
  timestamp: number
  price: string
  qty: string
}

interface KorbitWsMessage {
  symbol?: string
  type?: string
  data?: unknown
}

function assertOk<T>(envelope: KorbitEnvelope<T>, context: string): T {
  if (!envelope.success || envelope.data === undefined) {
    throw new Error(`Korbit ${context} error: ${envelope.error?.message ?? 'unknown'}`)
  }
  return envelope.data
}

async function listSymbols(): Promise<SymbolInfo[]> {
  const response = await fetch(`${REST_ROOT}/currencyPairs`)
  if (!response.ok) throw new Error(`Korbit currencyPairs request failed: ${response.status}`)
  const envelope = (await response.json()) as KorbitEnvelope<KorbitPair[]>
  const pairs = assertOk(envelope, 'currencyPairs')
  return pairs
    .filter((p) => p.status === 'launched')
    .map((p) => {
      const [base, quote] = p.symbol.split('_')
      return { symbol: p.symbol, baseAsset: base.toUpperCase(), quoteAsset: quote.toUpperCase() }
    })
}

function rowToCandle(row: KorbitCandleRow): Candle {
  return {
    time: Math.floor(row.timestamp / 1000),
    open: Number(row.open),
    high: Number(row.high),
    low: Number(row.low),
    close: Number(row.close),
    volume: Number(row.volume)
  }
}

async function fetchCandlePage(
  symbol: string,
  interval: Interval,
  limit: number,
  startMs?: number,
  endMs?: number
): Promise<KorbitCandleRow[]> {
  const range = startMs !== undefined && endMs !== undefined ? `&start=${startMs}&end=${endMs}` : ''
  const response = await fetch(
    `${REST_ROOT}/candles?symbol=${symbol}&interval=${NATIVE_INTERVAL[interval]}&limit=${limit}${range}`
  )
  if (!response.ok) throw new Error(`Korbit candles request failed: ${response.status} ${response.statusText}`)
  const envelope = (await response.json()) as KorbitEnvelope<KorbitCandleRow[]>
  return assertOk(envelope, 'candles')
}

async function fetchHistoricalCandles(symbol: string, interval: Interval, limit = 500): Promise<Candle[]> {
  const rows = await fetchCandlePage(symbol, interval, Math.min(limit, MAX_CANDLES_PER_PAGE))
  return rows.map(rowToCandle)
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
  const total = Math.max(1, Math.ceil((endSec - startSec) / INTERVAL_SECONDS[interval]))
  const endMs = endSec * 1000
  let cursor = startSec * 1000
  const collected: Candle[] = []

  while (cursor < endMs) {
    if (isCancelled()) break
    const rows = await fetchCandlePage(symbol, interval, MAX_CANDLES_PER_PAGE, cursor, endMs)
    if (rows.length === 0) break
    collected.push(...rows.map(rowToCandle))
    onProgress(Math.min(collected.length, total), total)
    const last = rows[rows.length - 1].timestamp
    if (last <= cursor) break
    cursor = last + intervalMs
    if (rows.length < MAX_CANDLES_PER_PAGE) break
  }
  return collected
}

async function fetchTicker24h(symbol: string): Promise<Ticker24h> {
  const response = await fetch(`${REST_ROOT}/tickers?symbol=${symbol}`)
  if (!response.ok) throw new Error(`Korbit tickers request failed: ${response.status} ${response.statusText}`)
  const envelope = (await response.json()) as KorbitEnvelope<KorbitTickerData[]>
  const data = assertOk(envelope, 'tickers')
  const t = data[0]
  if (!t) throw new Error(`Korbit tickers returned no data for ${symbol}`)
  return {
    symbol,
    lastPrice: Number(t.close),
    priceChange: Number(t.priceChange),
    priceChangePercent: Number(t.priceChangePercent),
    highPrice: Number(t.high),
    lowPrice: Number(t.low),
    volume: Number(t.volume),
    quoteVolume: Number(t.quoteVolume)
  }
}

async function subscribeCandles(
  symbol: string,
  interval: Interval,
  onUpdate: (candle: Candle) => void
): Promise<() => void> {
  // Korbit's WS API has no kline/candle channel — build live bars from the trade feed,
  // bucketed to the requested interval width.
  let current: Candle | null = null

  return createReconnectingSocket(WS_URL, {
    onOpen: (socket) => {
      socket.send(JSON.stringify([{ method: 'subscribe', type: 'trade', symbols: [symbol] }]))
    },
    onMessage: (raw) => {
      let msg: KorbitWsMessage
      try {
        msg = JSON.parse(raw.toString())
      } catch {
        return
      }
      if (msg.type !== 'trade' || msg.symbol !== symbol) return
      const trades = msg.data as KorbitWsTradeItem[] | undefined
      if (!trades) return

      for (const trade of trades) {
        const price = Number(trade.price)
        const size = Number(trade.qty)
        const tradeTimeSec = Math.floor(trade.timestamp / 1000)
        const bucketTime = bucketTimeFor(tradeTimeSec, interval)

        if (!current || current.time !== bucketTime) {
          current = { time: bucketTime, open: price, high: price, low: price, close: price, volume: size }
        } else {
          current = {
            ...current,
            high: Math.max(current.high, price),
            low: Math.min(current.low, price),
            close: price,
            volume: current.volume + size
          }
        }
        onUpdate(current)
      }
    },
    onError: (error) => console.error('Korbit candle socket error:', error)
  })
}

async function subscribeTicker(symbol: string, onUpdate: (ticker: Ticker24h) => void): Promise<() => void> {
  return createReconnectingSocket(WS_URL, {
    onOpen: (socket) => {
      socket.send(JSON.stringify([{ method: 'subscribe', type: 'ticker', symbols: [symbol] }]))
    },
    onMessage: (raw) => {
      let msg: KorbitWsMessage
      try {
        msg = JSON.parse(raw.toString())
      } catch {
        return
      }
      if (msg.type !== 'ticker' || msg.symbol !== symbol) return
      const t = msg.data as KorbitWsTickerData | undefined
      if (!t) return
      onUpdate({
        symbol,
        lastPrice: Number(t.close),
        priceChange: Number(t.priceChange),
        priceChangePercent: Number(t.priceChangePercent),
        highPrice: Number(t.high),
        lowPrice: Number(t.low),
        volume: Number(t.volume),
        quoteVolume: Number(t.quoteVolume)
      })
    },
    onError: (error) => console.error('Korbit ticker socket error:', error)
  })
}

export const korbitAdapter: ExchangeAdapter = {
  listSymbols,
  fetchHistoricalCandles,
  fetchHistoricalRange,
  fetchTicker24h,
  subscribeCandles,
  subscribeTicker
}
