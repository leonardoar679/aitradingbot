import { scoreOpportunity, type OpportunityCall, type OpportunityCosts, type OpportunityOutcome } from '../aiOpportunityOutcome'
import type { Candle, ExecutorConfig, PositionExecutorParams } from '../ipc'
import { RESEARCH_MIN_TRADES, researchCalls, tradeStats, type ResearchInput, type TradeStats } from './common'

// EXIT RULES ON IDENTICAL ENTRIES (the V4 document, §63): the same calls, the same entries, and
// four ways out, each scored on the same minutes: the call's own bracket; an ATR stop (one and a
// half times the fourteen-bar average true range of the fifteen-minute bars before the event) with
// the call's target; a trailing stop (armed at 1% in favour, trailing by 0.5%) with the call's stop
// until then and no target; and a time stop (the call's horizon, no stop, no target). NET, after
// the fees and slippage the score charges. The exit check's own trades are a separate row, LIVE
// PAPER, as they were settled.

export const EXIT_RULES = ['plan', 'atr', 'trailing', 'time'] as const
export type ExitRule = (typeof EXIT_RULES)[number]
export const EXIT_RULE_NAMES: Record<ExitRule, string> = {
  plan: "The call's bracket (stop, target, horizon)",
  atr: 'An ATR stop: 1.5 × ATR14 on 15m, with the call\'s target',
  trailing: 'A trailing stop: armed at +1%, trailing 0.5%',
  time: 'A time stop: out at the horizon, no stop, no target'
}
export const ATR_BARS = 14
export const ATR_MULTIPLE = 1.5
export const TRAIL_ACTIVATION_PCT = 1
export const TRAIL_PCT = 0.5
const QUARTER_HOUR = 900
const BAR_SECONDS = 60

/** Fifteen-minute bars from one-minute bars, each from the minutes inside its quarter hour that
 * are all there; oldest first. */
export function quarterBars(minutes: readonly Candle[]): Candle[] {
  const byQuarter = new Map<number, Candle[]>()
  for (const bar of minutes) {
    const quarter = Math.floor(bar.time / QUARTER_HOUR) * QUARTER_HOUR
    byQuarter.set(quarter, [...(byQuarter.get(quarter) ?? []), bar])
  }
  const out: Candle[] = []
  for (const [time, bars] of [...byQuarter.entries()].sort((a, b) => a[0] - b[0])) {
    if (bars.length !== 15) continue
    const sorted = [...bars].sort((a, b) => a.time - b.time)
    out.push({
      time,
      open: sorted[0].open,
      high: Math.max(...sorted.map((bar) => bar.high)),
      low: Math.min(...sorted.map((bar) => bar.low)),
      close: sorted[sorted.length - 1].close,
      volume: sorted.reduce((sum, bar) => sum + bar.volume, 0)
    })
  }
  return out
}

/** The fourteen-bar average true range of the fifteen-minute bars that closed before `beforeSec`,
 * in price; null without fourteen of them. */
export function atr15m(lead: readonly Candle[], beforeSec: number, bars = ATR_BARS): number | null {
  const quarters = quarterBars(lead.filter((bar) => bar.time + BAR_SECONDS <= beforeSec)).filter((bar) => bar.time + QUARTER_HOUR <= beforeSec)
  if (quarters.length < bars + 1) return null
  const last = quarters.slice(-(bars + 1))
  let sum = 0
  for (let index = 1; index < last.length; index++) {
    const bar = last[index]
    const previousClose = last[index - 1].close
    sum += Math.max(bar.high - bar.low, Math.abs(bar.high - previousClose), Math.abs(bar.low - previousClose))
  }
  return sum / bars
}

/** The call with a trailing stop: the call's stop until the price is `activationPct` in its
 * favour, then a stop `trailPct` behind the best price, and no target; out at the horizon
 * otherwise. Scored as the score scores a call, on the same minutes. */
