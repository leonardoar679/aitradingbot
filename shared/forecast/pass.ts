import { computeAtr } from '../atr'
import { executionQuality, isStale, bookSpreadPct, type LiveBook, type LiveDepth, type LiveState } from '../liveMarket'
import type { MarketRegime } from '../marketResearch'
import { cellKey, emptyAciTable, levelsOf, stepAciTable, type AciTable, type CellKey } from './aciTable'
import { FORECAST_BAR_SECONDS, lastClosedBarTime, type ForecastBar } from './bars'
import { driftOf, pruneDrift, type DriftReading } from './drift'
import { FEATURE_NAMES, HORIZONS, crossSectionAt, endsAt, featuresAt, quickAt, type Horizon, type PairClass, type PairQuick, type PairSeries } from './features'
import { isMissing, missingOutcomeLine, outcomeLine, passLine, predictionLine, recordedHorizons, type MissingOutcomeLine, type OutcomeLine, type PassLine, type PredictionLine } from './forecastRecord'
import { MARKET_SHOCK_LINES, btcTimelineOf, marketShockStateOf, shockMomentsOf, type MarketShockState, type ShockMoment } from './marketShock'
import { predictDirection, predictExcursion, predictHorizon, type DirectionModelId, type FittedHorizon, type ForecastModelId } from './models'
import { newsSkillOf } from './newsEffect'
import { breakoutAt, classKeyOf, setupOf, type ClassVerdict } from './opportunityClass'
import { dueAt, outcomeOf } from './outcome'
import { makePrediction, type PredictionNews, type PricePrediction } from './prediction'
import { rangeDriversFor, type RangeDriver } from './rangeDrivers'
import { funnel, rankOf, type ForecastRanking, type RankedForecast } from './ranking'
import { acrossMedian, refreshReasons, type RefreshReason } from './refresh'
import { cellOf, type RunCalibration } from './runCalibration'
import { SHOCK_LINES, liveBtcMove } from './shock'
import type { EngineState } from './status'
import { decideTrade, liveOfBook, type TradeDecision } from './tradeDecision'
import { moveRatesOf, type MoveRates } from './moveRates'

// THE FORECAST PASS AS PURE FUNCTIONS (V7.2 Stage 5, 18 October 2026). Everything the live forecast
// decides -- every pair forecast at a close, the outcomes due written and the adaptive levels moved, a
// pair's trade decision and the ranking, a forecast made again between closes -- is arithmetic on what
// it is handed: the bars as held, the models and the calibration in use, the live book, the news, the
// calendar, the class verdicts, and the moment. The forecast service hands those in as PassSources, keeps
// one PassState, and does what these functions cannot: it reads the files, writes the lines they return,
// tells the window and the notices. A replay hands the same functions a record's bars, a run's models and
// no live book, and must get the same forecasts to four decimals (shared/forecast/fidelity.ts): that
// check is the regression test of this move, since nothing here was meant to change what the app does.
//
// What a function returns is what the service must write or tell; what it changes is in the state
// handed to it and nothing else. No clock is read here: every function takes its moment.
//
// IT FORECASTS FROM PUBLIC MARKET DATA AND NOTHING ELSE. No key, no model of anyone else's, no order.

export const PASS_VERSION = 'pass-v1'

/** The closes a pair's usual spread is the median of, and the fewest it is read from (V7.1 Stage 11). */
export const SPREAD_CLOSES = 24
export const SPREAD_MIN_CLOSES = 6
/** The stake an execution's quality is read for, in the quote. */
export const RANKING_STAKE = 100
/** How long past due an outcome waits for its bars before it is written as missing. */
export const MISSING_AFTER_SEC = 3600
/** How long the stream's reading of Bitcoin stands for the close's: the stream reads it every five seconds. */
export const LIVE_BTC_MS = 15_000
/** The five-minute bars the ATR is read over (shared/atr.ts), and the ATR of the last of them in percent
 * of the close: what a trade plan's entry zone and nearest stop are measured in (V6 Stage 12). */
export const ATR_BARS = 14

const RV24 = FEATURE_NAMES.indexOf('rv_24h')
const RATIO = FEATURE_NAMES.indexOf('rv_ratio')
const Z1H = FEATURE_NAMES.indexOf('z_1h')
const BREADTH1H = FEATURE_NAMES.indexOf('breadth_1h')
const Z15 = FEATURE_NAMES.indexOf('z_15m')
const VOL1H = FEATURE_NAMES.indexOf('vol_ratio_1h')

/** What a pass reads. Every source is read at the moment it is asked, so that a replay can hand the
 * record's bars at each close, a run's models, no live book and no news. */
