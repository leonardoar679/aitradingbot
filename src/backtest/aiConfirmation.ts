import type { Candle, Exchange, Interval } from '../../shared/ipc'
import { GPT_LOOKBACK_BARS, type AiCallSource, type AiSignalDecision } from '../../shared/aiSignal'
import {
  AI_CONFIRM_MAX_DECISIONS,
  isBarSettled,
  isEntryConfirmed,
  type AiEntryConfirmRequest,
  type AiStrategyBlock
} from '../../shared/aiConfirm'
import { runBacktest, type BacktestResult, type RunBacktestOptions, type Trade } from './engine'
import { STRATEGIES, getStrategy, type StrategyDefinition, type StrategySignals } from './strategies'

// A strategy's entries, with a model allowed to veto each one (shared/aiConfirm.ts).
//
// A VETO REMOVES THE TRADE, NOT THE BAR. The strategy would have opened a position on the vetoed
// bar and held it until its own exit or stop; a veto keeps the account out for exactly that
// stretch, and the next question is about the strategy's next trade. So a model is asked ONCE PER
// TRADE THE STRATEGY WOULD TAKE: the reviewed run is the strategy's own run with some of its
// trades missing, and the number of questions is known before the first one is asked.
//
// The first version of this file held a veto only until the strategy withdrew its entry signal,
// and running it against real candles showed what that does. Short-Term Channel's signal is a
// threshold on a noisy reading, so it drops and re-fires within the hour: the same breakout was
// vetoed at 22:15, vetoed again at 23:00, vetoed again the next afternoon and confirmed two hours
// after that -- one trade, asked about four times and entered anyway, a day late. Ninety days
// took 28 calls for 9 trades against an estimate of 9, and "no" only ever meant "ask me again".
// A veto that can be outlasted by asking is not a veto.
//
// THE QUESTIONS ARE STILL FOUND BY RUNNING THE ENGINE, one answer at a time: run it with every
// veto so far applied, take the first position it opens that nobody has ruled on, ask about that
// bar, and run again. On a spot run with no cooldown that walk visits exactly the strategy's own
// trades. With leverage or a re-entry cooldown it need not -- a vetoed trade is one that never
// lost, never liquidated the account and never started a cooldown -- and the walk follows whatever
// the engine then does rather than assuming. The engine is causal, so everything before the first
// unruled entry is already final and nothing is asked about an entry the run never reaches.
//
// THE ENGINE IS THE ONLY POSITION MACHINE. GPT Intraday keeps a small one of its own in
// shared/aiSignal.ts because the main process has to walk it; here the walk happens beside the
// engine, so stops, liquidation, cooldowns and leverage are whatever runBacktest says they are and
// there is no second copy to drift.
//
// THE MODEL SEES THE SIGNAL BAR, AND THE ENTRY FILLS AT ITS CLOSE. A strategy here computes its
// signal from a bar's close and the engine fills at that same close, so the review is made from
// the bars up to and including that one and from nothing after it. A confirmed entry therefore
// fills exactly where the unconfirmed strategy's would, and the two runs differ only by the
// trades that were removed. What that leaves out is the few seconds a model takes to answer,
// which is the same simplification the strategy's own fill already makes.

export type EngineOptions = Omit<RunBacktestOptions, 'signals'>

export const CONFIRMATION_CANCELLED = 'AI confirmation cancelled'

/** Whether a model can be put in front of this strategy's entries. Every registered strategy
 * except the one whose decisions already come from a model. */
export function canConfirmEntries(strategyId: string): boolean {
  return STRATEGIES.some((strategy) => strategy.id === strategyId && !strategy.requiresExternalSignals)
}

/** The strategy's signals, held flat until a review has the history it needs.
 *
 * A review reads the lookback's worth of bars ending at the signal bar, so no entry before that
 * many bars can be reviewed -- and an entry that cannot be reviewed must not be taken. Raising
 * the warm-up rather than refusing those entries one by one keeps the unconfirmed comparison run
 * on the same bars: both start trading on the same candle. */
