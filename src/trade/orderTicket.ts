/** Why the order ticket cannot be submitted, in words, or null when it can be.
 *
 * The submit button was disabled by a bare boolean, so an unfillable ticket was a greyed-out
 * button and no explanation -- the same dead-end as a page that fails silently. Waiting for a
 * price, a missing limit price and an unusable amount all looked identical.
 *
 * It also guards the amount properly. `Number(amount) > 0` is true for Infinity, which
 * `<input type="number">` yields from a perfectly typeable "1e999", so the ticket accepted an
 * infinite order size and carried it into the row it wrote. Paper only, so nothing was at risk,
 * but it is the same mistake that switched off a real risk limit elsewhere in this app. */
export function describeTicketProblem(params: {
  amountRaw: string
  type: 'market' | 'limit'
  limitPriceRaw: string
  lastPrice: number | null
}): string | null {
  const { amountRaw, type, limitPriceRaw, lastPrice } = params

  if (amountRaw.trim() === '') return 'Enter an amount to trade.'
  const amount = Number(amountRaw)
  if (!Number.isFinite(amount)) return 'That amount is not a usable number.'
  if (amount <= 0) return 'Amount has to be greater than 0.'

  if (type === 'limit') {
    if (limitPriceRaw.trim() === '') return 'Enter a limit price.'
    const limitPrice = Number(limitPriceRaw)
    if (!Number.isFinite(limitPrice)) return 'That limit price is not a usable number.'
    if (limitPrice <= 0) return 'Limit price has to be greater than 0.'
    return null
  }

  // Market order: it can only be priced against a live price, which may not have arrived yet.
  if (lastPrice === null) return 'Waiting for a live price for this pair — a market order needs one to fill against.'
  if (!Number.isFinite(lastPrice) || lastPrice <= 0) return 'The live price for this pair is not usable right now.'
  return null
}
