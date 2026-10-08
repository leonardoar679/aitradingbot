import { scoreOpportunity, type OpportunityOutcome } from '../aiOpportunityOutcome'
import { MARKET_EVENT_TYPES, describeEventType, type MarketEventType } from '../marketEvent'
import { RESEARCH_MIN_SLICE, researchCalls, tradeStats, type ResearchInput, type TradeStats } from './common'

// FALSE OPPORTUNITIES (the V4 document, §67): of the answers this app would act on, by the kind of
// event, how many lost -- the share of actionable calls that were wrong by their own bracket. NET.
// Ten trades a kind.

export interface FalseOpportunityRow {
  eventType: MarketEventType
  name: string
  label: 'NET'
  /** Actionable answers, and those among them that closed. */
  calls: number
  closed: number
  losses: number
  /** Of the closed, the share that lost; null under ten. */
  lossSharePct: number | null
  stats: TradeStats
}

export function falseOpportunityRows(input: ResearchInput): FalseOpportunityRow[] {
  const calls = researchCalls(input)
  const rows: FalseOpportunityRow[] = []
  for (const eventType of MARKET_EVENT_TYPES) {
    const own = calls.filter((call) => call.event.type === eventType)
    if (own.length === 0) continue
    const outcomes: OpportunityOutcome[] = own.map(({ event, call, costs }) => scoreOpportunity(call, input.bars[event.id] ?? [], input.nowSec, costs))
    const stats = tradeStats(outcomes, RESEARCH_MIN_SLICE)
    // A loss is a closed trade that is not a win: one that made nothing was wrong by its bracket too.
    const losses = stats.closed - stats.wins
    rows.push({
      eventType,
      name: describeEventType(eventType),
      label: 'NET',
      calls: own.length,
      closed: stats.closed,
      losses,
      lossSharePct: stats.closed >= RESEARCH_MIN_SLICE ? (losses / stats.closed) * 100 : null,
      stats
    })
  }
  return rows.sort((a, b) => b.calls - a.calls)
}
