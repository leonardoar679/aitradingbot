import { stopFillPrice, limitFillPrice } from '../fills'
import type { PositionExecutorParams } from '../ipc'
import type { LiveBook } from '../liveMarket'
import { paperFillOf } from '../venueCosts'
import { FORECAST_BAR_SECONDS, coarseBars, type CoarseBar, type ForecastBar } from './bars'
import { HORIZONS, type Horizon, type PairSeries } from './features'
import type { MissingOutcomeLine, OutcomeLine, PassLine, PredictionLine } from './forecastRecord'
import { LAB_RISK, LAB_STRATEGIES, classOnly, labStrategiesOf, type LabStrategy } from './labTrader'
import { QUANTILE_LEVELS } from './ml/quantile'
import type { FittedHorizon } from './models'
import { EXCURSION_WIDTH, type OosRecord } from './oosRecord'
import { newPassState, pass, recorded, settle, type PassSources } from './pass'
import type { PricePrediction } from './prediction'
import { RANGE_LINES, RANGE_STRATEGIES, barIndexFrom, bandOrderOf, gridOrderOf, resolveBand, resolveGrid, type RangeExit } from './rangeStrategies'
import { buildRunCalibration, tradeableVerdictsOf, type RunCalibration, type TradeableBefore } from './runCalibration'
import { decideOnBook, heldBackByPrice } from './tradeDecision'
import { planValid, tradePlanOf, type TargetLevel } from './tradePlan'
import type { Promotion } from './training'
import { BLOCK_HOURS, bootstrapOverHours, hourOf, type Figure } from './uncertainty'

// THE REPLAY OUT OF SAMPLE (V7.2-R Stage 5, 22 October 2026; the V7.2 draft's Stage 6). The live laboratory has made
// no trade since it was funded, because nothing calls a way; so "is it tradable" is answered here instead, on weeks
// the models never saw. A walk forward (the training worker's task folds) tests its models on its last four weeks,
// each week's models fitted only on what came before it, and since V7.2 Stage 5 it keeps each week's models on disk
// (fold-<k>-<horizon>.json). The replay walks every five-minute close of those weeks through the forecast's own pure
// pass (shared/forecast/pass.ts) -- the outcomes due settled and the adaptive levels moved, every pair forecast, every
// decision and the ranking made -- with the week's own models and a calibration made ONLY from the weeks before it
// (forwardCalibrations): nothing a replayed forecast reads was fitted on its week. The first week has no week before
// it and is not replayed. What it says is written in the record's own formats, each line stamped with its sample.
//
// THEN THE STRATEGIES, on the forecasts of every quarter-hour, played on the bars that came after them:
// - BAND_REVERSION and RANGE_GRID (shared/forecast/rangeStrategies.ts), which need no way;
// - the laboratory's four (shared/forecast/labTrader.ts), through the live decision: a call held back by the price
//   alone decided again on a book at the close (the replay holds no book: a spread of REPLAY_LINES.spreadPct is
//   assumed, and said), qualified by the laboratory's rules, planned by the trade plan at the default risk mode's
//   target, under the laboratory's caps (three open, one a pair), and filled as the paper engine fills a Position
//   (positionOutcomeOf, held to src/executors/engine.ts's simulatePosition by tests/forecastReplay.test.ts) on the
//   five-minute bars where the live laboratory reads one-minute candles. The hybrid needs Trend Regime 4h's side, which
//   the replay reads only where its reader hands one in.
//
// WHAT IT CANNOT KNOW, said on every report: the pairs the app held at the time (every pair on file is forecast); the
// books and their spreads; the news (none is read); the class verdicts (none: no class is judged); the members the
// run promoted (read as the run promoted them on the four weeks: their weights, the calibration and the P(up) map
// come from the weeks before alone). The adaptive levels begin again with each week's calibration, as the live
// engine's do with each refit's.
//
// A SEGMENT MAY BE MARKED IN SAMPLE (the final models over the weeks they were fitted on, for a fidelity check): its
// figures are refused, every P&L line null and its verdict 'in sample' -- a replay of models on their own training
// weeks says how well they remember, not how they would have traded.
//
// Two replays of the same inputs write the same bytes: no clock is read and nothing is drawn at random.

export const REPLAY_VERSION = 'replay-v1'

