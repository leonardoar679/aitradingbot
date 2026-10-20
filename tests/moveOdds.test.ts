import { describe, expect, it } from 'vitest'
import { MOVE_ODDS_LINES, MOVE_ODDS_VERSION, closeOdds, levelsReadable, moveOddsOf, oddsLine, touchOdds } from '../shared/forecast/moveOdds'

// THE ODDS OF A MOVE THAT CLEARS ITS COSTS (shared/forecast/moveOdds.ts; V7.2-R Stage 3): the chance a horizon's
// close is 1%, 2% or 5% either way, read off the five shown levels by straight lines and past P10 and P90 by an
// exponential tail; the chance the path touches 1% or 2% either way, read off the likely highs and lows the same
// way; a chance read in a tail marked.

const SYMMETRIC = [-2, -1, 0, 1, 2]

describe('the close', () => {
  it('reads a chance between the levels by straight lines', () => {
    expect(closeOdds(SYMMETRIC, 1)).toEqual({ pct: 1, up: 0.25, down: 0.25, upTail: false, downTail: false })
    expect(closeOdds(SYMMETRIC, 0.5)!.up).toBeCloseTo(0.375, 12)
    expect(closeOdds(SYMMETRIC, 2)).toMatchObject({ up: expect.closeTo(0.1, 12), down: expect.closeTo(0.1, 12), upTail: false, downTail: false })
    // A forecast that leans down: +1% between P75 and P90, -1% between P25 and P50.
    const leaning = closeOdds([-3, -1.5, -0.2, 0.8, 1.6], 1)!
    expect(leaning.up).toBeCloseTo(1 - (0.75 + 0.25 * 0.15), 12)
    expect(leaning.down).toBeCloseTo(0.25 + (0.5 / 1.3) * 0.25, 12)
  })

  it('reads past P90 and P10 by an exponential tail that falls by the same factor per point as from P75 to P90, and marks it', () => {
    const three = closeOdds(SYMMETRIC, 3)!
    expect(three.up).toBeCloseTo(0.1 / 2.5, 12)
    expect(three.down).toBeCloseTo(0.1 / 2.5, 12)
    expect(three.upTail && three.downTail).toBe(true)
    expect(closeOdds(SYMMETRIC, 5)!.up).toBeCloseTo(0.1 / 2.5 ** 3, 12)
    // Continuous at the level, and falling with the move.
    expect(closeOdds(SYMMETRIC, 2 - 1e-9)!.up).toBeCloseTo(closeOdds(SYMMETRIC, 2 + 1e-9)!.up, 6)
    const moves = [0.25, 0.5, 1, 1.5, 2, 3, 5, 8]
    const ups = moves.map((pct) => closeOdds([-4, -1.2, 0.1, 1.4, 3], pct)!.up)
    expect(ups.every((value, at) => at === 0 || value < ups[at - 1])).toBe(true)
    // The lower tail is scaled from P25 to P10, not from the upper levels.
    const skewed = closeOdds([-6, -2, 0, 1, 2], 8)!
    expect(skewed.down).toBeCloseTo(0.1 * Math.exp((-Math.log(2.5) * 2) / 4), 12)
    expect(skewed.up).toBeCloseTo(0.1 * Math.exp(-Math.log(2.5) * 6), 12)
  })

  it('reads nothing past levels that do not spread, and refuses levels it cannot read', () => {
    expect(closeOdds([0, 0, 0, 0, 0], 1)).toEqual({ pct: 1, up: 0, down: 0, upTail: true, downTail: true })
    expect(closeOdds([0, 1, Number.NaN, 2, 3], 1)).toBeNull()
    expect(closeOdds([0, 2, 1, 3, 4], 1)).toBeNull()
    expect(closeOdds([0, 1, 2, 3], 1)).toBeNull()
    expect(closeOdds(SYMMETRIC, 0)).toBeNull()
    expect(levelsReadable(SYMMETRIC)).toBe(true)
  })
})

describe('the path', () => {
  const highs = [1, 2, 3]
  const lows = [-1, -2, -3]

  it('reads the chance of a touch from no move, which the path always reaches, through its likely highs and lows', () => {
    expect(touchOdds(highs, lows, 1)).toEqual({ pct: 1, up: 0.5, down: 0.5, upTail: false, downTail: false })
    expect(touchOdds(highs, lows, 0.5)!.up).toBeCloseTo(0.75, 12)
    expect(touchOdds(highs, lows, 2)!.up).toBeCloseTo(0.2, 12)
    expect(touchOdds(highs, lows, 2.5)!.down).toBeCloseTo(0.15, 12)
    const far = touchOdds(highs, lows, 4)!
    expect(far.up).toBeCloseTo(0.05, 12)
    expect(far.upTail).toBe(true)
    // One side wider than the other.
    const lopsided = touchOdds([0.4, 0.9, 1.2], [-1.5, -3, -4], 1)!
    expect(lopsided.up).toBeCloseTo(0.2 - (0.1 / 0.3) * 0.1, 12)
    expect(lopsided.down).toBeCloseTo(1 - (1 / 1.5) * 0.5, 12)
  })

  it('refuses levels out of order or not finite', () => {
    expect(touchOdds([2, 1, 3], lows, 1)).toBeNull()
    expect(touchOdds(highs, [-1, Number.NaN, -3], 1)).toBeNull()
    expect(touchOdds(highs, lows, -1)).toBeNull()
  })
})

describe("a horizon's odds", () => {
  it('reads the close at each of the moves asked, the path where the forecast carries one, and the minutes where a table says them', () => {
    const odds = moveOddsOf(SYMMETRIC, { highPct: [1, 2, 3], lowPct: [-1, -2, -3] }, (pct, side) => (pct === 1 && side === 'up' ? 95 : null))!
    expect(odds.version).toBe(MOVE_ODDS_VERSION)
    expect(odds.close.map((side) => side.pct)).toEqual(MOVE_ODDS_LINES.closeMovesPct)
    expect(odds.touch!.map((side) => side.pct)).toEqual(MOVE_ODDS_LINES.touchMovesPct)
    expect(odds.touchMinutes).toEqual([
      { pct: 1, up: 95, down: null },
      { pct: 2, up: null, down: null }
    ])
    expect(oddsLine(odds)).toEqual([0.25, 0.25, 0.1, 0.1, 0.006, 0.006, 0.5, 0.5, 0.2, 0.2])
    const noPath = moveOddsOf(SYMMETRIC, undefined, null)!
    expect(noPath.touch).toBeNull()
    expect(noPath.touchMinutes).toBeNull()
    expect(oddsLine(noPath)).toHaveLength(6)
    expect(moveOddsOf([1, 0, 2, 3, 4], undefined, null)).toBeNull()
    expect(MOVE_ODDS_LINES.closeMovesPct).toEqual([1, 2, 5])
    expect(MOVE_ODDS_LINES.touchMovesPct).toEqual([1, 2])
  })
})