export interface PassSources {
  /** The pairs the forecast reads, and each one's bars as held; null before a pair is read. */
  universe(): readonly string[]
  seriesOf(symbol: string): PairSeries | null
  /** The models in use, their calibration and the run they belong to; empty or null while waited for. */
  models(): ReadonlyMap<Horizon, FittedHorizon>
  calibration(): RunCalibration | null
  runId(): string | null
  /** The live book and depth of a pair as the stream holds them; undefined where it holds none. */
  book(symbol: string): LiveBook | undefined
  depth(symbol: string): LiveDepth | undefined
  /** Each pair's day volume in the quote, for the ranking. */
  volumes(): ReadonlyMap<string, number | null>
  /** A coin's news as the forecast reads it; undefined where there is none. */
  news(symbol: string): PredictionNews | undefined
  /** Whether a moment falls within the hour before a scheduled release (the macro calendar). */
  preEvent(tSec: number): boolean
  /** How each opportunity class stands; null until judged, and then no class is. */
  classVerdict(): ((key: string) => ClassVerdict) | null
  /** The close an owed horizon is settled at: its due moment, unless the source names a later one -- a
   * replay following a record whose bars came late, so that the levels take the steps the live run's took.
   * Absent on the live service. */
  settleAt?(line: PredictionLine, horizon: Horizon, due: number): number
}

/** What a close gave a pair, kept for forecasting it again before the next. */
export interface PairInput {
  models: Partial<Record<Horizon, Record<ForecastModelId, number[]>>>
  /** Each horizon's direction models' raw chances of up at the close (V7.1 Stage 2). */
  direction: Partial<Record<Horizon, Record<DirectionModelId, number>>>
  /** Each horizon's excursion levels at the close, in usual moves (V7.1 Stage 3). */
  excursion: Partial<Record<Horizon, { high: number[]; low: number[] }>>
  rv24h: number
  rvRatio: number
  cls: PairClass
  regime: MarketRegime
  price: number
  barTime: number
  usualMinuteVolume: number | null
  /** The coin's last hour in its usual moves, the market's breadth over it, and its volume against its
   * usual hour. */
  market: { z1h: number; breadth1h: number; volRatio1h: number; atr5mPct: number | null }
  /** Whether the close broke the day before's range: an opportunity's setup (V6 Stage 12). */
  breakout: boolean
  /** What moved each horizon's size reading most (§36). */
  drivers: Partial<Record<Horizon, RangeDriver[]>>
  /** How often the coin moved over its last ninety days (V7.2-R Stage 3), read once an hour. */
  moveRates: MoveRates | null
}

export interface OwedForecast {
  line: PredictionLine
  horizons: Set<Horizon>
}

export interface NewsOutcome {
  h: Horizon
  due: number
  pUp: number
  up: boolean
}

/** The market's state and figures as last read, at the moment they were: what the status shows. */
export type MarketReading = NonNullable<EngineState['market']>

/** Everything the pass keeps from one moment to the next. */
export interface PassState {
  inputs: Map<string, PairInput>
  latest: Map<string, PricePrediction>
  decisions: Map<string, TradeDecision>
  ranking: ForecastRanking
  lastRefreshAt: Map<string, number>
  /** Recorded forecasts with horizons still owed an outcome, by id. */
  owed: Map<string, OwedForecast>
  aci: AciTable | null
  /** A pair's spread at the last closes, in percent, where the live book held it then. */
  spreads: Map<string, number[]>
  /** Each horizon's outcomes of the last day, for the live drift gate (V7.1 Stage 13). */
  driftOutcomes: Map<Horizon, { due: number; in80: boolean }[]>
  /** Whether a pair's live price stood across its expected price against its call at the last reading. */
  acrossBefore: Map<string, boolean>
  /** Bitcoin's last fifteen minutes and its hour in its usual moves at the last close, with the day's
   * volatility they are measured by; and, read from its live minutes, the latest. */
  closeBtc: { t: number; btc15: number | null; btc1h: number | null; rv24h: number | null }
  liveBtc: { btc15: number; btc1h: number | null; atMs: number } | null
  /** The market at the last close (V7.1 Stage 11): the breadth of its last fifteen minutes, its volume
   * against its usual, and the shock moments of the four hours before, from Bitcoin's bars. */
  closeMarket: { breadth15: number; volAcc15: number; moments: ShockMoment[] } | null
  lastRecordedAt: number
  /** The news-moved forecasts' outcomes, for their own skill. */
  newsOutcomes: NewsOutcome[]
  newsSkill: Partial<Record<Horizon, number | null>>
  /** Each pair's move rates and the hour they were read at (V7.2-R Stage 3): read again the next hour. */
  moveRates: Map<string, { hour: number; rates: MoveRates | null }>
}

export function newPassState(): PassState {
  return {
    inputs: new Map(),
    latest: new Map(),
    decisions: new Map(),
    ranking: { at: null, ranked: [], top10: [], top3: [] },
    lastRefreshAt: new Map(),
    owed: new Map(),
    aci: null,
    spreads: new Map(),
    driftOutcomes: new Map(),
    acrossBefore: new Map(),
    closeBtc: { t: 0, btc15: null, btc1h: null, rv24h: null },
    liveBtc: null,
    closeMarket: null,
    lastRecordedAt: 0,
    newsOutcomes: [],
    newsSkill: {},
    moveRates: new Map()
  }
}

