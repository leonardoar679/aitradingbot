import { FEE_RATE } from '../fees'
import type { Candle } from '../ipc'
import { describeEventType, expectedDirection, type NewsEventType, type StoryReaction } from '../newsFeed'
import { RESEARCH_MIN_SLICE, type TradeStats } from './common'
import { tradeStats } from './common'
import type { OpportunityOutcome } from '../aiOpportunityOutcome'

// NEWS TIMING (the V4 document, §68): a story of a kind with a way of its own, followed that way
// from the close of the minute it was published in, entering at the open of the next minute, or
// one, three or five minutes later, and out an hour after the entry: no stop, no target. On minute
// bars: there is no thirty-second step to measure, and this says so. NET of the fees on both fills.
// Ten stories a kind.

export const NEWS_DELAYS = [0, 1, 3, 5] as const
export type NewsDelay = (typeof NEWS_DELAYS)[number]
export const NEWS_HOLD_SECONDS = 3600
const BAR_SECONDS = 60

export interface NewsTimingRow {
  eventType: NewsEventType
  name: string
  direction: 'up' | 'down'
  label: 'NET'
  stories: number
  byDelay: Record<NewsDelay, TradeStats>
}

/** One story followed its kind's way from a delay after its minute, held an hour: the net of the
 * closes, with the fees on both fills, from the bars of its coin. Null where the bars do not reach. */
export function newsFollowOutcome(reaction: Pick<StoryReaction, 'publishedAt' | 'eventType'>, bars: readonly Candle[], delay: NewsDelay, nowSec: number): OpportunityOutcome | null {
  const direction = expectedDirection(reaction.eventType)
  if (direction === null) return null
  const minute = Math.floor(reaction.publishedAt / 60) * 60
  const byTime = new Map(bars.filter((bar) => bar.time + BAR_SECONDS <= nowSec).map((bar) => [bar.time, bar]))
  const entryBar = byTime.get(minute + (1 + delay) * 60)
  const exitBar = byTime.get(minute + (1 + delay) * 60 + NEWS_HOLD_SECONDS - 60)
  if (entryBar === undefined || exitBar === undefined || !(entryBar.open > 0)) return null
  const sign = direction === 'up' ? 1 : -1
  const entryPrice = entryBar.open
  const exitPrice = exitBar.close
  let best = 0
  let worst = 0
  for (let time = entryBar.time; time <= exitBar.time; time += 60) {
    const bar = byTime.get(time)
    if (bar === undefined) return null
    best = Math.max(best, sign * ((direction === 'up' ? bar.high : bar.low) / entryPrice - 1) * 100)
    worst = Math.min(worst, sign * ((direction === 'up' ? bar.low : bar.high) / entryPrice - 1) * 100)
  }
  const netPct = sign * (exitPrice / entryPrice - 1) * 100 - FEE_RATE * (1 + exitPrice / entryPrice) * 100
  return { status: 'closed', entryTime: entryBar.time, entryPrice, exit: 'time', exitTime: exitBar.time, exitPrice, netPct, r: null, bestPct: best, worstPct: worst, heldMinutes: NEWS_HOLD_SECONDS / 60 }
}

/** By kind and delay, over the reactions given with their coins' bars (by story id). */
export function newsTimingRows(reactions: readonly StoryReaction[], bars: Readonly<Record<string, Candle[]>>, nowSec: number): NewsTimingRow[] {
  const kinds = [...new Set(reactions.map((reaction) => reaction.eventType))].filter((kind) => expectedDirection(kind) !== null)
  const rows: NewsTimingRow[] = []
  for (const eventType of kinds) {
    const own = reactions.filter((reaction) => reaction.eventType === eventType && bars[reaction.storyId] !== undefined)
    if (own.length === 0) continue
    const byDelay = {} as Record<NewsDelay, TradeStats>
    for (const delay of NEWS_DELAYS) {
      const outcomes = own.map((reaction) => newsFollowOutcome(reaction, bars[reaction.storyId] ?? [], delay, nowSec)).filter((outcome): outcome is OpportunityOutcome => outcome !== null)
      byDelay[delay] = tradeStats(outcomes, RESEARCH_MIN_SLICE)
    }
    rows.push({ eventType, name: describeEventType(eventType), direction: expectedDirection(eventType) as 'up' | 'down', label: 'NET', stories: own.length, byDelay })
  }
  return rows.sort((a, b) => b.stories - a.stories)
}