export const REPLAY_LINES = {
  /** The spread of the book a replayed decision is made again on, in percent of the price: the replay holds none. */
  spreadPct: 0.02,
  /** The target the laboratory's replayed plans take: the default risk mode's (Conservative, shared/appDefaults.ts). */
  targetLevel: 'P75' as TargetLevel,
  /** The fewest trades a cell's line is read on; under it, the cell is not measured. */
  minTrades: 100,
  /** The best hours whose part of a cell's net is told, as a share of its hours. */
  bestHours: 0.05,
  /** How long after the last segment the replay goes on settling the outcomes owed, forecasting nothing. */
  settleTailSec: 86_400,
  /** How long after its close a replayed pass is made, in milliseconds: the live pass runs seconds after the close. */
  passLagMs: 10_000
} as const

export type ReplaySample = 'in' | 'out'

export interface ReplaySegment {
  sample: ReplaySample
  /** What the segment is, for a report: "week 2 of 4". */
  label: string
  /** The closes forecast at: from <= t < to, on the five-minute grid. */
  from: number
  to: number
  models: ReadonlyMap<Horizon, FittedHorizon>
  calibration: RunCalibration
  /** The run the forecasts name. */
  runId: string
}

export interface ReplayInput {
  /** Every pair's bars on file, oldest first. */
  bars: ReadonlyMap<string, readonly ForecastBar[]>
  segments: readonly ReplaySegment[]
  /** The calendar: whether a moment is within the hour before a release. None where absent. */
  preEvent?: (tSec: number) => boolean
  /** Trend Regime 4h's side on a pair at a moment from its bars as held then; without it the hybrid qualifies nothing. */
  quantSide?: (pair: string, series: PairSeries, nowSec: number) => 'long' | 'short' | null
  /** Told after each close walked. */
  onClose?: (closedAt: number, done: number, total: number) => void
}

/** Where the replay's lines go, as made: every line stamped with its sample. */
export interface ReplaySink {
  prediction?(line: PredictionLine & { sample: ReplaySample }): void
  outcome?(line: (OutcomeLine | MissingOutcomeLine) & { sample: ReplaySample }): void
  pass?(line: PassLine & { sample: ReplaySample }): void
  trade?(trade: ReplayTrade): void
}

export type ReplayStrategy = (typeof RANGE_STRATEGIES)[number] | LabStrategy

/** One replayed order of a strategy and how it ended. */
export interface ReplayTrade {
  /** The strategy and its cell: band:<horizon>, grid:hours24, lab:<strategy>. */
  cell: string
  strategy: ReplayStrategy
  sample: ReplaySample
  pair: string
  predictionId: string
  /** The close the order was made at, and the horizon it trades. */
  t: number
  horizon: Horizon
  side: 'BUY' | 'SELL'
  exit: RangeExit
  /** When it was bought (the fill bar's open) and at what; null where it never was. */
  filledAt: number | null
  fillPrice: number | null
  exitAt: number | null
  exitPrice: number | null
  /** In percent of its stake: the move, its costs, and its net. */
  grossPct: number
  costPct: number
  netPct: number
  /** When the order ended: its exit bar's close, or its life's end. */
  endedAt: number
  /** The market's state at the forecast; null where it could not be read. */
  state: string | null
  /** The long held over the order's life at a market round trip (the drift beside it); null for the laboratory's. */
  baselinePct: number | null
  /** A grid's rungs sold a step up, and those held at its end. */
  cycles?: number
  heldAtEnd?: number
}

export type CellVerdict = 'held' | 'failed' | 'not measured' | 'in sample'

/** A strategy cell's figures over one sample. */
export interface CellFigures {
  cell: string
  strategy: ReplayStrategy
  horizon: Horizon
  sample: ReplaySample
  /** Orders made, and of them trades: bought, a grid run, a laboratory trade entered. */
  orders: number
  trades: number
  /** Every P&L figure is null in sample. */
  wins: number | null
  winRate: number | null
  profitFactor: number | null
  /** The mean net a trade after costs, in percent of its stake, with its 95% interval resampled by the hour bought in
   * blocks as long as the horizon; null in sample or with too few hours for an interval. */
  net: Figure | null
  netSumPct: number | null
  maxDrawdownPct: number | null
  meanCostPct: number | null
  byExit: Partial<Record<RangeExit, number>>
  byState: Record<string, { trades: number; meanNetPct: number | null }>
  /** The share of the summed net made in the best REPLAY_LINES.bestHours of its hours; null where the sum is not above zero. */
  bestHoursShare: number | null
  /** The long held over every order's life at a market round trip, with its interval: the drift the cell is set beside. */
  baseline: Figure | null
  /** The registered line: at least REPLAY_LINES.minTrades trades and the net's interval above zero. */
  verdict: CellVerdict
}

