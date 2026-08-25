/** Leverage, and what it actually does to a position.
 *
 * Everything here is simulation-only. This app places no leveraged order on any exchange, and
 * PositionForm refuses live mode for anything above 1x -- see canGoLivePosition. The point of
 * having it at all is that leverage is the fastest way a beginner loses everything, and the
 * cheapest place to find that out is a simulation that liquidates them.
 *
 * The one sentence worth taking from this file: at L times leverage, a move of 100/L percent
 * against the position destroys the whole margin. At 20x that is 5%, which BTC does in an
 * afternoon. */

/** Below this, "leverage" is not leverage. 1 is spot -- the position is the money. */
export const MIN_LEVERAGE = 1

/** Nothing in this app has any business simulating more than this, and every major exchange caps
 * BTC perps at or below it. A cap here is not a safety feature -- nothing real is at stake in a
 * simulation -- it stops a mistyped 1000 from producing a liquidation price on the wrong side of
 * the entry and a chart nobody can read. */
export const MAX_LEVERAGE = 125

/** Fraction of the notional an exchange requires be left before it liquidates. Binance's is
 * tiered by position size and starts at 0.4% for BTC; this app simulates one small position at a
 * time, so the first tier is the whole story. Being a little conservative here means the
 * simulation liquidates fractionally EARLIER than the real thing would, which is the safe
 * direction for a number a beginner is learning from. */
export const MAINTENANCE_MARGIN_RATE = 0.004

/** A two-sided range check, and no separate isFinite -- deliberately, because the range check is
 * already what excludes NaN and Infinity: NaN fails the lower bound and Infinity fails the upper.
 *
 * Worth stating rather than leaving as a coincidence. The recurring bug in this app is the
 * ONE-sided comparison, where NaN's losing every comparison means it slips through the check
 * instead of failing it. Two bounds is what makes the difference, so removing MAX_LEVERAGE would
 * quietly reopen that hole -- which is what the NaN test on this function is standing guard over. */
export function isUsableLeverage(leverage: number): boolean {
  return leverage >= MIN_LEVERAGE && leverage <= MAX_LEVERAGE
}

/** What the position is worth in the market, as opposed to what it cost to open.
 *
 * This is the number every risk limit should be denominated in and currently is not: a 25 USDT
 * order at 10x controls 250 USDT of BTC, and a limit written against the 25 is ten times weaker
 * than it reads. */
export function notionalFor(marginQuote: number, leverage: number): number {
  return marginQuote * leverage
}

/** The price at which the margin is gone and the exchange closes the position for you.
 *
 * Isolated margin, one position, no cross-collateral -- which is what this app simulates. The
 * standard approximation:
 *
 *   long:  entry * (1 - 1/L + mmr)
 *   short: entry * (1 + 1/L - mmr)
 *
 * Deliberately an approximation, and worth being explicit about what it leaves out, because a
 * liquidation price presented as exact is a promise this cannot keep: it ignores the entry and
 * exit fees already deducted from margin, any funding paid while the position was open, and the
 * tiered maintenance amount on large positions. Every one of those moves the real liquidation
 * CLOSER to the entry, so the true number is always at least as bad as this one. A simulation
 * that liquidates slightly late is the wrong direction to be wrong in for someone learning, which
 * is why the maintenance rate above is not shaded downward to compensate.
 *
 * At 1x there is nothing to liquidate: a spot position can go to zero and no more, so this
 * returns null rather than a price, and the caller must not draw a line for it. */
