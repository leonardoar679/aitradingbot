import type { ExecutorConfig } from '../ipc'
import { HORIZON_BARS, type Horizon } from './features'
import type { MissingOutcomeLine, OutcomeLine, PredictionLine } from './forecastRecord'
import { liveLab, type LabMetrics } from './lab'

// THE PRICE FORECAST IN A RUN'S REPORT (the V6 document, §45-48 and §113-114; V6 Stage 15, 13 October
// 2026): what the engine forecast over a run's span and how it came out, read from its own record
// (forecasts/predictions-*.jsonl and outcomes-*.jsonl) -- the forecasts made, per horizon the calls'
// accuracy, the ranges' coverage and the median's error, the bull and bear calls' success, the forecasts
// a story moved against the rest, and the forecast trader's paper trades -- with the document's gates for
// a shadow run: forecasts made at their closes and stamped right, a refresh linked to what it replaced,
// every due forecast judged, every notice's sound on file, and no trade on a stale forecast. A span
// shorter than a horizon judges none of it, and says so.

export const RUN_SECTION_VERSION = 'forecast-run-v1'

/** The lines the gates are read by, pinned. */
export const RUN_LINES = {
  /** The record keeps every pair at each quarter-hour close. */
  gridSeconds: 900,
  /** A forecast is made within this long of its close. */
  madeWithinSeconds: 120,
  /** An outcome is written at the first close after it is due: judged missing only past this. */
  outcomeGraceSeconds: 600,
  /** A trade is on a stale forecast when its forecast's close is more than two closes old. */
  staleTradeSeconds: 600,
  /** The trades a profitability conclusion needs (shared/experimentRun.ts VERDICT_LINES). */
  minTrades: 30
} as const

export const SAMPLE_NOTE = 'Sample size is too small for a profitability conclusion.'

export interface RunHorizon {
  outcomes: number
  /** The shown forecast's (V4's) figures over the span's outcomes. */
  metrics: LabMetrics
  /** BULLISH calls and how many ended up; BEARISH calls and how many ended down. */
  bull: { calls: number; right: number }
  bear: { calls: number; right: number }
  /** The forecasts a story moved, and the rest. */
  news: { moved: LabMetrics; unmoved: LabMetrics }
}

export interface ForecastRunGate {
  id: 'forecast_made' | 'forecast_stamped' | 'forecast_refresh' | 'forecast_outcomes' | 'notice_sounds' | 'stale_trades'
  label: string
  status: 'pass' | 'fail' | 'not measured'
  detail: string
}

export interface ForecastRunSection {
  version: string
  fromSec: number
  toSec: number
  predictions: {
    lines: number
    pairs: number
    /** The quarter-hour closes the record holds forecasts at, of those the span holds. */
    gridCloses: number
    expectedGridCloses: number
    refreshes: number
    byReason: Record<string, number>
  }
  horizons: Partial<Record<Horizon, RunHorizon>>
  trades: { opened: number; closed: number; wins: number; netQuote: number }
  /** SAMPLE_NOTE where fewer trades closed than a conclusion needs. */
  sampleNote: string | null
  gates: ForecastRunGate[]
  /** No gate failed; one not measured fails nothing. */
  passed: boolean
}

export interface ForecastRunInput {
  fromSec: number
  toSec: number
  predictions: readonly PredictionLine[]
  outcomes: readonly (OutcomeLine | MissingOutcomeLine)[]
  executors: readonly ExecutorConfig[]
  /** The notices told in the span, with the sound each made where it was recorded. */
  alerts: readonly { at: number; sound?: string }[]
  /** When the section is read: every horizon of the span's forecasts due by then, with time to write
   * it, is wanted judged. The span's end where absent -- a report filed as the run ends; a run read an
   * hour on wants its forecasts' hours too. */
  asOfSec?: number
}