export interface ReplaySummary {
  version: string
  segments: { label: string; sample: ReplaySample; from: number; to: number; runId: string; calibrationRun: string }[]
  closes: number
  forecasts: number
  outcomes: number
  cells: CellFigures[]
  /** What the replay cannot know, said with every report. */
  assumptions: string[]
}

export const REPLAY_ASSUMPTIONS: readonly string[] = [
  'every pair on file is forecast at every close, not the pairs the app held at the time',
  `no book was recorded: a decision is made again on a book at the close with a ${REPLAY_LINES.spreadPct}% spread, and every trade is costed at the flat round trip`,
  'no news is read and no opportunity class is judged',
  'the members the run promoted are read as it promoted them on its four weeks; their weights, the calibration and the P(up) map come from the weeks before each week alone',
  'the adaptive levels begin again with each week, as with each refit live',
  "the laboratory's trades fill on five-minute bars where the live laboratory reads one-minute candles"
]

/** A record's rows of the weeks before `week`: what a calibration for that week may be made from. */
export function recordBefore(record: OosRecord, week: number): OosRecord {
  const keep: number[] = []
  for (let row = 0; row < record.rows; row++) if (record.fold[row] < week) keep.push(row)
  function pick<T extends Uint32Array | Uint16Array | Uint8Array | Float32Array>(column: T, width: number, make: (length: number) => T): T {
    const out = make(keep.length * width)
    keep.forEach((row, at) => {
      for (let k = 0; k < width; k++) out[at * width + k] = column[row * width + k]
    })
    return out
  }
  const u32 = (n: number): Uint32Array => new Uint32Array(n)
  const u16 = (n: number): Uint16Array => new Uint16Array(n)
  const u8 = (n: number): Uint8Array => new Uint8Array(n)
  const f32 = (n: number): Float32Array => new Float32Array(n)
  return {
    ...record,
    rows: keep.length,
    time: pick(record.time, 1, u32),
    pair: pick(record.pair, 1, u16),
    cls: pick(record.cls, 1, u8),
    regime: pick(record.regime, 1, u8),
    fold: pick(record.fold, 1, u8),
    z: pick(record.z, 1, f32),
    rv24h: pick(record.rv24h, 1, f32),
    y: pick(record.y, 1, f32),
    best: pick(record.best, 1, f32),
    worst: pick(record.worst, 1, f32),
    quantiles: pick(record.quantiles, record.models.length * QUANTILE_LEVELS.length, f32),
    ...(record.btc15 === undefined ? {} : { btc15: pick(record.btc15, 1, f32) }),
    ...(record.direction === undefined || record.directionModels === undefined ? {} : { direction: pick(record.direction, record.directionModels.length, f32) }),
    ...(record.excursion === undefined ? {} : { excursion: pick(record.excursion, EXCURSION_WIDTH, f32) }),
    ...(record.state === undefined ? {} : { state: pick(record.state, 1, u8) })
  }
}

/** The calibration each replayed week reads: made from the walk forward's record of the weeks before it alone, with
 * the members the run promoted, and the verdicts of the week before's calibration as the run before's (V7.2 Stage 2).
 * The first week has none. */
export function forwardCalibrations(records: ReadonlyMap<Horizon, OosRecord>, promotions: readonly Promotion[], runId: string, weeks: readonly number[]): Map<number, RunCalibration> {
  const out = new Map<number, RunCalibration>()
  let before: TradeableBefore | undefined
  for (const week of [...weeks].sort((a, b) => a - b)) {
    if (week < 1) continue
    const mine = new Map<Horizon, OosRecord>()
    for (const [horizon, record] of records) {
      const rows = recordBefore(record, week)
      if (rows.rows > 0) mine.set(horizon, rows)
    }
    if (mine.size === 0) continue
    const calibration = buildRunCalibration(mine, promotions, `${runId}#before-week-${week}`, undefined, before)
    out.set(week, calibration)
    before = tradeableVerdictsOf(calibration)
  }
  return out
}

/** The bars a series held at a close, kept growing as the closes are walked rather than cut again at each. */
interface GrowingSeries {
  m5: ForecastBar[]
  h1: CoarseBar[]
  all: readonly ForecastBar[]
  hours: readonly CoarseBar[]
  next5: number
  next1: number
}

/** A replayed trade's baseline: the long bought at the open of the order's first bar and sold at its last bar's close,
 * at market each way (the paper engine's fee and slippage). Null where the bars do not span the life. */