export function liquidationPrice({
  entryPrice,
  leverage,
  side,
  maintenanceMarginRate = MAINTENANCE_MARGIN_RATE
}: {
  entryPrice: number
  leverage: number
  side: 'buy' | 'sell'
  maintenanceMarginRate?: number
}): number | null {
  if (!isUsableLeverage(leverage) || leverage === 1) return null

  const price =
    side === 'buy'
      ? entryPrice * (1 - 1 / leverage + maintenanceMarginRate)
      : entryPrice * (1 + 1 / leverage - maintenanceMarginRate)

  // One guard, on the answer rather than on each input, because it covers both: an unusable entry
  // price produces a NaN or a non-positive level here, and so does a maintenance rate large enough
  // to put the level at or below zero. Neither is a level anything can cross, and drawing one
  // would put a "you get liquidated here" line at a price that means nothing.
  if (!Number.isFinite(price) || price <= 0) return null
  return price
}

/** How far the price has to move against the position to wipe out the margin, as a percentage.
 *
 * The number that makes leverage concrete. 100/L, adjusted for the maintenance margin the
 * exchange keeps back. Null at 1x, for the same reason liquidationPrice is. */
export function liquidationDistancePct(leverage: number, maintenanceMarginRate = MAINTENANCE_MARGIN_RATE): number | null {
  if (!isUsableLeverage(leverage) || leverage === 1) return null
  const distance = (1 / leverage - maintenanceMarginRate) * 100
  return distance > 0 ? distance : null
}

/** Funding, which is the cost of holding a perp that nothing on a spot position prepares you for.
 *
 * Charged on NOTIONAL, not on margin, every eight hours. At 10x, a 0.01% funding rate is 0.1% of
 * the money actually at risk per payment, three times a day -- a position held a week pays around
 * 2% of its margin in funding alone while doing nothing. Positive rate means longs pay shorts.
 *
 * Returns a signed cost from the position's point of view: positive is money leaving. */
export function fundingCost({
  notionalQuote,
  fundingRate,
  periods,
  side
}: {
  notionalQuote: number
  /** Per eight-hour period, as a fraction. Binance quotes 0.0001 for the usual 0.01%. */
  fundingRate: number
  periods: number
  side: 'buy' | 'sell'
}): number {
  if (!Number.isFinite(notionalQuote) || !Number.isFinite(fundingRate) || !Number.isFinite(periods)) return 0
  if (periods <= 0) return 0
  const paid = notionalQuote * fundingRate * periods
  return side === 'buy' ? paid : -paid
}

/** Whole eight-hour funding periods a position was open for.
 *
 * Whole ones only: funding is charged at fixed times, and a position opened and closed between
 * two of them pays nothing at all. Counting fractions would invent a charge that never happens
 * and make every short-lived simulated trade look slightly worse than it was. */
export const FUNDING_INTERVAL_SEC = 8 * 3600

/** The rate the simulation charges, because it does not fetch the real historical one.
 *
 * 0.01% per eight hours is the base rate the major perp venues settle at when the market is
 * balanced, and it is what an exchange charges by default. It is an assumption, and a mild one:
 * in a strongly one-sided market the real rate reaches several times this and occasionally goes
 * negative. Named rather than inlined so it reads as the assumption it is, and so the day this
 * fetches real funding history there is one place to delete. */
export const ASSUMED_FUNDING_RATE = 0.0001

export function fundingPeriodsBetween(openedAt: number, closedAt: number): number {
  if (!Number.isFinite(openedAt) || !Number.isFinite(closedAt)) return 0
  const held = closedAt - openedAt
  return held <= 0 ? 0 : Math.floor(held / FUNDING_INTERVAL_SEC)
}

/** The leverage an executor actually runs at.
 *
 * Absent means 1x: every Position executor created before leverage existed has no such field, and
 * must keep behaving exactly as it did. An unusable value falls back the same way rather than
 * reaching the liquidation maths -- a NaN there produces a liquidation price of NaN, which no
 * comparison is ever true against, so the position would simply never be liquidated. Silently
 * removing a liquidation is the worst possible direction for this particular number to fail in. */
export function resolveLeverage(leverage: number | undefined): number {
  return leverage !== undefined && isUsableLeverage(leverage) ? leverage : MIN_LEVERAGE
}
