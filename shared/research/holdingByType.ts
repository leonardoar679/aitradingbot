import { REPLAY_ASK_DELAY_SEC, scoreOpportunity, type OpportunityOutcome } from '../aiOpportunityOutcome'
import { MARKET_EVENT_TYPES, describeEventType, type MarketEventType } from '../marketEvent'
import { RESEARCH_MIN_SLICE, researchCalls, tradeStats, type ResearchInput, type TradeStats } from './common'

// HOLDING TIME BY EVENT TYPE (the V4 document, §65): each event followed its own way from the open
// of the first minute after the question could have been put, with no stop and no target, and out
// after five, fifteen or thirty minutes, an hour, two or four. NET. Ten trades a slice.

export const HOLDS = [
  { id: 'm5', seconds: 300, name: '5 min' },
  { id: 'm15', seconds: 900, name: '15 min' },
  { id: 'm30', seconds: 1800, name: '30 min' },
  { id: 'h1', seconds: 3600, name: '1 h' },
  { id: 'h2', seconds: 7200, name: '2 h' },
  { id: 'h4', seconds: 14_400, name: '4 h' }
] as const
export type HoldId = (typeof HOLDS)[number]['id']

export interface HoldingRow {
  eventType: MarketEventType
  name: string
  label: 'NET'
  events: number
  /** By hold: the stats over the events of this type, ten or more. */
  byHold: Record<HoldId, TradeStats>
}

/** Every event followed its own way (the watch's events, whichever model answered); an event
 * with no direction is not followed. */
export function holdingRows(input: ResearchInput): HoldingRow[] {
  const seen = new Set<string>()
  const events = input.events.filter((event) => {
    if (seen.has(event.id) || event.direction === 'none') return false
    seen.add(event.id)
    return true
  })
  // Costs as the research calls charge them for the pair; the default where no call was made on it.
  const costsByEvent = new Map(researchCalls(input).map((call) => [call.event.id, call.costs]))
  const rows: HoldingRow[] = []
  for (const eventType of MARKET_EVENT_TYPES) {
    const own = events.filter((event) => event.type === eventType)
    if (own.length === 0) continue
    const byHold = {} as Record<HoldId, TradeStats>
    for (const hold of HOLDS) {
      const outcomes: OpportunityOutcome[] = []
      for (const event of own) {
        const bars = input.bars[event.id] ?? []
        const answeredAt = event.time + REPLAY_ASK_DELAY_SEC
        const first = bars.find((bar) => bar.time >= answeredAt)
        if (first === undefined) continue
        const long = event.direction === 'up'
        outcomes.push(
          scoreOpportunity(
            { time: event.time, side: long ? 'long' : 'short', entryMin: first.open, entryMax: first.open, stopLoss: long ? 0 : Number.MAX_VALUE, takeProfit: long ? Number.MAX_VALUE : 0, expiresAt: first.time + 60, holdSeconds: hold.seconds, answeredAt },
            bars,
            input.nowSec,
            costsByEvent.get(event.id) ?? { feeRate: 0.001, slippageRate: 0.0002 }
          )
        )
      }
      byHold[hold.id] = tradeStats(outcomes, RESEARCH_MIN_SLICE)
    }
    rows.push({ eventType, name: describeEventType(eventType), label: 'NET', events: own.length, byHold })
  }
  return rows.sort((a, b) => b.events - a.events)
}