export function holdBaselinePct(bars: readonly ForecastBar[], from: number, until: number): number | null {
  const first = barIndexFrom(bars, from)
  const end = barIndexFrom(bars, until)
  if (first >= end || bars[end - 1].time + FORECAST_BAR_SECONDS !== until) return null
  const buy = bars[first].open * (1 + RANGE_LINES.slippagePct / 100)
  const sell = bars[end - 1].close * (1 - RANGE_LINES.slippagePct / 100)
  return ((sell / buy) * (1 - RANGE_LINES.takerFeePct / 100) - 1 - RANGE_LINES.takerFeePct / 100) * 100
}

export interface PositionOutcome {
  exit: RangeExit
  enteredAt: number | null
  levelPrice: number | null
  /** After the market fill's slippage. */
  entryPrice: number | null
  exitAt: number | null
  exitPrice: number | null
  grossPct: number
  netPct: number
  endedAt: number
}

/** A paper Position as the paper engine fills it (src/executors/engine.ts simulatePosition), unlevered and untrailed as
 * the laboratory's are, on the bars from `fromIndex`; the stake is one quote. Null where the bars end before it does. */
export function positionOutcomeOf(params: Pick<PositionExecutorParams, 'side' | 'entryPrice' | 'entryRange' | 'entryExpiresAt' | 'takeProfitPct' | 'stopLossPct' | 'timeLimitSec' | 'slippageRate' | 'feeRate'>, bars: readonly ForecastBar[], fromIndex: number): PositionOutcome | null {
  const isBuy = params.side === 'buy'
  const slippage = typeof params.slippageRate === 'number' && Number.isFinite(params.slippageRate) && params.slippageRate >= 0 ? params.slippageRate : RANGE_LINES.slippagePct / 100
  const fee = typeof params.feeRate === 'number' && Number.isFinite(params.feeRate) && params.feeRate >= 0 && params.feeRate < 0.05 ? params.feeRate : RANGE_LINES.takerFeePct / 100
  const marketFill = (price: number, buying: boolean): number => price * (buying ? 1 + slippage : 1 - slippage)
  let levelPrice: number | null = null
  let entryPrice: number | null = null
  let enteredAt: number | null = null
  for (let at = Math.max(0, fromIndex); at < bars.length; at++) {
    const candle = bars[at]
    if (entryPrice === null) {
      if (params.entryExpiresAt != null && candle.time >= params.entryExpiresAt) return { exit: 'unfilled', enteredAt: null, levelPrice: null, entryPrice: null, exitAt: null, exitPrice: null, grossPct: 0, netPct: 0, endedAt: candle.time }
      let level: number | null = null
      if (params.entryRange != null) {
        const { min, max } = params.entryRange
        if (candle.low <= max && candle.high >= min) level = candle.open >= min && candle.open <= max ? candle.open : candle.open > max ? max : min
      } else if (params.entryPrice === null) level = candle.open
      else level = limitFillPrice(candle, params.entryPrice, isBuy)
      if (level === null) continue
      levelPrice = level
      entryPrice = marketFill(level, isBuy)
      enteredAt = candle.time
    }
    const base = levelPrice as number
    const stop = params.stopLossPct !== null ? (isBuy ? base * (1 - params.stopLossPct / 100) : base * (1 + params.stopLossPct / 100)) : null
    const slHit = stop !== null && (isBuy ? candle.low <= stop : candle.high >= stop)
    const target = params.takeProfitPct !== null ? (isBuy ? base * (1 + params.takeProfitPct / 100) : base * (1 - params.takeProfitPct / 100)) : null
    const tpHit = target !== null && (isBuy ? candle.high >= target : candle.low <= target)
    const timeUp = params.timeLimitSec !== null && candle.time - (enteredAt as number) >= params.timeLimitSec
    if (!slHit && !tpHit && !timeUp) continue
    const raw = slHit ? stopFillPrice(candle.open, stop as number, isBuy) : tpHit ? (target as number) : candle.close
    const exitPrice = tpHit && !slHit ? raw : marketFill(raw, !isBuy)
    const qty = 1 / entryPrice
    const gross = isBuy ? qty * (exitPrice - entryPrice) : qty * (entryPrice - exitPrice)
    const net = gross - (qty * entryPrice + qty * exitPrice) * fee
    const move = isBuy ? raw / base - 1 : 1 - raw / base
    return { exit: slHit ? 'stop' : tpHit ? 'target' : 'time', enteredAt, levelPrice, entryPrice, exitAt: candle.time, exitPrice, grossPct: move * 100, netPct: net * 100, endedAt: candle.time + FORECAST_BAR_SECONDS }
  }
  return null
}

