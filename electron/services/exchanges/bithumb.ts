import { aggregateCandles, bucketTimeFor } from './aggregate'
import { createReconnectingSocket } from './reconnectingSocket'
import type { ExchangeAdapter } from './types'
import { INTERVAL_SECONDS, type Candle, type Interval, type SymbolInfo, type Ticker24h } from '../../../shared/ipc'

const REST_ROOT = 'https://api.bithumb.com/public'
const WS_URL = 'wss://pubwss.bithumb.com/pub/ws'

// Bithumb's candlestick chart_intervals only include these; verified live that '5m' and
// '1h' both return real data (same row shape as '1m'). 15m/4h/1w have no native interval,
// so they're built by aggregating real 5m/1h/24h bars.
const NATIVE_CHART_INTERVAL: Partial<Record<Interval, string>> = {
  '1m': '1m',
  '1h': '1h',
  '1d': '24h'
}
const AGGREGATE_FROM: Partial<Record<Interval, string>> = {
  '15m': '5m',
  '4h': '1h',
  '1w': '24h'
}

interface BithumbEnvelope<T> {
  status: string
  data?: T
  message?: string
}

interface BithumbTickerData {
  opening_price: string
  closing_price: string
  min_price: string
  max_price: string
  units_traded_24H: string
  acc_trade_value_24H: string
  fluctate_24H: string
  fluctate_rate_24H: string
}

// [time_ms, open, close, high, low, volume]
type BithumbCandleRow = [number, string, string, string, string, string]

interface BithumbWsTickerContent {
  openPrice: string
  closePrice: string
  highPrice: string
  lowPrice: string
  volume: string
  value: string
  chgAmt: string
  chgRate: string
}

interface BithumbWsTransactionItem {
  contPrice: string
  contQty: string
}

interface BithumbWsMessage {
  type?: string
  content?: unknown
}

function assertOk<T>(envelope: BithumbEnvelope<T>, context: string): T {
  if (envelope.status !== '0000' || envelope.data === undefined) {
    throw new Error(`Bithumb ${context} error: ${envelope.message ?? envelope.status}`)
  }
  return envelope.data
}

async function listSymbols(): Promise<SymbolInfo[]> {
  const response = await fetch(`${REST_ROOT}/ticker/ALL_KRW`)
  if (!response.ok) throw new Error(`Bithumb ticker/ALL_KRW request failed: ${response.status}`)
  const envelope = (await response.json()) as BithumbEnvelope<Record<string, unknown>>
  const data = assertOk(envelope, 'ticker/ALL_KRW')
  return Object.keys(data)
    .filter((key) => key !== 'date')
    .map((base) => ({ symbol: `${base}_KRW`, baseAsset: base, quoteAsset: 'KRW' }))
}

async function fetchCandleRows(symbol: string, chartInterval: string): Promise<Candle[]> {
  const response = await fetch(`${REST_ROOT}/candlestick/${symbol}/${chartInterval}`)
  if (!response.ok) {
    throw new Error(`Bithumb candlestick request failed: ${response.status} ${response.statusText}`)
  }
  const envelope = (await response.json()) as BithumbEnvelope<BithumbCandleRow[]>
  const rows = assertOk(envelope, 'candlestick')
  return rows.map(([time, open, close, high, low, volume]) => ({
    time: Math.floor(time / 1000),
    open: Number(open),
    high: Number(high),
    low: Number(low),
    close: Number(close),
    volume: Number(volume)
  }))
}

async function fetchHistoricalCandles(symbol: string, interval: Interval, limit = 500): Promise<Candle[]> {
  const native = NATIVE_CHART_INTERVAL[interval]
  if (native) {
    const candles = await fetchCandleRows(symbol, native)
    return candles.slice(-limit)
  }
  // 15m/4h/1w aggregate from real 5m/1h/24h bars — exact rollups, not approximations.
  const candles = await fetchCandleRows(symbol, AGGREGATE_FROM[interval]!)
  return aggregateCandles(candles, interval).slice(-limit)
}