const isMissing = (line: OutcomeLine | MissingOutcomeLine): line is MissingOutcomeLine => 'missing' in line
const within = (time: number, input: { fromSec: number; toSec: number }): boolean => time >= input.fromSec && time <= input.toSec
const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`

/** A horizon's length in seconds. */
export function horizonSeconds(horizon: Horizon): number {
  return HORIZON_BARS[horizon] * 300
}

/** The section over a span, from the record and the executors. */
export function forecastRunSectionOf(input: ForecastRunInput): ForecastRunSection {
  const span = { fromSec: input.fromSec, toSec: input.toSec }
  const lines = input.predictions.filter((line) => within(line.t, span))
  const ids = new Set(lines.map((line) => line.id))
  const judged = input.outcomes.filter((line) => ids.has(line.id))
  const outcomes = judged.filter((line): line is OutcomeLine => !isMissing(line))
  const lab = liveLab(lines, outcomes)

  const horizons: ForecastRunSection['horizons'] = {}
  for (const [horizon, read] of Object.entries(lab.horizons) as [Horizon, NonNullable<(typeof lab.horizons)[Horizon]>][]) {
    const own = outcomes.filter((line) => line.h === horizon)
    const bull = own.filter((line) => line.dir === 'BULLISH')
    const bear = own.filter((line) => line.dir === 'BEARISH')
    horizons[horizon] = {
      outcomes: read.outcomes,
      metrics: read.variants.v4,
      bull: { calls: bull.length, right: bull.filter((line) => line.move > 0).length },
      bear: { calls: bear.length, right: bear.filter((line) => line.move < 0).length },
      news: read.news
    }
  }

  const grid = lines.filter((line) => line.why === 'grid')
  const gridCloses = new Set(grid.map((line) => line.t)).size
  const firstGrid = Math.ceil(span.fromSec / RUN_LINES.gridSeconds) * RUN_LINES.gridSeconds
  const expectedGridCloses = firstGrid > span.toSec ? 0 : Math.floor((span.toSec - firstGrid) / RUN_LINES.gridSeconds) + 1
  const refreshes = lines.filter((line) => line.why === 'refresh')
  const byReason: Record<string, number> = {}
  for (const line of refreshes) for (const reason of line.reasons ?? []) byReason[reason] = (byReason[reason] ?? 0) + 1

  // The forecast trader's paper trades opened in the span, and those of them that closed in it.
  const trades = input.executors.filter((executor) => executor.forecast !== undefined && within(executor.forecast.openedAt, span))
  const closed = trades.filter((executor) => executor.forecast?.result !== undefined && within(executor.forecast.result.closedAt, span))
  const netQuote = closed.reduce((sum, executor) => sum + (executor.forecast?.result?.pnlQuote ?? 0), 0)
  const wins = closed.filter((executor) => (executor.forecast?.result?.pnlQuote ?? 0) > 0).length

  const gates = [
    madeGate(lines.length, gridCloses, expectedGridCloses),
    stampedGate(lines),
    refreshGate(refreshes),
    outcomesGate(lines, judged, Math.max(span.toSec, input.asOfSec ?? span.toSec)),
    soundsGate(input.alerts.filter((alert) => within(alert.at, span))),
    staleGate(trades)
  ]
  return {
    version: RUN_SECTION_VERSION,
    fromSec: span.fromSec,
    toSec: span.toSec,
    predictions: { lines: lines.length, pairs: new Set(lines.map((line) => line.pair)).size, gridCloses, expectedGridCloses, refreshes: refreshes.length, byReason },
    horizons,
    trades: { opened: trades.length, closed: closed.length, wins, netQuote },
    sampleNote: closed.length < RUN_LINES.minTrades ? SAMPLE_NOTE : null,
    gates,
    passed: gates.every((gate) => gate.status !== 'fail')
  }
}

/** Forecasts were made, at each quarter-hour close of the span but at most one at its edges. */
function madeGate(lines: number, gridCloses: number, expected: number): ForecastRunGate {
  const label = 'Forecasts are made at their closes'
  if (expected === 0) return { id: 'forecast_made', label, status: 'not measured', detail: 'The span holds no quarter-hour close.' }
  const ok = lines > 0 && gridCloses >= expected - 1
  return {
    id: 'forecast_made',
    label,
    status: ok ? 'pass' : 'fail',
    detail: `${plural(lines, 'forecast', 'forecasts')} on record, at ${gridCloses} of the span's ${plural(expected, 'quarter-hour close', 'quarter-hour closes')}.`
  }
}

/** Each forecast is stamped with a five-minute close, and was made after it: a quarter-hour's within
 * two minutes, a refresh before the next close but one. */
function stampedGate(lines: readonly PredictionLine[]): ForecastRunGate {
  const label = 'Forecasts carry their close and their making'
  if (lines.length === 0) return { id: 'forecast_stamped', label, status: 'not measured', detail: 'No forecast is on record in the span.' }
  const wrong = lines.filter((line) => {
    const madeSec = line.at / 1000
    if (line.t % 300 !== 0 || madeSec < line.t) return true
    return line.why === 'grid' ? madeSec > line.t + RUN_LINES.madeWithinSeconds : madeSec > line.t + 600
  })
  return {
    id: 'forecast_stamped',
    label,
    status: wrong.length === 0 ? 'pass' : 'fail',
    detail: wrong.length === 0 ? `Each of the ${plural(lines.length, 'forecast', 'forecasts')} is stamped with its close and was made after it, in time.` : `${plural(wrong.length, 'forecast is', 'forecasts are')} stamped wrong or made late, the first ${wrong[0].pair} at ${wrong[0].t}.`
  }
}

