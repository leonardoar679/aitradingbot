import { bucketTimeFor } from './aggregate'
import { createReconnectingSocket } from './reconnectingSocket'
import type { ExchangeAdapter } from './types'
import { INTERVAL_SECONDS, type Candle, type Interval, type SymbolInfo, type Ticker24h } from '../../../shared/ipc'

// Coinone's chart interval query values are exactly our own Interval strings — verified live
// that 1m/15m/1h/4h/1d/1w all return real, distinct data. No aggregation needed.
const MAX_CANDLES_PER_PAGE = 500
const REST_ROOT = 'https://api.coinone.co.kr/public/v2'
const WS_URL = 'wss://stream.coinone.co.kr'

function splitSymbol(symbol: string): { target: string; quote: string } {
  const [target, quote] = symbol.split('_')
  return { target, quote }
}

interface CoinoneMarket {
  quote_currency: string
  target_currency: string
  maintenance_status: number
  trade_status: number
}

interface CoinoneMarketsResponse {
  result: string
  error_code: string
  markets: CoinoneMarket[]
}

interface CoinoneChartRow {
  timestamp: number
  open: string
  high: string
  low: string
  close: string
  target_volume: string
  quote_volume: string
}

interface CoinoneChartResponse {
  result: string
  error_code: string
  is_last: boolean
  chart: CoinoneChartRow[]
}

interface CoinoneTickerData {
  quote_currency: string
  target_currency: string
  timestamp: number
  high: string
  low: string
  first: string
  last: string
  quote_volume: string
  target_volume: string
}

interface CoinoneTickerResponse {
  result: string
  error_code: string
  tickers: CoinoneTickerData[]
}

interface CoinoneWsTickerData {
  high: string
  low: string
  first: string
  last: string
  quote_volume: string
  target_volume: string
}

interface CoinoneWsTradeData {
  timestamp: number
  price: string
  qty: string
}

interface CoinoneWsMessage {
  response_type?: string
  channel?: string
  data?: unknown
}

function assertOk<T extends { result: string; error_code: string }>(envelope: T, context: string): T {
  if (envelope.result !== 'success') {
    throw new Error(`Coinone ${context} error: ${envelope.error_code}`)
  }
  return envelope
}

async function listSymbols(): Promise<SymbolInfo[]> {
  const response = await fetch(`${REST_ROOT}/markets/KRW`)
  if (!response.ok) throw new Error(`Coinone markets request failed: ${response.status}`)
  const envelope = assertOk((await response.json()) as CoinoneMarketsResponse, 'markets')
  return envelope.markets
    .filter((m) => m.trade_status === 1 && m.maintenance_status === 0)
    .map((m) => ({ symbol: `${m.target_currency}_${m.quote_currency}`, baseAsset: m.target_currency, quoteAsset: m.quote_currency }))
}

async function fetchChartPage(symbol: string, interval: Interval, size: number, beforeMs?: number): Promise<CoinoneChartRow[]> {
  const { target, quote } = splitSymbol(symbol)
  const cursor = beforeMs !== undefined ? `&timestamp=${beforeMs}` : ''
  const response = await fetch(`${REST_ROOT}/chart/${quote}/${target}?interval=${interval}&size=${size}${cursor}`)
  if (!response.ok) throw new Error(`Coinone chart request failed: ${response.status} ${response.statusText}`)
  const envelope = assertOk((await response.json()) as CoinoneChartResponse, 'chart')
  return envelope.chart
}

function rowToCandle(row: CoinoneChartRow): Candle {
  return {
    time: Math.floor(row.timestamp / 1000),
    open: Number(row.open),
    high: Number(row.high),
    low: Number(row.low),
    close: Number(row.close),
    volume: Number(row.target_volume)
  }
}

async function fetchHistoricalCandles(symbol: string, interval: Interval, limit = 500): Promise<Candle[]> {
  const rows = await fetchChartPage(symbol, interval, Math.min(limit, MAX_CANDLES_PER_PAGE))
  // Coinone returns newest-first; ascending is what the rest of the app expects.
  return rows.map(rowToCandle).reverse().slice(-limit)
}

