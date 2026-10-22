import { positionFeeRate, positionSlippageRate } from '../fees'
import type { ExecutorConfig, PositionExecutorParams } from '../ipc'
import { DIRECTION_MODELS, type DirectionModelId } from './models'
import { classTradable } from './opportunityClass'
import type { PricePrediction } from './prediction'
import type { TradeDecision } from './tradeDecision'
import type { ForecastTradeMark } from './trader'
import { DIRECTION_LINES } from './direction'

// THE PAPER LABORATORY (V7.1 Stage 4, 16 October 2026): a $10,000 paper account on which four
// strategies are measured, each a paper trader like the forecast trader (shared/forecast/trader.ts),
// each off until a person switches it on, on the same paper account the app has (Paper Trading):
// - STRICT: the forecast trader's own rule -- a TRADE decision in an opportunity class that is approved
//   or on probation -- traded again under the laboratory's caps, so that its record is read beside the
//   others';
// - DIRECTION: a call whose P(up) came from a promoted direction model (V7.1 Stage 2), held back by
//   nothing but its opportunity class: what the class gate alone keeps from trading;
// - NEWS EVENT: a call a story moved its way, from a kind the library had thirty stories of, held back
//   by nothing but its class;
// - HYBRID: a call held back by nothing but its class, where Trend Regime 4h stood on its side at the
//   moment (src/agents/quantState.ts), as the Lab's hybrid row has it.
// A pair is opened once a pass, under the first of those it qualifies for, in that order; the others it
// qualified for are written on the trade, for the record. V6's runs found zero forecast trades under the
// production gates: these say how the candidates would have traded, without pretending the gates
// approved them.
//
// THE LINES, pinned here before any result was looked at: a quarter of a percent of the paper account's
// equity risked at the stop a trade, a tenth of the equity staked a trade at most, three open at once, no
// leverage, a SELL a paper short, and a DAILY STOP: once the laboratory's trades closed in a UTC day have
// lost 1.5% of the equity together, it opens none until the next day, and says so once. The money-out
// cap and the correlated-side cap of Risk & Safety apply to it as to the app's other paper trades.
//
// PREDECLARED SENSITIVITY, counted and never traded: how many forecasts a pass would have called a way
// with a direction model's P(up) at 55% and at 52% instead of the 58% line, so that a laboratory that
// makes no trade can still say where the line binds.
//
// IT IS PAPER. Nothing here reaches an order.

export const LAB_STRATEGIES = ['strict', 'direction', 'news', 'hybrid'] as const
export type LabStrategy = (typeof LAB_STRATEGIES)[number]

export const LAB_RISK = {
  /** What the laboratory funds the paper account to, in USDT: a click, never by itself. */
  fundQuote: 10_000,
  /** Of the equity: what a trade risks at its stop, and the most it stakes. */
  riskPct: 0.25,
  maxPositionPct: 10,
  maxOpen: 3,
  /** Of the equity: what the day's closed trades may lose together before it stops for the day. */
  dailyStopPct: 1.5,
  /** The P(up) lines the sensitivity is counted at, beside the call's own. */
  sensitivity: [0.55, 0.52] as readonly number[]
} as const

/** Where the laboratory's trades go (V7.1 Stage 8): the paper account, or an exchange's DEMO
 * account over its demo key -- play money, through the one module that can reach nothing real. */
export type LabExecution = 'paper' | 'demo'

export interface LabSettings {
  strategies: Record<LabStrategy, boolean>
  /** The day the stop was reached, and what was lost against what equity; null while it was not. */
  stopped: { day: string; at: number; lossQuote: number; equityQuote: number } | null
  execution: LabExecution
}

export const DEFAULT_LAB_SETTINGS: LabSettings = { strategies: { strict: false, direction: false, news: false, hybrid: false }, stopped: null, execution: 'paper' }

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)

/** A stored setting, read as one: only a stored `true` switches a strategy on; a stop that is not whole
 * is dropped. */
