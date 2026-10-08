import { EXIT_LINES } from '../../shared/aiAdditions'
import { MARKET_BARS_15M, MARKET_BARS_1M, MARKET_REFERENCE_SYMBOLS, referenceReturns, type ReferenceCandles } from '../../shared/aiEventMarket'
import type { Candle, Exchange, ExecutorConfig } from '../../shared/ipc'
import { marketRegimeOf, type MarketRegime } from '../../shared/marketResearch'
import { runExecutorSimulation } from '../executors/engine'

// WHERE AN OPEN TRADE STANDS, READ FROM ITS MINUTES. What the exit check (exitCheck.ts) and the
// Positions page's thesis status (src/positions/thesisMeasure.ts) both measure in the renderer, where
// the engine runs, and the main process cannot: where the engine says a paper trade entered, the
// last closed minute, the pair's move over its last fifteen, and the market's regime by Bitcoin's
// minutes (shared/marketResearch.ts) as of any minute. IT READS. Nothing here writes, asks or
// places; a reading is judged on the last CLOSED minute, as the settle loops judge a trade.

export const QUARTER_HOUR = 900

/** Candles of [startSec, endSec], of a minute or of fifteen. */
export type FetchCandles = (exchange: Exchange, symbol: string, interval: '1m' | '15m', startSec: number, endSec: number) => Promise<Candle[]>

/** A pair's last closed minute, and its move over the fifteen before. */
export interface MinutesReading {
  /** The last closed minute. */
  last: Candle
  /** The move over the fifteen closed minutes before it, in percent; null when they are not all
   * there. */
  move15mPct: number | null
}

/** The last closed minute of a pair's minutes, and the move over the fifteen before it. Null when
 * none has closed, or the last closed is not of the last few (EXIT_LINES.priceMaxAgeSeconds): a
 * stale minute is not where the trade is. */
export function readMinutes(minutes: Candle[], nowSec: number): MinutesReading | null {
  const closed = minutes.filter((bar) => bar.time + 60 <= nowSec)
  if (closed.length === 0) return null
  const last = closed[closed.length - 1]
  if (nowSec - (last.time + 60) > EXIT_LINES.priceMaxAgeSeconds) return null
  const before = closed.find((bar) => bar.time === last.time - QUARTER_HOUR)
  const move15mPct = before === undefined || !(before.close > 0) ? null : (last.close / before.close - 1) * 100
  return { last, move15mPct }
}

/** Where an open paper trade stands on its closed minutes. */
export interface OpenTradeReading extends MinutesReading {
  entryPrice: number
  enteredAt: number
}

/** Where a paper trade stands: where the engine says it entered, the last close, and the pair's last
 * fifteen minutes. Null for one that has not entered, has closed, or whose minutes are not of the
 * last few. */
export function readOpenTrade(executor: ExecutorConfig, minutes: Candle[], nowSec: number): OpenTradeReading | null {
  const closed = minutes.filter((bar) => bar.time + 60 <= nowSec)
  // Its own minutes are the ones the settle loops simulate: from when it was opened.
  const own = closed.filter((bar) => bar.time >= executor.createdAt)
  if (own.length === 0) return null
  const state = runExecutorSimulation(own, executor, own[0].close)
  if (state.kind !== 'position' || state.status !== 'open' || state.entryPrice === null || state.enteredAt === null) return null
  const reading = readMinutes(closed, nowSec)
  if (reading === null) return null
  return { entryPrice: state.entryPrice, enteredAt: state.enteredAt, ...reading }
}

/** The market's regime as of a minute, by Bitcoin's candles before it (shared/marketResearch.ts), or
 * null when they do not reach it. */
export function regimeAt(btc: ReferenceCandles, time: number): MarketRegime | null {
  return marketRegimeOf(referenceReturns(btc, time))
}

/** Bitcoin's minutes and quarters from before `fromSec` to now: enough for the regime as of any
 * minute from `fromSec` on. Null when they cannot be read. */
export function readBitcoin(fetchCandles: FetchCandles, exchange: Exchange, fromSec: number, nowSec: number): Promise<ReferenceCandles | null> {
  return Promise.all([
    fetchCandles(exchange, MARKET_REFERENCE_SYMBOLS.btc, '1m', fromSec - (MARKET_BARS_1M + 1) * 60, nowSec),
    fetchCandles(exchange, MARKET_REFERENCE_SYMBOLS.btc, '15m', fromSec - (MARKET_BARS_15M + 2) * QUARTER_HOUR, nowSec)
  ]).then(
    ([candles1m, candles15m]) => ({ candles1m, candles15m }),
    () => null
  )
}