/** The live book of a pair the stream holds, while it is fresh: its mid and its spread. */
export function liveBookOf(sources: Pick<PassSources, 'book'>, symbol: string, nowMs: number): { mid: number; spreadPct: number | null } | null {
  const book = sources.book(symbol)
  if (book === undefined || isStale(book, nowMs) || !(book.bid > 0) || !(book.ask > 0)) return null
  return { mid: (book.bid + book.ask) / 2, spreadPct: bookSpreadPct(book) }
}

/** A pair's usual spread, in percent: the median of its spreads at the last closes, from at least six. */
export function usualSpreadOf(state: Pick<PassState, 'spreads'>, symbol: string): number | null {
  const held = state.spreads.get(symbol) ?? []
  if (held.length < SPREAD_MIN_CLOSES) return null
  const sorted = [...held].sort((a, b) => a - b)
  const middle = sorted.length >> 1
  return sorted.length % 2 === 1 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2
}

/** The market's state from Bitcoin's figures given, with the close's breadth, volume and shock moments;
 * null before a close read them. Before a scheduled release (V7.1 Stage 12): the calendar's word, within
 * the hour before it. */
export function marketStateOf(state: Pick<PassState, 'closeMarket'>, sources: Pick<PassSources, 'preEvent'>, btc15: number | null, btc1h: number | null, tSec: number): MarketShockState | null {
  if (state.closeMarket === null || btc15 === null || btc1h === null) return null
  return marketShockStateOf({ t: tSec, btc15, btc1h, breadth15: state.closeMarket.breadth15, volAcc15: state.closeMarket.volAcc15 }, state.closeMarket.moments, { preEvent: sources.preEvent(tSec) })
}

/** Bitcoin's last fifteen minutes now: the stream's reading while it is fresh, the close's otherwise. */
export function currentBtc15(state: Pick<PassState, 'closeBtc' | 'liveBtc'>, nowMs: number): number | null {
  return state.liveBtc !== null && nowMs - state.liveBtc.atMs <= LIVE_BTC_MS ? state.liveBtc.btc15 : state.closeBtc.btc15
}

/** The market's state now: from the stream's reading while it is fresh, at the moment it was read; the
 * close's otherwise, at the close. */
export function currentMarketState(state: Pick<PassState, 'closeBtc' | 'liveBtc' | 'closeMarket'>, sources: Pick<PassSources, 'preEvent'>, nowMs: number): MarketShockState | null {
  const fresh = state.liveBtc !== null && nowMs - state.liveBtc.atMs <= LIVE_BTC_MS
  return fresh ? marketStateOf(state, sources, state.liveBtc!.btc15, state.liveBtc!.btc1h ?? state.closeBtc.btc1h, Math.floor(state.liveBtc!.atMs / 1000)) : marketStateOf(state, sources, state.closeBtc.btc15, state.closeBtc.btc1h, state.closeBtc.t)
}

/** What the status shows of the market: its state and figures as read, at the moment they were. */
export function marketReadingOf(state: Pick<PassState, 'closeMarket'>, sources: Pick<PassSources, 'preEvent'>, btc15: number | null, btc1h: number | null, atSec: number): MarketReading | null {
  const marketState = marketStateOf(state, sources, btc15, btc1h, atSec)
  return marketState === null || state.closeMarket === null ? null : { state: marketState, btc15: btc15 as number, btc1h: btc1h as number, breadth15: state.closeMarket.breadth15, volAcc15: state.closeMarket.volAcc15, readAt: atSec }
}

/** Whether any horizon's rule on Bitcoin's sharp moves is in use: without one, its crossing changes nothing. */
export function shockRuleInUse(calibration: RunCalibration | null): boolean {
  return calibration !== null && HORIZONS.some((horizon) => calibration.horizons[horizon]?.shock?.adopted === true && calibration.horizons[horizon]?.marketShock?.chosen !== 'states' && calibration.horizons[horizon]?.marketShock?.chosen !== 'none')
}

/** Whether any horizon widens by the market's states (V7.1 Stage 11): without one, a change of state
 * changes nothing. */
export function stateRulesInUse(calibration: RunCalibration | null): boolean {
  return (
    calibration !== null &&
    HORIZONS.some((horizon) => {
      const rules = calibration.horizons[horizon]?.marketShock
      return rules !== undefined && rules.chosen === 'states' && Object.values(rules.byState).some((rule) => rule.adopted)
    })
  )
}

