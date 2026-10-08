import { describe, expect, it } from 'vitest'
import { getStrategy } from '../src/backtest/strategies'
import { MEASURED_EXPECTATIONS } from '../src/backtest/marketConditions'
import { STRATEGY_HEALTH_TRADES, STRATEGY_HOLD_RATIO, STRATEGY_WIN_RATE_SLACK_POINTS, describeHours, describeStrategyHealth, profitFactorOf, strategyHealth, type StrategyTrade, type StrategyTradeExpectation } from '../shared/strategyHealth'

// shared/strategyHealth.ts: a bot's last thirty closed paper trades against what its strategy
// made a trade where it was measured. A flag and a line; nothing is stopped by it.

const T0 = Date.parse('2026-09-01T00:00:00Z') / 1000
/** A trade a day, the newest last, each held `holdHours`. */
function trades(returns: number[], holdHours = 100): StrategyTrade[] {
  return returns.map((returnPct, index) => ({ entryTime: T0 + index * 86_400, exitTime: T0 + index * 86_400 + holdHours * 3600, returnPct }))
}
const fill = (count: number, value: number): number[] => Array.from({ length: count }, () => value)
const MEASURED: StrategyTradeExpectation = { trades: 1039, profitFactor: 1.8, winRatePct: 33.5, meanHoldHours: 106 }

describe('the figures', () => {
  it('divides gains by losses, and has nothing to divide by without a loss', () => {
    expect(profitFactorOf([3, -1, 2, -1])).toBeCloseTo(2.5, 10)
    expect(profitFactorOf([3, 2])).toBeNull()
    expect(profitFactorOf([0, -1])).toBe(0)
    expect(describeHours(30)).toBe('30 h')
    expect(describeHours(60)).toBe('2.5 days')
  })
})

describe('the verdict', () => {
  it('needs thirty closed trades, and the figures are over the last thirty', () => {
    expect(strategyHealth(trades([...fill(10, 3), ...fill(19, -1)]), MEASURED)).toEqual({ verdict: 'not enough', closed: 29, profitFactor: null, winRatePct: null, meanHoldHours: null, reasons: [] })
    expect(STRATEGY_HEALTH_TRADES).toBe(30)
    // Ten old losers, then thirty good trades: the old ones are not in the window.
    const health = strategyHealth(trades([...fill(10, -5), ...fill(10, 3), ...fill(20, -1)]), MEASURED)
    expect(health).toMatchObject({ verdict: 'as measured', closed: 40, profitFactor: 1.5, meanHoldHours: 100, reasons: [] })
    expect(health.winRatePct).toBeCloseTo((10 / 30) * 100, 10)
    // Newest by when it closed, not by where it is in the list.
    const shuffled = [...trades([...fill(10, -5), ...fill(10, 3), ...fill(20, -1)])].reverse()
    expect(strategyHealth(shuffled, MEASURED).verdict).toBe('as measured')
  })

  it('has nothing to set a strategy against that was not measured', () => {
    const health = strategyHealth(trades([...fill(10, 3), ...fill(20, -1)]), null)
    expect(health).toMatchObject({ verdict: 'unmeasured', closed: 30, profitFactor: 1.5 })
    expect(describeStrategyHealth(health, null)).toMatch(/^Strategy health: over its last 30 closed trades profit factor 1\.50, win rate 33%, hold 4\.2 days; nothing was measured/)
  })

  it('is degraded when losing and winning well under the measured rate, not when losing alone', () => {
    // Five wins of thirty: 17%, more than fifteen points under 33.5%; profit factor 10 / 25.
    const degraded = strategyHealth(trades([...fill(5, 2), ...fill(25, -1)]), MEASURED)
    expect(degraded.verdict).toBe('degraded')
    expect(degraded.reasons).toEqual(['profit factor 0.40 over its last 30 closed trades', 'wins 17% of the time against 34% measured'])
    expect(describeStrategyHealth(degraded, MEASURED)).toBe('DEGRADED: profit factor 0.40 over its last 30 closed trades; wins 17% of the time against 34% measured. It keeps running on paper; a person stops it.')
    // Losing (22.5 against 25.2) at the measured win rate and hold: thirty trades of a breakout strategy lose as a matter of course.
    const losing = strategyHealth(trades([...fill(9, 2.5), ...fill(21, -1.2)]), MEASURED)
    expect(losing.verdict).toBe('as measured')
    expect(losing.profitFactor).toBeCloseTo(22.5 / 25.2, 10)
    // Winning well under the measured rate but making money: not degraded either.
    expect(strategyHealth(trades([...fill(5, 10), ...fill(25, -1)]), MEASURED).verdict).toBe('as measured')
  })

  it('counts the win rate against the slack exactly, and the hold against the ratio exactly', () => {
    const measured = { ...MEASURED, winRatePct: 35 }
    expect(STRATEGY_WIN_RATE_SLACK_POINTS).toBe(15)
    // Six of thirty is 20%: on the line (35 − 15), not under it. Five is under.
    expect(strategyHealth(trades([...fill(6, 1), ...fill(24, -1)]), measured).verdict).toBe('as measured')
    expect(strategyHealth(trades([...fill(5, 1), ...fill(25, -1)]), measured).verdict).toBe('degraded')
    expect(STRATEGY_HOLD_RATIO).toBe(3)
    // Losing at the measured win rate, held three times as long (318 h) or a third as long (35.3 h): degraded. Just inside either line: not.
    const held = (hours: number): ReturnType<typeof strategyHealth> => strategyHealth(trades([...fill(10, 1), ...fill(20, -1)], hours), MEASURED)
    expect(held(318).verdict).toBe('degraded')
    expect(held(318).reasons[1]).toBe('holds 13.3 days a trade against 4.4 days measured')
    expect(held(317).verdict).toBe('as measured')
    expect(held(35).verdict).toBe('degraded')
    expect(held(36).verdict).toBe('as measured')
  })

  it('says what was measured beside what the bot did', () => {
    const health = strategyHealth(trades([...fill(10, 3), ...fill(20, -1)]), MEASURED)
    expect(describeStrategyHealth(health, MEASURED)).toBe('Strategy health: as measured. Over its last 30 closed trades profit factor 1.50, win rate 33%, hold 4.2 days; measured 1.80, 34%, 4.4 days over 1039 trades.')
    expect(describeStrategyHealth(strategyHealth(trades(fill(3, 1)), MEASURED), MEASURED)).toBe('Strategy health: not enough yet, 3 of 30 closed trades.')
  })
})

