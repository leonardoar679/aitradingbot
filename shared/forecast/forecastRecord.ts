import type { MarketRegime } from '../marketResearch'
import type { Direction } from './direction'
import { HORIZONS, PAIR_CLASSES, type Horizon, type PairClass } from './features'
import { QUANTILE_LEVELS } from './ml/quantile'
import { FORECAST_MODELS, type ForecastModelId } from './models'
import { MARKET_SHOCK_STATES, type MarketShockState } from './marketShock'
import type { ErrorKind, ForecastOutcome } from './outcome'
import { TOUCH_WINDOWS } from './firstTouch'
import type { PricePrediction } from './prediction'
import type { RefreshReason } from './refresh'
import type { PUpSource } from './runCalibration'
import type { TradeDecision } from './tradeDecision'

// THE FORECAST ON RECORD (the V6 document, §26-28, §42, §49 and §94; V6 Stage 7, 13 October 2026):
// forecasts/predictions-YYYY-MM.jsonl and forecasts/outcomes-YYYY-MM.jsonl, a JSON line each, by the
// UTC month of the close a forecast was read at.
//
// WHAT IS RECORDED: every pair's forecast at every quarter-hour close -- its 5-minute, 15-minute and
// 1-hour horizons; its 4- and 24-hour ones on the hour, where a quarter-hour's would mostly repeat
// the last -- and every forecast made again between closes (§39), with the one it replaced. For each
// horizon: the five levels of the forecast shown and of the price-only one beside it (§49), P(up),
// the call, the widths, the skills, the calibration cell, and each model's part (§14); and, where a
// story moved it (V6 Stage 8), the news-moved forecasts' levels (V3, V4), the story and what it did
// (§58). Every figure in percent to four decimals, a probability to three.
//
// AN OUTCOME a line a horizon, written once when it is due (shared/forecast/outcome.ts), with what it
// is judged by repeated, so that a line can be read alone: where the close fell against the shown
// forecast's levels and the price-only one's, and the kinds of error. A horizon whose bars never came
// (a gap at the exchange, the app closed for days) is written as missing, an hour after it was due,
// so that every forecast recorded has an outcome line for each of its horizons.
//
// A PASS a line at each quarter-hour close recorded (forecasts/passes-YYYY-MM.jsonl, since V6 Stage
// 16), naming the pairs the pass held bars for: a pair skipped at a close is then told from one that
// had left the research's pairs, which the forecasts alone cannot tell -- the 12-hour run's history
// gate counted three coins that left them for hours as skipping every close.

export const FORECAST_RECORD_VERSION = 'forecast-record-v1'

/** A month file whose month ended more than this long ago is deleted at start. */
export const FORECAST_RECORD_DAYS = 180

/** The horizons a forecast read at `barTime` is recorded for: the short three at every
 * quarter-hour, all five on the hour. */
export function recordedHorizons(barTime: number): Horizon[] {
  if (barTime % 900 !== 0) return []
  return barTime % 3600 === 0 ? [...HORIZONS] : ['minutes5', 'minutes15', 'hour1']
}

const pct4 = (value: number): number => Math.round(value * 10_000) / 10_000
const p3 = (value: number): number => Math.round(value * 1000) / 1000
const figure = (value: number | null): number | null => (value === null || !Number.isFinite(value) ? null : pct4(value))

export interface HorizonLine {
  q: number[]
  pUp: number
  dir: Direction
  strong: boolean
  uncertain: boolean
  rel: 'LOW' | 'MEDIUM' | 'HIGH'
  width: number
  usualWidth: number
  skill: number | null
  dirSkill: number | null
  cell: PairClass | 'pooled'
  v1: number[]
  v1pUp: number
  parts: [ForecastModelId, number, number][]
  /** Its quality, 0 to 100 (V6 Stage 9). */
  qual?: number
  /** Where a story moved V3 or V4: its levels and the story (V6 Stage 11, for the Lab's variants on the
   * same moments). */
  news?: Partial<Record<'v3' | 'v4', NewsLine>>
  /** V2's own levels, wherever the shown forecast's are not -- a story moved them, a thin book or, since
   * V6.1, Bitcoin's sharp move widened them: what the adaptive V2 levels learn from. */
  v2?: number[]
  /** Where Bitcoin's sharp move widened it (V6.1): Bitcoin's last fifteen minutes in its usual moves, and
   * the outer and inner factors. */
  shock?: [number, number, number]
  /** Where its P(up) came from (V7.1 Stage 2); absent on a forecast recorded before. */
  src?: PUpSource
  /** The path's likely high and low (V7.1 Stage 3): the highs at each of EXCURSION_LEVELS, then the lows,
   * in percent from the close; absent where the run held no excursion calibration. */
  ex?: number[]
  /** When the median is reached (V7.1 Stage 3): its distance in usual hourly moves, the chance within each
   * window (TOUCH_WINDOWS' order), the typical minutes, and whether it is unlikely within the horizon. */
  arr?: { k: number; p: number[]; med: number | null; unlikely: boolean }
}

