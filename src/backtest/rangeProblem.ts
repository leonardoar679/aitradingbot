/** Why a backtest cannot be run over the requested dates, or null if it can.
 *
 * The date fields are plain `<input type="date">`, so they can be cleared entirely, and nothing
 * stops the start being set after the end. Neither used to be checked. `new Date('T00:00:00Z')`
 * is an Invalid Date whose getTime() is NaN, and the fetch loop is `while (cursorMs < endMs)` --
 * false for NaN and false for a backwards range alike. Both cases therefore returned zero candles
 * with no error, and a zero-candle backtest still renders the full results page: an equity curve,
 * thirty-odd metrics, Sharpe and Sortino and Omega all reading 0.00, and a balance of
 * "10,000.00 → 10,000.00".
 *
 * Nothing on that page says the range was the problem. Someone still learning reads "0 trades"
 * as "this strategy does not trade", not "I typed the dates in the wrong boxes". */
export function describeRangeProblem({
  startDate,
  endDate
}: {
  startDate: string
  endDate: string
}): string | null {
  const startSec = Date.parse(`${startDate}T00:00:00Z`) / 1000
  const endSec = Date.parse(`${endDate}T23:59:59Z`) / 1000

  if (!Number.isFinite(startSec)) return 'Pick a start date — the backtest needs a date to run from.'
  if (!Number.isFinite(endSec)) return 'Pick an end date — the backtest needs a date to run until.'
  // >= rather than >, though the two are equivalent as written: start parses at 00:00:00Z and
  // end at 23:59:59Z, so they can never be equal. Kept as >= so this stays correct if those
  // time suffixes are ever changed.
  if (startSec >= endSec) {
    return `The start date (${startDate}) is not before the end date (${endDate}). Swap them, or widen the range — as entered there is no period to test over.`
  }
  return null
}

/** Why a range that looked valid still produced nothing to test. Separate from the above because
 * the user did nothing wrong here and the fix is different: a different symbol, interval, or a
 * period the exchange actually has data for. */
export function describeEmptyRange({
  candleCount,
  startDate,
  endDate
}: {
  candleCount: number
  startDate: string
  endDate: string
}): string | null {
  if (candleCount > 0) return null
  return `The exchange returned no candles for ${startDate} → ${endDate}. That period may be before this pair started trading, or the interval may be too coarse for it. Nothing was tested, so no results are shown.`
}
