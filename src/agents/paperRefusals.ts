// The app's own paper trades refused this session, for the session report (shared/shadowReport.ts):
// the watch's, each with the sentence its writer gave, and the news rules', each with theirs.
//
// KEPT FOR THE SESSION HERE, and since 8 October 2026 written to a file as well by whoever records
// one (shared/records.ts, through the bridge the caller holds; this file has none), so that a
// restart loses nothing and the session report and a trade's timeline can read it back. It records;
// nothing reads it to decide anything.

export interface PaperRefusal {
  /** One id, so that the session's list and the file's (shared/records.ts) can be put together
   * without a refusal counted twice. */
  id: string
  /** Seconds. */
  at: number
  source: 'watch' | 'news'
  symbol: string
  text: string
  /** The event, the model and the ledger row of the call refused, where it was a call: what joins
   * the refusal to the trade's timeline. Absent on a news rule's. */
  eventId?: string
  model?: string
  callId?: string
  side?: 'buy' | 'sell'
  /** `restart`: written at start for an answer the app was not running to act on (shared/restartMisses.ts). */
  stage?: 'restart'
}

const KEPT = 2000

/** When this session's records begin: when the window was loaded. */
export const SESSION_STARTED_SEC = Math.floor(Date.now() / 1000)

let refusals: PaperRefusal[] = []

export function recordPaperRefusal(refusal: PaperRefusal): void {
  refusals = [...refusals, refusal].slice(-KEPT)
}

export function paperRefusals(): readonly PaperRefusal[] {
  return refusals
}

/** Test seam. */
export function resetPaperRefusals(): void {
  refusals = []
}