/** A pair's forecast now, from what its close gave it and what has changed since. */
export function predictionFor(state: PassState, sources: PassSources, symbol: string, nowMs: number): PricePrediction | null {
  const input = state.inputs.get(symbol)
  const calibration = sources.calibration()
  const runId = sources.runId()
  if (input === undefined || calibration === null || runId === null) return null
  return makePrediction({
    pair: symbol,
    pairClass: input.cls,
    regime: input.regime,
    barTime: input.barTime,
    price: input.price,
    generatedAt: nowMs,
    rv24h: input.rv24h,
    rvRatio: input.rvRatio,
    spreadPct: liveBookOf(sources, symbol, nowMs)?.spreadPct ?? null,
    market: input.market,
    drivers: input.drivers,
    models: input.models,
    direction: input.direction,
    excursion: input.excursion,
    moveRates: input.moveRates,
    calibration,
    levels: (horizon, variant, cell) => levelsOf(state.aci, cellKey(horizon, variant, cell)),
    news: sources.news(symbol),
    btc15: currentBtc15(state, nowMs),
    marketState: currentMarketState(state, sources, nowMs),
    runId,
    foldsRunId: calibration.runId
  })
}

/** Each horizon's live drift from the last day's outcomes (V7.1 Stage 13). */
export function driftAt(state: Pick<PassState, 'driftOutcomes'>, horizon: Horizon, nowSec: number): DriftReading {
  return driftOf(state.driftOutcomes.get(horizon) ?? [], nowSec)
}

/** Every horizon's drift with an outcome in the window, the outcomes outside it let go. */
export function driftReadings(state: Pick<PassState, 'driftOutcomes'>, nowSec: number): NonNullable<EngineState['drift']> {
  const out: NonNullable<EngineState['drift']> = {}
  for (const horizon of HORIZONS) {
    const held = state.driftOutcomes.get(horizon)
    if (held === undefined) continue
    const pruned = pruneDrift(held, nowSec)
    state.driftOutcomes.set(horizon, pruned)
    if (pruned.length > 0) out[horizon] = driftAt(state, horizon, nowSec)
  }
  return out
}

/** A pair's trade decision at its lead horizon -- its best, or the hour's -- from its forecast and the
 * live book. The class a trade on its side falls in (shared/forecast/opportunityClass.ts) is judged by the
 * verdicts handed in; not judged before they are. */
export function decisionFor(state: Pick<PassState, 'inputs' | 'driftOutcomes'>, sources: Pick<PassSources, 'book' | 'classVerdict'>, prediction: PricePrediction, nowMs: number): TradeDecision {
  const horizon = prediction.bestHorizon ?? (prediction.horizons.hour1 !== undefined ? 'hour1' : (Object.keys(prediction.horizons)[0] as keyof PricePrediction['horizons']))
  const live = liveOfBook(sources.book(prediction.pair))
  const range = prediction.horizons[horizon]
  const judge = sources.classVerdict()
  const classOf =
    judge === null || range === undefined
      ? null
      : (side: 'BUY' | 'SELL'): { key: string; verdict: ClassVerdict } => {
          const setup = setupOf({ side, story: range.news.v4 !== null || range.news.v3 !== null, breakout: state.inputs.get(prediction.pair)?.breakout === true, prior: prediction.market?.z1h ?? null, regime: prediction.regime })
          const key = classKeyOf(prediction.pairClass, horizon, setup)
          return { key, verdict: judge(key) }
        }
  // The live drift gate (V7.1 Stage 13): the horizon's last day of outcomes, as the forecast's own record holds them.
  return decideTrade({ prediction, horizon, nowMs, live, classOf, drift: driftAt(state, horizon, Math.floor(nowMs / 1000)) })
}

export function atr5mPctAt(bars: readonly ForecastBar[]): number | null {
  if (bars.length < ATR_BARS + 1) return null
  const atr = computeAtr([...bars], ATR_BARS)
  const last = atr[atr.length - 1]
  const close = bars[bars.length - 1].close
  return Number.isFinite(last) && last > 0 && close > 0 ? (last / close) * 100 : null
}

/** Every pair's decision, and the ranking of them all. */
export function rankAll(state: PassState, sources: PassSources, nowMs: number): void {
  const volumes = sources.volumes()
  const ranked: RankedForecast[] = []
  for (const prediction of state.latest.values()) {
    const decision = decisionFor(state, sources, prediction, nowMs)
    state.decisions.set(prediction.pair, decision)
    const book = sources.book(prediction.pair) ?? null
    const execution = book === null ? null : executionQuality({ book, depth: sources.depth(prediction.pair) ?? null, side: decision.side === 'SELL' ? 'sell' : 'buy', stakeQuote: RANKING_STAKE, nowMs }).score
    ranked.push({ ...rankOf({ prediction, horizon: decision.horizon, edge: decision.edge, quoteVolume24h: volumes.get(prediction.pair) ?? null, execution }), decision })
  }
  const ordered = funnel(ranked)
  state.ranking = {
    at: state.latest.values().next().value?.barTime ?? null,
    ranked: ordered.ranked as RankedForecast[],
    top10: ordered.top10.map((entry) => entry.pair),
    top3: ordered.top3.map((entry) => entry.pair)
  }
}

