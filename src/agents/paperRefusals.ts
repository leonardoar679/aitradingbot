// The app's own paper trades refused this session, for the session report (shared/shadowReport.ts):
// the watch's, each with the sentence its writer gave, and the news rules', each with theirs.
//
// KEPT FOR THE SESSION ONLY, as the alerts are (src/news/alertStore.ts). A restart starts it again,
// and the report says from when. It records; nothing reads it to decide anything.

export interface PaperRefusal {
  /** Seconds. */
  at: number
  source: 'watch' | 'news'
  symbol: string
  text: string
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
