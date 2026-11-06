import { AsyncLocalStorage } from 'node:async_hooks'
import { BinanceBudget, GapBudget, HTTP_PACING_LINES, WeightBudget, realClock, type Priority } from '../../shared/httpPacing'

// The main process's one budget per host (shared/httpPacing.ts; V8 Stage 1). Every public read of the host goes
// through its budget; a signed request never does. Since V9 Stage 3 a read runs in the background lane where the work
// it is part of was started in it (inBackground): finding traders and analysing them do, a follow never does.

const lane = new AsyncLocalStorage<Priority>()

/** The lane the read now running belongs to: the background where its work was started there, else normal. */
export const laneNow = (): Priority => lane.getStore() ?? 'normal'

/** Runs work whose public reads wait behind every other: each read it makes, however deep, is in the background lane. */
export function inBackground<T>(work: () => Promise<T>): Promise<T> {
  return lane.run('background', work)
}

/** Binance's public market data: every read through fetchMarketData (exchanges/binance.ts). */
export const binanceBudget = new BinanceBudget()

/** Hyperliquid's info endpoint (V8 Stage 6), costed before each request. */
export const hyperliquidBudget = new WeightBudget('Hyperliquid', HTTP_PACING_LINES.hyperliquid.weightPerMinute, realClock, laneNow)

/** OKX's public copy-trading endpoints (V8 Stage 7), one key an endpoint. */
export const okxBudget = new GapBudget('OKX', HTTP_PACING_LINES.okx.minGapMs, realClock, laneNow)

/** Binance's USD-M futures market data (V8 Stage 6), costed before each request, and its funding history apart. */
export const binanceFuturesBudget = new WeightBudget('Binance futures', HTTP_PACING_LINES.binanceFutures.weightPerMinute, realClock, laneNow)
export const binanceFundingBudget = new GapBudget('Binance futures funding', HTTP_PACING_LINES.binanceFutures.fundingGapMs, realClock, laneNow)

/** Bitget's public market data for its perpetuals (V8 Stage 6). */
export const bitgetMarketBudget = new GapBudget('Bitget', HTTP_PACING_LINES.bitget.minGapMs, realClock, laneNow)
