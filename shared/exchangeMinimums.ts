/** Whether the orders a strategy will place are large enough for the exchange to accept.
 *
 * An exchange refuses any order below a minimum value -- 5 USDT on Binance's BTCUSDT -- and a
 * ladder divides one total into many small orders. A 10 USDT TWAP over three slices is 3.33 an
 * order, which is not a small mistake to find out about later: nothing is placed, nothing is
 * bought, and the message that comes back from the exchange is "Filter failure: NOTIONAL".
 *
 * Checked here so it can be said before the strategy is created, in terms of the number the
 * person actually chose. The exchange still enforces it; this only explains it in time. */

export interface SymbolTradingRules {
  /** Smallest order value the exchange will accept, in the quote asset. 0 when the symbol has no
   * such rule, which is also what an unreadable one becomes -- see the guard in the describe
   * function below for why that direction is the safe one. */
  minNotional: number
  /** Smallest tradable amount of the base asset, and the increment it must be a multiple of. */
  minQty: number
  stepSize: string
  tickSize: string
}

/** Why these orders are too small for this symbol, or null if they are not.
 *
 * `perOrderQuote` is the SMALLEST single order the strategy will place, not the largest: the
 * exchange refuses each order on its own, so a ladder is only placeable if its smallest rung is.
 *
 * A rule that cannot be read (`minNotional` absent, zero or NaN) produces no message at all.
 * That is deliberate: this is a warning ahead of the real check, and inventing a minimum would
 * block strategies the exchange would have accepted. Spelled `minNotional > 0` rather than
 * `!== null` so NaN takes the same path. */
export function describeBelowExchangeMinimum({
  perOrderQuote,
  orderCount,
  rules,
  symbol,
  quoteAsset,
  exchangeLabel
}: {
  perOrderQuote: number
  orderCount: number
  rules: SymbolTradingRules | null
  symbol: string
  quoteAsset: string
  exchangeLabel: string
}): string | null {
  // An amount that cannot be read is not a small order, it is not an order at all -- and it is
  // caught before the minimum is even consulted, because it fails whatever the minimum is. The
  // size gate and the main process both refuse it too; a guard that leans on someone else's
  // guard is one refactor away from being off.
  if (!(perOrderQuote > 0)) {
    const subject = orderCount > 1 ? `Each of the ${orderCount} orders this would place` : 'This order'
    return `${subject} works out to ${perOrderQuote}, which is not an amount ${exchangeLabel} can be sent.`
  }

  if (rules === null) return null
  if (!(rules.minNotional > 0)) return null
  if (perOrderQuote >= rules.minNotional) return null

  const each =
    orderCount > 1
      ? `Each of the ${orderCount} orders this would place is ${perOrderQuote.toFixed(2)} ${quoteAsset}`
      : `This order is ${perOrderQuote.toFixed(2)} ${quoteAsset}`
  const needed = rules.minNotional * Math.max(orderCount, 1)
  const fix =
    orderCount > 1
      ? ` Raise the total to at least ${needed.toFixed(2)} ${quoteAsset}, or use fewer orders.`
      : ` Raise it to at least ${rules.minNotional} ${quoteAsset}.`

  return `${each}, and ${exchangeLabel} will not accept a ${symbol} order below ${rules.minNotional} ${quoteAsset}.${fix}`
}