export function healLabSettings(value: unknown): LabSettings {
  const raw = isObject(value) ? value : {}
  const strategies = isObject(raw.strategies) ? raw.strategies : {}
  const stopped = raw.stopped
  const whole = isObject(stopped) && typeof stopped.day === 'string' && typeof stopped.at === 'number' && typeof stopped.lossQuote === 'number' && typeof stopped.equityQuote === 'number'
  return {
    strategies: Object.fromEntries(LAB_STRATEGIES.map((strategy) => [strategy, strategies[strategy] === true])) as Record<LabStrategy, boolean>,
    stopped: whole ? { day: stopped.day as string, at: stopped.at as number, lossQuote: stopped.lossQuote as number, equityQuote: stopped.equityQuote as number } : null,
    // Only a stored 'demo' sends the laboratory's trades to a demo account; anything else is paper.
    execution: raw.execution === 'demo' ? 'demo' : 'paper'
  }
}

/** What a laboratory trade carries: the forecast trader's mark, the strategy it was opened under, and
 * every strategy it qualified for. */
export interface LabTradeMark extends ForecastTradeMark {
  strategy: LabStrategy
  qualified: LabStrategy[]
}

/** The laboratory's trades among the executors: paper Positions carrying its mark; one strategy's where
 * named. */
export function labPaperExecutors(executors: readonly ExecutorConfig[], strategy?: LabStrategy): ExecutorConfig[] {
  // On paper, or on a demo account (V7.1 Stage 8): never live, which the laboratory cannot make.
  return executors.filter((executor) => executor.mode !== 'live' && executor.type === 'position' && executor.lab !== undefined && (strategy === undefined || executor.lab.strategy === strategy))
}

/** The UTC day a moment falls in, as the stop names it. */
export function labDayOf(sec: number): string {
  return new Date(sec * 1000).toISOString().slice(0, 10)
}

/** A decision held back by nothing, or by its opportunity class alone: the candidates' gate. */
export function classOnly(decision: TradeDecision): boolean {
  return decision.side !== null && decision.reasons.every((reason) => reason.code === 'CLASS_NOT_APPROVED')
}

/** Which strategies a ranked forecast qualifies for, in the laboratory's order. `quantSide` is Trend
 * Regime 4h's side at the moment, or null where it could not be read. */
export function labStrategiesOf(decision: TradeDecision, prediction: PricePrediction, quantSide: 'long' | 'short' | null): LabStrategy[] {
  const out: LabStrategy[] = []
  const range = prediction.horizons[decision.horizon]
  if (range === undefined || decision.side === null) return out
  if (decision.decision === 'TRADE' && decision.classVerdict !== null && classTradable(decision.classVerdict)) out.push('strict')
  if (!classOnly(decision)) return out
  if (range.pUpSource !== undefined && (DIRECTION_MODELS as readonly string[]).includes(range.pUpSource)) out.push('direction')
  const story = range.news.v4
  if (story !== null && story.fromLibrary && story.shiftPct !== 0 && (story.shiftPct > 0) === (decision.side === 'BUY')) out.push('news')
  if ((decision.side === 'BUY' && quantSide === 'long') || (decision.side === 'SELL' && quantSide === 'short')) out.push('hybrid')
  return out
}

/** The sensitivity counts of a pass: forecasts whose lead horizon's P(up) came from a direction model and
 * stood at or past each line (or at or under its mirror) with the median on its side, by line. Counted
 * only; nothing trades on them. */
export function sensitivityCounts(predictions: readonly PricePrediction[]): Record<string, number> {
  const out: Record<string, number> = {}
  for (const line of [DIRECTION_LINES.bullish, ...LAB_RISK.sensitivity]) {
    // The mirror of a line is written out to six places: 1 - 0.55 is a hair under 0.45 in floating point,
    // and a chance read at 0.45 exactly stands at the line.
    const mirror = Number((1 - line).toFixed(6))
    let count = 0
    for (const prediction of predictions) {
      const horizon = prediction.bestHorizon ?? 'hour1'
      const range = prediction.horizons[horizon]
      if (range === undefined || range.pUpSource === undefined || !(DIRECTION_MODELS as readonly string[]).includes(range.pUpSource as DirectionModelId)) continue
      const median = range.medianPct ?? 0
      if ((range.pUp >= line && median > 0) || (range.pUp <= mirror && median < 0)) count++
    }
    out[line.toFixed(2)] = count
  }
  return out
}