export function confirmableSignals(strategy: StrategyDefinition, candles: Candle[]): StrategySignals {
  const signals = strategy.generateSignals(candles)
  return { ...signals, warmupBars: Math.max(signals.warmupBars, GPT_LOOKBACK_BARS) }
}

/** A stretch of bars, both ends included, on which no position may be opened. */
export interface EntryBlock {
  from: number
  through: number
}

/** `signals` with no entry inside any of `blocks`, and optionally none from `freezeFrom` on.
 * Exits and stops are untouched: a veto never closes or keeps open anything. */
export function gateEntries(signals: StrategySignals, blocks: Iterable<EntryBlock>, freezeFrom: number | null = null): StrategySignals {
  const entries = signals.entries.slice()
  for (const { from, through } of blocks) entries.fill(false, Math.max(0, from), through + 1)
  if (freezeFrom !== null) entries.fill(false, Math.max(0, freezeFrom))
  return { ...signals, entries }
}

/** Candle indexes at which a run opened a position, oldest first. */
export function openedAt(result: BacktestResult, indexByTime: ReadonlyMap<number, number>): number[] {
  const times = result.trades.map((trade) => trade.entryTime)
  // Not in `trades` when the caller asked for the open position to be left open.
  if (result.openPositionAtEnd) times.push(result.openPositionAtEnd.entryTime)
  const indexes = new Set<number>()
  for (const time of times) {
    const index = indexByTime.get(time)
    if (index !== undefined) indexes.add(index)
  }
  return [...indexes].sort((a, b) => a - b)
}

/** What the model is told about the strategy whose entry it is reviewing. */
export function strategyBlockFor(strategy: StrategyDefinition, candles: Candle[], index: number, stop: number | null): AiStrategyBlock {
  const close = candles[index].close
  return {
    id: strategy.id,
    name: strategy.name,
    rule: strategy.description,
    // One decimal: the stop is usually a multiple of a Wilder ATR, which carries a trace of where
    // the series began, and a value hashed into the cache key must not.
    stopDistancePct:
      stop !== null && close > 0 && stop >= 0 && stop <= close ? Number((((close - stop) / close) * 100).toFixed(1)) : null,
    readings: strategy.entryReadings?.(candles, index) ?? []
  }
}

interface Market {
  exchange: Exchange
  symbol: string
  interval: Interval
  model?: string
  source: AiCallSource
}

/** The question about the entry signalled on `candles[index]`. Nothing after that bar is sent. */
export function entryConfirmRequest(
  market: Market,
  strategy: StrategyDefinition,
  candles: Candle[],
  signals: StrategySignals,
  index: number
): AiEntryConfirmRequest {
  return {
    exchange: market.exchange,
    symbol: market.symbol,
    interval: market.interval,
    window: candles.slice(index - GPT_LOOKBACK_BARS + 1, index + 1),
    strategy: strategyBlockFor(strategy, candles, index, signals.stopPrices[index]),
    model: market.model,
    source: market.source
  }
}

/** The trade the strategy makes from `index` when allowed in there: what a vetoed entry would
 * have become. Null when the engine does not open a position on that bar at all. */
export function tradeFrom(
  candles: Candle[],
  strategyId: string,
  signals: StrategySignals,
  index: number,
  engine: EngineOptions = {}
): Trade | null {
  const fromHere = { ...signals, entries: signals.entries.map((entry, i) => entry && i >= index) }
  const first = runBacktest(candles, strategyId, { ...engine, signals: fromHere, forceCloseAtEnd: true }).trades[0]
  return first !== undefined && first.entryTime === candles[index].time ? first : null
}

/** The bars a veto at `index` keeps the account out for: the life of the trade it removed.
 *
 * Where it ends depends on how that trade would have ended, because that is what decides the
 * first bar the strategy alone could have opened its NEXT position on. The engine can open a new
 * position on the very bar a signal exit (or a give-back exit) closed the last one, so the block
 * stops one bar short of it; it cannot on a bar that stopped the position out or liquidated it,
 * so the block covers that bar too. A trade still open when the candles run out is one the engine
 * closes on the last bar as `end_of_data`, which is neither kind of exit, so it blocks to the end. */
