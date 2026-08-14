export type Timeframe = '1D' | '1W' | '1M' | '3M'

export const TIMEFRAMES: Timeframe[] = ['1D', '1W', '1M', '3M']

/** How far back each timeframe button filters PortfolioEvolutionChart's real snapshot history --
 * unlike the old mock series, real snapshots arrive on a fixed cadence (PortfolioScheduler's poll
 * interval), not a fixed point count, so this is a lookback window rather than a point count. */
export const TIMEFRAME_LOOKBACK_SEC: Record<Timeframe, number> = {
  '1D': 24 * 3600,
  '1W': 7 * 24 * 3600,
  '1M': 30 * 24 * 3600,
  '3M': 90 * 24 * 3600
}
