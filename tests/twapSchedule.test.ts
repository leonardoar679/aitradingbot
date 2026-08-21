import { describe, it, expect } from 'vitest'
import { computeNextSliceAt } from '../electron/services/liveTwapService'

// A TWAP whose schedule falls behind real time must NOT fire its backlog back-to-back: the
// loop ticks every few seconds, so an 8-hour gap would otherwise place every remaining real
// market order within a minute.
const INTERVAL = 3600
const POLL = 5
const NUM_ORDERS = 10

/** Replays the real loop, using the real scheduling rule when `withGuard`. */
function simulate(withGuard: boolean, gapSeconds: number): { firedInFirstMinute: number; sliceTimes: number[] } {
  let nextSliceAt = 1_000_000 + INTERVAL
  let sliceIndex = 1
  let now = 1_000_000 + gapSeconds
  const start = now
  let firedInFirstMinute = 0
  const sliceTimes: number[] = []

  for (let step = 0; step < 20_000 && sliceIndex < NUM_ORDERS; step++) {
    if (now >= nextSliceAt) {
      sliceTimes.push(nextSliceAt)
      if (now - start <= 60) firedInFirstMinute++
      sliceIndex++
      nextSliceAt = withGuard ? computeNextSliceAt(nextSliceAt, INTERVAL, now) : nextSliceAt + INTERVAL
    }
    now += POLL
  }
  return { firedInFirstMinute, sliceTimes }
}

describe('live TWAP slice scheduling', () => {
  it('does not dump the backlog after the app was closed for hours', () => {
    const gap = 8 * 3600
    expect(simulate(false, gap).firedInFirstMinute).toBeGreaterThan(1) // the old behaviour
    expect(simulate(true, gap).firedInFirstMinute).toBe(1)
  })

  it('leaves normal cadence exactly on schedule when nothing is late', () => {
    expect(simulate(true, 0).sliceTimes.slice(0, 4)).toEqual([1_003_600, 1_007_200, 1_010_800, 1_014_400])
  })

  it('matches the unguarded cadence when the app never falls behind', () => {
    expect(simulate(true, 0).sliceTimes).toEqual(simulate(false, 0).sliceTimes)
  })
})
