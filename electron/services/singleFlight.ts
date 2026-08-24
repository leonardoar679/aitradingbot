/** Wraps an async operation so it never runs concurrently with itself.
 *
 * The two background loops in this app (livePositionWatchersService, liveTwapService) each carry
 * a hand-rolled version of this, with a comment explaining why: their work awaits real network
 * calls -- endpoint resolution, /time, the order itself -- that can easily outlast the poll
 * interval, and a second entry would read the same not-yet-advanced state and act on it twice.
 *
 * The live-order poll had the same exposure and none of the guard. It reads every 'open' order,
 * queries each one, and on a fill both resolves the ledger record and records the fill against
 * the position. Two overlapping runs would both see the order still 'open', both see it FILLED,
 * and both record it -- doubling a real position's tracked quantity and consuming the daily cap
 * twice.
 *
 * Skipping is the right behaviour rather than queueing: the caller polls on a timer, so a skipped
 * run is retried moments later, whereas a queued one would run against state that has already
 * moved on. `whenBusy` is what a skipped call returns. */
export function singleFlight<T>(operation: () => Promise<T>, whenBusy: () => T): () => Promise<T> {
  let inFlight = false
  return async (): Promise<T> => {
    if (inFlight) return whenBusy()
    inFlight = true
    try {
      return await operation()
    } finally {
      // finally, not a trailing assignment: an operation that throws must not wedge this
      // permanently busy, which would silently stop the poll forever after one bad tick.
      inFlight = false
    }
  }
}
