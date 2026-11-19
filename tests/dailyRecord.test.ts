import { describe, expect, it } from 'vitest'
import { DAILY_RECORD_VERSION, dailyFactorsOf, dailyOutcomeOf, dailyPredictionOf, onHorizonGrid, parseDailyOutcome, parseDailyPrediction } from '../shared/forecast/daily/dailyRecord'
import { DAILY_SIZE_LINES, type DayBar } from '../shared/forecast/daily/dailySize'
import { expectedMove } from '../shared/forecast/size'

// THE DAILY FORECAST'S RECORD (shared/forecast/daily/dailyRecord.ts; V10 Stage 4): the ranges' widths from every coin's
// past moves on the horizon's own days, a coin's forecast from its day's open, its outcome once the days are up.

const DAY = 86_400
const MONDAY = Date.UTC(2026, 10, 16) / 1000

/** A coin's bars over `count` days before and after `start`, prices walking by a seeded rule. */
function walk(start: number, count: number, seed: number): Map<number, DayBar> {
  const out = new Map<number, DayBar>()
  let price = 100
  let state = seed
  for (let k = 0; k < count; k++) {
    state = (state * 1103515245 + 12345) % 2147483648
    const step = ((state / 2147483648) - 0.5) * 0.06
    const open = price
    const close = price * Math.exp(step)
    const time = start + k * DAY
    out.set(time, { time, open, high: Math.max(open, close) * 1.01, low: Math.min(open, close) * 0.99, close })
    price = close
  }
  return out
}

describe("the daily forecast's record", () => {
  it('reads widths on each horizon\'s own days: every day for one, every third day for three, Mondays for seven', () => {
    expect(onHorizonGrid(MONDAY, 1)).toBe(true)
    expect(onHorizonGrid(MONDAY, 7)).toBe(true)
    expect(onHorizonGrid(MONDAY + DAY, 7)).toBe(false)
    expect(onHorizonGrid(Math.floor(MONDAY / (3 * DAY)) * 3 * DAY, 3)).toBe(true)
    expect(onHorizonGrid(Math.floor(MONDAY / (3 * DAY)) * 3 * DAY + DAY, 3)).toBe(false)
  })

  it('fits each horizon\'s widths from moves ended before the day, and makes a coin\'s levels about no move from its open', () => {
    const start = MONDAY - 1100 * DAY
    const bars = new Map([
      ['AAAUSDT', walk(start, 1100, 7)],
      ['BBBUSDT', walk(start, 1100, 11)]
    ])
    const factors = dailyFactorsOf(bars, MONDAY)
    // Two coins' thousand days: about 2,000 moves of a day and 660 of three, but under the 500 a width needs of seven.
    expect(Object.keys(factors).sort()).toEqual(['day1', 'days3'])
    expect(factors.day1![0]).toBeLessThan(factors.day1![1])
    // A day after the bars end changes no width: only moves ended by the day are read.
    const later = new Map([...bars].map(([pair, byDay]) => [pair, new Map([...byDay, [MONDAY, { time: MONDAY, open: 100, high: 300, low: 10, close: 250 }]])]))
    expect(dailyFactorsOf(later, MONDAY).day1).toEqual(factors.day1)
    const line = dailyPredictionOf('AAAUSDT', bars.get('AAAUSDT')!, MONDAY, 123, factors, MONDAY + 600)!
    expect(line).toMatchObject({ v: DAILY_RECORD_VERSION, id: `AAAUSDT:${MONDAY}`, pair: 'AAAUSDT', day: MONDAY, at: MONDAY + 600, price: 123 })
    expect(line.h.day1!.q[2]).toBe(0)
    expect(line.h.day1!.size).toBeCloseTo(expectedMove(line.h.day1!.q), 3)
    expect(line.h.days3!.size).toBeGreaterThan(line.h.day1!.size)
    expect(parseDailyPrediction(JSON.parse(JSON.stringify(line)))).toEqual(line)
    expect(parseDailyPrediction({ ...line, h: { day2: line.h.day1 } })).toBeNull()
    expect(dailyPredictionOf('AAAUSDT', new Map(), MONDAY, 123, factors, MONDAY)).toBeNull()
    expect(DAILY_SIZE_LINES.fitDays).toBe(1000)
  })

  it("settles a horizon from its open to the close of its last day, and not before every bar of it is held", () => {
    const bars = walk(MONDAY - 40 * DAY, 47, 3)
    const factors = { day1: [0.67, 1.28] as [number, number], days3: [0.67, 1.28] as [number, number], days7: [0.67, 1.28] as [number, number] }
    const line = dailyPredictionOf('AAAUSDT', bars, MONDAY, bars.get(MONDAY)!.open, factors, MONDAY + 600)!
    const three = dailyOutcomeOf(line, 'days3', bars, MONDAY + 3 * DAY + 60)!
    const close = bars.get(MONDAY + 2 * DAY)!.close
    expect(three.move).toBeCloseTo((close / line.price - 1) * 100, 4)
    expect(three).toMatchObject({ h: 'days3', due: MONDAY + 3 * DAY, mid: 0, size: line.h.days3!.size })
    expect(three.in80).toBe(three.move >= line.h.days3!.q[0] && three.move <= line.h.days3!.q[4])
    expect(three.below).toBe(line.h.days3!.q.map((level) => (three.move <= level ? '1' : '0')).join(''))
    expect(parseDailyOutcome(JSON.parse(JSON.stringify(three)))).toEqual(three)
    // A bar missing inside the horizon: no outcome yet.
    const gap = new Map(bars)
    gap.delete(MONDAY + DAY)
    expect(dailyOutcomeOf(line, 'days3', gap, MONDAY + 4 * DAY)).toBeNull()
    expect(dailyOutcomeOf(line, 'days7', walk(MONDAY - 40 * DAY, 42, 3), MONDAY + 8 * DAY)).toBeNull()
  })
})