/** What the laboratory's trades closed in the UTC day of `nowSec` made together, in `quoteAsset`, and how
 * many closed. A trade whose entry expired made nothing and is not counted. */
export function labDailyNet(executors: readonly ExecutorConfig[], nowSec: number, quoteAsset: string): { netQuote: number; closed: number } {
  const day = labDayOf(nowSec)
  let netQuote = 0
  let closed = 0
  for (const executor of labPaperExecutors(executors)) {
    const result = executor.lab?.result
    if (executor.status !== 'stopped' || result === undefined || result.exit === 'entry_expired' || executor.quoteAsset !== quoteAsset) continue
    if (labDayOf(result.closedAt) !== day) continue
    netQuote += result.pnlQuote
    closed++
  }
  return { netQuote, closed }
}

/** Whether the day's loss has reached the stop against the equity: a loss of the stop's share or more. */
export function labStopReached(netQuote: number, equityQuote: number | null): boolean {
  return equityQuote !== null && equityQuote > 0 && netQuote <= -(equityQuote * LAB_RISK.dailyStopPct) / 100 + 1e-9
}

export interface LabStats {
  strategy: LabStrategy
  opened: number
  closed: number
  open: number
  wins: number
  netQuote: number
  profitFactor: number | null
  winRate: number | null
  expectancyQuote: number | null
  maxDrawdownQuote: number
  /** The fees and the slippage the fills were charged, on the trades that entered, as the engine charges
   * them (shared/fees.ts): each fill's notional at the fee rate, both fills' at the slippage rate. */
  feesQuote: number
  slippageQuote: number
  /** What the open trades stake, as a share of the equity, in percent; null without equity. */
  utilizationPct: number | null
}

/** One strategy's record from the executors: its trades opened, closed and open, what they made, and
 * what their fills cost. */
export function labStatsOf(executors: readonly ExecutorConfig[], strategy: LabStrategy, equityQuote: number | null): LabStats {
  const mine = labPaperExecutors(executors, strategy)
  const open = mine.filter((executor) => executor.status === 'active')
  const closed = mine.filter((executor) => executor.status === 'stopped' && executor.lab?.result !== undefined && executor.lab.result.exit !== 'entry_expired')
  const byClose = [...closed].sort((a, b) => a.lab!.result!.closedAt - b.lab!.result!.closedAt)
  let won = 0
  let lost = 0
  let wins = 0
  let sum = 0
  let peak = 0
  let drawdown = 0
  let fees = 0
  let slippage = 0
  for (const executor of byClose) {
    const pnl = executor.lab!.result!.pnlQuote
    if (pnl > 0) {
      wins++
      won += pnl
    } else lost -= pnl
    sum += pnl
    peak = Math.max(peak, sum)
    drawdown = Math.max(drawdown, peak - sum)
    const params = executor.params as PositionExecutorParams
    fees += 2 * params.amountQuote * positionFeeRate(params)
    slippage += 2 * params.amountQuote * positionSlippageRate(params)
  }
  const staked = open.reduce((total, executor) => total + (executor.params as PositionExecutorParams).amountQuote, 0)
  return {
    strategy,
    opened: mine.length,
    closed: closed.length,
    open: open.length,
    wins,
    netQuote: sum,
    profitFactor: lost > 0 ? won / lost : null,
    winRate: closed.length === 0 ? null : wins / closed.length,
    expectancyQuote: closed.length === 0 ? null : sum / closed.length,
    maxDrawdownQuote: drawdown,
    feesQuote: fees,
    slippageQuote: slippage,
    utilizationPct: equityQuote === null || !(equityQuote > 0) ? null : (100 * staked) / equityQuote
  }
}