describe('what was measured', () => {
  it('carries a per-trade expectation for each measured strategy, at its own interval, in the units the reading uses', () => {
    // research/tradeexpect.ts, 8 October 2026: six held-out symbols, one continuous run each at the
    // strategy's shipped interval. Breakout strategies: a profit factor over one, a win rate under
    // half, a hold of days, hundreds of trades. A figure in the wrong unit fails here.
    expect(MEASURED_EXPECTATIONS).toHaveLength(3)
    for (const expectation of MEASURED_EXPECTATIONS) {
      expect(expectation.interval, expectation.strategyId).toBe(getStrategy(expectation.strategyId).preferredInterval)
      expect(expectation.trades.trades, expectation.strategyId).toBeGreaterThanOrEqual(300)
      expect(expectation.trades.profitFactor, expectation.strategyId).toBeGreaterThan(1)
      expect(expectation.trades.winRatePct, expectation.strategyId).toBeGreaterThan(20)
      expect(expectation.trades.winRatePct, expectation.strategyId).toBeLessThan(50)
      expect(expectation.trades.meanHoldHours, expectation.strategyId).toBeGreaterThan(24)
      expect(expectation.trades.meanHoldHours, expectation.strategyId).toBeLessThan(24 * 30)
    }
    expect(MEASURED_EXPECTATIONS.find((expectation) => expectation.strategyId === 'trend-regime-ensemble')?.trades).toEqual({ trades: 322, profitFactor: 4.37, winRatePct: 24.5, meanHoldHours: 409 })
    expect(MEASURED_EXPECTATIONS.find((expectation) => expectation.strategyId === 'short-term-channel')?.trades).toEqual({ trades: 1039, profitFactor: 1.8, winRatePct: 33.5, meanHoldHours: 106 })
    expect(MEASURED_EXPECTATIONS.find((expectation) => expectation.strategyId === 'short-term-channel-regime')?.trades).toEqual({ trades: 583, profitFactor: 2.34, winRatePct: 35.2, meanHoldHours: 114 })
  })
})