// Bithumb's public candlestick endpoint has no start/end/pagination params at all — verified
// live it always returns a fixed ~200-row window of the most recent candles, regardless of
// interval. There is no way to reach further back through this API, so a requested range that
// extends beyond that window is only ever partially covered — reported honestly via `total`
// rather than padded out.
async function fetchHistoricalRange(
  symbol: string,
  interval: Interval,
  startSec: number,
  endSec: number,
  onProgress: (done: number, total: number) => void,
  isCancelled: () => boolean
): Promise<Candle[]> {
  const total = Math.max(1, Math.ceil((endSec - startSec) / INTERVAL_SECONDS[interval]))
  if (isCancelled()) return []
  const native = NATIVE_CHART_INTERVAL[interval]
  const candles = native
    ? await fetchCandleRows(symbol, native)
    : aggregateCandles(await fetchCandleRows(symbol, AGGREGATE_FROM[interval]!), interval)
  const inRange = candles.filter((c) => c.time >= startSec && c.time <= endSec)
  onProgress(Math.min(inRange.length, total), total)
  return inRange
}

async function fetchTicker24h(symbol: string): Promise<Ticker24h> {
  const response = await fetch(`${REST_ROOT}/ticker/${symbol}`)
  if (!response.ok) {
    throw new Error(`Bithumb ticker request failed: ${response.status} ${response.statusText}`)
  }
  const envelope = (await response.json()) as BithumbEnvelope<BithumbTickerData>
  const t = assertOk(envelope, 'ticker')
  return {
    symbol,
    lastPrice: Number(t.closing_price),
    priceChange: Number(t.fluctate_24H),
    priceChangePercent: Number(t.fluctate_rate_24H),
    highPrice: Number(t.max_price),
    lowPrice: Number(t.min_price),
    volume: Number(t.units_traded_24H),
    quoteVolume: Number(t.acc_trade_value_24H)
  }
}

async function subscribeCandles(
  symbol: string,
  interval: Interval,
  onUpdate: (candle: Candle) => void
): Promise<() => void> {
  // Bithumb's WS API has no kline/candle channel — build live bars from the trade feed,
  // bucketed to the requested interval width. Trade timestamps (contDtm) are KST strings
  // with no explicit offset; we bucket by receipt time instead of parsing them, which is
  // both simpler and avoids a timezone bug.
  let current: Candle | null = null

  return createReconnectingSocket(WS_URL, {
    onOpen: (socket) => {
      socket.send(JSON.stringify({ type: 'transaction', symbols: [symbol] }))
    },
    onMessage: (raw) => {
      let msg: BithumbWsMessage
      try {
        msg = JSON.parse(raw.toString())
      } catch {
        return
      }
      if (msg.type !== 'transaction') return
      const list = (msg.content as { list?: BithumbWsTransactionItem[] } | undefined)?.list
      if (!list) return

      for (const item of list) {
        const price = Number(item.contPrice)
        const size = Number(item.contQty)
        const nowSec = Math.floor(Date.now() / 1000)
        const bucketTime = bucketTimeFor(nowSec, interval)

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
    onError: (error) => console.error('Bithumb candle socket error:', error)
  })
}

async function subscribeTicker(symbol: string, onUpdate: (ticker: Ticker24h) => void): Promise<() => void> {
  return createReconnectingSocket(WS_URL, {
    onOpen: (socket) => {
      socket.send(JSON.stringify({ type: 'ticker', symbols: [symbol], tickTypes: ['24H'] }))
    },
    onMessage: (raw) => {
      let msg: BithumbWsMessage
      try {
        msg = JSON.parse(raw.toString())
      } catch {
        return
      }
      if (msg.type !== 'ticker') return
      const t = msg.content as BithumbWsTickerContent | undefined
      if (!t) return
      onUpdate({
        symbol,
        lastPrice: Number(t.closePrice),
        priceChange: Number(t.chgAmt),
        priceChangePercent: Number(t.chgRate),
        highPrice: Number(t.highPrice),
        lowPrice: Number(t.lowPrice),
        volume: Number(t.volume),
        quoteVolume: Number(t.value)
      })
    },
    onError: (error) => console.error('Bithumb ticker socket error:', error)
  })
}

export const bithumbAdapter: ExchangeAdapter = {
  listSymbols,
  fetchHistoricalCandles,
  fetchHistoricalRange,
  fetchTicker24h,
  subscribeCandles,
  subscribeTicker
}
