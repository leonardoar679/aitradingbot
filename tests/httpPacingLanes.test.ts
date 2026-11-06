import { describe, expect, it } from 'vitest'
import { GapBudget, HTTP_PACING_LINES, WeightBudget, type PacingClock, type Priority } from '../shared/httpPacing'
import { inBackground, laneNow } from '../electron/services/httpPacing'

// THE BACKGROUND LANE (shared/httpPacing.ts; V9 Stage 3): finding and analysing traders read the hosts a paper follow
// reads its leader on, in a lane of their own -- half of a weight budget's minute, twice a gap budget's gap, in a queue
// apart -- so that a background read waiting its turn never holds a follow's read behind it. The lane is the work's,
// however deep a read is made (electron/services/httpPacing.ts inBackground).

/** A clock whose sleeps wait until a test moves it. */
function manualClock(start: number): PacingClock & { advance: (ms: number) => void; pending: () => number } {
  let now = start
  let waits: { until: number; resolve: () => void }[] = []
  return {
    now: () => now,
    sleep: (ms) => new Promise<void>((resolve) => waits.push({ until: now + ms, resolve })),
    advance: (ms) => {
      now += ms
      const due = waits.filter((wait) => wait.until <= now)
      waits = waits.filter((wait) => wait.until > now)
      for (const wait of due) wait.resolve()
    },
    pending: () => waits.length
  }
}

const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))
const MINUTE = Date.UTC(2026, 10, 6, 12, 0, 0)

describe('the background lane', () => {
  it("spends at most its share of a weight budget's minute, and its wait holds no normal read behind it", async () => {
    const clock = manualClock(MINUTE)
    let lane: Priority = 'background'
    const budget = new WeightBudget('Hyperliquid', 600, clock, () => lane)
    const share = Math.floor(600 * HTTP_PACING_LINES.background.weightShare)
    await budget.spend(share)
    let late = false
    const waiting = budget.spend(10).then(() => {
      late = true
    })
    lane = 'normal'
    // The normal lane has the rest of the minute at once, behind no background wait.
    await budget.spend(600 - share)
    await settle()
    expect(late).toBe(false)
    expect(clock.pending()).toBe(1)
    clock.advance(60_000)
    await waiting
    expect(late).toBe(true)
    lane = 'background'
    await expect(budget.spend(share + 1)).rejects.toThrow(`within ${share} a minute`)
  })

  it("waits twice a gap budget's gap since the last read of either lane, and its wait holds no normal read behind it", async () => {
    const clock = manualClock(MINUTE)
    let lane: Priority = 'normal'
    const budget = new GapBudget('OKX', 500, clock, () => lane)
    await budget.take('/a')
    lane = 'background'
    let done = false
    const background = budget.take('/a').then(() => {
      done = true
    })
    lane = 'normal'
    await settle()
    clock.advance(500)
    // Half a second on, the normal lane takes the endpoint; the background still waits its two gaps.
    await budget.take('/a')
    await settle()
    expect(done).toBe(false)
    // Two gaps after the first read is not enough: the normal read since counts.
    clock.advance(500)
    await settle()
    expect(done).toBe(false)
    clock.advance(500)
    await background
    expect(done).toBe(true)
  })

  it('is the lane of the work a read is part of, however deep, and normal outside it', async () => {
    expect(laneNow()).toBe('normal')
    const seen: Priority[] = []
    await inBackground(async () => {
      seen.push(laneNow())
      await settle()
      await Promise.all([1, 2].map(async () => seen.push(laneNow())))
    })
    expect(seen).toEqual(['background', 'background', 'background'])
    expect(laneNow()).toBe('normal')
  })
})
