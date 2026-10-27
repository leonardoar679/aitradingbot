import { VENUE_FEES } from './venueCosts'

// THE BASELINE BOOK'S LINES (V8 Stage 9, 27 October 2026; the plan's decision of 26 October: the best of the
// strategies already built, run as it was backtested, beside the two new ideas). Trend Regime Ensemble
// (src/backtest/strategies/trendRegimeEnsemble.ts) on the eight symbols its backtests were read on, at its own
// interval, long only on spot as it was built, its trades in the baseline book on paper. It enters only on a signal at
// a bar that closed after paper testing was started -- never on a regime already standing then -- so the book's run is
// the strategy's own from its Start. Fixed here, and named by V8-S9-BOOKS, before the first Start.

export const BASELINE_LINES = {
  version: 'baseline-v1',
  strategy: 'trend-regime-ensemble',
  interval: '4h',
  /** research/interval.ts's SELECT and CONFIRM: the eight its backtests were read on. */
  symbols: ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'ADAUSDT', 'BNBUSDT', 'LINKUSDT', 'LTCUSDT', 'XRPUSDT'],
  /** Entered only on an entry signal at a bar that closed after the Start. */
  freshSignalsOnly: true,
  /** A bar is read this long after its close, so that its close is final. */
  readAfterCloseSec: 30,
  /** Long on Binance's spot at its taker fee each way: no funding. */
  venue: 'binance',
  takerPct: VENUE_FEES.binance.takerPct
} as const

export type BaselineSymbol = (typeof BASELINE_LINES.symbols)[number]