/** The laboratory's executor parameters for a plan, as src/forecast/labTrader.ts labPaperExecutor makes them. */
export function labPositionParams(plan: NonNullable<ReturnType<typeof tradePlanOf>>): Pick<PositionExecutorParams, 'side' | 'entryPrice' | 'entryRange' | 'entryExpiresAt' | 'takeProfitPct' | 'stopLossPct' | 'timeLimitSec' | 'slippageRate' | 'feeRate'> {
  const fill = paperFillOf(plan.cost)
  return {
    side: plan.side === 'BUY' ? 'buy' : 'sell',
    entryPrice: null,
    takeProfitPct: Math.round(plan.targetPct * 100) / 100,
    stopLossPct: Math.round(plan.stopPct * 100) / 100,
    timeLimitSec: plan.holdSec,
    entryExpiresAt: plan.validUntil,
    entryRange: { min: plan.entryMin, max: plan.entryMax },
    slippageRate: fill.slippageRate,
    feeRate: fill.feeRate
  }
}

/** The book a replayed decision is made again on: the close, a REPLAY_LINES.spreadPct spread about it, fresh. */
export function replayBook(symbol: string, price: number, nowMs: number): LiveBook {
  const half = REPLAY_LINES.spreadPct / 200
  return { symbol, bid: price * (1 - half), bidQty: 0, ask: price * (1 + half), askQty: 0, updatedAt: nowMs, source: 'rest' }
}

/** The replay: every close of every segment forecast through the pure pass, the outcomes settled, the strategies'
 * orders made at each quarter-hour and played on the bars; the lines handed to the sink as made. */
