import type { Candle, Interval, SymbolInfo, Ticker24h } from '../../../shared/ipc'

export interface ExchangeAdapter {
  listSymbols(): Promise<SymbolInfo[]>
  fetchHistoricalCandles(symbol: string, interval: Interval, limit?: number): Promise<Candle[]>
  /** Paginates real requests to cover [startSec, endSec). Reports cumulative candles fetched
   * via onProgress after each page. Checks isCancelled between pages and stops early if true.
   * Returns the real fetched candles, ascending by time. */
  fetchHistoricalRange(
    symbol: string,
    interval: Interval,
    startSec: number,
    endSec: number,
    onProgress: (done: number, total: number) => void,
    isCancelled: () => boolean
  ): Promise<Candle[]>
  fetchTicker24h(symbol: string): Promise<Ticker24h>
  /** Returns an unsubscribe function. */
  subscribeCandles(
    symbol: string,
    interval: Interval,
    onUpdate: (candle: Candle) => void
  ): Promise<() => void>
  subscribeTicker(symbol: string, onUpdate: (ticker: Ticker24h) => void): Promise<() => void>
}