export interface NewsLine {
  q: number[]
  /** V4's P(up) as the map read it, beside the one shown, for measuring the news's own skill. */
  pUpMapped: number
  story: string
  kind: string
  impact: number
  shift: number
  widen: number
  widenShare: number
  fromLibrary: boolean
}

export interface PredictionLine {
  v: string
  id: string
  pair: string
  /** Unix seconds: the close it was read at; Unix milliseconds: when it was made. */
  t: number
  at: number
  price: number
  cls: PairClass
  regime: MarketRegime
  best: Horizon | null
  run: string
  foldsRun: string
  /** Why it was recorded: the quarter-hour, or made again between closes, and then why and in place
   * of which. */
  why: 'grid' | 'refresh'
  reasons?: RefreshReason[]
  previous?: string
  h: Partial<Record<Horizon, HorizonLine>>
  /** The trade decision at the lead horizon (V6 Stage 9): its side, whether to trade, and why not. */
  trade?: { h: Horizon; side: 'BUY' | 'SELL' | null; ok: boolean; why: string[]; edge: number | null; pProfit: number | null }
  /** The coin's last hour in its usual moves at the close (V6 Stage 11): what the Lab reads a shock by. */
  z1h?: number
  /** The market's shock state at the forecast's moment (V7.1 Stage 11); absent where it could not be read,
   * or on a forecast recorded before. */
  state?: MarketShockState
  /** The day's realized volatility the row was read at (V7.2 Stage 5), to six significant digits: what every
   * level is scaled by, so that a replay from other bars can be told from other arithmetic. Absent on a
   * forecast recorded before. */
  rv?: number
}

/** A forecast's line, carrying the horizons given. */
export function predictionLine(prediction: PricePrediction, horizons: readonly Horizon[], why: PredictionLine['why'], refresh?: { reasons: RefreshReason[]; previous: string | null }, decision?: TradeDecision, row?: { rv24h?: number }): PredictionLine {
  const h: PredictionLine['h'] = {}
  for (const horizon of horizons) {
    const range = prediction.horizons[horizon]
    if (range === undefined) continue
    const v1 = range.variants.v1
    h[horizon] = {
      q: range.quantilesPct.map(pct4),
      pUp: p3(range.pUp),
      dir: range.direction,
      strong: range.strong,
      uncertain: range.uncertain,
      rel: range.reliability,
      width: pct4(range.width80Pct),
      usualWidth: pct4(range.usualWidth80Pct),
      skill: figure(range.skill),
      dirSkill: figure(range.directionSkill),
      cell: range.ownClass ? prediction.pairClass : 'pooled',
      v1: (v1?.quantilesPct ?? []).map(pct4),
      v1pUp: p3(v1?.pUp ?? Number.NaN),
      parts: range.contributions.map((member) => [member.model, p3(member.weight), pct4(member.medianLogPct)]),
      qual: range.quality.score,
      ...(range.pUpSource === undefined ? {} : { src: range.pUpSource }),
      ...(range.excursion === undefined ? {} : { ex: [...range.excursion.highPct, ...range.excursion.lowPct].map(pct4) }),
      ...(range.arrival === undefined
        ? {}
        : { arr: { k: Math.round(range.arrival.k * 1000) / 1000, p: TOUCH_WINDOWS.map((window) => p3(range.arrival!.pWithin[window])), med: range.arrival.medianMinutes === null ? null : Math.round(range.arrival.medianMinutes), unlikely: range.arrival.unlikely } }),
      ...ownLevelsOf(range)
    }
  }
  const z1h = prediction.market?.z1h
  return {
    v: FORECAST_RECORD_VERSION,
    id: prediction.id,
    pair: prediction.pair,
    t: prediction.barTime,
    at: prediction.generatedAt,
    price: prediction.currentPrice,
    cls: prediction.pairClass,
    regime: prediction.regime,
    best: prediction.bestHorizon,
    run: prediction.versions.run,
    foldsRun: prediction.versions.foldsRun,
    why,
    ...(refresh === undefined ? {} : { reasons: refresh.reasons, ...(refresh.previous === null ? {} : { previous: refresh.previous }) }),
    h,
    ...(z1h === undefined || !Number.isFinite(z1h) ? {} : { z1h: Math.round(z1h * 1000) / 1000 }),
    ...(prediction.marketState === undefined || prediction.marketState === null ? {} : { state: prediction.marketState }),
    ...(row?.rv24h === undefined || !Number.isFinite(row.rv24h) ? {} : { rv: Number(row.rv24h.toPrecision(6)) }),
    ...(decision === undefined
      ? {}
      : {
          trade: {
            h: decision.horizon,
            side: decision.side,
            ok: decision.decision === 'TRADE',
            why: decision.reasons.map((reason) => reason.code),
            edge: decision.edge === null ? null : pct4(decision.edge.edgePct),
            pProfit: decision.edge === null ? null : p3(decision.edge.pProfit)
          }
        })
  }
}

