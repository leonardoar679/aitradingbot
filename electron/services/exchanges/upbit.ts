import { bucketTimeFor } from './aggregate'
import { createReconnectingSocket } from './reconnectingSocket'
import type { ExchangeAdapter } from './types'
import { INTERVAL_SECONDS, type Candle, type Interval, type SymbolInfo, type Ticker24h } from '../../../shared/ipc'

// Upbit silently caps `count` at 200 per request regardless of what's requested — verified live.
const MAX_CANDLES_PER_PAGE = 200

const REST_ROOT = 'https://api.upbit.com/v1'
const WS_URL = 'wss://api.upbit.com/websocket/v1'

// Upbit has a dedicated REST endpoint per granularity — verified live that weeks (the
// less-obvious one) returns real data in the same shape as minutes/days.
function candlePath(interval: Interval): string {
  switch (interval) {
    case '1m':
      return 'candles/minutes/1'
    case '15m':
      return 'candles/minutes/15'
    case '1h':
      return 'candles/minutes/60'
    case '4h':
      return 'candles/minutes/240'
    case '1d':
      return 'candles/days'
    case '1w':
      return 'candles/weeks'
  }
}

interface UpbitMarket {
  market: string // e.g. 'KRW-BTC'
}

interface UpbitCandle {
  candle_date_time_utc: string
  opening_price: number
  high_price: number
  low_price: number
  trade_price: number
  candle_acc_trade_volume: number
}

interface UpbitTickerRest {
  opening_price: number
  high_price: number
  low_price: number
  trade_price: number
  signed_change_price: number
  signed_change_rate: number
  acc_trade_volume_24h: number
  acc_trade_price_24h: number
}

interface UpbitWsTickerMessage {
  type: string
  code: string
  opening_price: number
  high_price: number
  low_price: number
  trade_price: number
  signed_change_price: number
  signed_change_rate: number
  acc_trade_volume_24h: number
  acc_trade_price_24h: number
}

function splitMarket(market: string): { baseAsset: string; quoteAsset: string } {
  const [quoteAsset, baseAsset] = market.split('-')
  return { baseAsset, quoteAsset }
}

async function listSymbols(): Promise<SymbolInfo[]> {
  const response = await fetch(`${REST_ROOT}/market/all`)
  if (!response.ok) throw new Error(`Upbit market/all request failed: ${response.status}`)
  const markets = (await response.json()) as UpbitMarket[]
  return markets.map((m) => ({ symbol: m.market, ...splitMarket(m.market) }))
}

async function fetchHistoricalCandles(symbol: string, interval: Interval, limit = 500): Promise<Candle[]> {
  const response = await fetch(`${REST_ROOT}/${candlePath(interval)}?market=${symbol}&count=${limit}`)
  if (!response.ok) {
    throw new Error(`Upbit candles request failed: ${response.status} ${response.statusText}`)
  }
  const rows = (await response.json()) as UpbitCandle[]
  // Upbit returns newest-first; we want ascending time.
  return rows
    .map((row) => ({
      time: Math.floor(new Date(`${row.candle_date_time_utc}Z`).getTime() / 1000),
      open: row.opening_price,
      high: row.high_price,
      low: row.low_price,
      close: row.trade_price,
      volume: row.candle_acc_trade_volume
    }))
    .sort((a, b) => a.time - b.time)
}

