import type { Candle, Interval, SymbolInfo, Ticker24h } from '../../../shared/ipc'

/** The best resting bid and ask for one pair. */
export interface BookTicker {
  symbol: string
  bidPrice: number
  askPrice: number
}

/** Whole-market reads: every pair in one request. Only some exchanges offer them, and a scanner
 * that had to ask pair by pair what is liquid and how wide its spread is would spend its whole
 * request budget before it had read a candle. */
export interface MarketScanSource {
  fetchAllTickers24h(): Promise<Ticker24h[]>
  fetchBookTickers(): Promise<BookTicker[]>
  /** The newest `limit` candles, oldest first; the last is still forming. Bounded in time, unlike
   * fetchHistoricalCandles: a scanner asks for sixty of these a minute, and one that hangs would
   * hold up the whole pass. */
  fetchRecentCandles(symbol: string, interval: Interval, limit: number): Promise<Candle[]>
}

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
  /** Present only where the exchange can be scanned as a whole market. */
  scan?: MarketScanSource
}
