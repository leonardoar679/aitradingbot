import type { Candle } from '../ipc'
import { bootstrapOverHours, intervalOf, SHARE, type Figure, type HourSample, type Interval } from '../forecast/uncertainty'

// ONE RECORD FOR EVERY PREDICTION THAT IS NOT THE FORECAST'S OWN (V8 Stage 2, 26 October 2026).
//
// The price forecast keeps its own record and scores it (shared/forecast/forecastRecord.ts, outcome.ts). V8
// adds predictions from other sources -- a Binance delisting's rule, a pasted article's reading, a followed
// trader's trade, a person's own view, the big-mover list's size calls -- and each must be kept and scored the
// same way, or none can be judged against another. So each is one line of this record when it is made, with
// everything it said: the side or none, the move and its target, the window, the distribution behind it, the
// route's cost and the expected net; and one outcome line once its horizon has passed, settled from the
// venue's one-minute bars: the move, whether the side was right, how far the size was off, whether and when
// the target was touched, and the net after the route's cost. Its figures are read with intervals resampled by
// the source's own unit of evidence -- an announcement's hour, a trading day -- since predictions made at the
// same moment share its market (shared/forecast/uncertainty.ts).
//
// It writes nothing and asks nothing: the main process keeps the files (electron/services/predictionLedgerService.ts).

export const SOURCE_RECORD_VERSION = 'source-record-v1'

/** What a prediction says: a way and a size, a size alone (a move of so much either way), or nothing to score. */
export type SourceKind = 'direction' | 'size'

/** What a source predicted, as it was made. Prices and moves in percent from the reference price. */
export interface SourcePrediction {
  v: typeof SOURCE_RECORD_VERSION
  id: string
  /** The source and its version: `delisting-rule`, `article`, `trader`, `user`, `big-movers`, ... */
  source: string
  sourceVersion: string
  kind: SourceKind
  pair: string
  venue: 'binance' | 'bitget'
  /** When it was made, in seconds, and the close of the bar it was made on, or null. */
  madeAt: number
  bar: number | null
  /** How long it speaks for, in seconds: its outcome is the move from `madeAt` to `madeAt + horizonSec`. */
  horizonSec: number
  refPrice: number
  /** The way it calls, or null for a size alone. */
  side: 'up' | 'down' | null
  /** The predicted move in the call's favour (a size call: either way), in percent; the target it sets. */
  movePct: number | null
  targetPrice: number | null
  /** When the move is expected, in seconds from `madeAt`. */
  window: { fromSec: number; toSec: number } | null
  /** The distribution behind it, as far as the source has one. */
  dist: {
    pRight: number | null
    /** Move quantiles P10, P25, P50, P75, P90 in percent, signed. */
    q: [number, number, number, number, number] | null
    /** The chance of a close at least 1, 2, 5 and 10% away, either way. */
    pMove: { 1: number; 2: number; 5: number; 10: number } | null
  }
  /** Risk scenarios in the call's favour and against it, and the worst on file, in percent. */
  scenarios: { upPct: number; downPct: number; worstPct: number | null } | null
  /** The route's round trip at the stake. */
  cost: { roundTripPct: number; basis: 'book' | 'best' | 'flat'; stakeQuote: number } | null
  /** What the source's record says a call like it nets after the cost, with its interval. */
  expectedNet: { pct: number; low: number | null; high: number | null } | null
  reason: string
  /** The records it rests on: a URL record's id, a trader's trade, a rule's announcement. */
  evidence: string[]
  /** The unit of evidence its figures are resampled by (an announcement's hour; a trading day by default). */
  unit: number
  versions: { engine: string; config: string }
}