function blockFor(candles: Candle[], index: number, removed: Trade | null, indexByTime: ReadonlyMap<number, number>): EntryBlock {
  // No trade to remove means the engine would not have entered here; the veto covers its own bar.
  if (removed === null) return { from: index, through: index }
  const exitIndex = indexByTime.get(removed.exitTime) ?? candles.length - 1
  const sameBarReentry = removed.exitReason === 'signal' || removed.exitReason === 'trailing'
  return { from: index, through: sameBarReentry ? exitIndex - 1 : exitIndex }
}

/** Why an entry could not be ruled on this time.
 *
 * `forming`: its bar has not closed, so there is nothing settled to ask about yet.
 * `uncached`: the caller would not pay, and the answer is not already held.
 * `unanswered`: the model was asked and could not be reached. */
export type UnsettledReason = 'forming' | 'uncached' | 'unanswered'

export interface UnsettledEntry {
  index: number
  time: number
  reason: UnsettledReason
  /** The transport error, when the model could not be reached. */
  detail: string | null
}

export interface ConfirmedRun {
  /** The strategy with every vetoed trade removed. When an entry is unsettled, no new position is
   * opened from that bar on: an entry nobody has ruled on is not taken. */
  result: BacktestResult
  /** The same strategy over the same candles with nobody asked. */
  quantOnly: BacktestResult
  /** The strategy's own signals, before any veto. */
  signals: StrategySignals
  /** Every ruling, by the candle index it was asked about. */
  decisions: Map<number, AiSignalDecision>
  /** For each vetoed entry, the trade the veto removed. */
  removed: Map<number, Trade | null>
  unsettled: UnsettledEntry | null
  /** Entries the run would still open that nobody has ruled on, the unsettled one included: how
   * many more questions there are. */
  openQuestions: number
}

export interface ResolveInput extends Market {
  candles: Candle[]
  strategyId: string
  engine?: EngineOptions
  /** Entries before this time are allowed without asking. A bot passes the moment it was switched
   * on: what the strategy did before then is its own history, not this bot's, and paying to
   * second-guess trades the bot never took would buy nothing. Zero asks about every entry. */
  confirmFromSec: number
  nowSec: number
  /** The ruling on one entry, or null when it cannot be had without spending and this caller may
   * not spend. A decision carrying `error` means the model was not reached. */
  ask: (request: AiEntryConfirmRequest) => Promise<AiSignalDecision | null>
  /** Rulings already held, from an earlier pass over the same candles. */
  known?: ReadonlyMap<number, AiSignalDecision>
  shouldStop?: () => boolean
  onProgress?: (decided: number, expected: number) => void
}

