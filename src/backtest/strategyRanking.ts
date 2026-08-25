import type { BacktestStats } from './engine'

/** A strategy that never opened a position, and how to rank and describe one.
 *
 * The backtest of a strategy that never fired comes back looking respectable: net 0.00%, max
 * drawdown 0.00%, and a green tint because 0 is not negative. Sorted by net profit it lands
 * ABOVE every strategy that actually traded and lost, and sorted by drawdown it comes FIRST,
 * because risking nothing has the best risk figures available.
 *
 * None of those numbers is false. The account really would have ended flat. What is false is the
 * comparison: a row that never took a position is not a safer strategy, it is the absence of a
 * result, and the ranking it wins is the one nobody should act on. Measured on real data, one of
 * this app's three strategies (RSI Mean-Reversion) opened a single position in twenty-seven runs
 * -- its two entry conditions are close to mutually exclusive -- and the comparison table showed
 * it mid-field in green.
 */

export function tookNoTrades(stats: BacktestStats): boolean {
  return stats.totalClosedTrades === 0 && stats.openTrades === 0
}

/** Why there is nothing to read in this row, in plain words.
 *
 * Deliberately does not guess at a fix: whether the entry rule is too strict or the window is
 * simply the wrong market is not something a backtest of one window can tell anyone. */
export function describeNoTrades(strategyName: string, stats: BacktestStats, candleCount: number): string {
  const tradable = Math.max(candleCount - stats.warmupBars, 0)
  return (
    `${strategyName} never opened a position here. Its entry conditions did not occur together on any of the ` +
    `${tradable.toLocaleString()} candles it could trade on` +
    (stats.warmupBars > 0 ? ` (the first ${stats.warmupBars.toLocaleString()} are indicator warm-up)` : '') +
    `. The flat 0.00% is the absence of a result, not a good one — and it is not comparable to a strategy that traded.`
  )
}

export interface RankableRow<T> {
  row: T
  stats: BacktestStats
}

/** Orders strategies for the comparison table, with every no-trade row below every row that
 * traded, whatever the column is sorted by.
 *
 * The two-step comparator is written so it stays consistent when the arguments are swapped:
 * reversing only one branch would make it claim "a first" for both (a,b) and (b,a), and the
 * result would then depend on the sort's internals rather than on the data. */
export function rankStrategyRows<T>(
  rows: readonly RankableRow<T>[],
  sortKey: keyof BacktestStats,
  higherIsBetter: boolean
): RankableRow<T>[] {
  return [...rows].sort((a, b) => {
    const aFlat = tookNoTrades(a.stats)
    const bFlat = tookNoTrades(b.stats)
    if (aFlat !== bFlat) return aFlat ? 1 : -1

    const aValue = a.stats[sortKey]
    const bValue = b.stats[sortKey]
    if (typeof aValue !== 'number' || typeof bValue !== 'number') return 0
    // Compared rather than subtracted. Profit factor really does come back as Infinity for a run
    // with no losing trade, and Infinity - Infinity is NaN -- which the sort spec then coerces to
    // 0, so subtraction happens to reach the same answer. Saying "equal" outright does not depend
    // on knowing that.
    if (aValue === bValue) return 0
    const diff = aValue > bValue ? 1 : -1
    return higherIsBetter ? -diff : diff
  })
}

/** The comparison table's columns, kept here rather than in the view so the sort direction of
 * each one is a fact a test can check without rendering React. */
export type SortKey = 'totalNetProfitPct' | 'winRatePct' | 'maxDrawdownPct' | 'sharpeRatio' | 'profitFactor'

export const COMPARISON_COLUMNS: { key: SortKey; label: string; format: (stats: BacktestStats) => string; higherIsBetter: boolean }[] = [
  { key: 'totalNetProfitPct', label: 'Net %', format: (s) => `${s.totalNetProfitPct >= 0 ? '+' : ''}${s.totalNetProfitPct.toFixed(2)}%`, higherIsBetter: true },
  { key: 'winRatePct', label: 'Win Rate', format: (s) => `${s.winRatePct.toFixed(1)}%`, higherIsBetter: true },
  // maxDrawdownPct is stored NEGATIVE (-34.23 for a 34% fall), so the better drawdown is the
  // LARGER number -- the one nearer zero. Flagged false, this column sorted the worst drawdown to
  // the top while every other column sorted best-first.
  { key: 'maxDrawdownPct', label: 'Max Drawdown', format: (s) => `${s.maxDrawdownPct.toFixed(2)}%`, higherIsBetter: true },
  { key: 'sharpeRatio', label: 'Sharpe', format: (s) => s.sharpeRatio.toFixed(2), higherIsBetter: true },
  { key: 'profitFactor', label: 'Profit Factor', format: (s) => (s.profitFactor === Infinity ? '∞' : s.profitFactor.toFixed(2)), higherIsBetter: true }
]

