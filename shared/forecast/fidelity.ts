import type { AciTable } from './aciTable'
import { FORECAST_BAR_SECONDS, barsUpTo, coarseBars, type ForecastBar } from './bars'
import { HORIZONS, type Horizon, type PairSeries } from './features'
import { isMissing, type MissingOutcomeLine, type OutcomeLine, type PassLine, type PredictionLine } from './forecastRecord'
import type { FittedHorizon } from './models'
import { newPassState, owe, pass, type PassSources } from './pass'
import type { RunCalibration } from './runCalibration'

// REPLAY FIDELITY (V7.2 Stage 5, 18 October 2026): a record made by the live forecast, replayed through
// the pure pass (shared/forecast/pass.ts) from the same bars, the same models and the same calibration,
// with no live book, no news and no class verdicts -- and compared, at every quarter-hour close, on V2's
// own levels: the five levels of the forecast shown where nothing moved them, and the levels the record
// keeps as V2's own where a story, a thin book or Bitcoin's sharp move did. V2's own levels depend on the
// bars, the models, the calibration's cell and the adaptive levels alone, so a replay from the same
// record must reproduce them; the record's own forecasts, grid and refresh, are owed their outcomes in
// the replay, so that the adaptive levels take the same steps at the same closes. Every forecast that does
// not replay to four decimals is listed with its reason: not replayed (the pair or horizon was not forecast
// at the close), bars differ (the close's price is not the record's: the bars on file changed since), cell
// differs (the calibration reads the pair in another cell), or levels differ, with the largest difference.
// The registered line (V72-S5-FIDELITY): at least 99% of the grid forecasts replay to four decimals.
//
// What the comparison cannot settle: a close the live app never passed (its data pass failed) settled its
// outcomes at the next close, in one step of the adaptive levels where the replay takes two; a pass between
// quarter-hours is not on record, so the replay walks every five-minute close. Both show as levels differ.

export const FIDELITY_VERSION = 'fidelity-v1'

export const FIDELITY_LINES = {
  /** The decimals the record keeps a level at, and within which a replayed level must agree. */
  decimals: 4,
  /** The share of the grid forecasts' horizon lines that must replay for the line to hold. */
  share: 0.99
} as const

export type RemainderReason = 'not replayed' | 'bars differ' | 'cell differs' | 'levels differ'

export interface Remainder {
  pair: string
  t: number
  horizon: Horizon
  reason: RemainderReason
  /** The largest absolute difference across the five levels, in percent; null where nothing replayed. */
  maxDiff: number | null
  /** V2's own levels as recorded, and as replayed (to the record's decimals); null where nothing replayed. */
  recorded: number[]
  replayed: number[] | null
}

export interface FidelityHorizon {
  lines: number
  matched: number
  /** Where the P(up) recorded (to three decimals) agrees with the replay's. */
  pUpMatched: number
}

export interface FidelityReport {
  version: string
  /** The span compared, and the closes walked (from the record's first forecast, so that the levels move as they did). */
  from: number
  to: number
  closes: number
  /** The grid forecasts' horizon lines compared, those that replay to four decimals, and their share. */
  lines: number
  matched: number
  share: number
  byHorizon: Partial<Record<Horizon, FidelityHorizon>>
  /** Where the record carries the market's state: the lines compared and agreeing; null where it carries none. */
  states: { lines: number; matched: number } | null
  remainders: Remainder[]
  byReason: Record<RemainderReason, number>
  /** The registered line: the share at or above FIDELITY_LINES.share. */
  passed: boolean
  /** The adaptive levels at the end of the replay, to set beside the record's own table. */
  aci: AciTable | null
}