/** A recorded forecast owed an outcome for each of its horizons. */
export function owe(state: Pick<PassState, 'owed'>, line: PredictionLine): void {
  const horizons = new Set(Object.keys(line.h) as Horizon[])
  if (horizons.size > 0) state.owed.set(line.id, { line, horizons })
}

export const pendingCount = (state: Pick<PassState, 'owed'>): number => [...state.owed.values()].reduce((sum, entry) => sum + entry.horizons.size, 0)

/** The pairs outcomes are still owed for. */
export const owedPairs = (state: Pick<PassState, 'owed'>): string[] => [...new Set([...state.owed.values()].map((entry) => entry.line.pair))]

/** What a close's settling leaves to write and to tell. */
export interface Settled {
  /** The outcome lines, measured and missing, in the order made; none where nothing was due. */
  lines: (OutcomeLine | MissingOutcomeLine)[]
  measured: number
  /** The news-moved forecasts' outcomes among them, for their own file. */
  newsTouched: NewsOutcome[]
  /** Whether the adaptive levels moved: the table in the state is then to be written. */
  aciMoved: boolean
  /** Each horizon's live drift after these outcomes; null where nothing was settled and it is not told. */
  drift: NonNullable<EngineState['drift']> | null
}

/** The outcomes due by the close `closedAt`, each once; the adaptive levels moved by them, once for the
 * moment. The state's owed forecasts, drift outcomes, news outcomes and table move; the lines come back
 * to be written. */
export function settle(state: PassState, sources: Pick<PassSources, 'seriesOf' | 'calibration' | 'settleAt'>, closedAt: number): Settled {
  const lines: (OutcomeLine | MissingOutcomeLine)[] = []
  for (const [id, entry] of state.owed) {
    for (const horizon of [...entry.horizons]) {
      const due = dueAt(entry.line.t, horizon)
      if ((sources.settleAt?.(entry.line, horizon, due) ?? due) > closedAt) continue
      const recorded = entry.line.h[horizon]!
      const series = sources.seriesOf(entry.line.pair)
      const path = series === null ? [] : series.m5.filter((bar) => bar.time >= entry.line.t && bar.time < due)
      const outcome = outcomeOf(
        { horizon, quantilesPct: recorded.q, pUp: recorded.pUp, direction: recorded.dir, width80Pct: recorded.width, usualWidth80Pct: recorded.usualWidth, newsShiftPct: recorded.news?.v4?.shift ?? 0 },
        entry.line.t,
        entry.line.price,
        path
      )
      if (outcome !== null) lines.push(outcomeLine(entry.line, horizon, outcome, closedAt))
      else if (closedAt - due >= MISSING_AFTER_SEC) lines.push(missingOutcomeLine(entry.line, horizon, due, path.length === 0 ? 'no bars' : `${path.length} of its bars`))
      else continue
      entry.horizons.delete(horizon)
    }
    if (entry.horizons.size === 0) state.owed.delete(id)
  }
  if (lines.length === 0) return { lines, measured: 0, newsTouched: [], aciMoved: false, drift: null }
  const measured = lines.filter((line): line is OutcomeLine => !isMissing(line))
  // The last day's outcomes by horizon, for the drift gate (V7.1 Stage 13).
  for (const line of measured) state.driftOutcomes.set(line.h, [...(state.driftOutcomes.get(line.h) ?? []), { due: line.due, in80: line.in80 }])
  const drift = driftReadings(state, closedAt)
  const calibration = sources.calibration()
  if (calibration === null || measured.length === 0) return { lines, measured: measured.length, newsTouched: [], aciMoved: false, drift }
  if (state.aci === null || state.aci.calibrationRun !== calibration.runId) state.aci = emptyAciTable(calibration.runId)
  const steps: { key: CellKey; below: boolean[] }[] = []
  for (const line of measured) {
    // V2's levels learn from V2's own, where the shown were moved off them (V6.1): a story's, a thin book's
    // or Bitcoin's sharp move's widening teaches them nothing.
    steps.push({ key: cellKey(line.h, 'v2', line.cell), below: [...(line.v2below ?? line.below)].map((flag) => flag === '1') })
    if (line.v1below.length === 5) steps.push({ key: cellKey(line.h, 'v1', line.cell), below: [...line.v1below].map((flag) => flag === '1') })
    // The news-moved forecasts' levels learn only from the outcomes a story moved.
    if (line.v3below !== undefined) steps.push({ key: cellKey(line.h, 'v3', line.cell), below: [...line.v3below].map((flag) => flag === '1') })
    if (line.v4below !== undefined) steps.push({ key: cellKey(line.h, 'v4', line.cell), below: [...line.v4below].map((flag) => flag === '1') })
  }
  const newsTouched = measured.filter((line) => line.newsPUp !== undefined).map((line) => ({ h: line.h, due: line.due, pUp: line.newsPUp!, up: line.up }))
  if (newsTouched.length > 0) {
    state.newsOutcomes.push(...newsTouched)
    state.newsSkill = newsSkillOf(state.newsOutcomes, closedAt)
  }
  state.aci = stepAciTable(state.aci, steps, closedAt)
  return { lines, measured: measured.length, newsTouched, aciMoved: true, drift }
}

