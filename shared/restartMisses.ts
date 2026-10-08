import { opportunitySide } from './aiOpportunity'
import type { AiSignalDecision } from './aiSignal'
import { voteOf } from './opportunityVote'
import type { PaperRefusalRecord } from './records'

// THE RECORD WHOLE ACROSS A RESTART (the V5 document, §94; V5 Stage 12, 8 October 2026). The watch
// asks about an event and, on an answer it would act on, opens its paper trade in the same breath.
// Closed between the two -- the answer written to the ledger, the app gone before the trade -- it
// forgot the event for good: the ledger said it had been asked about, so it was never asked again,
// and nothing said that nothing had been done. Now the watch reads today's ledger at start, and an
// event with an answer to act on, no trade on the books and no refusal on file is written as a
// refusal at stage `restart`, in words that say why, and shown as MISSED. The event is still
// never asked again: the record is made whole, not the question. Everything here is arithmetic on
// what was read; the reading and the writing are the watch's (src/agents/opportunityWatch.ts).

export const RESTART_REFUSAL_TEXT = 'No paper trade: the app was not running when it could have been entered.'

export interface AnsweredEvent {
  eventId: string
  symbol: string
  /** The answers the watch had for the event before this start, one per model, oldest first. */
  decisions: AiSignalDecision[]
}

/** A ledger row as the sweep reads it: what joins it to its event, and the decision it was. */
export interface AnsweredRow {
  eventId: string
  symbol: string
  model: string
  status: string
  /** Seconds. */
  at: number
  decision: AiSignalDecision
}

/** Today's watch rows read into the events answered before this start, by the rule the live board
 * reads them (src/agents/liveBoard.ts): the first answer a model gave for an event is the one
 * kept, a call that never reached a model has nothing to act on, and a row at or after the start
 * is this run's own business -- its trade follows in the same breath, or its refusal is written. */
export function answeredBeforeStart(rows: readonly AnsweredRow[], startedSec: number): AnsweredEvent[] {
  const byEvent = new Map<string, { symbol: string; byModel: Map<string, AiSignalDecision> }>()
  for (const row of [...rows].sort((a, b) => a.at - b.at)) {
    if (row.status === 'failed' || row.at >= startedSec) continue
    const held = byEvent.get(row.eventId) ?? { symbol: row.symbol, byModel: new Map<string, AiSignalDecision>() }
    if (!held.byModel.has(row.model)) held.byModel.set(row.model, row.decision)
    byEvent.set(row.eventId, held)
  }
  return [...byEvent.entries()].map(([eventId, held]) => ({ eventId, symbol: held.symbol, decisions: [...held.byModel.values()] }))
}

export interface RestartMissInput {
  answered: readonly AnsweredEvent[]
  /** Events with a paper trade of the watch's own on the books, and with a refusal on file. */
  traded: ReadonlySet<string>
  refused: ReadonlySet<string>
  /** Seconds. */
  nowSec: number
}

/** The refusals to write at start: one per event the watch had an answer to act on for, with no
 * trade on the books and no refusal on file. The answers are read by the rule the watch trades on
 * (shared/opportunityVote.ts voteOf, which with one answer follows that answer), so an event the
 * vote would have refused, or a hold, is not a miss: nothing would have been entered. */
export function restartMisses(input: RestartMissInput): PaperRefusalRecord[] {
  const out: PaperRefusalRecord[] = []
  const seen = new Set<string>()
  for (const event of input.answered) {
    if (seen.has(event.eventId) || input.traded.has(event.eventId) || input.refused.has(event.eventId)) continue
    seen.add(event.eventId)
    const vote = voteOf(event.decisions)
    if (vote.chosen === null) continue
    const side = opportunitySide(vote.chosen)
    out.push({
      id: `${event.eventId}:restart:${input.nowSec}`,
      at: input.nowSec,
      source: 'watch',
      symbol: event.symbol,
      text: RESTART_REFUSAL_TEXT,
      eventId: event.eventId,
      model: vote.chosen.model,
      ...(vote.chosen.callId !== undefined ? { callId: vote.chosen.callId } : {}),
      ...(side === 'long' ? { side: 'buy' as const } : side === 'short' ? { side: 'sell' as const } : {}),
      stage: 'restart'
    })
  }
  return out
}
