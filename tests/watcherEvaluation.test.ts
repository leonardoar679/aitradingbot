import { describe, it, expect } from 'vitest'
import { evaluateWatcher, type WatcherBarriers } from '../electron/services/watcherEvaluation'

// Entry 100, stop loss -5%, take profit +10%, trailing 2% once price is +3% up.
const BASE: WatcherBarriers = {
  entryPrice: 100,
  takeProfitPct: 10,
  stopLossPct: 5,
  timeLimitSec: null,
  trailingStop: { activationPct: 3, trailPct: 2 },
  trailingPeakPrice: 100,
  enteredAt: 0
}

/** Feeds prices in order the way tick() does -- persisting the peak between ticks. */
function replay(prices: number[], start: WatcherBarriers = BASE) {
  let peak = start.trailingPeakPrice
  const exits: (string | null)[] = []
  for (const price of prices) {
    const result = evaluateWatcher({ ...start, trailingPeakPrice: peak }, price, 10)
    peak = result.newPeak
    exits.push(result.reason)
  }
  return { peak, exits }
}

describe('evaluateWatcher', () => {
  it('fires the stop loss when price falls through it', () => {
    expect(evaluateWatcher(BASE, 94, 10).reason).toBe('stop_loss')
  })

  it('fires the trailing stop after the peak activates it', () => {
    const { exits } = replay([103, 106, 103.8])
    expect(exits).toEqual([null, null, 'trailing_stop'])
  })

  it('tracks the peak upward and never downward', () => {
    expect(replay([103, 106, 104]).peak).toBe(106)
  })

  it('does not let an unusable price destroy the tracked peak', () => {
    // fetchTicker24h builds lastPrice with Number(...) over an API field, and two adapters pass
    // the raw value straight through. A malformed response yields NaN, and Math.max(NaN, x) is
    // NaN forever after -- one bad tick used to disable the trailing stop for the whole session
    // while consecutiveFailures stayed 0 and the position read as healthy.
    const { peak } = replay([103, 106, NaN])
    expect(peak).toBe(106)
  })

  it('keeps the trailing stop working after an unusable price', () => {
    const { exits } = replay([103, 106, NaN, 103.8])
    expect(exits[3]).toBe('trailing_stop')
  })

  it('claims no exit from an unusable price', () => {
    // Every comparison against NaN is false, so a garbage price already produced "no exit" -- but
    // by accident, not because anything was checked. It must stay null deliberately.
    expect(evaluateWatcher(BASE, NaN, 10).reason).toBeNull()
    expect(evaluateWatcher(BASE, Infinity, 10).reason).toBeNull()
    expect(evaluateWatcher(BASE, 0, 10).reason).toBeNull()
    expect(evaluateWatcher(BASE, -5, 10).reason).toBeNull()
  })

  it('recovers a peak that was persisted as null to the entry price, not to the current price', () => {
    // JSON cannot hold NaN, so a poisoned peak reaches disk as null. Math.max(null, price) is
    // just price, which silently re-bases a trailing stop that had legitimately climbed to 110
    // onto whatever the market happens to be at on restart. The peak is at least the entry price
    // by definition, so that is the safe floor.
    const loaded = { ...BASE, trailingPeakPrice: null as unknown as number }
    expect(evaluateWatcher(loaded, 95, 10).newPeak).toBe(100)
  })

  it('still fires the stop loss on the tick after an unusable price', () => {
    const { exits } = replay([103, NaN, 94])
    expect(exits[2]).toBe('stop_loss')
  })
})
