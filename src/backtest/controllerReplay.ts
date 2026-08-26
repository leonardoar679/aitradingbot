import { executorAllocatedQuote } from '../executors/computeSnapshot'
import { runExecutorSimulation } from '../executors/engine'
import { executorPnlFromState } from '../executors/executorPnl'
import { controllerDrawdownPct } from '../controllers/riskMath'
import { evaluateControllerRisk, type ControllerBreach } from '../controllers/riskBreach'
import { SNAPSHOT_INTERVAL_MS } from '../controllers/types'
import { describeExecutorOutcome } from './executorReplay'
import type { Candle, ControllerConfig, ExecutorConfig } from '../../shared/ipc'
import type { EquityPoint } from './engine'

/** Replays a controller over a historical range: its attached executors run together, and its risk
 * controls are checked against their combined P&L exactly as the live scheduler checks them.
 *
 * A controller is not a strategy and this does not pretend it is one. It has no entry rule and
 * takes no position of its own -- it watches a group of executors and stops all of them at once
 * when the group's loss, gain, or fall from peak crosses a limit. So the question a controller
 * backtest answers is not "would this have made money" but "would these limits have fired, when,
 * and was the group better or worse off for it" -- which is why the uncontrolled result is
 * computed alongside and reported next to the controlled one.
 *
 * The percentages are against total allocated capital, not the Starting Capital field, because
 * that is the denominator the live controller uses. A run whose numbers were relative to something
 * else could not be compared with what the controller will actually do. */

export interface ControllerExecutorOutcome {
  id: string
  name: string
  type: ExecutorConfig['type']
  symbol: string
  allocatedQuote: number
  pnlQuote: number
  outcome: string
}

export interface ControllerReplayResult {
  /** Equity with the controller acting: flat after a breach, because everything was closed. */
  equityCurve: EquityPoint[]
  /** The same executors with no controller attached, for comparison. */
  uncontrolledCurve: EquityPoint[]
  allocatedQuote: number
  breach: { breach: ControllerBreach; atTime: number; pnlQuote: number } | null
  finalPnlQuote: number
  uncontrolledPnlQuote: number
  finalPnlPct: number
  uncontrolledPnlPct: number
  /** Positive, and measured the way the controller's own limit is: a fall from peak equity. */
  peakDrawdownPct: number
  executorOutcomes: ControllerExecutorOutcome[]
  /** Attached executors that could not be replayed, and why -- never silently dropped. */
  skipped: { name: string; reason: string }[]
  checks: number
  checkIntervalSec: number
  candles: number
}

/** Each check replays every attached executor from the start of the range, so the cost is
 * checks x executors x candles. The budget keeps a long range on several executors inside a
 * second or two; short ranges fall well under it and are checked at every candle. */
const CHECK_BUDGET_CANDLE_STEPS = 4_000_000
const MAX_CHECKS = 400
const MIN_CHECKS = 60

/** Checks are never spaced closer than the live snapshot interval.
 *
 * Without this, a range of 1-minute candles would be checked every minute -- five times more often
 * than the running app ever checks -- and would report a stop-loss firing on a dip the real
 * controller would have slept straight through. A backtest that catches breaches the live code
 * cannot catch is worse than useless: it is reassuring. */
const MIN_CHECK_SPACING_SEC = SNAPSHOT_INTERVAL_MS / 1000

function checkTimes(timeline: number[], executorCount: number, candleCount: number): number[] {
  if (timeline.length === 0) return []

  const spaced: number[] = []
  for (const time of timeline) {
    if (spaced.length === 0 || time - spaced[spaced.length - 1] >= MIN_CHECK_SPACING_SEC) spaced.push(time)
  }
  // The end of the range is always checked, even if it falls less than five minutes after the
  // previous one, so the reported final result is the range's actual end rather than up to one
  // interval short of it. That last check is the only one that can sit closer than the live
  // interval, and it is the one moment a real controller would also see.
  const last = timeline[timeline.length - 1]
  if (spaced[spaced.length - 1] !== last) spaced.push(last)

  const affordable = Math.floor(CHECK_BUDGET_CANDLE_STEPS / Math.max(1, executorCount * candleCount))
  const budgeted = Math.min(MAX_CHECKS, Math.max(MIN_CHECKS, affordable))
  if (spaced.length <= budgeted) return spaced

  const step = (spaced.length - 1) / (budgeted - 1)
  const picked = Array.from({ length: budgeted }, (_, i) => spaced[Math.round(i * step)])
  return [...new Set(picked)]
}

interface ReplayableExecutor {
  config: ExecutorConfig
  candles: Candle[]
  allocatedQuote: number
}

/** `candlesBySymbol` is what was fetched for the range -- one entry per distinct symbol among the
 * attached executors, since a controller can supervise executors on different markets. */
