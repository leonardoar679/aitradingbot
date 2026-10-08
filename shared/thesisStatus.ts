import { EXIT_LINES, REVIEW_LINES } from './aiAdditions'
import type { MarketRegime } from './marketResearch'
import { NEAR_STOP_SHARE, stopProgress } from './notices'
import type { NewsAgainstStory } from './paperNewsBlock'

// THE THESIS STATUS OF AN OPEN POSITION (the V4 document, §50-51): VALID, WEAKENING or BROKEN, by
// fixed lines written down before any result, and SHOWN ONLY. It is a reading of where a trade
// stands against what it was opened on, for the Positions page; nothing acts on it. The exit check
// still asks and decides by its own triggers (shared/aiAdditions.ts), a paper stop is still a stop
// (src/executors/engine.ts), and a real position's watcher still closes it by its own barriers
// (the watcher's evaluation in the main process). The lines are the ones already in force
// elsewhere, said once:
// three quarters of the way to the stop (the near-stop notice), a story of major impact against the
// side (the news block), Bitcoin's regime (the market status), and the exit check's sharp move.
//
// WEAKENING on any one of: near its stop; a story of impact 70 or more naming the coin and pointing
// against the side; Bitcoin's regime turned against the side since the entry; a move of 2% against
// it over the pair's last fifteen minutes. BROKEN when the stop is hit -- the engine or the watcher
// closes it at its next look, and until then it reads as broken -- or when two reasons hold at once.
// VALID otherwise. Nothing here reads the window, the bridge or a file: it is given its inputs.

export const THESIS_LINES = {
  /** Of the way from the entry to the stop, this much covered is near it. */
  nearStopShare: NEAR_STOP_SHARE,
  /** A story of this impact or more, naming the coin and pointing against the side, is news against
   * it. */
  newsImpact: REVIEW_LINES.majorNewsImpact,
  /** A move against the trade this large over the pair's last fifteen closed minutes, in percent, is
   * sharp. */
  oppositeMovePct: EXIT_LINES.oppositeMovePct,
  /** This many reasons at once break the thesis. */
  brokenReasons: 2
} as const

export const THESIS_REASONS = ['stop_hit', 'near_stop', 'news_against', 'regime_against', 'opposite_move'] as const
export type ThesisReason = (typeof THESIS_REASONS)[number]
export const THESIS_STATUSES = ['VALID', 'WEAKENING', 'BROKEN'] as const
export type ThesisStatus = (typeof THESIS_STATUSES)[number]

export interface ThesisInput {
  side: 'buy' | 'sell'
  entryPrice: number
  /** The stop, as a distance from the entry in percent; null for none. */
  stopPct: number | null
  /** The last closed minute's close: where the trade is judged. */
  price: number
  /** The pair's move over its last fifteen closed minutes, in percent; null when they are not all
   * there. */
  move15mPct: number | null
  regimeAtEntry: MarketRegime | null
  regimeNow: MarketRegime | null
  /** The strongest story against the side (shared/paperNewsBlock.ts storiesAgainst); null for
   * none. */
  storyAgainst: Pick<NewsAgainstStory, 'impact'> | null
}

export interface ThesisVerdict {
  status: ThesisStatus
  /** Why, in the order the rules are read; empty for VALID. */
  reasons: ThesisReason[]
  /** Where the price stands between the entry and the stop: 0 at the entry, 1 at the stop; null
   * without a stop. */
  stopProgress: number | null
}

/** Whether a regime is against a side: a long in a falling or a panicking market, a short in a
 * rising or a recovering one. An unknown regime is against nothing. */
export function regimeAgainst(side: 'buy' | 'sell', regime: MarketRegime | null): boolean {
  if (regime === null) return false
  return side === 'buy' ? regime === 'bear' || regime === 'panic' : regime === 'bull' || regime === 'recovery'
}

/** The status, by the lines above. */
export function thesisStatus(input: ThesisInput): ThesisVerdict {
  const reasons: ThesisReason[] = []
  const progress = stopProgress({ side: input.side, entryPrice: input.entryPrice, stopPct: input.stopPct, price: input.price })
  if (progress !== null && progress >= 1) reasons.push('stop_hit')
  else if (progress !== null && progress >= THESIS_LINES.nearStopShare) reasons.push('near_stop')
  if (input.storyAgainst !== null && input.storyAgainst.impact >= THESIS_LINES.newsImpact) reasons.push('news_against')
  // Turned against: against now, and not when it entered. A trade opened into a regime against it
  // was opened knowing that; its thesis is not weakened by what it already knew.
  if (regimeAgainst(input.side, input.regimeNow) && !regimeAgainst(input.side, input.regimeAtEntry)) reasons.push('regime_against')
  const against = input.move15mPct === null ? null : input.side === 'buy' ? -input.move15mPct : input.move15mPct
  if (against !== null && against >= THESIS_LINES.oppositeMovePct) reasons.push('opposite_move')
  const status: ThesisStatus = reasons.includes('stop_hit') || reasons.length >= THESIS_LINES.brokenReasons ? 'BROKEN' : reasons.length > 0 ? 'WEAKENING' : 'VALID'
  return { status, reasons, stopProgress: progress }
}

export function describeThesisReason(reason: ThesisReason): string {
  const words: Record<ThesisReason, string> = {
    stop_hit: 'its stop is hit',
    near_stop: 'it is near its stop',
    news_against: 'news against it',
    regime_against: "Bitcoin's regime turned against it",
    opposite_move: 'a sharp move against it'
  }
  return words[reason]
}

/** The status as it is shown: its word, the tone it is shown in, and what it means. */
export function describeThesisStatus(status: ThesisStatus): { word: ThesisStatus; tone: 'up' | 'gold' | 'down'; detail: string } {
  const shown: Record<ThesisStatus, { word: ThesisStatus; tone: 'up' | 'gold' | 'down'; detail: string }> = {
    VALID: { word: 'VALID', tone: 'up', detail: 'Nothing measured here is against it. A reading, not a decision: its stop and its exit check stand as they are.' },
    WEAKENING: { word: 'WEAKENING', tone: 'gold', detail: 'One thing measured here is against it. A reading, not a decision: its stop and its exit check stand as they are.' },
    BROKEN: { word: 'BROKEN', tone: 'down', detail: 'Its stop is hit, or two things measured here are against it. A reading, not a decision: its stop, or its watcher, closes it; nothing here does.' }
  }
  return shown[status]
}

/** One sentence: the status and its reasons. "WEAKENING: it is near its stop." */
export function describeThesisVerdict(verdict: Pick<ThesisVerdict, 'status' | 'reasons'>): string {
  if (verdict.reasons.length === 0) return `${verdict.status}: nothing measured is against it.`
  return `${verdict.status}: ${verdict.reasons.map(describeThesisReason).join('; ')}.`
}