/** Replays a strategy with each entry put to `ask` first. See the note at the top of this file. */
export async function resolveConfirmedRun(input: ResolveInput): Promise<ConfirmedRun> {
  const strategy = getStrategy(input.strategyId)
  const signals = confirmableSignals(strategy, input.candles)
  const replay = (gated: StrategySignals): BacktestResult =>
    runBacktest(input.candles, input.strategyId, { ...input.engine, signals: gated })
  const quantOnly = replay(signals)
  const indexByTime = new Map(input.candles.map((candle, index) => [candle.time, index]))

  const decisions = new Map<number, AiSignalDecision>()
  const removed = new Map<number, Trade | null>()
  const blocks: EntryBlock[] = []
  // A veto is turned into the stretch it blocks once, when it is recorded: each one costs a replay
  // to find where its trade would have ended, and the walk below would otherwise redo all of them
  // on every pass.
  const record = (index: number, decision: AiSignalDecision): void => {
    decisions.set(index, decision)
    if (isEntryConfirmed(decision)) return
    const trade = tradeFrom(input.candles, input.strategyId, signals, index, input.engine)
    removed.set(index, trade)
    blocks.push(blockFor(input.candles, index, trade, indexByTime))
  }
  for (const [index, decision] of [...(input.known ?? [])].sort(([a], [b]) => a - b)) record(index, decision)

  for (;;) {
    if (input.shouldStop?.()) throw new Error(CONFIRMATION_CANCELLED)
    // Every veto so far applied, every entry not yet ruled on allowed through: the first of those
    // the engine actually opens is the next question, and everything before it is final.
    const speculative = replay(gateEntries(signals, blocks))
    const open = openedAt(speculative, indexByTime).filter(
      (index) => input.candles[index].time >= input.confirmFromSec && !decisions.has(index)
    )
    if (open.length === 0) {
      return { result: speculative, quantOnly, signals, decisions, removed, unsettled: null, openQuestions: 0 }
    }

    const next = open[0]
    const leaveUnsettled = (reason: UnsettledReason, detail: string | null = null): ConfirmedRun => ({
      result: replay(gateEntries(signals, blocks, next)),
      quantOnly,
      signals,
      decisions,
      removed,
      unsettled: { index: next, time: input.candles[next].time, reason, detail },
      openQuestions: open.length
    })

    if (!isBarSettled(input.candles[next].time, input.interval, input.nowSec)) return leaveUnsettled('forming')
    if (decisions.size >= AI_CONFIRM_MAX_DECISIONS) {
      throw new Error(
        `An AI-confirmed run reviews at most ${AI_CONFIRM_MAX_DECISIONS} entries, and this strategy signals more than that ` +
          'over this range. Shorten the range, or run it without confirmation.'
      )
    }
    const decision = await input.ask(entryConfirmRequest(input, strategy, input.candles, signals, next))
    if (decision === null) return leaveUnsettled('uncached')
    // Not a ruling, and not kept: the model was never reached, so the entry stays unsettled and is
    // asked about again next time rather than being recorded as a veto it never gave.
    if (decision.error !== null) return leaveUnsettled('unanswered', decision.error)
    record(next, decision)
    input.onProgress?.(decisions.size, decisions.size + open.length - 1)
  }
}

export interface EntryReview {
  index: number
  time: number
  /** The signal bar's close: the price the entry fills at, before slippage. */
  price: number
  decision: AiSignalDecision
  confirmed: boolean
  /** A confirmed entry's own trade, or the trade a veto REMOVED -- the only way to say whether a
   * veto was worth having. An `end_of_data` exit means it was still open when the candles ran
   * out. Null when a confirmed entry is still open and was left open. */
  trade: Trade | null
}

/** Every ruling of a finished run, oldest first, with what each entry made or would have made. */
export function reviewEntries(candles: Candle[], run: ConfirmedRun): EntryReview[] {
  return [...run.decisions]
    .sort(([a], [b]) => a - b)
    .map(([index, decision]) => {
      const time = candles[index].time
      const confirmed = isEntryConfirmed(decision)
      const trade = confirmed
        ? run.result.trades.find((candidate) => candidate.entryTime === time) ?? null
        : run.removed.get(index) ?? null
      return { index, time, price: candles[index].close, decision, confirmed, trade }
    })
}

export interface ConfirmationCounts {
  reviewed: number
  confirmed: number
  vetoed: number
  /** Of the vetoes, answers the validator refused. A model that cannot answer in the shape asked
   * for vetoes everything, and that should not be read as judgement. */
  refused: number
  cached: number
  generated: number
  /** What this run's new calls cost. Cached rulings contribute nothing. */
  costUsd: number
}

export function confirmationCounts(decisions: Iterable<AiSignalDecision>): ConfirmationCounts {
  const counts: ConfirmationCounts = { reviewed: 0, confirmed: 0, vetoed: 0, refused: 0, cached: 0, generated: 0, costUsd: 0 }
  for (const decision of decisions) {
    counts.reviewed++
    if (isEntryConfirmed(decision)) counts.confirmed++
    else counts.vetoed++
    if (decision.rejected) counts.refused++
    if (decision.cached) counts.cached++
    else {
      counts.generated++
      counts.costUsd += decision.usage?.costUsd ?? 0
    }
  }
  return counts
}
