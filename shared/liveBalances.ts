/** Shaping for the balances a real exchange reports, kept out of both the fetch code and the UI
 * so it can be tested against the shapes an exchange actually returns.
 *
 * Binance answers /account with every asset it has ever listed -- roughly 400 rows, almost all of
 * them zero -- as decimal strings. Rendering that list raw buries the two or three assets the
 * user actually holds, which is the whole point of showing it. */

export interface ExchangeBalance {
  asset: string
  /** Spendable right now. */
  free: number
  /** Reserved by a resting order the user placed, here or anywhere else. */
  locked: number
}

export interface BalanceReadout {
  rows: ExchangeBalance[]
  /** Assets the exchange reported in a form this app could not read as a number.
   *
   * Named and surfaced rather than dropped quietly. A row silently removed is a balance the user
   * holds and cannot see, which is a worse failure than an ugly one: they would have no reason to
   * suspect anything is missing. Showing the raw NaN is not an option either -- it prints as
   * "NaN" beside real figures, and any later comparison against it is false, so a NaN that
   * reached a funding check would disable it rather than fail it. */
  unreadable: string[]
}

/** Non-zero balances, largest first, plus whatever could not be read.
 *
 * Sorted by total rather than free: an asset entirely tied up in a resting order is still money
 * the user has, and burying it under dust because none of it is spendable right now would be
 * telling them the wrong thing about their own account. Ties break on the asset name so the list
 * does not reshuffle between refreshes that changed nothing. */
export function readableBalances(raw: readonly ExchangeBalance[]): BalanceReadout {
  const rows: ExchangeBalance[] = []
  const unreadable: string[] = []

  for (const entry of raw) {
    const asset = typeof entry.asset === 'string' ? entry.asset.trim() : ''
    // An unnamed row cannot be shown or reported -- there is nothing to call it. Counting it as
    // unreadable would produce a message the user could do nothing with.
    if (asset === '') continue
    if (!Number.isFinite(entry.free) || !Number.isFinite(entry.locked)) {
      unreadable.push(asset)
      continue
    }
    // Negative is not a balance any exchange should report, but if one does, it is not dust and
    // must not be filtered away as if it were zero.
    if (entry.free === 0 && entry.locked === 0) continue
    rows.push({ asset, free: entry.free, locked: entry.locked })
  }

  rows.sort((a, b) => {
    const diff = b.free + b.locked - (a.free + a.locked)
    return diff !== 0 ? diff : a.asset.localeCompare(b.asset)
  })
  return { rows, unreadable }
}

/** What is spendable in one asset, for a check against what an order is about to cost.
 *
 * Free only. Locked funds are already promised to a resting order, and treating them as
 * available is how a pre-flight check passes and the exchange then rejects the order. Returns 0
 * for an asset that is absent or unreadable, so a caller cannot accidentally treat "not known"
 * as "plenty". */
export function freeBalance(readout: BalanceReadout, asset: string): number {
  const row = readout.rows.find((r) => r.asset === asset)
  return row ? row.free : 0
}

/** Whether the account has the cash a real BUY is about to spend, phrased for someone reading it
 * in an error box rather than a log.
 *
 * Buys only, deliberately. A market SELL in this app is also sized in quote currency, so working
 * out how much of the base asset the exchange will need means multiplying by a price the app
 * would have to guess at the moment of the order. Blocking a real order on a guessed price is
 * worse than letting the exchange answer the question it can answer exactly -- so a sell is left
 * to the exchange, which rejects it cleanly and costs nothing but a failed order.
 *
 * Returns null -- allow -- for anything it cannot judge. This is a message-quality check standing
 * in front of the exchange's own balance check, not the last line of defence: the exchange still
 * refuses an order there is no money for. Blocking a legitimate order because a balance could not
 * be read would be a real failure; letting one through that the exchange then refuses is not. */
export function describeLiveShortfall({
  side,
  quoteAsset,
  quoteAmount,
  free,
  exchangeLabel
}: {
  side: 'buy' | 'sell'
  quoteAsset: string
  /** What the order will spend, in the quote asset. */
  quoteAmount: number
  /** Spendable balance in that asset -- freeBalance(), not including funds locked in orders. */
  free: number
  exchangeLabel: string
}): string | null {
  if (side !== 'buy') return null
  // An unusable size is already refused, with its own message, by the live trading gate this
  // stands beside. Reporting it a second time here as a funding problem would name the wrong
  // cause -- and NaN loses every comparison, so it would otherwise fall through as affordable.
  if (!Number.isFinite(quoteAmount) || quoteAmount <= 0) return null
  // Written as "not less than" rather than "greater or equal" on purpose: an unreadable balance
  // arrives as NaN, every comparison against NaN is false, and this is the direction in which
  // that means allow. The other spelling would block every order whenever a balance could not
  // be read.
  if (!(free < quoteAmount)) return null

  return `Not enough ${quoteAsset} on ${exchangeLabel}: this order spends ${quoteAmount} and only ${free} is free. Funds held in resting orders do not count -- cancel one, or add ${quoteAmount - free} ${quoteAsset}.`
}

/** The heads-up for a laddered strategy whose FULL plan costs more than is free, as opposed to
 * describeLiveShortfall's refusal of one order that cannot be paid for right now.
 *
 * Two different facts, so two different messages. A DCA ladder, a TWAP schedule and a live Grid
 * each place many orders over time, and the money only has to be there when each one fires. That
 * makes "you cannot afford the whole plan" a warning rather than a refusal: the strategy will run
 * and do real work, and then quietly stop being able to. Saying so up front is the difference
 * between a plan the user chose to under-fund and one that failed halfway for no visible reason.
 *
 * Returns null when the plan fits, when the total is not a usable number, or when the free
 * balance could not be read -- the same allow-on-doubt rule as everything else here. */
export function describeLivePlanShortfall({
  quoteAsset,
  planTotal,
  free,
  exchangeLabel
}: {
  quoteAsset: string
  /** What every order in the plan adds up to, in the quote asset. */
  planTotal: number
  free: number
  exchangeLabel: string
}): string | null {
  if (!Number.isFinite(planTotal) || planTotal <= 0) return null
  if (!(free < planTotal)) return null

  return `This plan places ${planTotal} ${quoteAsset} of orders in total and only ${free} is free on ${exchangeLabel}. It will start, then stop being able to place its later orders. Fund the difference or reduce the size.`
}
