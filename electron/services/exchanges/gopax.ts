import { aggregateCandles, bucketTimeFor } from './aggregate'
import { createReconnectingSocket } from './reconnectingSocket'
import type { ExchangeAdapter } from './types'
import { INTERVAL_SECONDS, type Candle, type Interval, type SymbolInfo, type Ticker24h } from '../../../shared/ipc'

// GOPAX's candle endpoint only natively supports 1/5/30/1440-minute granularities — verified
// live. 15m/1h/4h/1w are built by aggregating real 1m/5m/30m/1440m bars — exact rollups.
const NATIVE_MINUTES: Partial<Record<Interval, number>> = { '1m': 1, '1d': 1440 }
const AGGREGATE_BASE_MINUTES: Partial<Record<Interval, number>> = { '15m': 1, '1h': 5, '4h': 30, '1w': 1440 }
const MAX_CANDLES_PER_PAGE = 1024
const REST_ROOT = 'https://api.gopax.co.kr'
const WS_URL = 'wss://wsapi.gopax.co.kr'

interface GopaxTradingPair {
  name: string
  baseAsset: string
  quoteAsset: string
}

// [time_ms, low, high, open, close, volume] — an unusual field order, confirmed live against
// the /stats endpoint (matching open/high values for the same window).
type GopaxCandleRow = [number, number, number, number, number, number]

interface GopaxTicker {
  price: number
  quoteVolume: number
  volume: number
}

interface GopaxStats {
  open: number
  high: number
  low: number
}

interface GopaxWsTradeEvent {
  price: number
  baseAmount: number
  occurredAt: number // seconds, unlike the REST endpoints' millisecond timestamps
  tradingPairName: string
}

interface GopaxWsTickerEntry {
  last: number
  open: number
  high: number
  low: number
  baseVolume: number
  quoteVolume: number
  tradingPairName: string
}

interface GopaxWsMessage {
  n?: string
  o?: unknown
}

async function listSymbols(): Promise<SymbolInfo[]> {
  const response = await fetch(`${REST_ROOT}/trading-pairs`)
  if (!response.ok) throw new Error(`GOPAX trading-pairs request failed: ${response.status}`)
  const pairs = (await response.json()) as GopaxTradingPair[]
  return pairs.map((p) => ({ symbol: p.name, baseAsset: p.baseAsset, quoteAsset: p.quoteAsset }))
}

function rowToCandle(row: GopaxCandleRow): Candle {
  const [time, low, high, open, close, volume] = row
  return { time: Math.floor(time / 1000), open, high, low, close, volume }
}

async function fetchCandleRows(symbol: string, minutes: number, startMs: number, endMs: number, limit: number): Promise<Candle[]> {
  const response = await fetch(
    `${REST_ROOT}/trading-pairs/${symbol}/candles?start=${startMs}&end=${endMs}&interval=${minutes}&limit=${limit}`
  )
  if (!response.ok) throw new Error(`GOPAX candles request failed: ${response.status} ${response.statusText}`)
  const rows = (await response.json()) as GopaxCandleRow[]
  return rows.map(rowToCandle).sort((a, b) => a.time - b.time)
}

async function fetchHistoricalCandles(symbol: string, interval: Interval, limit = 500): Promise<Candle[]> {
  const endMs = Date.now()
  const native = NATIVE_MINUTES[interval]
  if (native) {
    const startMs = endMs - limit * native * 60_000
    const candles = await fetchCandleRows(symbol, native, startMs, endMs, Math.min(limit, MAX_CANDLES_PER_PAGE))
    return candles.slice(-limit)
  }
  const baseMinutes = AGGREGATE_BASE_MINUTES[interval]!
  const ratio = INTERVAL_SECONDS[interval] / (baseMinutes * 60)
  const startMs = endMs - limit * ratio * baseMinutes * 60_000
  const baseCandles = await fetchCandleRows(symbol, baseMinutes, startMs, endMs, MAX_CANDLES_PER_PAGE)
  return aggregateCandles(baseCandles, interval).slice(-limit)
}

