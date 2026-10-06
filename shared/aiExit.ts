import { EXIT_TRIGGERS, describeExitTrigger, type ExitTrigger } from './aiAdditions'
import type { AiExitMark, ExecutorConfig, PositionExecutorParams, PositionExitReason } from './ipc'
import { describeR, rMultiple } from './paperRisk'

// WHAT THE EXIT CHECK'S EXIT DOES TO A PAPER TRADE, AND WHAT IT CAME TO (shared/aiAdditions.ts asks).
//
// AN EXIT BRINGS THE TRADE'S TIME LIMIT FORWARD, AND NOTHING ELSE. The new limit ends the trade in the
// minute after the answer was acted on, counted from where the engine says it entered. So the engine
// ends it by its own rule, at that minute's close, the way it ends any trade whose time is up; and the
// settle loops that stop and book every one of the app's own paper trades stop and book this one the
// same way. Its stop and its target stay where they were and keep working in that last minute: one
// hit first ends the trade itself. A time limit is only ever made shorter. A trade whose own clock
// ends it as soon is left as it is.
//
// THE PLAN AS IT WAS IS KEPT BESIDE IT: the time limit it had, and where it entered. Once that time
// has passed, the settle loops simulate the plan to its own end on the same minutes and write what it
// would have made beside what the exit made. The difference, in R, is whether the check helps.
//
// PAPER ONLY. The two files that write it (src/agents/watchPaperTrade.ts, src/news/newsPaperShort.ts)
// find the trade among their own paper positions, and nothing here makes or reads a live one.

/** An EXIT to act on: the trade, where the engine says it entered, and what was said. */
export interface AiExitOrder {
  executorId: string
  enteredAt: number
  model: string
  triggers: readonly string[]
  confidence: number
  reason: string
}

/** What acting on an EXIT writes: the trade's parameters with its time limit brought forward to end
 * it in the minute after `nowSec`, and the mark that says so. Null when there is nothing to bring
 * forward: its own time limit ends it in that minute or sooner, it has none to measure the plan by,
 * or the entry given is not a minute at or before now. */
export function aiExitWrite(input: {
  params: PositionExecutorParams
  enteredAt: number
  nowSec: number
  model: string
  triggers: readonly string[]
  confidence: number
  reason: string
}): { params: PositionExecutorParams; mark: AiExitMark } | null {
  const { params, enteredAt, nowSec } = input
  const plan = params.timeLimitSec
  if (plan === null || !(enteredAt <= nowSec) || enteredAt % 60 !== 0) return null
  const closeAt = Math.floor(nowSec / 60) * 60 + 60
  const limit = closeAt - enteredAt
  if (plan <= limit) return null
  return {
    params: { ...params, timeLimitSec: limit },
    mark: { at: nowSec, closeAt, enteredAt, planTimeLimitSec: plan, model: input.model, triggers: [...input.triggers], confidence: input.confidence, reason: input.reason }
  }
}

/** The plan as it was before the check closed the trade: the same parameters, with the time limit
 * it had. */
export function aiExitPlanParams(params: PositionExecutorParams, mark: Pick<AiExitMark, 'planTimeLimitSec'>): PositionExecutorParams {
  return { ...params, timeLimitSec: mark.planTimeLimitSec }
}

/** The minute the plan's own time limit ends it in, at the latest. */
export function aiExitPlanEnd(mark: Pick<AiExitMark, 'enteredAt' | 'planTimeLimitSec'>): number {
  return mark.enteredAt + mark.planTimeLimitSec
}

/** How long after the plan's end its minutes are waited for, before it is written down as not
 * measured. */
export const AI_EXIT_PLAN_PATIENCE_SECONDS = 86_400

/** The plan's result from its simulation on the minutes read: its exit and what it made, once it has
 * ended; null when it still has not after its minutes were waited for long enough; undefined until
 * then. */
export function aiExitPlanResult(
  state: { status: 'pending' | 'open' | 'closed'; exitReason: PositionExitReason | null; realizedPnl: number | null; closedAt: number | null } | null,
  mark: Pick<AiExitMark, 'enteredAt' | 'planTimeLimitSec'>,
  nowSec: number
): AiExitMark['plan'] | undefined {
  if (state !== null && state.status === 'closed' && state.exitReason !== null) {
    return { exit: state.exitReason, pnlQuote: state.realizedPnl ?? 0, closedAt: state.closedAt ?? aiExitPlanEnd(mark) }
  }
  return nowSec > aiExitPlanEnd(mark) + AI_EXIT_PLAN_PATIENCE_SECONDS ? null : undefined
}

/** How a trade is written down as having ended: one the check closed and the time limit it brought
 * forward ended is the check's exit. Its own stop or target, hit first, is theirs. */
export function aiExitOutcome(reason: PositionExitReason, mark: AiExitMark | undefined): PositionExitReason | 'ai_exit' {
  return reason === 'time_limit' && mark !== undefined ? 'ai_exit' : reason
}

/** The app's own paper trades the check has closed, on file. */
function exitedTrades(executors: ExecutorConfig[]): { executor: ExecutorConfig; mark: AiExitMark; result: { pnlQuote: number } }[] {
  const out: { executor: ExecutorConfig; mark: AiExitMark; result: { pnlQuote: number } }[] = []
  for (const executor of executors) {
    if (executor.mode !== 'paper' || executor.type !== 'position' || executor.status !== 'stopped') continue
    const own = executor.watch ?? executor.newsRule
    if (own?.aiExit === undefined || own.result === undefined) continue
    out.push({ executor, mark: own.aiExit, result: own.result })
  }
  return out
}

