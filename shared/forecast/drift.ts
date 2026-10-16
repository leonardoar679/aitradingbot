// THE LIVE DRIFT GATE (V7.1 Stage 13, 16 October 2026). The walk forward judges a run on weeks it had not
// seen, but the market it is then run on is another: a horizon whose forecasts have been missing live --
// the 80% ranges of the last day holding under three in five of their outcomes -- is one the trader should
// not act on, whatever a single forecast says. Every decision at such a horizon is NO TRADE with the reason
// ENGINE_DRIFT (shared/forecast/tradeDecision.ts), shown on Home as any reason is; the forecasts themselves
// are still made and recorded, and nothing else is touched: no key, no cap, no kill switch, no strategy.
// The gate opens again on its own as the day's outcomes come right, or a refit is adopted and the next
// day's outcomes hold.
//
// IT IS ARITHMETIC on the outcomes the engine wrote. No key, no model, no order.

export const DRIFT_VERSION = 'drift-v1'

export const DRIFT_LINES = {
  /** The outcomes read: those due within this many seconds before now. */
  windowSec: 86_400,
  /** The fewest outcomes in the window before the gate can close. */
  minOutcomes: 50,
  /** The share of the window's outcomes inside their 80% range under which the horizon has drifted. */
  minCoverage80: 0.6
} as const

export interface DriftReading {
  outcomes: number
  /** NaN where there are none. */
  coverage80: number
  drifted: boolean
}

/** The horizon's drift from its outcomes due in the window before `nowSec`. */
export function driftOf(outcomes: readonly { due: number; in80: boolean }[], nowSec: number): DriftReading {
  const from = nowSec - DRIFT_LINES.windowSec
  let n = 0
  let held = 0
  for (const outcome of outcomes) {
    if (outcome.due < from || outcome.due > nowSec) continue
    n++
    if (outcome.in80) held++
  }
  const coverage80 = n === 0 ? Number.NaN : held / n
  return { outcomes: n, coverage80, drifted: n >= DRIFT_LINES.minOutcomes && coverage80 < DRIFT_LINES.minCoverage80 }
}

/** The outcomes still worth keeping for the gate: those due within the window before `nowSec`. */
export function pruneDrift<T extends { due: number }>(outcomes: readonly T[], nowSec: number): T[] {
  const from = nowSec - DRIFT_LINES.windowSec
  return outcomes.filter((outcome) => outcome.due >= from)
}
