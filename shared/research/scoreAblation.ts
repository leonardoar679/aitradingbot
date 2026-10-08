import { REPLAY_ASK_DELAY_SEC, scoreOpportunity, type OpportunityOutcome } from '../aiOpportunityOutcome'
import type { MarketEvent } from '../marketEvent'
import { SIGNAL_WEIGHTS, type SignalPartId, type SignalScore } from '../opportunityScore'
import { RESEARCH_MIN_TRADES, researchCalls, tradeStats, type ResearchInput, type TradeStats } from './common'

// ABLATION OF THE SIGNAL SCORE (the V4 document, §100): the score with one input left out and the
// rest re-weighed to the same whole, and what each day's three strongest events under it would
// have made followed their own way for an hour. "Everything − news" against "Everything": if the
// news leaves the picks no worse, it is not earning its weight. NET; thirty picks a row. The
// scores are each event's as it is scored now from what is on file: the news and the regime as
// read today, which is said on the table.

export const ABLATED_INPUTS = ['volume', 'breakout', 'liquidity', 'news', 'regime', 'models'] as const
export type AblatedInput = (typeof ABLATED_INPUTS)[number]
export const TOP_PER_DAY = 3
const HOLD_SECONDS = 3600

/** A score with one part left out: the other parts' points, scaled so the weights still sum to
 * one. The penalties stand. */
export function ablatedScore(score: SignalScore, without: AblatedInput | null): number {
  const kept = score.parts.filter((part) => part.id !== without)
  const weight = kept.reduce((sum, part) => sum + part.weight, 0)
  if (!(weight > 0)) return 0
  const points = kept.reduce((sum, part) => sum + part.points, 0) / weight
  const penalties = score.penalties.reduce((sum, penalty) => sum + penalty.points, 0)
  return Math.max(0, Math.min(100, points - penalties))
}

export interface AblationRow {
  without: AblatedInput | null
  name: string
  label: 'NET'
  /** Days with at least one scored event. */
  days: number
  picks: number
  stats: TradeStats
}

/** Each day's top picks under each ablation, followed their own way for an hour from the open of
 * the first minute after the question could have been put. `scores` holds each event's score as
 * scored now, by event id; an event without one is not a candidate. */
export function ablationRows(input: ResearchInput, scores: Readonly<Record<string, SignalScore>>): AblationRow[] {
  const seen = new Set<string>()
  const candidates = input.events.filter((event) => {
    if (seen.has(event.id) || event.direction === 'none' || scores[event.id] === undefined) return false
    seen.add(event.id)
    return true
  })
  const costsByEvent = new Map(researchCalls(input).map((call) => [call.event.id, call.costs]))
  const followed = (event: MarketEvent): OpportunityOutcome | null => {
    const bars = input.bars[event.id] ?? []
    const answeredAt = event.time + REPLAY_ASK_DELAY_SEC
    const first = bars.find((bar) => bar.time >= answeredAt)
    if (first === undefined) return null
    const long = event.direction === 'up'
    return scoreOpportunity(
      { time: event.time, side: long ? 'long' : 'short', entryMin: first.open, entryMax: first.open, stopLoss: long ? 0 : Number.MAX_VALUE, takeProfit: long ? Number.MAX_VALUE : 0, expiresAt: first.time + 60, holdSeconds: HOLD_SECONDS, answeredAt },
      bars,
      input.nowSec,
      costsByEvent.get(event.id) ?? { feeRate: 0.001, slippageRate: 0.0002 }
    )
  }
  const byDay = new Map<string, MarketEvent[]>()
  for (const event of candidates) {
    const day = new Date(event.time * 1000).toISOString().slice(0, 10)
    byDay.set(day, [...(byDay.get(day) ?? []), event])
  }
  const variants: (AblatedInput | null)[] = [null, ...ABLATED_INPUTS]
  return variants.map((without) => {
    const outcomes: OpportunityOutcome[] = []
    let picks = 0
    for (const events of byDay.values()) {
      const top = [...events].sort((a, b) => ablatedScore(scores[b.id], without) - ablatedScore(scores[a.id], without) || a.time - b.time).slice(0, TOP_PER_DAY)
      for (const event of top) {
        picks++
        const outcome = followed(event)
        if (outcome !== null) outcomes.push(outcome)
      }
    }
    return { without, name: without === null ? 'Everything' : `Everything − ${without}`, label: 'NET', days: byDay.size, picks, stats: tradeStats(outcomes, RESEARCH_MIN_TRADES) }
  })
}

/** The parts an ablation can leave out, with their weights, for the table's note. */
export function ablationWeights(): { id: SignalPartId; weight: number }[] {
  return (Object.keys(SIGNAL_WEIGHTS) as SignalPartId[]).map((id) => ({ id, weight: SIGNAL_WEIGHTS[id] }))
}