async function fetchHistoricalRange(
  symbol: string,
  interval: Interval,
  startSec: number,
  endSec: number,
  onProgress: (done: number, total: number) => void,
  isCancelled: () => boolean
): Promise<Candle[]> {
  const total = Math.max(1, Math.ceil((endSec - startSec) / INTERVAL_SECONDS[interval]))
  let cursorMs: number | undefined = endSec * 1000
  const collected: Candle[] = []

  // Coinone paginates backward: `timestamp` is an inclusive "at or before" cursor.
  while (true) {
    if (isCancelled()) break
    const rows = await fetchChartPage(symbol, interval, MAX_CANDLES_PER_PAGE, cursorMs)
    if (rows.length === 0) break
    let oldest = cursorMs!
    for (const row of rows) {
      const t = Math.floor(row.timestamp / 1000)
      oldest = Math.min(oldest, row.timestamp)
      if (t < startSec || t > endSec) continue
      collected.push(rowToCandle(row))
    }
    onProgress(Math.min(collected.length, total), total)
    if (oldest <= startSec * 1000 || oldest >= cursorMs!) break
    cursorMs = oldest - 1
  }
  collected.sort((a, b) => a.time - b.time)
  return collected
}

async function fetchTicker24h(symbol: string): Promise<Ticker24h> {
  const { target, quote } = splitSymbol(symbol)
  const response = await fetch(`${REST_ROOT}/ticker_new/${quote}/${target}`)
  if (!response.ok) throw new Error(`Coinone ticker request failed: ${response.status} ${response.statusText}`)
  const envelope = assertOk((await response.json()) as CoinoneTickerResponse, 'ticker')
  const t = envelope.tickers[0]
  if (!t) throw new Error(`Coinone ticker returned no data for ${symbol}`)
  const last = Number(t.last)
  const first = Number(t.first)
  const priceChange = last - first
  return {
    symbol,
    lastPrice: last,
    priceChange,
    priceChangePercent: first ? (priceChange / first) * 100 : 0,
    highPrice: Number(t.high),
    lowPrice: Number(t.low),
    volume: Number(t.target_volume),
    quoteVolume: Number(t.quote_volume)
  }
}

async function subscribeCandles(
  symbol: string,
  interval: Interval,
  onUpdate: (candle: Candle) => void
): Promise<() => void> {
  // Coinone's WS API has no kline/candle channel — build live bars from the trade feed,
  // bucketed to the requested interval width.
  const { target, quote } = splitSymbol(symbol)
  let current: Candle | null = null

  return createReconnectingSocket(WS_URL, {
    onOpen: (socket) => {
      socket.send(
        JSON.stringify({ request_type: 'SUBSCRIBE', channel: 'TRADE', topic: { quote_currency: quote, target_currency: target } })
      )
    },
    onMessage: (raw) => {
      let msg: CoinoneWsMessage
      try {
        msg = JSON.parse(raw.toString())
      } catch {
        return
      }
      if (msg.response_type !== 'DATA' || msg.channel !== 'TRADE') return
      const trade = msg.data as CoinoneWsTradeData | undefined
      if (!trade) return

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
    },
    onError: (error) => console.error('Coinone candle socket error:', error)
  })
}

async function subscribeTicker(symbol: string, onUpdate: (ticker: Ticker24h) => void): Promise<() => void> {
  const { target, quote } = splitSymbol(symbol)
  return createReconnectingSocket(WS_URL, {
    onOpen: (socket) => {
      socket.send(
        JSON.stringify({ request_type: 'SUBSCRIBE', channel: 'TICKER', topic: { quote_currency: quote, target_currency: target } })
      )
    },
    onMessage: (raw) => {
      let msg: CoinoneWsMessage
      try {
        msg = JSON.parse(raw.toString())
      } catch {
        return
      }
      if (msg.response_type !== 'DATA' || msg.channel !== 'TICKER') return
      const t = msg.data as CoinoneWsTickerData | undefined
      if (!t) return
      const last = Number(t.last)
      const first = Number(t.first)
      const priceChange = last - first
      onUpdate({
        symbol,
        lastPrice: last,
        priceChange,
        priceChangePercent: first ? (priceChange / first) * 100 : 0,
        highPrice: Number(t.high),
        lowPrice: Number(t.low),
        volume: Number(t.target_volume),
        quoteVolume: Number(t.quote_volume)
      })
    },
    onError: (error) => console.error('Coinone ticker socket error:', error)
  })
}

export const coinoneAdapter: ExchangeAdapter = {
  listSymbols,
  fetchHistoricalCandles,
  fetchHistoricalRange,
  fetchTicker24h,
  subscribeCandles,
  subscribeTicker
}