/** Where the shown levels are not V2's own: the story that moved them, V2's levels, and Bitcoin's sharp
 * move where it widened them. */
function ownLevelsOf(range: PricePrediction['horizons'][Horizon] & object): Pick<HorizonLine, 'news' | 'v2' | 'shock'> {
  const out: NonNullable<HorizonLine['news']> = {}
  for (const variant of ['v3', 'v4'] as const) {
    const effect = range.news[variant]
    const levels = range.variants[variant]
    if (effect === null || levels === undefined) continue
    out[variant] = {
      q: levels.quantilesPct.map(pct4),
      pUpMapped: p3(levels.pUpMapped),
      story: effect.storyId,
      kind: effect.kind,
      impact: effect.impact,
      shift: pct4(effect.shiftPct),
      widen: pct4(effect.widenPct),
      widenShare: p3(effect.widenShare),
      fromLibrary: effect.fromLibrary
    }
  }
  const v2 = range.variants.v2
  const shock = range.shock ?? null
  const moved = Object.keys(out).length > 0 || range.spreadStretch !== 1 || shock !== null
  return {
    ...(Object.keys(out).length === 0 ? {} : { news: out }),
    ...(moved && v2 !== undefined ? { v2: v2.quantilesPct.map(pct4) } : {}),
    ...(shock === null ? {} : { shock: [p3(shock.btc15), p3(shock.k80), p3(shock.k50)] as [number, number, number] })
  }
}

const isNumbers = (value: unknown, length: number): value is number[] => Array.isArray(value) && value.length === length && value.every((entry) => typeof entry === 'number' && Number.isFinite(entry))

/** A recorded forecast read back; null for a line that is not one. */
export function parsePredictionLine(value: unknown): PredictionLine | null {
  const raw = value as Partial<PredictionLine> | null
  if (typeof raw !== 'object' || raw === null || raw.v !== FORECAST_RECORD_VERSION || typeof raw.id !== 'string' || typeof raw.pair !== 'string') return null
  if (typeof raw.t !== 'number' || typeof raw.at !== 'number' || !(typeof raw.price === 'number' && raw.price > 0) || !PAIR_CLASSES.includes(raw.cls as PairClass)) return null
  if (typeof raw.h !== 'object' || raw.h === null) return null
  for (const [horizon, line] of Object.entries(raw.h)) {
    const entry = line as Partial<HorizonLine> | null
    if (!HORIZONS.includes(horizon as Horizon) || typeof entry !== 'object' || entry === null || !isNumbers(entry.q, QUANTILE_LEVELS.length) || typeof entry.pUp !== 'number') return null
    if (entry.dir !== 'BULLISH' && entry.dir !== 'BEARISH' && entry.dir !== 'NEUTRAL') return null
    if (typeof entry.cell !== 'string' || !Array.isArray(entry.parts) || !entry.parts.every((part) => Array.isArray(part) && FORECAST_MODELS.includes(part[0] as ForecastModelId))) return null
  }
  if (raw.state !== undefined && !MARKET_SHOCK_STATES.includes(raw.state)) return null
  return raw as PredictionLine
}

export interface OutcomeLine {
  v: string
  /** The forecast's id and horizon. */
  id: string
  pair: string
  h: Horizon
  t: number
  due: number
  /** The move, the path's best and worst, in percent; where it fell against the shown levels and the
   * price-only ones, as a string of 0 and 1 from P10 to P90 (1: at or below). */
  move: number
  best: number
  worst: number
  below: string
  v1below: string
  in80: boolean
  in50: boolean
  up: boolean
  dir: Direction
  pUp: number
  cell: PairClass | 'pooled'
  cls: PairClass
  errors: ErrorKind[]
  /** Where a story moved the forecast: where the close fell against V3's and V4's levels, V4's P(up)
   * as the map read it, and the shift. */
  v3below?: string
  v4below?: string
  newsPUp?: number
  newsShift?: number
  /** Where the shown levels were not V2's own (V6.1): where the close fell against V2's, what the
   * adaptive V2 levels learn from. */
  v2below?: string
  /** When the path first reached the median, the P90 and the P10 (V7.1 Stage 3), in seconds after the
   * close; null where it never did within the horizon. Absent on an outcome written before. */
  touch?: [number | null, number | null, number | null]
  /** The close the outcome was settled at (V7.2 Stage 5): its due moment, or a later close where its bars
   * came late. The adaptive levels step once a close by the outcomes settled at it, so a replay needs the
   * moment, not the due. Absent on an outcome written before. */
  at?: number
}