async function fetchHistoricalRange(
  symbol: string,
  interval: Interval,
  startSec: number,
  endSec: number,
  onProgress: (done: number, total: number) => void,
  isCancelled: () => boolean
): Promise<Candle[]> {
  const intervalSec = INTERVAL_SECONDS[interval]
  const total = Math.max(1, Math.ceil((endSec - startSec) / intervalSec))
  const path = candlePath(interval)
  let cursorTo = endSec
  const collected: Candle[] = []

  // Upbit paginates backward: each page returns up to MAX_CANDLES_PER_PAGE candles ending at `to`.
  while (cursorTo > startSec) {
    if (isCancelled()) break
    const toParam = new Date(cursorTo * 1000).toISOString().split('.')[0]
    const response = await fetch(`${REST_ROOT}/${path}?market=${symbol}&count=${MAX_CANDLES_PER_PAGE}&to=${toParam}`)
    if (!response.ok) {
      throw new Error(`Upbit candles request failed: ${response.status} ${response.statusText}`)
    }
    const rows = (await response.json()) as UpbitCandle[]
    if (rows.length === 0) break
    let oldest = cursorTo
    for (const row of rows) {
      const t = Math.floor(new Date(`${row.candle_date_time_utc}Z`).getTime() / 1000)
      oldest = Math.min(oldest, t)
      if (t < startSec) continue
      collected.push({
        time: t,
        open: row.opening_price,
        high: row.high_price,
        low: row.low_price,
        close: row.trade_price,
        volume: row.candle_acc_trade_volume
      })
    }
    onProgress(Math.min(collected.length, total), total)
    if (oldest <= startSec || oldest >= cursorTo) break
    cursorTo = oldest - 1
  }
  collected.sort((a, b) => a.time - b.time)
  return collected
}

async function fetchTicker24h(symbol: string): Promise<Ticker24h> {
  const response = await fetch(`${REST_ROOT}/ticker?markets=${symbol}`)
  if (!response.ok) {
    throw new Error(`Upbit ticker request failed: ${response.status} ${response.statusText}`)
  }
  const rows = (await response.json()) as UpbitTickerRest[]
  const t = rows[0]
  if (!t) throw new Error(`Upbit ticker returned no data for ${symbol}`)
  return {
    symbol,
    lastPrice: t.trade_price,
    priceChange: t.signed_change_price,
    priceChangePercent: t.signed_change_rate * 100,
    highPrice: t.high_price,
    lowPrice: t.low_price,
    volume: t.acc_trade_volume_24h,
    quoteVolume: t.acc_trade_price_24h
  }
}

async function subscribeCandles(
  symbol: string,
  interval: Interval,
  onUpdate: (candle: Candle) => void
): Promise<() => void> {
  // Upbit's WS API has no kline/candle channel — build live bars from the trade feed,
  // bucketed to the requested interval width.
  let current: Candle | null = null

  return createReconnectingSocket(WS_URL, {
    onOpen: (socket) => {
      socket.send(
        JSON.stringify([
          { ticket: `trading-app-candles-${Date.now()}` },
          { type: 'trade', codes: [symbol] },
          { format: 'DEFAULT' }
        ])
      )
    },
    onMessage: (raw) => {
      let msg: { type?: string; trade_price?: number; trade_volume?: number; trade_timestamp?: number }
      try {
        msg = JSON.parse(raw.toString())
      } catch {
        return
      }
      if (msg.type !== 'trade' || msg.trade_price === undefined || msg.trade_volume === undefined) return
      const price = msg.trade_price
      const size = msg.trade_volume
      const tradeTimeSec = Math.floor((msg.trade_timestamp ?? Date.now()) / 1000)
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
    onError: (error) => console.error('Upbit candle socket error:', error)
  })
}

async function subscribeTicker(symbol: string, onUpdate: (ticker: Ticker24h) => void): Promise<() => void> {
  return createReconnectingSocket(WS_URL, {
    onOpen: (socket) => {
      socket.send(
        JSON.stringify([
          { ticket: `trading-app-ticker-${Date.now()}` },
          { type: 'ticker', codes: [symbol] },
          { format: 'DEFAULT' }
        ])
      )
    },
    onMessage: (raw) => {
      let msg: UpbitWsTickerMessage
      try {
        msg = JSON.parse(raw.toString())
      } catch {
        return
      }
      if (msg.type !== 'ticker') return
      onUpdate({
        symbol: msg.code,
        lastPrice: msg.trade_price,
        priceChange: msg.signed_change_price,
        priceChangePercent: msg.signed_change_rate * 100,
        highPrice: msg.high_price,
        lowPrice: msg.low_price,
        volume: msg.acc_trade_volume_24h,
        quoteVolume: msg.acc_trade_price_24h
      })
    },
    onError: (error) => console.error('Upbit ticker socket error:', error)
  })
}

export const upbitAdapter: ExchangeAdapter = {
  listSymbols,
  fetchHistoricalCandles,
  fetchHistoricalRange,
  fetchTicker24h,
  subscribeCandles,
  subscribeTicker
}