async function fetchAllBaseCandles(
  symbol: string,
  minutes: number,
  startSec: number,
  endSec: number,
  onProgress: (done: number, total: number) => void,
  isCancelled: () => boolean,
  totalForProgress: number
): Promise<Candle[]> {
  const intervalMs = minutes * 60_000
  const endMs = endSec * 1000
  let cursor = startSec * 1000
  const collected: Candle[] = []

  while (cursor < endMs) {
    if (isCancelled()) break
    const rows = await fetchCandleRows(symbol, minutes, cursor, endMs, MAX_CANDLES_PER_PAGE)
    if (rows.length === 0) break
    collected.push(...rows)
    onProgress(Math.min(collected.length, totalForProgress), totalForProgress)
    const last = rows[rows.length - 1].time * 1000
    if (last <= cursor) break
    cursor = last + intervalMs
    if (rows.length < MAX_CANDLES_PER_PAGE) break
  }
  return collected
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
  const native = NATIVE_MINUTES[interval]
  if (native) {
    const rows = await fetchAllBaseCandles(symbol, native, startSec, endSec, onProgress, isCancelled, total)
    return rows.filter((c) => c.time >= startSec && c.time <= endSec)
  }
  const baseMinutes = AGGREGATE_BASE_MINUTES[interval]!
  const rows = await fetchAllBaseCandles(symbol, baseMinutes, startSec, endSec, onProgress, isCancelled, total)
  return aggregateCandles(rows, interval).filter((c) => c.time >= startSec && c.time <= endSec)
}

async function fetchTicker24h(symbol: string): Promise<Ticker24h> {
  const [tickerRes, statsRes] = await Promise.all([
    fetch(`${REST_ROOT}/trading-pairs/${symbol}/ticker`),
    fetch(`${REST_ROOT}/trading-pairs/${symbol}/stats`)
  ])
  if (!tickerRes.ok) throw new Error(`GOPAX ticker request failed: ${tickerRes.status} ${tickerRes.statusText}`)
  if (!statsRes.ok) throw new Error(`GOPAX stats request failed: ${statsRes.status} ${statsRes.statusText}`)
  const ticker = (await tickerRes.json()) as GopaxTicker
  const stats = (await statsRes.json()) as GopaxStats
  const priceChange = ticker.price - stats.open
  return {
    symbol,
    lastPrice: ticker.price,
    priceChange,
    priceChangePercent: stats.open ? (priceChange / stats.open) * 100 : 0,
    highPrice: stats.high,
    lowPrice: stats.low,
    volume: ticker.volume,
    quoteVolume: ticker.quoteVolume
  }
}

async function subscribeCandles(
  symbol: string,
  interval: Interval,
  onUpdate: (candle: Candle) => void
): Promise<() => void> {
  // GOPAX's WS API has no kline/candle channel — build live bars from the public trade feed
  // included in a trading-pair subscription, bucketed to the requested interval width.
  let current: Candle | null = null

  return createReconnectingSocket(WS_URL, {
    onOpen: (socket) => {
      socket.send(JSON.stringify({ n: 'SubscribeToTradingPair', o: { tradingPairName: symbol } }))
    },
    onMessage: (raw) => {
      let msg: GopaxWsMessage
      try {
        msg = JSON.parse(raw.toString())
      } catch {
        return
      }
      if (msg.n !== 'PublicTradeEvent') return
      const trade = msg.o as GopaxWsTradeEvent | undefined
      if (!trade || trade.tradingPairName !== symbol) return

      const price = trade.price
      const size = trade.baseAmount
      const bucketTime = bucketTimeFor(Math.floor(trade.occurredAt), interval)

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
    onError: (error) => console.error('GOPAX candle socket error:', error)
  })
}

async function subscribeTicker(symbol: string, onUpdate: (ticker: Ticker24h) => void): Promise<() => void> {
  function emit(t: GopaxWsTickerEntry): void {
    const priceChange = t.last - t.open
    onUpdate({
      symbol,
      lastPrice: t.last,
      priceChange,
      priceChangePercent: t.open ? (priceChange / t.open) * 100 : 0,
      highPrice: t.high,
      lowPrice: t.low,
      volume: t.baseVolume,
      quoteVolume: t.quoteVolume
    })
  }

  return createReconnectingSocket(WS_URL, {
    onOpen: (socket) => {
      socket.send(JSON.stringify({ n: 'SubscribeToTickers', o: {} }))
    },
    onMessage: (raw) => {
      let msg: GopaxWsMessage
      try {
        msg = JSON.parse(raw.toString())
      } catch {
        return
      }
      // The initial ack bundles a snapshot for every pair as { data: [...] }; subsequent
      // deltas push one pair at a time keyed by trading pair name.
      if (msg.n === 'SubscribeToTickers') {
        const snapshot = (msg.o as { data?: GopaxWsTickerEntry[] } | undefined)?.data
        const entry = snapshot?.find((t) => t.tradingPairName === symbol)
        if (entry) emit(entry)
        return
      }
      if (msg.n !== 'TickerEvent') return
      const byPair = msg.o as Record<string, GopaxWsTickerEntry> | undefined
      const entry = byPair?.[symbol]
      if (entry) emit(entry)
    },
    onError: (error) => console.error('GOPAX ticker socket error:', error)
  })
}

export const gopaxAdapter: ExchangeAdapter = {
  listSymbols,
  fetchHistoricalCandles,
  fetchHistoricalRange,
  fetchTicker24h,
  subscribeCandles,
  subscribeTicker
}
