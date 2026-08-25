import type { LivePosition } from '../../shared/ipc'

/** Whether a watcher's exit actually finished, and what to say when it did not.
 *
 * A watcher fires one market sell for the whole position and then stops watching. That is only
 * safe if the sell really closed the position. A market order can fill PARTIALLY -- thin book,
 * a reduced fill, a rejection covering part of the size -- and livePositionsService only stamps
 * `closedAt` and `exitPrice` once the remaining quantity reaches zero. Anything less leaves the
 * position open, still holding real exposure, with the stop-loss and take-profit that were
 * guarding it switched off and nothing saying so.
 *
 * So deactivation is decided here, on the ledger's own record of the position rather than on the
 * order having been sent. Anything short of a fully closed, fully priced position keeps the
 * watcher running: the barrier is still breached, so the next tick retries the exit, and if the
 * remainder is too small for the exchange to trade the failure surfaces on the executor card
 * instead of vanishing. */
export function describeIncompleteExit(position: LivePosition | null, symbol: string): string | null {
  if (position === null) {
    return `The ${symbol} exit was sent but the position could not be read back, so this app cannot confirm it closed. Barriers stay active and the exit will be retried — check ${symbol} on the exchange.`
  }

  // Not `> 0`: a residual quantity is what "partially filled" looks like, and the ledger itself
  // treats anything at or below 1e-9 as flat.
  if (position.closedAt === null || position.qty > 1e-9) {
    return `The ${symbol} exit only partially filled — ${position.qty} is still open and still unprotected if this stops watching. Barriers stay active and the exit will be retried.`
  }

  // Closed, but with nothing to report it at. Reporting an exit without a price would put a
  // fabricated number on the card; leaving the watcher active costs one wasted tick, and the
  // next one sees a closed position and stands down cleanly.
  if (position.exitPrice === null || position.realizedPnl === null) {
    return `The ${symbol} position closed but the exchange did not report a fill price for it, so the result cannot be recorded yet.`
  }

  return null
}