export interface FidelityInput {
  /** Every pair's bars on file, oldest first. */
  bars: ReadonlyMap<string, readonly ForecastBar[]>
  models: ReadonlyMap<Horizon, FittedHorizon>
  calibration: RunCalibration
  runId: string
  /** The record: every forecast, grid and refresh; the passes, for the pairs each close held; the outcomes,
   * for the close each was settled at where the record says it (OutcomeLine.at, since V7.2 Stage 5). */
  predictions: readonly PredictionLine[]
  passes?: readonly PassLine[]
  outcomes?: readonly (OutcomeLine | MissingOutcomeLine)[]
  /** The span compared; the whole record where absent. The closes before `from` are walked, not compared. */
  from?: number
  to?: number
  /** The calendar: whether a moment is within the hour before a release. None where absent. */
  preEvent?: (tSec: number) => boolean
  /** The adaptive levels the record began with; none where absent. */
  aci?: AciTable | null
  /** The close the live run settled an owed horizon at, where the record shows it was later than its due
   * moment (its bars came late); the due moment where absent. */
  settleAt?: (line: PredictionLine, horizon: Horizon, due: number) => number
  /** Told after each close walked. */
  onClose?: (closedAt: number, done: number, total: number) => void
}

const round = (value: number, decimals: number): number => {
  const scale = 10 ** decimals
  return Math.round(value * scale) / scale
}

/** Whether replayed levels agree with recorded ones to the record's decimals: every level within one unit of
 * the last decimal kept (a figure on a rounding boundary may land a unit apart). */
export function levelsAgree(recorded: readonly number[], replayed: readonly number[], decimals: number = FIDELITY_LINES.decimals): boolean {
  if (recorded.length !== replayed.length) return false
  const unit = 10 ** -decimals
  return recorded.every((value, k) => Math.abs(value - replayed[k]) <= unit + 1e-12)
}

/** The pairs a close's pass held bars for: the last pass at or before it, else the first after. */
function heldAt(passes: readonly PassLine[], closedAt: number): readonly string[] | null {
  if (passes.length === 0) return null
  let held: readonly string[] | null = null
  for (const line of passes) {
    if (line.t <= closedAt) held = line.held
    else break
  }
  return held ?? passes[0].held
}