export function trailingOutcome(call: OpportunityCall, bars: Candle[], nowSec: number, costs: OpportunityCosts, trail: { activationPct: number; trailPct: number } = { activationPct: TRAIL_ACTIVATION_PCT, trailPct: TRAIL_PCT }): OpportunityOutcome {
  const long = call.side === 'long'
  const sign = long ? 1 : -1
  // The entry, as the score finds it: no earlier than the answer, inside the range, before expiry.
  const base = scoreOpportunity({ ...call, stopLoss: long ? 0 : Number.MAX_VALUE, takeProfit: long ? Number.MAX_VALUE : 0 }, bars, nowSec, costs)
  if (base.status !== 'closed' && base.status !== 'open') return base
  if (base.entryTime === null || base.entryPrice === null) return base
  const marketFill = (price: number, buying: boolean): number => price * (buying ? 1 + costs.slippageRate : 1 - costs.slippageRate)
  const entryPrice = base.entryPrice
  const netAt = (exitPrice: number): number => sign * (exitPrice / entryPrice - 1) * 100 - costs.feeRate * (1 + exitPrice / entryPrice) * 100
  const excursion = (price: number): number => sign * (price / entryPrice - 1) * 100
  const atStop = netAt(marketFill(call.stopLoss, !long))
  const holdEnd = base.entryTime + call.holdSeconds
  let best = 0
  let worst = 0
  let peak = entryPrice
  let armed = false
  const closed = (exit: OpportunityOutcome['exit'], exitTime: number, exitPrice: number): OpportunityOutcome => {
    const netPct = netAt(exitPrice)
    return { status: 'closed', entryTime: base.entryTime, entryPrice, exit, exitTime, exitPrice, netPct, r: atStop < 0 ? netPct / -atStop : null, bestPct: best, worstPct: worst, heldMinutes: Math.round((exitTime + BAR_SECONDS - (base.entryTime ?? 0)) / BAR_SECONDS) }
  }
  const entryIndex = bars.findIndex((bar) => bar.time === base.entryTime)
  if (entryIndex < 0) return base
  for (let index = entryIndex; index < bars.length; index++) {
    const bar = bars[index]
    if (bar.time + BAR_SECONDS > nowSec) break
    const first = index === entryIndex
    const adverse = long ? bar.low : bar.high
    const favourable = long ? bar.high : bar.low
    // The stop that applies this minute: the call's until armed, the trail after.
    const stopLevel = armed ? (long ? peak * (1 - trail.trailPct / 100) : peak * (1 + trail.trailPct / 100)) : call.stopLoss
    const stopped = long ? adverse <= stopLevel : adverse >= stopLevel
    if (stopped) {
      const gapped = !first && (long ? bar.open < stopLevel : bar.open > stopLevel)
      const level = gapped ? bar.open : stopLevel
      worst = Math.min(worst, excursion(adverse))
      best = Math.max(best, excursion(favourable))
      return closed('stop_loss', bar.time, marketFill(level, !long))
    }
    best = Math.max(best, excursion(favourable))
    worst = Math.min(worst, excursion(adverse))
    if (long ? favourable > peak : favourable < peak) peak = favourable
    if (!armed && excursion(peak) >= trail.activationPct) armed = true
    if (bar.time + BAR_SECONDS >= holdEnd) return closed('time', bar.time, marketFill(bar.close, !long))
  }
  return { status: 'open', entryTime: base.entryTime, entryPrice, exit: null, exitTime: null, exitPrice: null, netPct: null, r: null, bestPct: best, worstPct: worst, heldMinutes: null }
}

export interface ExitRuleRow {
  rule: ExitRule
  name: string
  label: 'NET'
  stats: TradeStats
  /** Calls this rule could not be tried on: an ATR without the bars before the event. */
  unmeasured: number
}

/** The four rules on the same calls. `lead` holds, by event id, the minutes before each event the
 * ATR is read from. */
export function exitRuleRows(input: ResearchInput, lead: Readonly<Record<string, Candle[]>>): ExitRuleRow[] {
  const calls = researchCalls(input)
  const rows: ExitRuleRow[] = []
  for (const rule of EXIT_RULES) {
    const outcomes: OpportunityOutcome[] = []
    let unmeasured = 0
    for (const { event, call, costs } of calls) {
      const bars = input.bars[event.id] ?? []
      const long = call.side === 'long'
      if (rule === 'plan') outcomes.push(scoreOpportunity(call, bars, input.nowSec, costs))
      else if (rule === 'time') outcomes.push(scoreOpportunity({ ...call, stopLoss: long ? 0 : Number.MAX_VALUE, takeProfit: long ? Number.MAX_VALUE : 0 }, bars, input.nowSec, costs))
      else if (rule === 'trailing') outcomes.push(trailingOutcome(call, bars, input.nowSec, costs))
      else {
        const atr = atr15m(lead[event.id] ?? [], event.time)
        if (atr === null) {
          unmeasured++
          continue
        }
        const stopLoss = long ? call.entryMin - ATR_MULTIPLE * atr : call.entryMax + ATR_MULTIPLE * atr
        outcomes.push(scoreOpportunity({ ...call, stopLoss }, bars, input.nowSec, costs))
      }
    }
    rows.push({ rule, name: EXIT_RULE_NAMES[rule], label: 'NET', stats: tradeStats(outcomes), unmeasured })
  }
  return rows
}

export interface ExitCheckRow {
  label: 'LIVE PAPER'
  /** The app's own paper trades the exit check closed, and all its closed trades beside them. */
  closedByCheck: number
  closed: number
  /** The mean result in percent of the stake, each; null under the minimum. */
  meanPctByCheck: number | null
  meanPctOthers: number | null
  enough: boolean
}

/** What the exit check's actual exits made against the trades it left alone: from the watch's
 * closed paper trades on file, as they were settled. */
export function exitCheckRow(executors: readonly ExecutorConfig[]): ExitCheckRow {
  const closed = executors.filter((executor) => executor.watch?.result !== undefined && executor.watch.result.exit !== 'btc_moved' && executor.mode === 'paper')
  const pct = (executor: ExecutorConfig): number => {
    const params = executor.params as PositionExecutorParams
    const result = executor.watch?.result
    return result === undefined || !(params.amountQuote > 0) ? 0 : (result.pnlQuote / params.amountQuote) * 100
  }
  const byCheck = closed.filter((executor) => executor.watch?.result?.exit === 'ai_exit')
  const others = closed.filter((executor) => executor.watch?.result?.exit !== 'ai_exit')
  const meanPct = (set: ExecutorConfig[]): number | null => (set.length >= RESEARCH_MIN_TRADES ? set.reduce((sum, executor) => sum + pct(executor), 0) / set.length : null)
  return { label: 'LIVE PAPER', closedByCheck: byCheck.length, closed: closed.length, meanPctByCheck: meanPct(byCheck), meanPctOthers: meanPct(others), enough: byCheck.length >= RESEARCH_MIN_TRADES }
}
