import { describe, expect, it } from 'vitest'
import { madeIn, portfolioValueLine } from '../src/overview/portfolioValueLine'

// src/overview/portfolioValueLine.ts: Overview's "Portfolio value" line. In a one-hour run of the app
// with no paper account, the first paper trade the watch opened made it read "+$54.20 this session":
// its stake, counted as if it had been earned.

const snap = (totalValue: number, costOutsideQuote: number, hasPaperAccount: boolean) => ({ totalValue, costOutsideQuote, hasPaperAccount })

describe("Overview's portfolio value", () => {
  it('with no paper account, says what the open positions are worth and are up or down, and nothing of a session', () => {
    // Nothing open when the session began; a short staked 54.34 is now worth 54.20.
    expect(portfolioValueLine(snap(0, 0, false), snap(54.2, 54.34, false))).toBe('$54.20 in open positions, -$0.14 on them')
    expect(portfolioValueLine(snap(0, 0, false), snap(1100, 1000, false))).toBe('$1,100.00 in open positions, +$100.00 on them')
    expect(portfolioValueLine(null, snap(0, 0, false))).toBe('$0.00 in open positions')
  })

  it("with a paper account, says what the session made, and not a position's stake brought in from outside", () => {
    expect(portfolioValueLine(snap(10_000, 0, true), snap(10_100, 0, true))).toBe('$10,100.00, +$100.00 this session')
    expect(portfolioValueLine(snap(10_000, 0, true), snap(9_950, 0, true))).toBe('$9,950.00, -$50.00 this session')
    // A real position bought for 200 during the session, worth 220 now: 20 made, not 220.
    expect(portfolioValueLine(snap(10_000, 0, true), snap(10_220, 200, true))).toBe('$10,220.00, +$20.00 this session')
    // One snapshot: nothing to compare with.
    const only = snap(10_000, 0, true)
    expect(portfolioValueLine(only, only)).toBe('$10,000.00')
    expect(portfolioValueLine(null, only)).toBe('$10,000.00')
  })

  it('reads what positions made as the total less what they cost from outside it', () => {
    expect(madeIn(snap(54.2, 54.34, false))).toBeCloseTo(-0.14, 10)
    expect(madeIn(snap(10_000, 0, true))).toBe(10_000)
  })
})