/** What a pass at a close made, or what it waits for. */
export type PassResult =
  | { status: 'waiting'; waitingFor: 'models' | 'calibration' | 'bars' }
  | {
      status: 'passed'
      settled: Settled
      /** The market as read at the close, for the status; null where Bitcoin's figures could not be read. */
      market: MarketReading | null
      /** The forecasts to record: every pair's at a quarter-hour not recorded yet, none otherwise. */
      predictions: PredictionLine[]
      /** The pass line to record beside them: the pairs the pass held bars for. */
      pass: PassLine | null
    }

/** Every pair forecast at a close, from the bars closed by then: the outcomes due settled first, so that
 * the forecasts read the levels they moved; then the forecasts, the decisions and the ranking. The lines to
 * record come back; `recorded` owes them once they are written. */
export function pass(state: PassState, sources: PassSources, closedAt: number, nowMs: number): PassResult {
  const fitted = sources.models()
  const calibration = sources.calibration()
  const waitingFor = fitted.size === 0 ? 'models' : calibration === null ? 'calibration' : null
  if (waitingFor !== null) return { status: 'waiting', waitingFor }
  const market = new Map<string, PairSeries>()
  for (const symbol of sources.universe()) {
    const series = sources.seriesOf(symbol)
    if (series !== null) market.set(symbol, series)
  }
  const btc = market.get('BTCUSDT')
  const quick = new Map<string, PairQuick>()
  for (const [symbol, series] of market) {
    const read = quickAt(series, closedAt)
    if (read !== null) quick.set(symbol, read)
  }
  const cross = btc === undefined ? null : crossSectionAt(quick)
  if (btc === undefined || cross === null) return { status: 'waiting', waitingFor: 'bars' }
  state.inputs.clear()
  state.closeBtc = { t: closedAt, btc15: null, btc1h: null, rv24h: null }
  // The market at the close (V7.1 Stage 11): its breadth and volume over the last fifteen minutes, and the
  // shock moments of the four hours before, read from Bitcoin's bars at every five-minute close.
  state.closeMarket = { breadth15: cross.breadth15m, volAcc15: cross.volAcc15m, moments: shockMomentsOf(btcTimelineOf(btc, closedAt - MARKET_SHOCK_LINES.recoveryHours * 3600 - FORECAST_BAR_SECONDS, closedAt - FORECAST_BAR_SECONDS)) }
  for (const [symbol, series] of market) {
    // A row needs the bar that closed at the close (featuresAt); its close is the forecast's price.
    const row = featuresAt({ symbol, series, btcH1: btc.h1, cross, tSec: closedAt })
    if (row === null) continue
    if (symbol === 'BTCUSDT') state.closeBtc = { t: closedAt, btc15: row[Z15], btc1h: row[Z1H], rv24h: row[RV24] }
    // The pair's spread at the close, for its usual spread (refresh reason `spread`).
    const spread = liveBookOf(sources, symbol, nowMs)?.spreadPct
    if (spread !== null && spread !== undefined && Number.isFinite(spread)) state.spreads.set(symbol, [...(state.spreads.get(symbol) ?? []), spread].slice(-SPREAD_CLOSES))
    const at = endsAt(series, closedAt).m5
    const bar = series.m5[at - 1]
    const models: PairInput['models'] = {}
    const direction: PairInput['direction'] = {}
    const excursion: PairInput['excursion'] = {}
    const drivers: PairInput['drivers'] = {}
    const cls = cross.classes.get(symbol)!
    for (const horizon of HORIZONS) {
      const model = fitted.get(horizon)
      if (model === undefined) continue
      models[horizon] = predictHorizon(model, row)
      direction[horizon] = predictDirection(model, row)
      excursion[horizon] = predictExcursion(model, row)
      const variant = calibration?.horizons[horizon]?.variants.v2
      drivers[horizon] = rangeDriversFor(model, variant === undefined ? [] : cellOf(variant, cls).weights, row)
    }
    const hour = series.m5.slice(Math.max(0, at - 12), at)
    // How often the coin moved enough to pay for a trade, over its last ninety days: once an hour a pair.
    const rateHour = Math.floor(closedAt / 3600)
    const heldRates = state.moveRates.get(symbol)
    const moveRates = heldRates !== undefined && heldRates.hour === rateHour ? heldRates.rates : moveRatesOf(series.m5, closedAt)
    state.moveRates.set(symbol, { hour: rateHour, rates: moveRates })
    const usualMinuteVolume = hour.length === 12 ? hour.reduce((sum, entry) => sum + entry.volume, 0) / 60 : null
    state.inputs.set(symbol, {
      models,
      direction,
      excursion,
      rv24h: row[RV24],
      rvRatio: row[RATIO],
      cls,
      regime: cross.regime,
      price: bar.close,
      barTime: closedAt,
      usualMinuteVolume,
      market: { z1h: row[Z1H], breadth1h: row[BREADTH1H], volRatio1h: row[VOL1H], atr5mPct: atr5mPctAt(series.m5.slice(Math.max(0, at - ATR_BARS - 1), at)) },
      breakout: breakoutAt(series.m5.slice(Math.max(0, at - 290), at), closedAt),
      drivers,
      moveRates
    })
  }
  const settled = settle(state, sources, closedAt)
  state.latest.clear()
  state.lastRefreshAt.clear()
  // A close reads Bitcoin's sharp move from its own bars, as the walk forward did (V6.1); the stream's reading
  // starts again from it, so that a crossing after the close makes the forecasts again.
  state.liveBtc = null
  state.acrossBefore.clear()
  const reading = marketReadingOf(state, sources, state.closeBtc.btc15, state.closeBtc.btc1h, closedAt)
  for (const symbol of state.inputs.keys()) {
    const prediction = predictionFor(state, sources, symbol, nowMs)
    if (prediction !== null) state.latest.set(symbol, prediction)
  }
  state.decisions.clear()
  rankAll(state, sources, nowMs)
  const horizons = recordedHorizons(closedAt)
  const recordable = horizons.length > 0 && closedAt > state.lastRecordedAt
  const predictions = recordable ? [...state.latest.values()].map((prediction) => predictionLine(prediction, horizons, 'grid', undefined, state.decisions.get(prediction.pair), { rv24h: state.inputs.get(prediction.pair)?.rv24h })) : []
  // The pairs this pass held bars for: one of them not forecast at the close was skipped, as one that had
  // left the research's pairs was not (shared/forecast/forecastRecord.ts, PassLine).
  return { status: 'passed', settled, market: reading, predictions, pass: recordable ? passLine(closedAt, market.keys()) : null }
}

