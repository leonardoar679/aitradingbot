import type { LiveExitResult } from '../../shared/ipc'

/** The Triple Barrier decision for a live position, split out from livePositionWatchersService so
 * it can be tested without pulling in `electron`. This is the code path that decides whether real
 * money exits, so it is worth being able to exercise directly. */
export interface WatcherBarriers {
  entryPrice: number
  takeProfitPct: number | null
  stopLossPct: number | null
  timeLimitSec: number | null
  trailingStop: { activationPct: number; trailPct: number } | null
  trailingPeakPrice: number
  enteredAt: number
}

export interface WatcherDecision {
  reason: LiveExitResult['exitReason'] | null
  newPeak: number
}

/** Ported from simulatePosition (src/executors/engine.ts), buy-only (live spot can't short),
 * adapted from "candle wick touches a target" to "last-traded price crosses a target." Same
 * stop-loss > take-profit > trailing-stop > time-limit priority as the paper engine. Always
 * returns the updated trailing peak so the caller persists it even on a tick with no exit. */
export function evaluateWatcher(
  watcher: WatcherBarriers,
  currentPrice: number,
  nowSec: number
): WatcherDecision {
  // A peak reaches disk as null when it was ever poisoned, because JSON cannot hold NaN, and
  // Math.max(null, price) is just price -- silently re-basing a trailing stop that had
  // legitimately climbed onto whatever the market happens to be at on restart. The peak is at
  // least the entry price by definition, so that is the safe floor to come back to.
  const storedPeak = Number.isFinite(watcher.trailingPeakPrice) ? watcher.trailingPeakPrice : watcher.entryPrice

  // A price that is not a usable number is not evidence that no barrier was hit. Every
  // comparison below is false against NaN, so a malformed tick used to be indistinguishable
  // from a healthy one -- while Math.max(NaN, x) poisoned the peak for the rest of the session
  // and left the trailing stop unable to activate ever again. Bail before touching the peak;
  // the caller reports the bad price through the failure path the UI already surfaces.
  if (!Number.isFinite(currentPrice) || currentPrice <= 0) {
    return { reason: null, newPeak: storedPeak }
  }

  const newPeak = Math.max(storedPeak, currentPrice)

  const slTarget = watcher.stopLossPct !== null ? watcher.entryPrice * (1 - watcher.stopLossPct / 100) : null
  const slHit = slTarget !== null && currentPrice <= slTarget

  const tpTarget = watcher.takeProfitPct !== null ? watcher.entryPrice * (1 + watcher.takeProfitPct / 100) : null
  const tpHit = tpTarget !== null && currentPrice >= tpTarget

  let trailHit = false
  if (watcher.trailingStop !== null) {
    const activationTarget = watcher.entryPrice * (1 + watcher.trailingStop.activationPct / 100)
    if (newPeak >= activationTarget) {
      const trailTarget = newPeak * (1 - watcher.trailingStop.trailPct / 100)
      trailHit = currentPrice <= trailTarget
    }
  }

  const timeUp = watcher.timeLimitSec !== null && nowSec - watcher.enteredAt >= watcher.timeLimitSec

  const reason = slHit ? 'stop_loss' : tpHit ? 'take_profit' : trailHit ? 'trailing_stop' : timeUp ? 'time_limit' : null
  return { reason, newPeak }
}