/** What came of a prediction once its horizon had passed. */
export interface SourceOutcome {
  v: typeof SOURCE_RECORD_VERSION
  id: string
  /** When it was settled, in seconds; `late` when that was after its due time and the lines' grace. */
  at: number
  status: 'settled' | 'late' | 'missing'
  /** The close at the horizon, and the move to it from the reference price, signed. */
  closePrice: number | null
  movePct: number | null
  /** The farthest the price went each way within the horizon, signed. */
  bestPct: number | null
  worstPct: number | null
  /** Whether the side was right (null for a size alone or a missing outcome). */
  right: boolean | null
  /** How far the size was off: the realized move in the call's favour (either way, for a size) less the predicted. */
  sizeErrorPct: number | null
  /** Whether the target was touched within the horizon, and after how many seconds. */
  touched: boolean | null
  touchSec: number | null
  /** The move in the call's favour less the route's round trip; null for a size alone. */
  netPct: number | null
  /** Why it is missing. */
  why?: string
}

/** The record's lines, pinned. */
export const SOURCE_RECORD_LINES = {
  version: SOURCE_RECORD_VERSION,
  /** After its due time, how long an outcome may take and not be late. */
  graceSec: 600,
  /** How far back owed outcomes are read at a start. */
  owedLookbackSec: 8 * 86_400
} as const

/** A prediction's id: its source, pair and moment, and a count for two made in the same second. */
export function sourcePredictionId(source: string, pair: string, madeAt: number, seq = 0): string {
  return `${source}:${pair}:${madeAt}${seq > 0 ? `:${seq}` : ''}`
}

/** When a prediction is due. */
export const dueAt = (prediction: Pick<SourcePrediction, 'madeAt' | 'horizonSec'>): number => prediction.madeAt + prediction.horizonSec

/** The call's sign: +1 for up, -1 for down, null for a size alone. */
const signOf = (side: SourcePrediction['side']): 1 | -1 | null => (side === 'up' ? 1 : side === 'down' ? -1 : null)

/** The outcome of a prediction from the venue's one-minute bars over its horizon, settled at `atSec`. The bars
 * are those whose minute starts at or after the first whole minute after `madeAt` -- the minute it was made in
 * holds prices from before it -- and before its due time; the close is the last bar's. Missing when no bar
 * covers the horizon's last minute. */
export function sourceOutcomeOf(prediction: SourcePrediction, bars: readonly Candle[], atSec: number): SourceOutcome {
  const due = dueAt(prediction)
  const base = { v: SOURCE_RECORD_VERSION, id: prediction.id, at: atSec } as const
  const missing = (why: string): SourceOutcome => ({ ...base, status: 'missing', closePrice: null, movePct: null, bestPct: null, worstPct: null, right: null, sizeErrorPct: null, touched: null, touchSec: null, netPct: null, why })
  if (!(prediction.refPrice > 0)) return missing('the prediction has no reference price')
  const firstMinute = Math.ceil(prediction.madeAt / 60) * 60
  const inside = bars.filter((bar) => bar.time >= firstMinute && bar.time < due).sort((a, b) => a.time - b.time)
  if (inside.length === 0) return missing('no bar of the venue covers the horizon')
  const last = inside[inside.length - 1]
  // The horizon's last minute must be there: a close read before the end would be an earlier move.
  if (last.time + 60 < due) return missing('the bars end before the horizon does')
  const pct = (price: number): number => (price / prediction.refPrice - 1) * 100
  const movePct = pct(last.close)
  const bestPct = pct(Math.max(...inside.map((bar) => bar.high)))
  const worstPct = pct(Math.min(...inside.map((bar) => bar.low)))
  const sign = signOf(prediction.side)
  let touched: boolean | null = null
  let touchSec: number | null = null
  if (prediction.targetPrice !== null && prediction.targetPrice > 0) {
    const up = prediction.targetPrice >= prediction.refPrice
    const hit = inside.find((bar) => (up ? bar.high >= prediction.targetPrice! : bar.low <= prediction.targetPrice!))
    touched = hit !== undefined
    touchSec = hit === undefined ? null : Math.max(0, hit.time - prediction.madeAt)
  }
  const favourable = sign === null ? Math.abs(movePct) : sign * movePct
  return {
    ...base,
    status: atSec > due + SOURCE_RECORD_LINES.graceSec ? 'late' : 'settled',
    closePrice: last.close,
    movePct,
    bestPct,
    worstPct,
    right: sign === null ? null : sign * movePct > 0,
    sizeErrorPct: prediction.movePct === null ? null : favourable - prediction.movePct,
    touched,
    touchSec,
    netPct: sign === null ? null : sign * movePct - (prediction.cost?.roundTripPct ?? 0)
  }
}

