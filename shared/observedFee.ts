import { FEE_RATE } from './fees'

/** Commission actually charged on one order, keyed by the asset it was taken in. */
export type Commissions = Record<string, number>

/** Converts real commission into quote terms, or null when it cannot be known.
 *
 * Binance takes commission in a variable asset: the base asset on a buy, the quote asset on a
 * sell, or BNB when the BNB discount is switched on. Only the first two convert with information
 * the app has at the time -- a BNB commission needs a BNB/quote rate this app has no table for,
 * so it returns null rather than inventing one. Any single unconvertible entry makes the whole
 * total unknown, because a partial sum would understate the fee while looking exact. */
export function commissionInQuote(
  commissions: Commissions,
  baseAsset: string,
  quoteAsset: string,
  fillPrice: number
): number | null {
  let total = 0
  for (const [asset, amount] of Object.entries(commissions)) {
    if (amount === 0) continue
    if (!Number.isFinite(amount) || amount < 0) return null
    if (asset === quoteAsset) total += amount
    else if (asset === baseAsset) {
      if (!(fillPrice > 0)) return null
      total += amount * fillPrice
    } else return null
  }
  return total
}

/** The fee rate an order was really charged, as a fraction of its notional. */
export function observedFeeRate(commissionQuote: number, notionalQuote: number): number | null {
  if (!(notionalQuote > 0) || !Number.isFinite(commissionQuote) || commissionQuote < 0) return null
  return commissionQuote / notionalQuote
}

/** How far the modelled rate may sit from the observed one before it is worth saying anything.
 * A tenth of a basis point absorbs rounding on small fills without hiding a real tier difference:
 * the standard 0.1% versus the BNB-discounted 0.075% is 25 basis points apart. */
export const FEE_RATE_TOLERANCE = 0.000_01

/** Names a disagreement between what the app assumes trading costs and what the exchange actually
 * charged. FEE_RATE drives every P&L figure on screen and the daily loss limit, so a wrong value
 * does not merely mislabel -- it moves a real safety threshold. The exchange reports the truth on
 * every fill, so the app can say which way it is wrong instead of asking to be told. */
export function describeFeeRateMismatch(observed: number | null, modelled: number = FEE_RATE): string | null {
  if (observed === null || !Number.isFinite(observed)) return null
  if (Math.abs(observed - modelled) <= FEE_RATE_TOLERANCE) return null

  const asPct = (rate: number): string => `${(rate * 100).toFixed(4).replace(/0+$/, '').replace(/\.$/, '')}%`
  const direction = observed > modelled ? 'more' : 'less'
  const effect = observed > modelled ? 'better' : 'worse'
  return `Your last live fill was charged ${asPct(observed)}, ${direction} than the ${asPct(modelled)} this app assumes. Every P&L figure here, and the daily loss limit, is currently ${effect} than reality — set FEE_RATE in shared/fees.ts to ${asPct(observed)}.`
}
