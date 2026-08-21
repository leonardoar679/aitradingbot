// Trading fees, modeled in ONE place so the backtest engine and the executor paper simulations
// can never drift apart on what a trade actually costs.
//
// Why this exists: the executor simulations originally computed gross P&L -- a Grid card could
// report "+$5.00 realized" for profit a real account would never keep, because every fill on a
// real exchange is charged. That understates nothing and overstates everything, and it hits the
// small-margin strategies hardest: at a 0.5% take-profit per Grid level, a 0.1%-per-side round
// trip is ~40% of the gross. Arbitrage is worse -- a two-leg capture pays two fees, so the
// default 0.4% threshold is barely above breakeven once they're charged.
//
// Flat rate on the notional of every fill, entry and exit alike. Binance spot is 0.1% per side
// at the standard tier (lower with volume tiers or the BNB discount), so this is a realistic
// baseline rather than a worst case. It is deliberately not user-configurable: a single honest
// default beats a knob a newcomer would be tempted to set to zero.
export const FEE_RATE = 0.001

/** Total fees for one completed round trip of `qty` units -- charged on the way in AND the way
 * out, which is why both prices appear here. Use for any position that opened and then closed. */
export function roundTripFee(qty: number, entryPrice: number, exitPrice: number): number {
  return (qty * entryPrice + qty * exitPrice) * FEE_RATE
}

/** Fee on a single fill of `qty` units at `price` -- one side only. */
export function fillFee(qty: number, price: number): number {
  return qty * price * FEE_RATE
}

/** Fees for one two-leg spread capture (XEMM/Arbitrage): buy one market, sell the other, so BOTH
 * legs are charged. This is why thin spreads rarely survive contact with reality -- against a
 * ~0.2% two-leg cost, a 0.2% threshold is already breakeven before any slippage or the cost of
 * moving funds between exchanges. A capture below that cost is a real loss, and is reported as
 * a negative number rather than being floored at zero. */
export function spreadCaptureFee(orderAmountQuote: number, capturedPct: number): number {
  const buyNotional = orderAmountQuote
  const sellNotional = orderAmountQuote * (1 + capturedPct / 100)
  return (buyNotional + sellNotional) * FEE_RATE
}

/** Net P&L for closing `qty` units bought at `entryPrice` and sold at `exitPrice`, after the
 * fees on both fills. Gross P&L on its own is not what an account keeps, so it is not what
 * either ledger reports -- paper (computeSnapshot.ts) or real (livePositionsService.ts).
 *
 * The real ledger matters twice over: it is what the Live Trade History shows, and it backs the
 * daily realized-loss gate. A gross figure there makes that gate fire later than the account's
 * actual losses warrant, which is the wrong direction for a safety limit to be wrong in. */
export function netRealizedPnl(qty: number, entryPrice: number, exitPrice: number): number {
  return qty * (exitPrice - entryPrice) - roundTripFee(qty, entryPrice, exitPrice)
}

/** Unrealized P&L as a percentage of cost basis, net of the round trip it would take to realize
 * it. Quantity cancels out, so this needs only the two prices.
 *
 * Every "unrealized %" in the UI used the raw price move. That is the *value* of what is held,
 * not what closing it would keep -- and it sat directly beside figures that were already net
 * (a bot card's paper-trade return, an executor's realized P&L, the real-money row on the same
 * Positions table), so one screen reported the same kind of number two different ways.
 *
 * `sell` is the paper short convention used by the executors: the price move is inverted, but
 * both legs are still charged, so the fee drag is identical. */
export function netUnrealizedPct(entryPrice: number, markPrice: number, side: 'buy' | 'sell' = 'buy'): number {
  if (!(entryPrice > 0)) return 0
  const gross = side === 'sell' ? (entryPrice - markPrice) / entryPrice : (markPrice - entryPrice) / entryPrice
  const feeDrag = ((entryPrice + markPrice) * FEE_RATE) / entryPrice
  return (gross - feeDrag) * 100
}
