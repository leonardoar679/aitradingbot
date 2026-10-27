import { BinanceBudget, GapBudget, HTTP_PACING_LINES, WeightBudget } from '../../shared/httpPacing'

// The main process's one budget per host (shared/httpPacing.ts; V8 Stage 1). Every public read of the host goes
// through its budget; a signed request never does.

/** Binance's public market data: every read through fetchMarketData (exchanges/binance.ts). */
export const binanceBudget = new BinanceBudget()

/** Hyperliquid's info endpoint (V8 Stage 6), costed before each request. */
export const hyperliquidBudget = new WeightBudget('Hyperliquid', HTTP_PACING_LINES.hyperliquid.weightPerMinute)

/** OKX's public copy-trading endpoints (V8 Stage 7), one key an endpoint. */
export const okxBudget = new GapBudget('OKX', HTTP_PACING_LINES.okx.minGapMs)

/** Binance's USD-M futures market data (V8 Stage 6), costed before each request, and its funding history apart. */
export const binanceFuturesBudget = new WeightBudget('Binance futures', HTTP_PACING_LINES.binanceFutures.weightPerMinute)
export const binanceFundingBudget = new GapBudget('Binance futures funding', HTTP_PACING_LINES.binanceFutures.fundingGapMs)

/** Bitget's public market data for its perpetuals (V8 Stage 6). */
export const bitgetMarketBudget = new GapBudget('Bitget', HTTP_PACING_LINES.bitget.minGapMs)
