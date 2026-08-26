import type { ControllerRiskControls } from '../../shared/ipc'

/** Whether a controller's risk controls have been crossed, and by which one.
 *
 * Lifted out of ControllerScheduler's snapshot tick, where it was three inline booleans inside a
 * React module -- so nothing could test the one decision in this app that stops every executor a
 * user has running, and nothing could tell them afterwards WHICH limit did it. The rules are
 * otherwise unchanged, apart from the zero-limit case below.
 *
 * The limits are stored signed-agnostic (`Math.abs` on both sides live), so a user who types -10
 * into "Max Drawdown" gets the 10% they meant rather than a control that can never fire. */

export type ControllerBreachKind = 'stop-loss' | 'take-profit' | 'max-drawdown'

export interface ControllerBreach {
  kind: ControllerBreachKind
  /** The configured limit, always a positive magnitude. */
  limitPct: number
  /** The figure that crossed it: P&L against allocated capital, or drawdown from peak equity. */
  actualPct: number
}

/** A limit of zero is not a limit -- it is an instant stop, and always a mistake.
 *
 * The controller form saves whatever number is typed (`stopLossPct ? Number(stopLossPct) : null`
 * keeps "0", because the string "0" is truthy), and every one of the three comparisons is
 * non-strict, so a zero reaches them and fires on the very first snapshot:
 *
 *   Max Drawdown 0%  ->  drawdown 0 >= 0        stops everything before the price has moved
 *   Take Profit  0%  ->  P&L      0 >= 0        stops everything at break-even
 *   Stop Loss    0%  ->  P&L      0 <= -0       stops everything at break-even
 *
 * Someone typing 0 means "no limit" or has fat-fingered a field; nobody means "close all my
 * positions on the next tick regardless of price". Treated as unset here, and refused by the form,
 * so an already-saved zero cannot stop a running controller either. */
function activeLimit(value: number | null): number | null {
  if (value === null) return null
  const magnitude = Math.abs(value)
  return Number.isFinite(magnitude) && magnitude > 0 ? magnitude : null
}

/** `pnlPct` is aggregate P&L as a percentage of allocated capital; `drawdownPct` is the positive
 * fall from peak equity that controllerDrawdownPct returns.
 *
 * Throws rather than returning "no breach" when either figure is not a real number. Every
 * comparison below is false against NaN, so an unreadable P&L would quietly *disable* all three
 * controls -- the failure mode where a stop-loss silently does nothing is the worst one available,
 * and the caller already refuses to act on P&L it could not compute. */
export function evaluateControllerRisk(
  controls: ControllerRiskControls,
  pnlPct: number,
  drawdownPct: number
): ControllerBreach | null {
  if (!Number.isFinite(pnlPct) || !Number.isFinite(drawdownPct)) {
    throw new Error(`Cannot check risk controls against an unreadable P&L (${pnlPct}%) or drawdown (${drawdownPct}%)`)
  }

  // Order matters only when two fire on the same tick, which is possible for a loss and a
  // drawdown, and for a drawdown and a take-profit. The reason shown should be the one that
  // explains the stop: a loss limit over a drawdown, and a drawdown over a take-profit, since a
  // take-profit that coincides with a drawdown is not why the run ended where it did.
  const stopLoss = activeLimit(controls.globalStopLossPct)
  if (stopLoss !== null && pnlPct <= -stopLoss) return { kind: 'stop-loss', limitPct: stopLoss, actualPct: pnlPct }

  const maxDrawdown = activeLimit(controls.maxDrawdownPct)
  if (maxDrawdown !== null && drawdownPct >= maxDrawdown) {
    return { kind: 'max-drawdown', limitPct: maxDrawdown, actualPct: drawdownPct }
  }

  const takeProfit = activeLimit(controls.globalTakeProfitPct)
  if (takeProfit !== null && pnlPct >= takeProfit) return { kind: 'take-profit', limitPct: takeProfit, actualPct: pnlPct }

  return null
}

/** What is wrong with a risk-limit field, or null if it is fine. Blank is fine -- all three
 * limits are optional, and blank is how "no limit" is spelled.
 *
 * The evaluator above already refuses to act on a zero, so this exists to say why the field is
 * rejected rather than letting someone save a control that looks armed and does nothing. */
export function describeRiskLimitProblem(raw: string): string | null {
  const trimmed = raw.trim()
  if (trimmed === '') return null
  const value = Number(trimmed)
  if (!Number.isFinite(value)) return 'That is not a number. Leave it blank for no limit.'
  if (Math.abs(value) === 0) return 'A limit of 0% would stop every attached executor on the next check. Leave it blank for no limit.'
  return null
}

/** One sentence a user can act on, naming the limit and the number that crossed it. Before this,
 * a breach stopped every attached executor and the page said only "stopped". */
export function describeControllerBreach(breach: ControllerBreach): string {
  const limit = `${breach.limitPct}%`
  if (breach.kind === 'stop-loss') {
    return `Stop loss hit — down ${Math.abs(breach.actualPct).toFixed(2)}% of allocated capital, limit ${limit}.`
  }
  if (breach.kind === 'take-profit') {
    return `Take profit hit — up ${breach.actualPct.toFixed(2)}% of allocated capital, target ${limit}.`
  }
  return `Max drawdown hit — ${breach.actualPct.toFixed(2)}% below the peak, limit ${limit}.`
}