/** A record replayed through the pure pass and compared on V2's own levels. */
export function replayFidelity(input: FidelityInput): FidelityReport {
  const byClose = new Map<number, PredictionLine[]>()
  for (const line of input.predictions) {
    const mine = byClose.get(line.t)
    if (mine === undefined) byClose.set(line.t, [line])
    else mine.push(line)
  }
  const times = [...byClose.keys()].sort((a, b) => a - b)
  const empty = (): FidelityReport => ({ version: FIDELITY_VERSION, from: 0, to: 0, closes: 0, lines: 0, matched: 0, share: 0, byHorizon: {}, states: null, remainders: [], byReason: { 'not replayed': 0, 'bars differ': 0, 'cell differs': 0, 'levels differ': 0 }, passed: false, aci: null })
  if (times.length === 0) return empty()
  const from = input.from ?? times[0]
  const to = input.to ?? times[times.length - 1]
  const passes = [...(input.passes ?? [])].sort((a, b) => a.t - b.t)
  const pairs = [...input.bars.keys()].sort()
  const state = newPassState()
  state.aci = input.aci ?? null
  let current = new Map<string, PairSeries>()
  let universe: readonly string[] = pairs
  // The close each outcome was settled at, where the record says it was later than its due moment.
  const settled = new Map<string, number>()
  for (const line of input.outcomes ?? []) if (!isMissing(line) && line.at !== undefined && line.at > line.due) settled.set(`${line.id}/${line.h}`, line.at)
  const settleAt = input.settleAt ?? (settled.size === 0 ? undefined : (line: PredictionLine, horizon: Horizon, due: number): number => settled.get(`${line.id}/${horizon}`) ?? due)
  const sources: PassSources = {
    universe: () => universe,
    seriesOf: (symbol) => current.get(symbol) ?? null,
    models: () => input.models,
    calibration: () => input.calibration,
    runId: () => input.runId,
    book: () => undefined,
    depth: () => undefined,
    volumes: () => new Map(),
    news: () => undefined,
    preEvent: input.preEvent ?? ((): boolean => false),
    classVerdict: () => null,
    ...(settleAt === undefined ? {} : { settleAt })
  }
  const report = empty()
  report.from = from
  report.to = to
  const byHorizon: Partial<Record<Horizon, FidelityHorizon>> = {}
  let stateLines = 0
  let stateMatched = 0
  const first = times[0]
  const total = Math.floor((to - first) / FORECAST_BAR_SECONDS) + 1
  let done = 0
  for (let closedAt = first; closedAt <= to; closedAt += FORECAST_BAR_SECONDS) {
    const held = heldAt(passes, closedAt)
    universe = held === null ? pairs : held.filter((symbol) => input.bars.has(symbol))
    current = new Map()
    for (const symbol of universe) {
      const m5 = barsUpTo(input.bars.get(symbol) ?? [], closedAt)
      if (m5.length > 0) current.set(symbol, { m5, h1: coarseBars(m5, '1h', closedAt) })
    }
    const made = pass(state, sources, closedAt, closedAt * 1000 + 10_000)
    report.closes++
    const recordedAt = byClose.get(closedAt) ?? []
    if (closedAt >= from) {
      for (const line of recordedAt) {
        if (line.why !== 'grid') continue
        const prediction = made.status === 'passed' ? state.latest.get(line.pair) : undefined
        if (line.state !== undefined && prediction !== undefined) {
          stateLines++
          if (prediction.marketState === line.state) stateMatched++
        }
        for (const horizon of HORIZONS) {
          const entry = line.h[horizon]
          if (entry === undefined) continue
          const mine = byHorizon[horizon] ?? (byHorizon[horizon] = { lines: 0, matched: 0, pUpMatched: 0 })
          mine.lines++
          report.lines++
          const range = prediction?.horizons[horizon]
          const own = range?.variants.v2
          const recorded = entry.v2 ?? entry.q
          if (prediction === undefined || range === undefined || own === undefined) {
            report.remainders.push({ pair: line.pair, t: line.t, horizon, reason: 'not replayed', maxDiff: null, recorded, replayed: null })
            continue
          }
          if (round(entry.pUp, 3) === round(range.pUp, 3)) mine.pUpMatched++
          const replayed = own.quantilesPct.map((value) => round(value, FIDELITY_LINES.decimals))
          const maxDiff = Math.max(...recorded.map((value, k) => Math.abs(value - replayed[k])))
          if (levelsAgree(recorded, replayed)) {
            mine.matched++
            report.matched++
            continue
          }
          // The bars as held differ where the close's price does, or where the record carries the day's
          // volatility the levels were scaled by (since V7.2 Stage 5) and the replay's is another.
          const rv = state.inputs.get(line.pair)?.rv24h
          const barsDiffer = prediction.currentPrice !== line.price || (line.rv !== undefined && rv !== undefined && Number(rv.toPrecision(6)) !== line.rv)
          const cell = range.ownClass ? prediction.pairClass : 'pooled'
          const reason: RemainderReason = barsDiffer ? 'bars differ' : entry.cell !== cell ? 'cell differs' : 'levels differ'
          report.remainders.push({ pair: line.pair, t: line.t, horizon, reason, maxDiff, recorded, replayed })
        }
      }
    }
    // The record's own forecasts at this close, grid and refresh, owed their outcomes: the levels then take
    // the steps the live engine's took.
    for (const line of recordedAt) owe(state, line)
    state.lastRecordedAt = closedAt
    done++
    input.onClose?.(closedAt, done, total)
  }
  report.byHorizon = byHorizon
  report.states = stateLines > 0 ? { lines: stateLines, matched: stateMatched } : null
  for (const remainder of report.remainders) report.byReason[remainder.reason]++
  report.share = report.lines === 0 ? 0 : report.matched / report.lines
  report.passed = report.lines > 0 && report.share >= FIDELITY_LINES.share
  report.aci = state.aci
  return report
}
