import { describe, it, expect } from 'vitest'
import { describeRangeProblem, describeEmptyRange } from '../src/backtest/rangeProblem'

describe('describeRangeProblem', () => {
  it('accepts an ordinary range', () => {
    expect(describeRangeProblem({ startDate: '2026-05-26', endDate: '2026-08-24' })).toBeNull()
  })

  it('accepts a single-day range', () => {
    // Start is 00:00:00 and end is 23:59:59 on the same day, so one day really is testable.
    expect(describeRangeProblem({ startDate: '2026-08-24', endDate: '2026-08-24' })).toBeNull()
  })

  it('rejects a start date after the end date', () => {
    // Observed in the running app: this produced a full results page -- equity curve, thirty-odd
    // metrics, Sharpe/Sortino/Omega all 0.00, balance "10,000.00 -> 10,000.00" -- with nothing
    // anywhere saying the dates were the problem.
    const problem = describeRangeProblem({ startDate: '2026-08-20', endDate: '2026-05-01' })
    expect(problem).not.toBeNull()
    expect(problem).toContain('2026-08-20')
    expect(problem).toContain('2026-05-01')
    // Not just that the dates appear -- that the sentence says what is wrong with them.
    expect(problem).toContain('is not before the end date')
    expect(problem).toContain('Swap them')
  })

  it('rejects a cleared start date', () => {
    // `new Date('T00:00:00Z')` is an Invalid Date; its getTime() is NaN, and the fetch loop
    // condition `cursorMs < endMs` is false for NaN, so this fetched nothing and reported success.
    expect(describeRangeProblem({ startDate: '', endDate: '2026-08-24' })).toContain('start date')
  })

  it('rejects a cleared end date', () => {
    expect(describeRangeProblem({ startDate: '2026-05-26', endDate: '' })).toContain('end date')
  })

  it('rejects an unparseable date rather than treating it as zero', () => {
    expect(describeRangeProblem({ startDate: 'not-a-date', endDate: '2026-08-24' })).not.toBeNull()
  })
})

describe('describeEmptyRange', () => {
  it('says nothing when candles came back', () => {
    expect(describeEmptyRange({ candleCount: 4321, startDate: '2026-05-26', endDate: '2026-08-24' })).toBeNull()
  })

  it('explains a valid range that the exchange had no data for', () => {
    const message = describeEmptyRange({ candleCount: 0, startDate: '2019-01-01', endDate: '2019-02-01' })
    expect(message).not.toBeNull()
    expect(message).toContain('no candles')
    expect(message).toContain('Nothing was tested')
  })
})