/** A close's forecasts written: each owed its outcomes, and the close marked recorded. */
export function recorded(state: Pick<PassState, 'owed' | 'lastRecordedAt'>, closedAt: number, lines: readonly PredictionLine[]): void {
  for (const line of lines) owe(state, line)
  state.lastRecordedAt = closedAt
}

/** A pair forecast again between closes, for the reasons given: the line to record, naming the one it
 * replaced; null where the pair cannot be forecast. The caller owes the line once it is written. */
export function refresh(state: PassState, sources: PassSources, symbol: string, reasons: RefreshReason[], nowMs: number): PredictionLine | null {
  const previous = state.latest.get(symbol)
  const prediction = predictionFor(state, sources, symbol, nowMs)
  if (prediction === null) return null
  state.latest.set(symbol, prediction)
  state.lastRefreshAt.set(symbol, nowMs)
  rankAll(state, sources, nowMs)
  return predictionLine(prediction, HORIZONS, 'refresh', { reasons, previous: previous?.id ?? null }, state.decisions.get(symbol), { rv24h: state.inputs.get(symbol)?.rv24h })
}

export interface ConsiderSignals {
  newsImpact?: number | null
  newEvent?: boolean
  minuteVolume?: number | null
  marketShock?: boolean
}

/** Whether a pair's forecast should be made again now, and if so made again: the reasons, and the line to
 * record where it was. Nothing while a pass runs (`passing`). */
