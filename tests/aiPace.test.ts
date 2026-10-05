import { describe, expect, it } from 'vitest'
import { AI_CALLS_PER_MINUTE_CHOICES, DEFAULT_AI_CALLS_PER_MINUTE, isCallsPerMinute, paceDelayMs, pacedMinimumMs } from '../shared/aiPace'

// How fast one model is asked: no more than so many calls starting in any sixty seconds.

const T = 1_791_170_000_000

describe('paceDelayMs', () => {
  it('lets a call start at once while the minute has room', () => {
    expect(paceDelayMs([], T, 10)).toBe(0)
    expect(paceDelayMs(Array.from({ length: 9 }, (_, i) => T - i * 1000), T, 10)).toBe(0)
  })

  it('makes the next call wait for the oldest of the minute to leave it', () => {
    // Ten calls, one every second, the last just now: the eleventh waits until the first is a
    // minute old.
    const starts = Array.from({ length: 10 }, (_, i) => T - 9000 + i * 1000)
    expect(paceDelayMs(starts, T, 10)).toBe(60_000 - 9000)
    // Out of order is the same.
    expect(paceDelayMs([...starts].reverse(), T, 10)).toBe(51_000)
    // Exactly a minute after the oldest, there is room again.
    expect(paceDelayMs(starts, T - 9000 + 60_000, 10)).toBe(0)
  })

  it('counts only the last sixty seconds, and nothing that has not started', () => {
    const old = Array.from({ length: 30 }, (_, i) => T - 60_000 - i)
    expect(paceDelayMs(old, T, 10)).toBe(0)
    // A start in the future is not a start yet.
    expect(paceDelayMs([T + 5000, T + 6000], T, 2)).toBe(0)
  })

  it('waits for the right one when more are in the minute than the pace allows', () => {
    // Twelve in the minute at a pace of ten (the pace was lowered): the next waits for three of
    // them to leave, not one.
    const starts = Array.from({ length: 12 }, (_, i) => T - 12_000 + i * 1000)
    expect(paceDelayMs(starts, T, 10)).toBe(T - 10_000 + 60_000 - T)
  })
})

describe('pacedMinimumMs', () => {
  it('is no time for what fits in one minute, and a minute for each window after it', () => {
    expect(pacedMinimumMs(0, 30)).toBe(0)
    expect(pacedMinimumMs(1, 30)).toBe(0)
    expect(pacedMinimumMs(30, 30)).toBe(0)
    expect(pacedMinimumMs(31, 30)).toBe(60_000)
    expect(pacedMinimumMs(100, 30)).toBe(3 * 60_000)
    expect(pacedMinimumMs(100, 60)).toBe(60_000)
    expect(pacedMinimumMs(10, 0)).toBe(0)
  })
})

describe('the setting', () => {
  it('is one of a few round numbers, thirty unless changed', () => {
    expect(AI_CALLS_PER_MINUTE_CHOICES).toEqual([10, 20, 30, 60])
    expect(DEFAULT_AI_CALLS_PER_MINUTE).toBe(30)
    for (const value of AI_CALLS_PER_MINUTE_CHOICES) expect(isCallsPerMinute(value)).toBe(true)
    for (const value of [0, 25, 100, '30', null, undefined, NaN]) expect(isCallsPerMinute(value)).toBe(false)
  })
})
