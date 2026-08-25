/** A managed allocation: how much of a real exchange balance this app is allowed to put to work.
 *
 * The existing live gates all bound FLOW -- the size of one order, the notional placed in a day,
 * the loss taken in a day. None of them bounds the POT. Every daily cap resets at midnight UTC,
 * so a 50-a-day cap permits 1,500 over a month, and someone who meant "manage 200 of my balance"
 * has no way to say it. That sentence is what this file exists to make sayable.
 *
 * The funds never move. There is no deposit, no custody, no internal ledger holding anybody's
 * money -- the allocation is a ceiling this app applies to its own behaviour against a balance
 * that stays on the user's exchange, in the user's account, under the user's withdrawal keys.
 * Saying "allocate 200" gives this app permission, not possession.
 *
 * Committed capital is DERIVED from the live positions and resting orders that actually exist,
 * never tracked alongside them. A separately-maintained running total is a second source of truth
 * that drifts the first time anything is missed -- a fill recorded while the app was closed, a
 * cancel that never came back -- and it drifts silently, in the direction of permitting more. */

import type { LiveOrder, LivePosition } from './ipc'

/** Capital tied up in one open position: what it cost, not what it is worth now.
 *
 * Cost basis rather than mark-to-market, deliberately. An allocation is permission to deploy an
 * amount, and a position that has doubled has not consumed any more of that permission than the
 * day it was opened. Marking to market would also mean a rising market quietly revoking
 * permission the user never withdrew, and a falling one handing it back. */
export function positionCostQuote(position: LivePosition): number {
  const cost = position.qty * position.avgCost
  return Number.isFinite(cost) && cost > 0 ? cost : 0
}

/** Capital reserved by one resting limit order.
 *
 * Counted in full from the moment it is placed, not when it fills: the money is spoken for as
 * soon as the order is resting on the book, and an allocation that ignored resting orders would
 * let someone commit the same funds twice over by placing orders faster than they fill. Only the
 * unfilled remainder is counted -- whatever has already filled is in a position and counted
 * there, and counting both would charge the allocation twice for one order. */
export function restingOrderReservedQuote(order: LiveOrder): number {
  if (order.status !== 'open' || order.side !== 'buy') return 0
  const remaining = order.quantity - order.filledQty
  const reserved = remaining * order.limitPrice
  return Number.isFinite(reserved) && reserved > 0 ? reserved : 0
}

/** Everything currently at work, in quote terms. Sells are excluded throughout: closing or
 * reducing a position returns capital rather than consuming it, and a gate that counted a sell
 * as commitment could trap someone inside an allocation they were trying to exit. */
export function committedAllocationQuote(
  positions: readonly LivePosition[],
  restingOrders: readonly LiveOrder[]
): number {
  const open = positions.filter((p) => p.closedAt === null).reduce((sum, p) => sum + positionCostQuote(p), 0)
  return restingOrders.reduce((sum, o) => sum + restingOrderReservedQuote(o), open)
}

/** How much of the allocation is left. Never negative: an allocation lowered below what is
 * already committed leaves nothing free, not a negative amount that would read as debt. */
export function allocationRemainingQuote(allocationQuote: number, committedQuote: number): number {
  const remaining = allocationQuote - committedQuote
  return Number.isFinite(remaining) && remaining > 0 ? remaining : 0
}

/** Why an order cannot be placed against the allocation, or null if it can.
 *
 * Returns a sentence rather than a boolean because this reaches the user as the reason a real
 * order was refused, and "blocked by allocation" tells them nothing about what to change. */
export function describeAllocationBreach({
  allocationQuote,
  committedQuote,
  orderQuote,
  quoteAsset
}: {
  /** Null means no allocation is configured -- this app's other gates still apply and this one
   * does not. Not the same as 0, which is an allocation of nothing and blocks everything. */
  allocationQuote: number | null
  committedQuote: number
  orderQuote: number
  quoteAsset: string
}): string | null {
  if (allocationQuote === null) return null

  // Every comparison below is a `>` test and all of those are false against NaN, so an unusable
  // number would pass the whole gate instead of failing it -- the same one-sided-comparison hole
  // that has bitten this app before. An allocation that cannot be read is treated as blocking,
  // because the alternative is treating it as permission.
  if (!Number.isFinite(allocationQuote) || allocationQuote < 0) {
    return 'The managed allocation could not be read, so no real order can be placed against it. Set it again in Settings.'
  }
  if (!Number.isFinite(committedQuote) || committedQuote < 0) {
    return 'What this app already has committed could not be worked out, so it cannot tell whether this order fits inside your allocation.'
  }
  if (!Number.isFinite(orderQuote) || orderQuote <= 0) {
    return 'That order size is not a usable number, so it cannot be checked against your allocation.'
  }

  const remaining = allocationRemainingQuote(allocationQuote, committedQuote)
  if (orderQuote > remaining) {
    return `This order would put ${(committedQuote + orderQuote).toFixed(2)} ${quoteAsset} to work, past the ${allocationQuote.toFixed(2)} ${quoteAsset} you allocated. ${committedQuote.toFixed(2)} is already committed, leaving ${remaining.toFixed(2)}. Raise the allocation in Settings, or close something first.`
  }
  return null
}

/** Why a whole strategy will not fit inside the allocation, or null if it will.
 *
 * Separate from describeAllocationBreach because the two questions are different, and only one of
 * them should stop anybody. That function asks whether the largest SINGLE order can be placed --
 * if it cannot, no order the strategy ever places can succeed and creating it is pointless. This
 * one asks whether every order ADDS UP to more than the allocation, which a ladder only finds out
 * level by level: it half-fills and then starts being refused, leaving a strategy that is neither
 * finished nor undone. Knowing that before creating it is the whole point, but it is a warning
 * rather than a refusal, because capital freed by an earlier level closing may well cover a later
 * one -- the app cannot know, and refusing on a guess would block a plan that would have worked. */
export function describeAllocationPlanShortfall({
  allocationQuote,
  committedQuote,
  planTotal,
  quoteAsset
}: {
  allocationQuote: number | null
  committedQuote: number
  planTotal: number
  quoteAsset: string
}): string | null {
  // Both of the guards either side of the finite check are provably redundant, and both stay.
  //
  // The null one is redundant only because Number.isFinite(null) happens to be false. Leaning on
  // that would make "no allocation is configured" -- the documented contract of this parameter --
  // an accident of coercion rather than something the code says.
  //
  // The planTotal one is redundant only because allocationRemainingQuote promises never to return
  // a negative, which makes the comparison below false for any total at or under zero. That is a
  // promise from a different function, and a guard that depends on one is worth keeping where it
  // can be read.
  if (allocationQuote === null) return null
  if (!Number.isFinite(allocationQuote) || !Number.isFinite(committedQuote) || !Number.isFinite(planTotal)) return null
  if (planTotal <= 0) return null

  const remaining = allocationRemainingQuote(allocationQuote, committedQuote)
  // Spelled as "not within" rather than "greater than" so a NaN that slipped past the check above
  // would fail the comparison into warning rather than out of it.
  if (!(planTotal > remaining)) return null

  return `Every order this strategy places adds up to ${planTotal.toFixed(2)} ${quoteAsset}, and only ${remaining.toFixed(2)} of your ${allocationQuote.toFixed(2)} ${quoteAsset} allocation is free. The later orders will be refused when they fire unless something closes first.`
}