/** A source's figures over its scored predictions, each resampled by the source's unit of evidence. */
export interface SourceFigures {
  /** Predictions with an outcome that is not missing, and the independent units they rest on. */
  n: number
  units: number
  missing: number
  /** The share whose side was right, the mean net after costs, the mean size error, the share that touched. */
  right: Figure | null
  net: Figure | null
  sizeError: Figure | null
  touched: Figure | null
}

/** The figures of a source's predictions joined to their outcomes, intervals by unit (1,000 seeded draws). */
export function sourceFiguresOf(pairs: readonly { prediction: SourcePrediction; outcome: SourceOutcome | null }[]): SourceFigures {
  const scored = pairs.filter((entry) => entry.outcome !== null && entry.outcome.status !== 'missing') as { prediction: SourcePrediction; outcome: SourceOutcome }[]
  const missing = pairs.filter((entry) => entry.outcome !== null && entry.outcome.status === 'missing').length
  const units = new Set(scored.map((entry) => entry.prediction.unit)).size
  const figure = (value: (entry: { prediction: SourcePrediction; outcome: SourceOutcome }) => number | null, bounds?: readonly [number, number]): Figure | null => {
    const rows: HourSample[] = []
    for (const entry of scored) {
      const x = value(entry)
      if (x !== null && Number.isFinite(x)) rows.push({ hour: entry.prediction.unit, sample: [x] })
    }
    if (rows.length === 0) return null
    const resampled = bootstrapOverHours(rows, [(sums, n): number => sums[0] / n], 1)
    if (resampled === null) {
      const mean = rows.reduce((sum, row) => sum + row.sample[0], 0) / rows.length
      return { value: mean, low: Number.NaN, high: Number.NaN, sd: Number.NaN }
    }
    const raw = resampled.figures[0]
    const bounded: Interval | null = bounds === undefined ? raw : intervalOf(raw, bounds)
    return { ...raw, low: bounded?.low ?? raw.low, high: bounded?.high ?? raw.high }
  }
  return {
    n: scored.length,
    units,
    missing,
    right: figure((entry) => (entry.outcome.right === null ? null : entry.outcome.right ? 1 : 0), SHARE),
    net: figure((entry) => entry.outcome.netPct),
    sizeError: figure((entry) => entry.outcome.sizeErrorPct),
    touched: figure((entry) => (entry.outcome.touched === null ? null : entry.outcome.touched ? 1 : 0), SHARE)
  }
}

/** The unit of evidence by default: the UTC day a prediction was made on. */
export const dayUnitOf = (madeAt: number): number => Math.floor(madeAt / 86_400)

/** The unit for an announcement: its hour, so every coin it named counts once together. */
export const hourUnitOf = (at: number): number => Math.floor(at / 3600)

/** A stored line, read as one: the shape checked, or null for a line this version does not know. */
export function readSourcePrediction(value: unknown): SourcePrediction | null {
  if (typeof value !== 'object' || value === null) return null
  const line = value as Partial<SourcePrediction>
  if (line.v !== SOURCE_RECORD_VERSION || typeof line.id !== 'string' || typeof line.source !== 'string' || typeof line.pair !== 'string') return null
  if (typeof line.madeAt !== 'number' || typeof line.horizonSec !== 'number' || !(line.horizonSec > 0) || typeof line.refPrice !== 'number') return null
  if (line.kind !== 'direction' && line.kind !== 'size') return null
  if (line.side !== 'up' && line.side !== 'down' && line.side !== null) return null
  if (line.kind === 'direction' && line.side === null) return null
  return line as SourcePrediction
}

export function readSourceOutcome(value: unknown): SourceOutcome | null {
  if (typeof value !== 'object' || value === null) return null
  const line = value as Partial<SourceOutcome>
  if (line.v !== SOURCE_RECORD_VERSION || typeof line.id !== 'string' || typeof line.at !== 'number') return null
  if (line.status !== 'settled' && line.status !== 'late' && line.status !== 'missing') return null
  return line as SourceOutcome
}
