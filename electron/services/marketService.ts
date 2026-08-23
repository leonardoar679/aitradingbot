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
import { createStreamSlot } from './streamSlot'

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
// One slot each, rather than a bare stop function: the renderer re-subscribes on every
// interval change, symbol change and page mount, so two connects are regularly in flight at
// once and the loser has to be closed rather than left holding a socket nobody can reach.
const candleSlot = createStreamSlot()
const tickerSlot = createStreamSlot()

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

// Keyed by requestId, not a single shared flag -- several independent fetches (a background bot
// poll, a scheduled routine, a Backtest run) can be in flight at once, and cancelling one must
// never truncate another. Each entry is removed once its fetch settles, so this never grows
// unbounded.
const cancelledRequestIds = new Set<string>()

export function fetchHistoricalRange(
  exchange: Exchange,
  symbol: string,
  interval: Interval,
  startSec: number,
  endSec: number,
  requestId: string,
  onProgress: (done: number, total: number) => void
): Promise<{ candles: Candle[]; cancelled: boolean }> {
  return getAdapter(exchange)
    .fetchHistoricalRange(symbol, interval, startSec, endSec, onProgress, () => cancelledRequestIds.has(requestId))
    .then((candles) => ({ candles, cancelled: cancelledRequestIds.has(requestId) }))
    .finally(() => cancelledRequestIds.delete(requestId))
}

export function cancelHistoricalRangeFetch(requestId: string): void {
  cancelledRequestIds.add(requestId)
}

export function subscribeCandles(exchange: Exchange, symbol: string, interval: Interval): Promise<void> {
  return candleSlot.open(() =>
    getAdapter(exchange).subscribeCandles(symbol, interval, (candle) => {
      for (const listener of candleListeners) listener(candle)
    })
  )
}

export function unsubscribeCandles(): void {
  candleSlot.close()
}

export function subscribeTicker(exchange: Exchange, symbol: string): Promise<void> {
  return tickerSlot.open(() =>
    getAdapter(exchange).subscribeTicker(symbol, (ticker) => {
      for (const listener of tickerListeners) listener(ticker)
    })
  )
}

export function unsubscribeTicker(): void {
  tickerSlot.close()
}
