export type PaperOrderType = 'market' | 'limit'
export type PaperOrderSide = 'buy' | 'sell'

/** What this page can honestly say happened to a manually submitted paper order.
 * - `filled`    — it would have executed at submit time.
 * - `resting`   — it was not marketable against the live price, so it would have sat on the book.
 *                 This page has no order book to wait on a later crossing, so it never becomes
 *                 `filled` afterwards.
 * - `unpriced`  — there was no live price at submit, so neither of the above is knowable. */
export type PaperOrderStatus = 'filled' | 'resting' | 'unpriced'

/** A market order can only be submitted when a live price exists (it *is* the execution price),
 * so it always fills. A limit order is marketable when it crosses the live price: a buy at or
 * above it, a sell at or below it.
 *
 * The `lastPrice === null` case used to fall through to `filled`, which contradicted the rule
 * the page documents and invented a fill nothing had confirmed — a real risk on a thin pair or a
 * stalled feed, where no trade has arrived to price against. Not knowing is its own answer. */
export function classifyPaperOrder(
  type: PaperOrderType,
  side: PaperOrderSide,
  execPrice: number,
  lastPrice: number | null
): PaperOrderStatus {
  if (type === 'market') return 'filled'
  if (lastPrice === null) return 'unpriced'
  const marketable = side === 'buy' ? execPrice >= lastPrice : execPrice <= lastPrice
  return marketable ? 'filled' : 'resting'
}

export function paperOrderStatusNote(status: PaperOrderStatus): string | null {
  switch (status) {
    case 'resting':
      return 'resting — not marketable at submit, would not have filled'
    case 'unpriced':
      return 'no live price at submit — whether this would have filled is unknown'
    case 'filled':
      return null
  }
}
