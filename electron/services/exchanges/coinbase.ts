import { aggregateCandles, bucketTimeFor } from './aggregate'
import { createReconnectingSocket } from './reconnectingSocket'
import type { ExchangeAdapter } from './types'
import type { Candle, Interval, SymbolInfo, Ticker24h } from '../../../shared/ipc'

// Coinbase Exchange's candles endpoint errors if a single request would return more than
// 300 aggregations — verified live (400 "Count of aggregations requested exceeds 300").
const MAX_CANDLES_PER_PAGE = 300

const REST_ROOT = 'https://api.exchange.coinbase.com'
const WS_URL = 'wss://ws-feed.exchange.coinbase.com'

// Coinbase Exchange's candles endpoint only offers these granularities (seconds); verified
// live that 60/900/3600/86400 all return real data. 4h and 1w have no native granularity,
// so they're built by aggregating real 1h/1d bars.
const NATIVE_GRANULARITY: Partial<Record<Interval, number>> = {
  '1m': 60,
  '15m': 900,
  '1h': 3600,
  '1d': 86400
}

interface CoinbaseProduct {
  id: string
  base_currency: string
  quote_currency: string
  status: string
  trading_disabled: boolean
}

// [time, low, high, open, close, volume]
type CoinbaseCandleRow = [number, number, number, number, number, number]

interface CoinbaseStats {
  open: string
  high: string
  low: string
  last: string
  volume: string
}

interface CoinbaseTickerRest {
  price: string
}

interface CoinbaseMatchMessage {
  type: string
  price: string
  size: string
  time: string
}

interface CoinbaseTickerMessage {
  type: string
  price: string
  open_24h: string
  high_24h: string
  low_24h: string
  volume_24h: string
}

async function listSymbols(): Promise<SymbolInfo[]> {
  const response = await fetch(`${REST_ROOT}/products`)
  if (!response.ok) throw new Error(`Coinbase products request failed: ${response.status}`)
  const products = (await response.json()) as CoinbaseProduct[]
  return products
    .filter((p) => p.status === 'online' && !p.trading_disabled)
    .map((p) => ({ symbol: p.id, baseAsset: p.base_currency, quoteAsset: p.quote_currency }))
}

async function fetchCandleRows(symbol: string, granularity: number): Promise<Candle[]> {
  const response = await fetch(`${REST_ROOT}/products/${symbol}/candles?granularity=${granularity}`)
  if (!response.ok) {
    throw new Error(`Coinbase candles request failed: ${response.status} ${response.statusText}`)
  }
  const rows = (await response.json()) as CoinbaseCandleRow[]
  // Coinbase returns newest-first; we want ascending time.
  return rows
    .map(([time, low, high, open, close, volume]) => ({ time, open, high, low, close, volume }))
    .sort((a, b) => a.time - b.time)
}

async function fetchHistoricalCandles(symbol: string, interval: Interval, limit = 500): Promise<Candle[]> {
  const native = NATIVE_GRANULARITY[interval]
  if (native !== undefined) {
    const candles = await fetchCandleRows(symbol, native)
    return candles.slice(-limit)
  }
  // 4h aggregates from real 1h bars, 1w from real 1d bars — exact rollups, not approximations.
  const baseGranularity = interval === '4h' ? NATIVE_GRANULARITY['1h']! : NATIVE_GRANULARITY['1d']!
  const candles = await fetchCandleRows(symbol, baseGranularity)
  return aggregateCandles(candles, interval).slice(-limit)
}

async function fetchHistoricalRange(
  symbol: string,
  interval: Interval,
  startSec: number,
  endSec: number,
  onProgress: (done: number, total: number) => void,
  isCancelled: () => boolean
): Promise<Candle[]> {
  const native = NATIVE_GRANULARITY[interval]
  const granularity = native ?? (interval === '4h' ? NATIVE_GRANULARITY['1h']! : NATIVE_GRANULARITY['1d']!)
  const total = Math.max(1, Math.ceil((endSec - startSec) / granularity))
  let cursor = startSec
  const collected: Candle[] = []

  while (cursor < endSec) {
    if (isCancelled()) break
    const chunkEnd = Math.min(endSec, cursor + MAX_CANDLES_PER_PAGE * granularity)
    const url = `${REST_ROOT}/products/${symbol}/candles?start=${new Date(cursor * 1000).toISOString()}&end=${new Date(chunkEnd * 1000).toISOString()}&granularity=${granularity}`
    const response = await fetch(url)
    if (!response.ok) {
      throw new Error(`Coinbase candles request failed: ${response.status} ${response.statusText}`)
    }
    const rows = (await response.json()) as CoinbaseCandleRow[]
    for (const [time, low, high, open, close, volume] of rows) {
      collected.push({ time, open, high, low, close, volume })
    }
    onProgress(Math.min(collected.length, total), total)
    cursor = chunkEnd
  }
  collected.sort((a, b) => a.time - b.time)
  return native !== undefined ? collected : aggregateCandles(collected, interval)
}