export function runReplay(input: ReplayInput, sink: ReplaySink = {}): ReplaySummary {
  const segments = [...input.segments].sort((a, b) => a.from - b.from)
  const summary: ReplaySummary = {
    version: REPLAY_VERSION,
    segments: segments.map((segment) => ({ label: segment.label, sample: segment.sample, from: segment.from, to: segment.to, runId: segment.runId, calibrationRun: segment.calibration.runId })),
    closes: 0,
    forecasts: 0,
    outcomes: 0,
    cells: [],
    assumptions: [...REPLAY_ASSUMPTIONS]
  }
  if (segments.length === 0) return summary
  if (input.quantSide === undefined) summary.assumptions.push("Trend Regime 4h was not read: the hybrid qualified nothing")
  const pairs = [...input.bars.keys()].sort()
  const series = new Map<string, GrowingSeries>()
  for (const pair of pairs) {
    const all = input.bars.get(pair)!
    series.set(pair, { m5: [], h1: [], all, hours: coarseBars(all, '1h', Number.MAX_SAFE_INTEGER), next5: 0, next1: 0 })
  }
  // Every bar and hour closed by the close, pushed on: the same bars barsUpTo and coarseUpTo cut at it.
  const advance = (closedAt: number): void => {
    for (const held of series.values()) {
      while (held.next5 < held.all.length && held.all[held.next5].time + FORECAST_BAR_SECONDS <= closedAt) held.m5.push(held.all[held.next5++])
      while (held.next1 < held.hours.length && held.hours[held.next1].time + 3600 <= closedAt) held.h1.push(held.hours[held.next1++])
    }
  }
  const volumes = new Map<string, number | null>()
  let segment = segments[0]
  const state = newPassState()
  const sources: PassSources = {
    universe: () => pairs.filter((pair) => series.get(pair)!.m5.length > 0),
    seriesOf: (symbol) => {
      const held = series.get(symbol)
      return held === undefined || held.m5.length === 0 ? null : held
    },
    models: () => segment.models,
    calibration: () => segment.calibration,
    runId: () => segment.runId,
    book: () => undefined,
    depth: () => undefined,
    volumes: () => volumes,
    news: () => undefined,
    preEvent: input.preEvent ?? ((): boolean => false),
    classVerdict: () => null
  }
  const sampleAt = (t: number): ReplaySample => (segments.find((entry) => t >= entry.from && t < entry.to) ?? segment).sample
  const trades: ReplayTrade[] = []
  const emit = (trade: ReplayTrade): void => {
    trades.push(trade)
    sink.trade?.(trade)
  }
  const writeOutcomes = (lines: readonly (OutcomeLine | MissingOutcomeLine)[]): void => {
    for (const line of lines) {
      summary.outcomes++
      sink.outcome?.({ ...line, sample: sampleAt(line.t) })
    }
  }
  // Each strategy's cell is busy on a pair until its order ends; the laboratory's trades, until theirs.
  const busy = new Map<string, number>()
  const labOpen: { pair: string; until: number }[] = []
  const trade = (closedAt: number, nowMs: number): void => {
    const nowSec = Math.floor(nowMs / 1000)
    const sample = segment.sample
    const ordered = [...state.latest.values()].sort((a, b) => a.pair.localeCompare(b.pair))
    for (const prediction of ordered) {
      const bars = input.bars.get(prediction.pair)
      if (bars === undefined) continue
      for (const horizon of RANGE_LINES.band.horizons) {
        const cell = `band:${horizon}`
        const key = `${cell}|${prediction.pair}`
        if ((busy.get(key) ?? 0) > closedAt) continue
        const order = bandOrderOf(prediction, horizon)
        if (order === null) continue
        const result = resolveBand(order, bars)
        if (result === null) continue
        busy.set(key, result.endedAt)
        emit({
          cell,
          strategy: 'band',
          sample,
          pair: prediction.pair,
          predictionId: prediction.id,
          t: closedAt,
          horizon,
          side: 'BUY',
          exit: result.exit,
          filledAt: result.filledAt,
          fillPrice: result.fillPrice,
          exitAt: result.exitAt,
          exitPrice: result.exitPrice,
          grossPct: result.grossPct,
          costPct: result.costPct,
          netPct: result.netPct,
          endedAt: result.endedAt,
          state: prediction.marketState ?? null,
          baselinePct: holdBaselinePct(bars, order.t, order.until)
        })
      }
      const gridKey = `grid:${RANGE_LINES.grid.horizon}|${prediction.pair}`
      if ((busy.get(gridKey) ?? 0) <= closedAt) {
        const order = gridOrderOf(prediction)
        const result = order === null ? null : resolveGrid(order, bars)
        if (order !== null && result !== null) {
          busy.set(gridKey, result.endedAt)
          emit({
            cell: `grid:${RANGE_LINES.grid.horizon}`,
            strategy: 'grid',
            sample,
            pair: prediction.pair,
            predictionId: prediction.id,
            t: closedAt,
            horizon: RANGE_LINES.grid.horizon,
            side: 'BUY',
            exit: 'time',
            filledAt: null,
            fillPrice: null,
            exitAt: null,
            exitPrice: null,
            grossPct: result.grossPct,
            costPct: result.costPct,
            netPct: result.netPct,
            endedAt: result.endedAt,
            state: prediction.marketState ?? null,
            baselinePct: holdBaselinePct(bars, order.t, order.until),
            cycles: result.cycles,
            heldAtEnd: result.heldAtEnd
          })
        }
      }
    }
    // The laboratory, in the ranking's order, as openLabTrades takes it up.
    const byPair = new Map<string, PricePrediction>(ordered.map((prediction) => [prediction.pair, prediction]))
    for (let at = labOpen.length - 1; at >= 0; at--) if (labOpen[at].until <= closedAt) labOpen.splice(at, 1)
    for (const entry of state.ranking.ranked) {
      const prediction = byPair.get(entry.pair)
      const bars = input.bars.get(entry.pair)
      if (prediction === undefined || bars === undefined) continue
      const book = replayBook(entry.pair, prediction.currentPrice, nowMs)
      const decision = heldBackByPrice(entry.decision) ? decideOnBook(entry.decision, prediction, book, nowMs) : entry.decision
      if (decision.side === null) continue
      const held = series.get(entry.pair)!
      const quant = classOnly(decision) && input.quantSide !== undefined ? input.quantSide(entry.pair, held, nowSec) : null
      const qualified = labStrategiesOf(decision, prediction, quant)
      if (qualified.length === 0) continue
      if (labOpen.some((open) => open.pair === entry.pair) || labOpen.length >= LAB_RISK.maxOpen) continue
      const mid = (book.bid + book.ask) / 2
      const plan = tradePlanOf({ decision: { ...decision, decision: 'TRADE' }, prediction, livePrice: mid, atr5mPct: prediction.market?.atr5mPct ?? null, targetLevel: REPLAY_LINES.targetLevel })
      if (plan === null || !planValid(plan, mid, nowSec)) continue
      const outcome = positionOutcomeOf(labPositionParams(plan), bars, barIndexFrom(bars, closedAt))
      if (outcome === null) continue
      labOpen.push({ pair: entry.pair, until: outcome.endedAt })
      const strategy = qualified[0]
      emit({
        cell: `lab:${strategy}`,
        strategy,
        sample,
        pair: entry.pair,
        predictionId: prediction.id,
        t: closedAt,
        horizon: plan.horizon,
        side: plan.side,
        exit: outcome.exit,
        filledAt: outcome.enteredAt,
        fillPrice: outcome.entryPrice,
        exitAt: outcome.exitAt,
        exitPrice: outcome.exitPrice,
        grossPct: outcome.grossPct,
        costPct: outcome.grossPct - outcome.netPct,
        netPct: outcome.netPct,
        endedAt: outcome.endedAt,
        state: prediction.marketState ?? null,
        baselinePct: null
      })
    }
  }
  const first = Math.ceil(segments[0].from / FORECAST_BAR_SECONDS) * FORECAST_BAR_SECONDS
  const lastBar = Math.max(...pairs.map((pair) => {
    const all = input.bars.get(pair)!
    return all.length === 0 ? 0 : all[all.length - 1].time + FORECAST_BAR_SECONDS
  }))
  const end = Math.min(segments[segments.length - 1].to + REPLAY_LINES.settleTailSec, lastBar)
  const total = Math.max(0, Math.floor((end - first) / FORECAST_BAR_SECONDS) + 1)
  let done = 0
  for (let closedAt = first; closedAt <= end; closedAt += FORECAST_BAR_SECONDS) {
    advance(closedAt)
    const mine = segments.find((entry) => closedAt >= entry.from && closedAt < entry.to)
    if (mine === undefined) {
      // Between segments, or after the last: the outcomes owed settled, nothing forecast.
      writeOutcomes(settle(state, sources, closedAt).lines)
    } else {
      segment = mine
      const nowMs = closedAt * 1000 + REPLAY_LINES.passLagMs
      for (const pair of pairs) {
        const held = series.get(pair)!.m5
        if (held.length === 0) continue
        let sum = 0
        for (let at = Math.max(0, held.length - 288); at < held.length; at++) sum += held[at].quoteVolume
        volumes.set(pair, sum)
      }
      const made = pass(state, sources, closedAt, nowMs)
      if (made.status === 'passed') {
        writeOutcomes(made.settled.lines)
        for (const line of made.predictions) sink.prediction?.({ ...line, sample: segment.sample })
        summary.forecasts += made.predictions.length
        if (made.pass !== null) sink.pass?.({ ...made.pass, sample: segment.sample })
        if (made.predictions.length > 0) {
          recorded(state, closedAt, made.predictions)
          trade(closedAt, nowMs)
        }
      }
    }
    summary.closes++
    done++
    input.onClose?.(closedAt, done, total)
  }
  summary.cells = cellsOf(trades)
  return summary
}