/** A horizon whose outcome could not be read. */
export interface MissingOutcomeLine {
  v: string
  id: string
  pair: string
  h: Horizon
  t: number
  due: number
  missing: string
}

export function missingOutcomeLine(recorded: PredictionLine, horizon: Horizon, due: number, why: string): MissingOutcomeLine {
  return { v: FORECAST_RECORD_VERSION, id: recorded.id, pair: recorded.pair, h: horizon, t: recorded.t, due, missing: why }
}

const flags = (values: readonly boolean[]): string => values.map((value) => (value ? '1' : '0')).join('')

/** An outcome's line from the recorded forecast's horizon and what happened, with the close it was settled at
 * where the engine says it. */
export function outcomeLine(recorded: PredictionLine, horizon: Horizon, outcome: ForecastOutcome, settledAt?: number): OutcomeLine {
  const line = recorded.h[horizon]!
  return {
    v: FORECAST_RECORD_VERSION,
    id: recorded.id,
    pair: recorded.pair,
    h: horizon,
    t: outcome.barTime,
    due: outcome.dueAt,
    ...(settledAt === undefined ? {} : { at: settledAt }),
    move: pct4(outcome.movePct),
    best: pct4(outcome.bestPct),
    worst: pct4(outcome.worstPct),
    below: flags(outcome.below),
    v1below: flags(line.v1.map((level) => outcome.movePct <= level)),
    in80: outcome.inside80,
    in50: outcome.inside50,
    up: outcome.wentUp,
    dir: line.dir,
    pUp: line.pUp,
    cell: line.cell,
    cls: recorded.cls,
    errors: outcome.errors,
    touch: [outcome.touch.target, outcome.touch.upper, outcome.touch.lower],
    ...(line.v2 === undefined ? {} : { v2below: flags(line.v2.map((level) => outcome.movePct <= level)) }),
    ...(line.news?.v3 === undefined ? {} : { v3below: flags(line.news.v3.q.map((level) => outcome.movePct <= level)) }),
    ...(line.news?.v4 === undefined ? {} : { v4below: flags(line.news.v4.q.map((level) => outcome.movePct <= level)), newsPUp: line.news.v4.pUpMapped, newsShift: line.news.v4.shift })
  }
}

/** An outcome line read back, measured or missing; null for a line that is not one. */
export function parseOutcomeLine(value: unknown): OutcomeLine | MissingOutcomeLine | null {
  const raw = value as Partial<OutcomeLine & MissingOutcomeLine> | null
  if (typeof raw !== 'object' || raw === null || raw.v !== FORECAST_RECORD_VERSION || typeof raw.id !== 'string' || !HORIZONS.includes(raw.h as Horizon)) return null
  if (typeof raw.missing === 'string') return raw as MissingOutcomeLine
  if (typeof raw.move !== 'number' || typeof raw.below !== 'string' || !/^[01]{5}$/.test(raw.below) || typeof raw.v1below !== 'string' || !/^([01]{5})?$/.test(raw.v1below)) return null
  return raw as OutcomeLine
}

export const isMissing = (line: OutcomeLine | MissingOutcomeLine): line is MissingOutcomeLine => 'missing' in line

export interface PassLine {
  v: string
  /** The close. */
  t: number
  /** The pairs the pass held bars for, by name. */
  held: string[]
}

export function passLine(t: number, held: Iterable<string>): PassLine {
  return { v: FORECAST_RECORD_VERSION, t, held: [...held].sort() }
}

export function parsePassLine(value: unknown): PassLine | null {
  const raw = value as Partial<PassLine> | null
  if (typeof raw !== 'object' || raw === null || raw.v !== FORECAST_RECORD_VERSION || typeof raw.t !== 'number' || !Number.isFinite(raw.t) || !Array.isArray(raw.held) || !raw.held.every((pair) => typeof pair === 'string')) return null
  return raw as PassLine
}

/** The month file a forecast read at `barTime` belongs in. */
export function recordMonth(barTime: number): string {
  return new Date(barTime * 1000).toISOString().slice(0, 7)
}