/** Each forecast made again between closes says why, and which it replaced. */
function refreshGate(refreshes: readonly PredictionLine[]): ForecastRunGate {
  const label = 'A refresh names its reason and what it replaced'
  if (refreshes.length === 0) return { id: 'forecast_refresh', label, status: 'not measured', detail: 'Nothing triggered a refresh in the span.' }
  const unlinked = refreshes.filter((line) => (line.reasons ?? []).length === 0 || typeof line.previous !== 'string' || line.previous === '')
  return {
    id: 'forecast_refresh',
    label,
    status: unlinked.length === 0 ? 'pass' : 'fail',
    detail: unlinked.length === 0 ? `Each of the ${plural(refreshes.length, 'refresh', 'refreshes')} names its reason and the forecast it replaced.` : `${plural(unlinked.length, 'refresh names', 'refreshes name')} no reason or no forecast replaced.`
  }
}

/** Every horizon of every forecast that fell due by the time the section is read, with time to write
 * it, was judged: an outcome, or a line saying why it could not be. */
function outcomesGate(lines: readonly PredictionLine[], judged: readonly (OutcomeLine | MissingOutcomeLine)[], asOfSec: number): ForecastRunGate {
  const label = 'Every due forecast is judged'
  const written = new Set(judged.map((line) => `${line.id}|${line.h}`))
  const due: string[] = []
  for (const line of lines) {
    for (const horizon of Object.keys(line.h) as Horizon[]) {
      if (line.t + horizonSeconds(horizon) + RUN_LINES.outcomeGraceSeconds <= asOfSec) due.push(`${line.id}|${horizon}`)
    }
  }
  if (due.length === 0) return { id: 'forecast_outcomes', label, status: 'not measured', detail: 'No forecast of the span has fallen due with time to judge it.' }
  const unjudged = due.filter((key) => !written.has(key))
  const missing = judged.filter((line) => isMissing(line)).length
  return {
    id: 'forecast_outcomes',
    label,
    status: unjudged.length === 0 ? 'pass' : 'fail',
    detail:
      unjudged.length === 0
        ? `Each of the ${plural(due.length, 'due horizon', 'due horizons')} has its outcome${missing > 0 ? `, ${missing} of them a line saying why it could not be judged` : ''}.`
        : `${plural(unjudged.length, 'due horizon has', 'due horizons have')} no outcome, the first ${unjudged[0].replace('|', ' at ')}.`
  }
}

/** Every notice told in the span recorded the sound it made (V6 Stage 13). */
function soundsGate(alerts: readonly { sound?: string }[]): ForecastRunGate {
  const label = "Every notice's sound is on file"
  if (alerts.length === 0) return { id: 'notice_sounds', label, status: 'not measured', detail: 'No notice was told in the span.' }
  const silent = alerts.filter((alert) => typeof alert.sound !== 'string').length
  return {
    id: 'notice_sounds',
    label,
    status: silent === 0 ? 'pass' : 'fail',
    detail: silent === 0 ? `Each of the ${plural(alerts.length, 'notice', 'notices')} records its sound.` : `${plural(silent, 'notice records', 'notices record')} no sound.`
  }
}

/** No forecast trade was opened on a forecast more than two closes old, or past its plan's time. */
function staleGate(trades: readonly ExecutorConfig[]): ForecastRunGate {
  const label = 'No trade on a stale forecast'
  if (trades.length === 0) return { id: 'stale_trades', label, status: 'not measured', detail: 'The forecast trader opened nothing in the span.' }
  const stale = trades.filter((executor) => {
    const mark = executor.forecast!
    return mark.openedAt - mark.barTime > RUN_LINES.staleTradeSeconds || mark.openedAt > mark.plan.validUntil
  })
  return {
    id: 'stale_trades',
    label,
    status: stale.length === 0 ? 'pass' : 'fail',
    detail: stale.length === 0 ? `Each of the ${plural(trades.length, 'paper trade', 'paper trades')} the forecast trader opened followed a forecast of its own close and plan.` : `${plural(stale.length, 'paper trade followed', 'paper trades followed')} a stale forecast.`
  }
}
