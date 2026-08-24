/** Whether a Grid executor's price range can do anything, and whether it will do it soon.
 *
 * Grid is the only executor type whose defaults are absolute prices rather than percentages or
 * nulls, and those defaults were derived from `price ?? 100` -- an invented price, used whenever
 * the modal's ticker fetch had not landed yet or had failed. Opening the modal and clicking
 * Create promptly produced a BTCUSDT grid spanning 95 to 105:
 *
 *   created 400ms after opening the modal:  start=95      end=105
 *   created 6s after opening the modal:     start=73522   end=81261
 *
 * The first one never fills, and nothing said so -- it simply sat at "0 / 21 levels filled"
 * forever. The defaults no longer invent a price, so the fields start empty instead, and this is
 * what keeps an empty or nonsensical range from being submitted.
 *
 * A range that does not bracket the current price is a WARNING, not an error: placing a grid
 * below the market to catch a dip is a real strategy, and refusing it would be wrong. It just
 * must not be the thing that happens silently by accident. */
export function describeGridBoundsProblem({
  startPrice,
  endPrice,
  lastPrice
}: {
  startPrice: number
  endPrice: number
  lastPrice: number | null
}): { blocking: string | null; warning: string | null } {
  const usable = (value: number): boolean => Number.isFinite(value) && value > 0
  if (!usable(startPrice) || !usable(endPrice)) {
    return { blocking: 'Enter a start and end price for the grid range.', warning: null }
  }
  if (startPrice === endPrice) {
    return { blocking: 'Start and end price are the same, so there is no range to place levels in.', warning: null }
  }

  if (lastPrice === null || !usable(lastPrice)) return { blocking: null, warning: null }

  const low = Math.min(startPrice, endPrice)
  const high = Math.max(startPrice, endPrice)
  if (lastPrice < low || lastPrice > high) {
    const side = lastPrice < low ? 'above' : 'below'
    return {
      blocking: null,
      warning: `This range sits entirely ${side} the current price of ${lastPrice}. No level can fill until the market moves into it.`
    }
  }
  return { blocking: null, warning: null }
}
