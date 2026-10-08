// ONE STATUS FOR AN OPPORTUNITY (the V5 document, §42; V5 Stage 6, 8 October 2026). Where an event
// stands was said in three places -- the feed's word (waiting, asked, valid, open, expired, closed:
// src/agents/opportunities.ts feedItemStatus), the live check's (ENTERABLE, WAITING, INVALIDATED:
// shared/liveMarket.ts revalidate) and the paper trade's ends -- and the document's words were
// missing two of them: ANALYSING, a call in the air, and MISSED, an answer the app could have
// acted on and did not. This reads them as one word, from what the page already holds; it decides
// nothing. NO TRADE is the document's list plus one: the models answered and would not act, which
// is most events, and is neither discovered nor expired.

export const OPPORTUNITY_STATUSES = ['discovered', 'analysing', 'no_trade', 'qualified', 'ready', 'executed', 'missed', 'invalidated', 'expired'] as const
export type OpportunityStatus = (typeof OPPORTUNITY_STATUSES)[number]

export interface OpportunityStatusInput {
  /** Answers on file for the event, refused ones included. */
  answered: number
  /** A call about the event is in the air now. */
  asking: boolean
  /** The feed's word for the event, or null where its candles are not read yet. */
  feed: 'waiting' | 'asked' | 'valid' | 'open' | 'expired' | 'closed' | null
  /** The live check of the entry on offer, where there is one and the stream is read. */
  live: 'enterable' | 'waiting' | 'invalidated' | null
  /** Why the live check ended it, when it did. */
  liveReasons: readonly string[]
  /** A refusal of the app's own paper trade is on file for the event. */
  refused: boolean
  /** A paper trade of the app's own is, or was, open on the event. */
  traded: boolean
}

/** The first that applies: executed (a paper trade of the app's own is or was open on it);
 * analysing (a call in the air); discovered (nothing answered yet); no trade (answered, nothing to
 * act on); missed (the price came into an entry's range -- the feed scores the answer as a trade
 * that ran -- and the app opened nothing: a refusal on file says why, or its paper trades were
 * off; or every entry ran out unfilled behind a refusal); expired (every entry ran out unfilled,
 * the price never came); ready (an entry on offer, enterable now); qualified (an entry on offer,
 * waiting for its price, or not yet checked); expired or invalidated (the live check ended it: by
 * its clock, or by Bitcoin, the spread or a stale price). */
export function opportunityStatusOf(input: OpportunityStatusInput): OpportunityStatus {
  if (input.traded) return 'executed'
  if (input.asking) return 'analysing'
  if (input.answered === 0) return 'discovered'
  if (input.feed === 'asked') return 'no_trade'
  if (input.feed === 'open' || input.feed === 'closed') return 'missed'
  if (input.feed === 'expired') return input.refused ? 'missed' : 'expired'
  if (input.live === 'enterable') return 'ready'
  if (input.live === 'invalidated') return input.liveReasons.some((reason) => /expired/.test(reason)) ? 'expired' : 'invalidated'
  return 'qualified'
}

export function describeOpportunityStatus(status: OpportunityStatus): { word: string; tone: 'up' | 'gold' | 'down' | 'muted' | 'primary'; detail: string } {
  const shown: Record<OpportunityStatus, { word: string; tone: 'up' | 'gold' | 'down' | 'muted' | 'primary'; detail: string }> = {
    discovered: { word: 'DISCOVERED', tone: 'muted', detail: 'Raised by the scanner; no model has answered it.' },
    analysing: { word: 'ANALYSING', tone: 'primary', detail: 'A call about it is in the air.' },
    no_trade: { word: 'NO TRADE', tone: 'muted', detail: 'The models answered, and none would act on it.' },
    qualified: { word: 'QUALIFIED', tone: 'gold', detail: 'An entry is on offer and waits for its price to come into the range, or for the stream to be read.' },
    ready: { word: 'READY', tone: 'up', detail: 'An entry is on offer and the live price is inside its range, fresh, on a spread within the line.' },
    executed: { word: 'EXECUTED', tone: 'up', detail: 'A paper trade of the app\'s own is, or was, open on it.' },
    missed: { word: 'MISSED', tone: 'down', detail: 'An entry was there to take and the app opened no paper trade on it: a refusal on file says why, or its paper trades were off.' },
    invalidated: { word: 'INVALIDATED', tone: 'down', detail: 'The live check ended it: Bitcoin against it, the spread over the line, or no fresh price.' },
    expired: { word: 'EXPIRED', tone: 'muted', detail: 'Its entry ran out, and the price never came into the range.' }
  }
  return shown[status]
}
