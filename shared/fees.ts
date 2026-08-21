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
