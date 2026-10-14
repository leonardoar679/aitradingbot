import { ENGLISH, type I18n } from './i18n/translate'

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
export function describeBelowExchangeMinimum(
  {
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
  },
  i18n: I18n = ENGLISH
): string | null {
  const { t } = i18n
  // An amount that cannot be read is not a small order, it is not an order at all -- and it is
  // caught before the minimum is even consulted, because it fails whatever the minimum is. The
  // size gate and the main process both refuse it too; a guard that leans on someone else's
  // guard is one refactor away from being off.
  if (!(perOrderQuote > 0)) {
    const values = { count: orderCount, amount: figureIn(perOrderQuote, i18n), exchange: exchangeLabel }
    return orderCount > 1
      ? t('Each of the {count} orders this would place works out to {amount}, which is not an amount {exchange} can be sent.', values)
      : t('This order works out to {amount}, which is not an amount {exchange} can be sent.', values)
  }

  if (rules === null) return null
  if (!(rules.minNotional > 0)) return null
  if (perOrderQuote >= rules.minNotional) return null

  const needed = rules.minNotional * Math.max(orderCount, 1)
  const values = {
    count: orderCount,
    amount: figureIn(perOrderQuote, i18n, 2),
    asset: quoteAsset,
    exchange: exchangeLabel,
    pair: symbol,
    minimum: figureIn(rules.minNotional, i18n),
    needed: figureIn(needed, i18n, 2)
  }
  return orderCount > 1
    ? t('Each of the {count} orders this would place is {amount} {asset}, and {exchange} will not accept a {pair} order below {minimum} {asset}. Raise the total to at least {needed} {asset}, or use fewer orders.', values)
    : t('This order is {amount} {asset}, and {exchange} will not accept a {pair} order below {minimum} {asset}. Raise it to at least {minimum} {asset}.', values)
}

/** A figure as the English always wrote it (`digits` fixed, or as JavaScript prints it), else in the
 * language's own form (V6 Stage 14). */
function figureIn(value: number, i18n: I18n, digits?: number): string {
  if (i18n.language === 'en') return digits === undefined ? String(value) : value.toFixed(digits)
  return digits === undefined ? i18n.num(value, 0, 8) : i18n.num(value, digits, digits)
}
