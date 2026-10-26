import type { ForecastBar } from '../forecast/bars'
import { dueAt, type SourcePrediction } from './predictionRecord'

// MOVES NOBODY CALLED (V8; the record Stage 2 named, written with Stage 3, 26 October 2026). The record of every
// prediction (predictionRecord.ts) says how often a source was right when it spoke; it cannot say how often a large
// move came with no source speaking, and a source that speaks rarely can look right while it misses nearly every
// move. So at every whole hour each pair the forecast reads is looked at over the hour and the day that ended, and a
// close-to-close move of 2% or more in the hour, or 5% or more in the day, is written with the predictions on file
// that called it: one on the pair, made no later than a quarter into the move's span and due no earlier than three
// quarters into it, calling the move's way -- or, a size alone, a move at least as large as it said. A move with none
// is one nobody called. Arithmetic on the forecast's own bars and the record: nothing is asked and nothing traded.

export const MOVES_VERSION = 'moves-v1'

export const MOVE_LINES = {
  version: MOVES_VERSION,
  /** A move worth recording, close to close, in percent: over an hour, and over a day. */
  hourPct: 2,
  dayPct: 5,
  /** A prediction called a move when it was made no later than this share into the move's span and was due no
   * earlier than this share before its end. */
  lead: 0.25
} as const

export type MoveSpan = 'hour' | 'day'
export const MOVE_SPAN_SEC: Readonly<Record<MoveSpan, number>> = { hour: 3600, day: 86_400 }

/** A large move, as it came, and who called it. */
export interface MoveLine {
  v: typeof MOVES_VERSION
  pair: string
  venue: SourcePrediction['venue']
  span: MoveSpan
  /** When the span ended (a whole hour), in seconds, and the closes the move is measured between. */
  at: number
  fromPrice: number
  toPrice: number
  movePct: number
  /** The ids of the predictions on file that called it; empty for a move nobody called. */
  calledBy: string[]
}

/** The close of the five-minute bar that ended at `atSec` -- the one that opened five minutes before -- or null where
 * the bars do not hold it. */
export function closeAt(bars: readonly ForecastBar[], atSec: number): number | null {
  const open = atSec - 300
  let lo = 0
  let hi = bars.length - 1
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    const time = bars[mid].time
    if (time === open) return bars[mid].close > 0 ? bars[mid].close : null
    if (time < open) lo = mid + 1
    else hi = mid - 1
  }
  return null
}

/** Whether a prediction called a move: the same pair, made early enough in the move's span and due late enough in
 * it, and calling its way, or a size alone no larger than the move. */
export function calledMove(prediction: Pick<SourcePrediction, 'pair' | 'madeAt' | 'horizonSec' | 'side' | 'movePct'>, move: Pick<MoveLine, 'pair' | 'span' | 'at' | 'movePct'>): boolean {
  if (prediction.pair !== move.pair) return false
  const span = MOVE_SPAN_SEC[move.span]
  const start = move.at - span
  if (prediction.madeAt > start + MOVE_LINES.lead * span) return false
  if (dueAt(prediction) < move.at - MOVE_LINES.lead * span) return false
  if (prediction.side === null) return prediction.movePct !== null && Math.abs(move.movePct) >= prediction.movePct
  return prediction.side === (move.movePct > 0 ? 'up' : 'down')
}

/** The large moves of a pair over the hour and the day that ended at `atSec`, each with the predictions that called
 * it. A span whose closes the bars do not hold is left out: no move is written from a price that is not there. */
export function movesOf(
  pair: string,
  venue: SourcePrediction['venue'],
  bars: readonly ForecastBar[],
  atSec: number,
  predictions: readonly Pick<SourcePrediction, 'id' | 'pair' | 'madeAt' | 'horizonSec' | 'side' | 'movePct'>[]
): MoveLine[] {
  const to = closeAt(bars, atSec)
  if (to === null) return []
  const out: MoveLine[] = []
  for (const span of ['hour', 'day'] as const) {
    const from = closeAt(bars, atSec - MOVE_SPAN_SEC[span])
    if (from === null) continue
    const movePct = (to / from - 1) * 100
    if (Math.abs(movePct) < (span === 'hour' ? MOVE_LINES.hourPct : MOVE_LINES.dayPct)) continue
    const move = { pair, span, at: atSec, movePct }
    out.push({
      v: MOVES_VERSION,
      pair,
      venue,
      span,
      at: atSec,
      fromPrice: from,
      toPrice: to,
      movePct,
      calledBy: predictions.filter((prediction) => calledMove(prediction, move)).map((prediction) => prediction.id)
    })
  }
  return out
}

/** A stored line, read as one; null for a line this version does not know. */
export function readMoveLine(value: unknown): MoveLine | null {
  if (typeof value !== 'object' || value === null) return null
  const line = value as Partial<MoveLine>
  if (line.v !== MOVES_VERSION || typeof line.pair !== 'string' || (line.span !== 'hour' && line.span !== 'day')) return null
  if (typeof line.at !== 'number' || typeof line.movePct !== 'number' || !Array.isArray(line.calledBy)) return null
  return line as MoveLine
}
