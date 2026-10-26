import { MISS_VERSION, type MissRecord } from '../../shared/misses'

// THE REFUSALS OF THE WRITERS THAT WERE THERE BEFORE V8, ON FILE (V8 Stage 2, 26 October 2026). The paper
// laboratory and the forecast trader each say, after a pass, which of the candidates their rules qualified they
// did not open, and why; until V8 that list lived for one pass on their cards. Now each is a miss of book
// "other" (shared/misses.ts) -- a candidate its rules had called, so never a forecast with no call -- written once
// an hour a pair at most, since a refusal stands for as long as its candidate does and a pass comes every five
// minutes. It writes misses and nothing else.

const ONCE_PER_SEC = 3600
const lastWritten = new Map<string, number>()

/** One pass's refusals as misses, leaving out a pair this writer told within the hour. */
export function refusalsAsMisses(writer: 'lab' | 'forecast-trader', refused: readonly { pair: string; why: string }[], at: number, told: Map<string, number> = lastWritten): MissRecord[] {
  const out: MissRecord[] = []
  for (const entry of refused) {
    const key = `${writer}:${entry.pair}`
    const last = told.get(key)
    if (last !== undefined && at - last < ONCE_PER_SEC) continue
    told.set(key, at)
    out.push({ v: MISS_VERSION, at, book: 'other', writer, pair: entry.pair, side: null, refPrice: null, stage: 'gate', reason: entry.why.slice(0, 400), predictionId: null, shadow: false })
  }
  return out
}

/** Writes one pass's refusals; a miss that cannot be written is said and never stops the pass. */
export async function recordRefusals(writer: 'lab' | 'forecast-trader', refused: readonly { pair: string; why: string }[], at: number): Promise<void> {
  for (const miss of refusalsAsMisses(writer, refused, at)) {
    try {
      await window.api.books.miss(miss)
    } catch (error) {
      console.error(`A missed opportunity of the ${writer} could not be written:`, error)
    }
  }
}