export function consider(state: PassState, sources: PassSources, symbol: string, signals: ConsiderSignals, nowMs: number, passing: boolean): { reasons: RefreshReason[]; line: PredictionLine | null } {
  const prediction = state.latest.get(symbol)
  const input = state.inputs.get(symbol)
  if (prediction === undefined || input === undefined || passing) return { reasons: [], line: null }
  // A forecast more than a close behind -- its bars not read since, as in an outage -- is not made again
  // from them: a refresh would restate stale bars as new. Found by V6 Stage 16's run: one made ten minutes
  // after its close while the data could not be read.
  const latestClose = lastClosedBarTime(Math.floor(nowMs / 1000)) + FORECAST_BAR_SECONDS
  if (prediction.barTime < latestClose - FORECAST_BAR_SECONDS) return { reasons: [], line: null }
  const lead = prediction.horizons[prediction.bestHorizon ?? 'hour1'] ?? Object.values(prediction.horizons)[0]
  const book = liveBookOf(sources, symbol, nowMs)
  const check = {
    nowMs,
    lastRefreshAt: state.lastRefreshAt.get(symbol) ?? null,
    newsImpact: signals.newsImpact,
    newEvent: signals.newEvent,
    livePrice: book?.mid ?? null,
    band: lead === undefined ? null : ([lead.quantilePrices[0], lead.quantilePrices[4]] as [number, number]),
    minuteVolume: signals.minuteVolume,
    usualMinuteVolume: input.usualMinuteVolume,
    marketShock: signals.marketShock,
    // V7.1 Stage 11: the live spread against the pair's usual, and the live price against the call.
    spreadPct: book?.spreadPct ?? null,
    usualSpreadPct: usualSpreadOf(state, symbol),
    call: lead?.direction,
    median: lead === undefined ? null : lead.quantilePrices[2],
    wasAcross: state.acrossBefore.get(symbol) ?? false
  }
  const reasons = refreshReasons(check)
  // Where the price stood against the call is kept from one reading to the next, so that a crossing is told
  // once; a reading within the minute's gap is not one.
  if (check.lastRefreshAt === null || nowMs - check.lastRefreshAt >= 60_000) state.acrossBefore.set(symbol, acrossMedian(check))
  const line = reasons.length > 0 ? refresh(state, sources, symbol, reasons, nowMs) : null
  return { reasons, line }
}

/** A forecast made again, with why. */
export interface Refreshed {
  symbol: string
  reasons: RefreshReason[]
  line: PredictionLine
}

/** What the live stream's reading left: the market as read from Bitcoin's minutes where they could be
 * read (undefined where not, and the status keeps the last), and the forecasts made again, in order. */
export interface LiveSignalResult {
  market?: MarketReading | null
  refreshed: Refreshed[]
}

/** The live stream looked at: Bitcoin's sharp move (V6.1) read from its minutes, which are always streamed;
 * its crossing the line since the last reading -- the stream's, however old, or the close's before any --
 * makes every pair's forecast again, where a horizon's rule is in use to widen them. Since V7.1 Stage 11
 * the market's state is read from the same minutes (its hour too), and a change of it does the same where
 * a state's rule is in use. Then every pair the stream holds a book for is considered: a price out of its
 * range, a volume shock, a spread shock, a crossing of the call. */
export function liveSignal(state: PassState, sources: PassSources, live: Pick<LiveState, 'books' | 'minutes' | 'btcMinutes'>, nowMs: number, passing: boolean): LiveSignalResult {
  const before = state.liveBtc !== null ? state.liveBtc.btc15 : state.closeBtc.btc15
  const stateBefore =
    state.liveBtc !== null ? marketStateOf(state, sources, state.liveBtc.btc15, state.liveBtc.btc1h ?? state.closeBtc.btc1h, Math.floor(state.liveBtc.atMs / 1000)) : marketStateOf(state, sources, state.closeBtc.btc15, state.closeBtc.btc1h, state.closeBtc.t)
  const btc15 = state.closeBtc.rv24h === null ? null : liveBtcMove(live.btcMinutes, state.closeBtc.rv24h, 3)
  const btc1h = state.closeBtc.rv24h === null ? null : liveBtcMove(live.btcMinutes, state.closeBtc.rv24h, 12)
  if (btc15 !== null) state.liveBtc = { btc15, btc1h, atMs: nowMs }
  const crossed = btc15 !== null && Math.abs(btc15) >= SHOCK_LINES.line && (before === null || Math.abs(before) < SHOCK_LINES.line)
  const stateAfter = btc15 === null ? stateBefore : marketStateOf(state, sources, btc15, btc1h ?? state.closeBtc.btc1h, Math.floor(nowMs / 1000))
  const market = btc15 === null ? undefined : marketReadingOf(state, sources, btc15, btc1h ?? state.closeBtc.btc1h, Math.floor(nowMs / 1000))
  const changed = stateAfter !== null && stateBefore !== null && stateAfter !== stateBefore
  const refreshed: Refreshed[] = []
  const calibration = sources.calibration()
  if ((crossed && shockRuleInUse(calibration)) || (changed && stateRulesInUse(calibration))) {
    for (const symbol of [...state.latest.keys()]) {
      const made = consider(state, sources, symbol, { marketShock: true }, nowMs, passing)
      if (made.line !== null) refreshed.push({ symbol, reasons: made.reasons, line: made.line })
    }
  }
  for (const symbol of Object.keys(live.books)) {
    if (!state.latest.has(symbol)) continue
    const minutes = live.minutes[symbol] ?? []
    const forming = minutes[minutes.length - 1]
    const made = consider(state, sources, symbol, { minuteVolume: forming !== undefined && !forming.closed ? forming.volume : null }, nowMs, passing)
    if (made.line !== null) refreshed.push({ symbol, reasons: made.reasons, line: made.line })
  }
  return { ...(market === undefined ? {} : { market }), refreshed }
}