export function replayController(
  controller: ControllerConfig,
  executors: ExecutorConfig[],
  candlesBySymbol: Record<string, Candle[]>
): ControllerReplayResult | null {
  const attached = executors.filter((e) => controller.executorIds.includes(e.id))
  const skipped: { name: string; reason: string }[] = []
  const replayable: ReplayableExecutor[] = []

  for (const config of attached) {
    // XEMM and Arbitrage price two markets at once and run on a different simulator entirely
    // (runExecutorSimulation throws for them). Named as skipped rather than quietly left out, so
    // the totals below are not read as covering executors they never touched.
    if (config.type === 'xemm' || config.type === 'arbitrage') {
      skipped.push({ name: config.name, reason: `${config.type} executors price two markets at once and cannot be replayed here.` })
      continue
    }
    const candles = candlesBySymbol[config.symbol] ?? []
    if (candles.length === 0) {
      skipped.push({ name: config.name, reason: `No ${config.symbol} candles in that range.` })
      continue
    }
    replayable.push({ config: { ...config, createdAt: candles[0].time }, candles, allocatedQuote: executorAllocatedQuote(config) })
  }

  if (replayable.length === 0) return null

  const timeline = [...new Set(replayable.flatMap((r) => r.candles.map((c) => c.time)))].sort((a, b) => a - b)
  const candleCount = Math.max(...replayable.map((r) => r.candles.length))
  const times = checkTimes(timeline, replayable.length, candleCount)
  const allocatedQuote = replayable.reduce((sum, r) => sum + r.allocatedQuote, 0)

  const equityCurve: EquityPoint[] = []
  const uncontrolledCurve: EquityPoint[] = []
  const pnlHistory: number[] = []
  let breach: ControllerReplayResult['breach'] = null
  let peakDrawdownPct = 0

  // Each executor's candles are walked with a cursor rather than re-filtered: the check times are
  // increasing, so the slice boundary only ever moves forward.
  const cursors = replayable.map(() => 0)

  for (const time of times) {
    let aggregate = 0
    for (const [i, entry] of replayable.entries()) {
      while (cursors[i] < entry.candles.length && entry.candles[cursors[i]].time <= time) cursors[i]++
      if (cursors[i] === 0) continue
      const upTo = entry.candles.slice(0, cursors[i])
      const state = runExecutorSimulation(upTo, entry.config, entry.candles[0].close)
      aggregate += executorPnlFromState(state, entry.config.params, upTo[upTo.length - 1].close, time)
    }

    uncontrolledCurve.push({ time, value: allocatedQuote + aggregate })

    if (breach !== null) {
      // Frozen: the breach stopped and settled every attached executor, so the controlled side
      // holds its value from that moment while the uncontrolled side carries on.
      equityCurve.push({ time, value: allocatedQuote + breach.pnlQuote })
      continue
    }

    equityCurve.push({ time, value: allocatedQuote + aggregate })
    pnlHistory.push(aggregate)

    const pnlPct = allocatedQuote > 0 ? (aggregate / allocatedQuote) * 100 : 0
    const drawdownPct = controllerDrawdownPct(pnlHistory, aggregate, allocatedQuote)
    peakDrawdownPct = Math.max(peakDrawdownPct, drawdownPct)

    const hit = evaluateControllerRisk(controller.riskControls, pnlPct, drawdownPct)
    if (hit !== null) breach = { breach: hit, atTime: time, pnlQuote: aggregate }
  }

  const executorOutcomes: ControllerExecutorOutcome[] = replayable.map((entry) => {
    // Each executor is reported as the controller left it: cut short at the breach if there was
    // one, so a per-executor figure cannot add up to something other than the total above.
    const upTo = breach === null ? entry.candles : entry.candles.filter((c) => c.time <= (breach as { atTime: number }).atTime)
    const candles = upTo.length === 0 ? entry.candles.slice(0, 1) : upTo
    const state = runExecutorSimulation(candles, entry.config, entry.candles[0].close)
    const last = candles[candles.length - 1]
    return {
      id: entry.config.id,
      name: entry.config.name,
      type: entry.config.type,
      symbol: entry.config.symbol,
      allocatedQuote: entry.allocatedQuote,
      pnlQuote: executorPnlFromState(state, entry.config.params, last.close, last.time),
      outcome: describeExecutorOutcome(state)
    }
  })

  const uncontrolledPnlQuote = uncontrolledCurve[uncontrolledCurve.length - 1].value - allocatedQuote
  const finalPnlQuote = breach !== null ? breach.pnlQuote : uncontrolledPnlQuote
  const asPct = (quote: number): number => (allocatedQuote > 0 ? (quote / allocatedQuote) * 100 : 0)

  return {
    equityCurve,
    uncontrolledCurve,
    allocatedQuote,
    breach,
    finalPnlQuote,
    uncontrolledPnlQuote,
    finalPnlPct: asPct(finalPnlQuote),
    uncontrolledPnlPct: asPct(uncontrolledPnlQuote),
    peakDrawdownPct,
    executorOutcomes,
    skipped,
    checks: times.length,
    checkIntervalSec: times.length > 1 ? (times[times.length - 1] - times[0]) / (times.length - 1) : 0,
    candles: timeline.length
  }
}

/** What the controller did, in one line, for someone who has not read any of the above. */
export function describeControllerOutcome(result: ControllerReplayResult): string {
  if (result.breach === null) return 'No limit was ever crossed — the controller would have let every executor run to the end of the range.'
  const difference = result.finalPnlQuote - result.uncontrolledPnlQuote
  const verdict =
    Math.abs(difference) < 0.005
      ? 'which made no difference to the final result'
      : difference > 0
        ? `which was worth ${difference.toFixed(2)} more than letting them run`
        : `which cost ${Math.abs(difference).toFixed(2)} against letting them run`
  return `The controller stopped every attached executor, ${verdict}.`
}
