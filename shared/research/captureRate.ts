import { REPLAY_ASK_DELAY_SEC, scoreOpportunity, type OpportunityOutcome } from '../aiOpportunityOutcome'
import type { Candle } from '../ipc'
import type { MarketEvent } from '../marketEvent'
import { RESEARCH_MIN_TRADES, researchCalls, tradeStats, type ResearchInput } from './common'

// CAPTURE AND MISSES (the V4 document, §63-64, §66): a ground truth outside the detector's bands --
// every move of three percent or more in fifteen minutes over the last seven days, found by the
// history scan over the universe at its lowest floor -- against what the live scanner raised and
// the watch asked about. Recall is the share of those moves that were raised as events; decision
// precision the share of the watch's actionable answers that were right by their own bracket; and
// the misses are the moves the app held or never asked about, with what followed. NET where an
// outcome is scored.

export const CAPTURE_MOVE_PCT = 3
export const CAPTURE_DAYS = 7
/** A raised event matches a move when it is the same pair within this many seconds. */
export const CAPTURE_MATCH_SECONDS = 15 * 60
export const MISSES_SHOWN = 50
const HOLD_SECONDS = 3600

export interface TruthMove {
  symbol: string
  time: number
  m15Pct: number
  direction: 'up' | 'down'
  /** The event on file that raised it, if any; and whether the watch asked about that event. */
  raisedBy: string | null
  asked: boolean
}

/** The moves of three percent or more in fifteen minutes among the scan's events, each matched to
 * the live events on file and to what the watch asked. */
export function truthMoves(scanned: readonly MarketEvent[], raised: readonly MarketEvent[], askedIds: ReadonlySet<string>): TruthMove[] {
  return scanned
    .filter((event) => Math.abs(event.returnsPct.m15) >= CAPTURE_MOVE_PCT)
    .map((event) => {
      const match = raised.find((live) => live.symbol === event.symbol && Math.abs(live.time - event.time) <= CAPTURE_MATCH_SECONDS) ?? null
      const direction: TruthMove['direction'] = event.returnsPct.m15 >= 0 ? 'up' : 'down'
      return { symbol: event.symbol, time: event.time, m15Pct: event.returnsPct.m15, direction, raisedBy: match === null ? null : match.id, asked: match !== null && askedIds.has(match.id) }
    })
    .sort((a, b) => b.time - a.time)
}

export interface CaptureSummary {
  moves: number
  raised: number
  asked: number
  /** Of the moves, the share raised as events; null without moves. */
  recallPct: number | null
  /** Of the watch's actionable answers that closed, the share that won; null under thirty. */
  decisionPrecisionPct: number | null
  closedAnswers: number
  label: 'NET'
}

export function captureSummary(moves: readonly TruthMove[], input: ResearchInput): CaptureSummary {
  const outcomes: OpportunityOutcome[] = researchCalls(input).map(({ event, call, costs }) => scoreOpportunity(call, input.bars[event.id] ?? [], input.nowSec, costs))
  const stats = tradeStats(outcomes, RESEARCH_MIN_TRADES)
  const raised = moves.filter((move) => move.raisedBy !== null).length
  return {
    moves: moves.length,
    raised,
    asked: moves.filter((move) => move.asked).length,
    recallPct: moves.length === 0 ? null : (raised / moves.length) * 100,
    decisionPrecisionPct: stats.winRatePct,
    closedAnswers: stats.closed,
    label: 'NET'
  }
}

export interface MissedMove extends TruthMove {
  /** Followed its own way for an hour from the minute after it: the net, where the bars were read. */
  followedNetPct: number | null
  why: 'never raised' | 'raised, not asked'
}

/** The moves the app held or never asked about, newest first, with what followed where the bars
 * were read (by `${symbol}:${time}`). */
export function missedMoves(moves: readonly TruthMove[], bars: Readonly<Record<string, Candle[]>>, nowSec: number): MissedMove[] {
  return moves
    .filter((move) => !move.asked)
    .slice(0, MISSES_SHOWN)
    .map((move) => {
      const own = bars[`${move.symbol}:${move.time}`] ?? []
      const answeredAt = move.time + REPLAY_ASK_DELAY_SEC
      const first = own.find((bar) => bar.time >= answeredAt)
      const long = move.direction === 'up'
      const outcome =
        first === undefined
          ? null
          : scoreOpportunity(
              { time: move.time, side: long ? 'long' : 'short', entryMin: first.open, entryMax: first.open, stopLoss: long ? 0 : Number.MAX_VALUE, takeProfit: long ? Number.MAX_VALUE : 0, expiresAt: first.time + 60, holdSeconds: HOLD_SECONDS, answeredAt },
              own,
              nowSec,
              { feeRate: 0.001, slippageRate: 0.0002 }
            )
      return { ...move, followedNetPct: outcome === null || outcome.status !== 'closed' ? null : outcome.netPct, why: move.raisedBy === null ? 'never raised' : 'raised, not asked' }
    })
}