/** replay-file-v1: what the app keeps of its last replay (forecastModels/replay.json): the walk forward replayed, when,
 * how long it took, and the summary. Its filled trades sit beside it in replay-trades.jsonl, written first. */
export const REPLAY_FILE_VERSION = 'replay-file-v1'

export interface ReplayFile {
  version: string
  runId: string
  madeAt: number
  ms: number
  summary: ReplaySummary
}

/** The app's kept replay, read back; null where it is not one whole (another version, a torn write). */
export function parseReplayFile(text: string): ReplayFile | null {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    return null
  }
  if (typeof raw !== 'object' || raw === null) return null
  const file = raw as Partial<ReplayFile>
  const summary = file.summary as Partial<ReplaySummary> | undefined
  if (file.version !== REPLAY_FILE_VERSION || typeof file.runId !== 'string' || typeof file.madeAt !== 'number' || typeof file.ms !== 'number') return null
  if (summary === undefined || summary === null || summary.version !== REPLAY_VERSION || !Array.isArray(summary.cells) || !Array.isArray(summary.segments) || !Array.isArray(summary.assumptions)) return null
  return file as ReplayFile
}

const meanOf = (values: readonly number[]): number | null => (values.length === 0 ? null : values.reduce((sum, value) => sum + value, 0) / values.length)

/** The mean of a figure over trades, with its interval resampled by the hour each began in, in blocks as long as the horizon. */
function meanFigure(entries: readonly { hour: number; value: number }[], horizon: Horizon): Figure | null {
  if (entries.length === 0) return null
  const made = bootstrapOverHours(
    entries.map((entry) => ({ hour: entry.hour, sample: [entry.value, 1] })),
    [(sums): number => sums[0] / sums[1]],
    BLOCK_HOURS[horizon]
  )
  return made === null ? null : made.figures[0]
}

