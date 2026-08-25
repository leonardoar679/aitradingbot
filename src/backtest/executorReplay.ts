import type { Candle, ExecutorConfig } from '../../shared/ipc'
import { runExecutorSimulation } from '../executors/engine'
import { executorPnlFromState } from '../executors/executorPnl'
import type { SingleMarketExecutorState } from '../executors/types'
import type { EquityPoint } from './engine'

/** Replays a saved executor over a historical range, the way the Backtest page replays a strategy.
 *
 * Executors and strategies are different shapes, and this does not pretend otherwise. A strategy
 * emits entry/exit signals and the backtest engine trades them one position at a time; an
 * executor IS the trading rule -- a grid holding many levels at once, a DCA ladder averaging in,
 * a TWAP slicing an order over hours. Only the executor simulators know how to run those, so this
 * runs the real ones rather than reimplementing them as signals. What comes back is therefore an
 * equity curve and an outcome, not the thirty-stat panel a signal strategy produces: most of that
 * panel is about a population of trades, and most executors take one position and manage it.
 *
 * `createdAt` is overridden to the first candle in the range. A TWAP schedules its slices from
 * when the executor was created, so replaying a saved one over last March with its real creation
 * date would place every slice outside the window and report that it did nothing.
 */

export interface ExecutorReplayResult {
  equityCurve: EquityPoint[]
  finalState: SingleMarketExecutorState
  startingBalance: number
  finishingBalance: number
  netProfit: number
  netProfitPct: number
  /** Signed, and negative: a fall from the running peak, matching the strategy backtest. */
  maxDrawdownPct: number
  /** Candles the range actually covered, after any exchange truncation. */
  candles: number
  /** How many equity points were computed. Fewer than `candles` by design -- see SAMPLE_POINTS. */
  samples: number
}

/** The curve is sampled rather than computed per candle, because each point costs a full replay:
 * the executor simulators return only a final state, so "what was this worth at candle i" means
 * running the simulation over candles 0..i. Per candle that is quadratic and unusable on a
 * 90-day 15m range; at a couple of hundred points it is linear enough to be instant and still
 * draws a curve no one can tell from the dense one. The final candle is always included, so the
 * reported result is exact even though the curve between points is sampled. */
const SAMPLE_POINTS = 200

function sampleIndices(count: number, points: number): number[] {
  if (count <= 0) return []
  if (count <= points) return Array.from({ length: count }, (_, i) => i)
  const step = (count - 1) / (points - 1)
  const indices = Array.from({ length: points }, (_, i) => Math.round(i * step))
  // Rounding can repeat an index near the ends; a duplicated timestamp draws as a vertical jump.
  return [...new Set(indices)]
}

export function replayExecutor(
  candles: Candle[],
  executor: ExecutorConfig,
  startingBalance: number
): ExecutorReplayResult | null {
  if (candles.length === 0) return null

  const scoped: ExecutorConfig = { ...executor, createdAt: candles[0].time }
  const basePrice = candles[0].close
  const equityCurve: EquityPoint[] = []

  let peak = startingBalance
  let maxDrawdownPct = 0

  for (const index of sampleIndices(candles.length, SAMPLE_POINTS)) {
    const upTo = candles.slice(0, index + 1)
    const candle = candles[index]
    const state = runExecutorSimulation(upTo, scoped, basePrice)
    const value = startingBalance + executorPnlFromState(state, scoped.params, candle.close, candle.time)
    equityCurve.push({ time: candle.time, value })

    peak = Math.max(peak, value)
    if (peak > 0) maxDrawdownPct = Math.min(maxDrawdownPct, ((value - peak) / peak) * 100)
  }

  const finalState = runExecutorSimulation(candles, scoped, basePrice)
  const last = candles[candles.length - 1]
  const finishingBalance = startingBalance + executorPnlFromState(finalState, scoped.params, last.close, last.time)

  return {
    equityCurve,
    finalState,
    startingBalance,
    finishingBalance,
    netProfit: finishingBalance - startingBalance,
    netProfitPct: startingBalance > 0 ? ((finishingBalance - startingBalance) / startingBalance) * 100 : 0,
    maxDrawdownPct,
    candles: candles.length,
    samples: equityCurve.length
  }
}

/** One line saying what the executor actually did, in its own vocabulary rather than a strategy's.
 *
 * Deliberately not "12 trades, 41% win rate": a grid cycling levels, a DCA ladder and a TWAP
 * schedule count completely different things, and flattening them into a shared trade count is
 * how a number stops meaning anything. */
export function describeExecutorOutcome(state: SingleMarketExecutorState): string {
  if (state.kind === 'grid') {
    const open = state.levels.filter((l) => l.status === 'filled').length
    const stopped = state.stoppedAt !== null ? ' Stop Price was hit, so the grid closed everything and froze.' : ''
    return `${state.closedLevels} level round trip${state.closedLevels === 1 ? '' : 's'} completed, ${open} still holding at the end.${stopped}`
  }
  if (state.kind === 'dca') {
    const filled = state.fills.length
    if (state.status === 'closed') return `${filled} of the ladder's levels filled, then the position closed.`
    return filled === 0 ? 'No level was ever reached — nothing was bought.' : `${filled} level${filled === 1 ? '' : 's'} filled and the position was still open at the end.`
  }
  if (state.kind === 'twap') {
    return `${state.fills.length} of ${state.numOrders} slices executed.`
  }
  if (state.kind === 'position') {
    if (state.status === 'closed') return `Entered and closed — ${state.exitReason ?? 'exit'}.`
    if (state.status === 'open') return 'Entered and still open at the end of the range.'
    return 'The entry price was never reached — nothing was bought.'
  }
  if (state.kind === 'order') {
    return state.status === 'filled' ? 'The order filled.' : 'The order never filled.'
  }
  return `${state.filledBuys} buy${state.filledBuys === 1 ? '' : 's'} and ${state.filledSells} sell${state.filledSells === 1 ? '' : 's'} filled, ${state.inventoryBaseQty === 0 ? 'ending flat' : 'still holding inventory'}.`
}
