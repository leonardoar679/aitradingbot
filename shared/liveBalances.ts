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