/** What the exit check's exits came to against the plans they cut short, from what is on file. */
export interface AiExitTally {
  /** The app's own paper trades it closed that have ended. */
  closed: number
  /** Of those, the ones whose plan has been worked out... */
  measured: number
  /** ...and of those, the ones the exit made more than the plan would have, less, and the same. */
  better: number
  worse: number
  same: number
  /** What the exits made less what the plans would have, in R, added up over the measured ones with a
   * stop -- R has no asset -- and how many there were. */
  rDiff: number
  rTrades: number
  /** The same in money, by quote asset, in the order first seen. */
  quoteDiff: { asset: string; amount: number }[]
  /** Ones whose plan's minutes could not be read to the end. */
  unmeasured: number
}

export function aiExitTally(executors: ExecutorConfig[]): AiExitTally {
  const tally: AiExitTally = { closed: 0, measured: 0, better: 0, worse: 0, same: 0, rDiff: 0, rTrades: 0, quoteDiff: [], unmeasured: 0 }
  for (const { executor, mark, result } of exitedTrades(executors)) {
    tally.closed++
    if (mark.plan === undefined) continue
    if (mark.plan === null) {
      tally.unmeasured++
      continue
    }
    tally.measured++
    const diff = result.pnlQuote - mark.plan.pnlQuote
    if (Math.abs(diff) < 1e-9) tally.same++
    else if (diff > 0) tally.better++
    else tally.worse++
    const held = tally.quoteDiff.find((entry) => entry.asset === executor.quoteAsset)
    if (held === undefined) tally.quoteDiff.push({ asset: executor.quoteAsset, amount: diff })
    else held.amount += diff
    const params = executor.params as PositionExecutorParams
    const taken = rMultiple(result.pnlQuote, params)
    const planned = rMultiple(mark.plan.pnlQuote, params)
    if (taken !== null && planned !== null) {
      tally.rDiff += taken - planned
      tally.rTrades++
    }
  }
  return tally
}

/** An amount of a quote asset with its sign, to four significant digits: "+3.786 USDT". */
function signedQuote(amount: number, asset: string): string {
  const shown = Number(amount.toPrecision(4))
  return `${shown > 0 ? '+' : ''}${shown} ${asset}`
}

/** The tally in a sentence or two. A sum and counts: not a rate. */
export function describeAiExitTally(tally: AiExitTally): string {
  if (tally.closed === 0) return "The exit check has closed none of the app's paper trades yet."
  const closed = `It has closed ${tally.closed} of the app's paper trades early.`
  const waiting = tally.closed - tally.measured - tally.unmeasured
  const pending = waiting === 0 ? '' : ` ${waiting} ${waiting === 1 ? 'is' : 'are'} still waiting for ${waiting === 1 ? 'its' : 'their'} plan's time to pass.`
  const lost = tally.unmeasured === 0 ? '' : ` ${tally.unmeasured} could not be measured.`
  if (tally.measured === 0) return `${closed}${pending}${lost}`
  const same = tally.same === 0 ? '' : `, ${tally.same} the same`
  const money = tally.quoteDiff.map((entry) => signedQuote(entry.amount, entry.asset)).join(', ')
  const r = tally.rTrades === 0 ? '' : `${describeR(tally.rDiff)}${tally.rTrades < tally.measured ? ` for the ${tally.rTrades} with a stop` : ''}, `
  return `${closed} Against the ${tally.measured} ${tally.measured === 1 ? 'plan' : 'plans'} it cut short: ${tally.better} better, ${tally.worse} worse${same}; ${r}${money} after fees in all.${pending}${lost}`
}

function utcClock(sec: number): string {
  return new Date(sec * 1000).toISOString().slice(11, 16)
}

/** The reasons on a mark, in words: the ones it knows. */
export function describeAiExitTriggers(triggers: readonly string[]): string {
  return triggers.filter((trigger): trigger is ExitTrigger => (EXIT_TRIGGERS as readonly string[]).includes(trigger)).map(describeExitTrigger).join(', ')
}

/** What a trade's card says about an EXIT on it: when, why and what was said, what it did, and what
 * the plan would have made, once that is known. */
export function describeAiExit(mark: AiExitMark, quoteAsset: string, params: Pick<PositionExecutorParams, 'amountQuote' | 'stopLossPct'>): string {
  const why = describeAiExitTriggers(mark.triggers)
  const said = `The exit check (${mark.model}) answered EXIT at ${utcClock(mark.at)} UTC${why === '' ? '' : `, asked because ${why}`}: "${mark.reason}"`
  const did = ` Its time limit was brought forward to close it in the minute of ${utcClock(mark.closeAt)} UTC; the plan would have run to ${utcClock(aiExitPlanEnd(mark))} UTC. Paper.`
  if (mark.plan === undefined) return `${said}${did}`
  if (mark.plan === null) return `${said}${did} What the plan would have made could not be measured.`
  const r = rMultiple(mark.plan.pnlQuote, params)
  return `${said}${did} The plan would have made ${signedQuote(mark.plan.pnlQuote, quoteAsset)} after fees${r === null ? '' : `, ${describeR(r)}`}.`
}
