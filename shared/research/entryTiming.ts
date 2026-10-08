import { scoreOpportunity, type OpportunityOutcome } from '../aiOpportunityOutcome'
import type { Candle } from '../ipc'
import { researchCalls, tradeStats, type ResearchInput, type TradeStats } from './common'

// ENTRY TIMING (the V4 document, §64): the same calls entered at the answer, one, three and five
// minutes after it, and after one bar closing the call's way; the same bracket each time. An entry
// that waits can miss its range and expire, which is counted. NET, as the score charges it.

export const ENTRY_TIMINGS = ['answer', 'plus1', 'plus3', 'plus5', 'confirming'] as const
export type EntryTiming = (typeof ENTRY_TIMINGS)[number]
export const ENTRY_TIMING_NAMES: Record<EntryTiming, string> = {
  answer: 'At the answer',
  plus1: 'One minute after it',
  plus3: 'Three minutes after it',
  plus5: 'Five minutes after it',
  confirming: 'After one bar closes its way'
}
const DELAY_SEC: Record<EntryTiming, number> = { answer: 0, plus1: 60, plus3: 180, plus5: 300, confirming: 0 }
const BAR_SECONDS = 60

/** The end of the first closed bar at or after `fromSec` that closes the side's way; null without
 * one among the bars. */
export function confirmingBarEnd(bars: readonly Candle[], fromSec: number, side: 'long' | 'short', nowSec: number): number | null {
  for (const bar of bars) {
    if (bar.time < fromSec || bar.time + BAR_SECONDS > nowSec) continue
    if (side === 'long' ? bar.close > bar.open : bar.close < bar.open) return bar.time + BAR_SECONDS
  }
  return null
}

export interface EntryTimingRow {
  timing: EntryTiming
  name: string
  label: 'NET'
  stats: TradeStats
  /** Calls whose range the price had left by then, so no entry was made. */
  expired: number
  /** Calls with no confirming bar among the candles (the confirming row only). */
  unconfirmed: number
}

export function entryTimingRows(input: ResearchInput): EntryTimingRow[] {
  const calls = researchCalls(input)
  return ENTRY_TIMINGS.map((timing) => {
    const outcomes: OpportunityOutcome[] = []
    let unconfirmed = 0
    for (const { event, call, costs } of calls) {
      const bars = input.bars[event.id] ?? []
      let answeredAt = call.answeredAt + DELAY_SEC[timing]
      if (timing === 'confirming') {
        const end = confirmingBarEnd(bars, call.answeredAt, call.side, input.nowSec)
        if (end === null) {
          unconfirmed++
          continue
        }
        answeredAt = end
      }
      outcomes.push(scoreOpportunity({ ...call, answeredAt }, bars, input.nowSec, costs))
    }
    return { timing, name: ENTRY_TIMING_NAMES[timing], label: 'NET', stats: tradeStats(outcomes), expired: outcomes.filter((outcome) => outcome.status === 'expired').length, unconfirmed }
  })
}