/** A cell's figures over one sample's trades: every P&L figure refused in sample. */
export function cellFiguresOf(cell: string, strategy: ReplayStrategy, horizon: Horizon, sample: ReplaySample, orders: readonly ReplayTrade[]): CellFigures {
  const traded = orders.filter((entry) => entry.exit !== 'unfilled')
  const byExit: Partial<Record<RangeExit, number>> = {}
  for (const entry of orders) byExit[entry.exit] = (byExit[entry.exit] ?? 0) + 1
  const base = { cell, strategy, horizon, sample, orders: orders.length, trades: traded.length, byExit }
  if (sample === 'in') {
    return { ...base, wins: null, winRate: null, profitFactor: null, net: null, netSumPct: null, maxDrawdownPct: null, meanCostPct: null, byState: {}, bestHoursShare: null, baseline: null, verdict: 'in sample' }
  }
  const nets = traded.map((entry) => entry.netPct)
  const wins = nets.filter((value) => value > 0)
  const lost = -nets.filter((value) => value <= 0).reduce((sum, value) => sum + value, 0)
  let sum = 0
  let peak = 0
  let drawdown = 0
  for (const entry of [...traded].sort((a, b) => a.endedAt - b.endedAt || a.pair.localeCompare(b.pair))) {
    sum += entry.netPct
    peak = Math.max(peak, sum)
    drawdown = Math.max(drawdown, peak - sum)
  }
  const byState: CellFigures['byState'] = {}
  for (const entry of traded) {
    const key = entry.state ?? 'unknown'
    const mine = byState[key] ?? (byState[key] = { trades: 0, meanNetPct: 0 })
    mine.trades++
    mine.meanNetPct = (mine.meanNetPct as number) + entry.netPct
  }
  for (const mine of Object.values(byState)) mine.meanNetPct = mine.trades === 0 ? null : (mine.meanNetPct as number) / mine.trades
  // The best hours' part of the net: the hours bought in, ranked by what their trades netted together.
  const byHour = new Map<number, number>()
  for (const entry of traded) byHour.set(hourOf(entry.filledAt ?? entry.t), (byHour.get(hourOf(entry.filledAt ?? entry.t)) ?? 0) + entry.netPct)
  const hourNets = [...byHour.values()].sort((a, b) => b - a)
  const top = hourNets.slice(0, Math.ceil(hourNets.length * REPLAY_LINES.bestHours)).reduce((total, value) => total + value, 0)
  const net = meanFigure(traded.map((entry) => ({ hour: hourOf(entry.filledAt ?? entry.t), value: entry.netPct })), horizon)
  const baseline = meanFigure(orders.filter((entry) => entry.baselinePct !== null).map((entry) => ({ hour: hourOf(entry.t), value: entry.baselinePct as number })), horizon)
  const verdict: CellVerdict = traded.length < REPLAY_LINES.minTrades || net === null ? 'not measured' : net.low > 0 ? 'held' : 'failed'
  return {
    ...base,
    wins: wins.length,
    winRate: traded.length === 0 ? null : wins.length / traded.length,
    profitFactor: lost > 0 ? wins.reduce((total, value) => total + value, 0) / lost : null,
    net,
    netSumPct: sum,
    maxDrawdownPct: drawdown,
    meanCostPct: meanOf(traded.map((entry) => entry.costPct)),
    byState,
    bestHoursShare: sum > 0 ? top / sum : null,
    baseline,
    verdict
  }
}

/** Every cell's figures, by sample: the band's at each horizon, the grid's, the laboratory's four. */
export function cellsOf(trades: readonly ReplayTrade[]): CellFigures[] {
  const cells: { cell: string; strategy: ReplayStrategy; horizon: Horizon }[] = [
    ...RANGE_LINES.band.horizons.map((horizon) => ({ cell: `band:${horizon}`, strategy: 'band' as const, horizon })),
    { cell: `grid:${RANGE_LINES.grid.horizon}`, strategy: 'grid' as const, horizon: RANGE_LINES.grid.horizon },
    ...LAB_STRATEGIES.map((strategy) => ({ cell: `lab:${strategy}`, strategy, horizon: 'hour1' as Horizon }))
  ]
  const out: CellFigures[] = []
  for (const sample of ['out', 'in'] as const) {
    for (const entry of cells) {
      const mine = trades.filter((trade) => trade.cell === entry.cell && trade.sample === sample)
      if (sample === 'in' && mine.length === 0) continue
      // The laboratory's trades are resampled at the horizons they traded: the longest among them sets the block.
      const horizon = entry.strategy === 'band' || entry.strategy === 'grid' ? entry.horizon : (HORIZONS.filter((h) => mine.some((trade) => trade.horizon === h)).pop() ?? entry.horizon)
      out.push(cellFiguresOf(entry.cell, entry.strategy, horizon, sample, mine))
    }
  }
  return out
}

