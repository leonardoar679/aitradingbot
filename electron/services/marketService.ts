import type { Candle, Exchange, Interval, SymbolInfo, Ticker24h } from '../../shared/ipc'
import { binanceAdapter } from './exchanges/binance'
import { coinbaseAdapter } from './exchanges/coinbase'
import { krakenAdapter } from './exchanges/kraken'
import { bithumbAdapter } from './exchanges/bithumb'
import { upbitAdapter } from './exchanges/upbit'
import { coinoneAdapter } from './exchanges/coinone'
import { korbitAdapter } from './exchanges/korbit'
import { gopaxAdapter } from './exchanges/gopax'
import type { ExchangeAdapter } from './exchanges/types'

const ADAPTERS: Record<Exchange, ExchangeAdapter> = {
  binance: binanceAdapter,
  coinbase: coinbaseAdapter,
  kraken: krakenAdapter,
  bithumb: bithumbAdapter,
  upbit: upbitAdapter,
  coinone: coinoneAdapter,
  korbit: korbitAdapter,
  gopax: gopaxAdapter
}

function getAdapter(exchange: Exchange): ExchangeAdapter {
  const adapter = ADAPTERS[exchange]
  if (!adapter) throw new Error(`Unknown exchange: ${exchange}`)
  return adapter
}

const candleListeners = new Set<(candle: Candle) => void>()
const tickerListeners = new Set<(ticker: Ticker24h) => void>()
let stopCandleStream: (() => void) | null = null
let stopTickerStream: (() => void) | null = null

export function onCandleUpdate(listener: (candle: Candle) => void): () => void {
  candleListeners.add(listener)
  return () => candleListeners.delete(listener)
}

export function onTickerUpdate(listener: (ticker: Ticker24h) => void): () => void {
  tickerListeners.add(listener)
  return () => tickerListeners.delete(listener)
}

export function listSymbols(exchange: Exchange): Promise<SymbolInfo[]> {
  return getAdapter(exchange).listSymbols()
}

export function fetchHistoricalCandles(
  exchange: Exchange,
  symbol: string,
  interval: Interval,
  limit?: number
): Promise<Candle[]> {
  return getAdapter(exchange).fetchHistoricalCandles(symbol, interval, limit)
}

export function fetchTicker24h(exchange: Exchange, symbol: string): Promise<Ticker24h> {
  return getAdapter(exchange).fetchTicker24h(symbol)
}

let rangeFetchCancelled = false

export function fetchHistoricalRange(
  exchange: Exchange,
  symbol: string,
  interval: Interval,
  startSec: number,
  endSec: number,
  onProgress: (done: number, total: number) => void
): Promise<{ candles: Candle[]; cancelled: boolean }> {
  rangeFetchCancelled = false
  return getAdapter(exchange)
    .fetchHistoricalRange(symbol, interval, startSec, endSec, onProgress, () => rangeFetchCancelled)
    .then((candles) => ({ candles, cancelled: rangeFetchCancelled }))
}

export function cancelHistoricalRangeFetch(): void {
  rangeFetchCancelled = true
}

export async function subscribeCandles(exchange: Exchange, symbol: string, interval: Interval): Promise<void> {
  stopCandleStream?.()
  stopCandleStream = await getAdapter(exchange).subscribeCandles(symbol, interval, (candle) => {
    for (const listener of candleListeners) listener(candle)
  })
}

export function unsubscribeCandles(): void {
  stopCandleStream?.()
  stopCandleStream = null
}

export async function subscribeTicker(exchange: Exchange, symbol: string): Promise<void> {
  stopTickerStream?.()
  stopTickerStream = await getAdapter(exchange).subscribeTicker(symbol, (ticker) => {
    for (const listener of tickerListeners) listener(ticker)
  })
}

export function unsubscribeTicker(): void {
  stopTickerStream?.()
  stopTickerStream = null
}