async function fetchTicker24h(symbol: string): Promise<Ticker24h> {
  const [statsRes, tickerRes] = await Promise.all([
    fetch(`${REST_ROOT}/products/${symbol}/stats`),
    fetch(`${REST_ROOT}/products/${symbol}/ticker`)
  ])
  if (!statsRes.ok) throw new Error(`Coinbase stats request failed: ${statsRes.status}`)
  if (!tickerRes.ok) throw new Error(`Coinbase ticker request failed: ${tickerRes.status}`)
  const stats = (await statsRes.json()) as CoinbaseStats
  const tick = (await tickerRes.json()) as CoinbaseTickerRest
  const lastPrice = Number(tick.price ?? stats.last)
  const open = Number(stats.open)
  const priceChange = lastPrice - open
  const volume = Number(stats.volume)
  return {
    symbol,
    lastPrice,
    priceChange,
    priceChangePercent: open ? (priceChange / open) * 100 : 0,
    highPrice: Number(stats.high),
    lowPrice: Number(stats.low),
    volume,
    // Coinbase's REST API doesn't expose 24h quote volume directly; approximate from base volume * last price.
    quoteVolume: volume * lastPrice
  }
}

async function subscribeCandles(
  symbol: string,
  interval: Interval,
  onUpdate: (candle: Candle) => void
): Promise<() => void> {
  // Coinbase has no kline/candle WS channel — build live bars from the trade feed, bucketed
  // to the requested interval width.
  let current: Candle | null = null

  return createReconnectingSocket(WS_URL, {
    onOpen: (socket) => {
      socket.send(JSON.stringify({ type: 'subscribe', product_ids: [symbol], channels: ['matches'] }))
    },
    onMessage: (raw) => {
      let msg: CoinbaseMatchMessage
      try {
        msg = JSON.parse(raw.toString())
      } catch {
        return
      }
      if (msg.type !== 'match' && msg.type !== 'last_match') return
      const price = Number(msg.price)
      const size = Number(msg.size)
      const tradeTimeSec = Math.floor(new Date(msg.time).getTime() / 1000)
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
    onError: (error) => console.error('Coinbase candle socket error:', error)
  })
}

async function subscribeTicker(symbol: string, onUpdate: (ticker: Ticker24h) => void): Promise<() => void> {
  return createReconnectingSocket(WS_URL, {
    onOpen: (socket) => {
      socket.send(JSON.stringify({ type: 'subscribe', product_ids: [symbol], channels: ['ticker'] }))
    },
    onMessage: (raw) => {
      let msg: CoinbaseTickerMessage
      try {
        msg = JSON.parse(raw.toString())
      } catch {
        return
      }
      if (msg.type !== 'ticker') return
      const lastPrice = Number(msg.price)
      const open = Number(msg.open_24h)
      const priceChange = lastPrice - open
      const volume = Number(msg.volume_24h)
      onUpdate({
        symbol,
        lastPrice,
        priceChange,
        priceChangePercent: open ? (priceChange / open) * 100 : 0,
        highPrice: Number(msg.high_24h),
        lowPrice: Number(msg.low_24h),
        volume,
        quoteVolume: volume * lastPrice
      })
    },
    onError: (error) => console.error('Coinbase ticker socket error:', error)
  })
}

export const coinbaseAdapter: ExchangeAdapter = {
  listSymbols,
  fetchHistoricalCandles,
  fetchHistoricalRange,
  fetchTicker24h,
  subscribeCandles,
  subscribeTicker
}
