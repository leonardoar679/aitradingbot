import { describe, expect, it } from 'vitest'
import { COMPARISON_COLUMNS, describeNoTrades, rankStrategyRows, tookNoTrades } from '../src/backtest/strategyRanking'
import type { BacktestStats } from '../src/backtest/engine'

// A strategy that never fires comes back looking respectable: 0.00% net, 0.00% drawdown, and a
// green tint because zero is not negative. Sorted by profit it outranks everything that traded
// and lost; sorted by drawdown it comes first, because risking nothing has the best risk figures
// there are. Every number is true and the comparison is worthless -- which is the failure mode
// this module exists to prevent.

function stats(overrides: Partial<BacktestStats> = {}): BacktestStats {
  return {
    totalClosedTrades: 12,
    openTrades: 0,
    totalNetProfitPct: -10,
    maxDrawdownPct: -20,
    sharpeRatio: 0.5,
    profitFactor: 1.1,
    winRatePct: 40,
    warmupBars: 100,
    ...overrides
  } as BacktestStats
}

const flat = stats({ totalClosedTrades: 0, openTrades: 0, totalNetProfitPct: 0, maxDrawdownPct: 0, sharpeRatio: 0, profitFactor: 0, winRatePct: 0 })

describe('spotting a strategy that never traded', () => {
  it('is not the same as one that traded and broke even', () => {
    expect(tookNoTrades(flat)).toBe(true)
    expect(tookNoTrades(stats({ totalClosedTrades: 1, totalNetProfitPct: 0 }))).toBe(false)
  })

  it('counts a position still open as having traded', () => {
    // It entered. The run simply ended before it left, which is a result, not a non-event.
    expect(tookNoTrades(stats({ totalClosedTrades: 0, openTrades: 1 }))).toBe(false)
  })
})

describe('ranking the comparison table', () => {
  const traded = { row: 'traded', stats: stats({ totalNetProfitPct: -10, maxDrawdownPct: -20 }) }
  const lost = { row: 'lost-badly', stats: stats({ totalNetProfitPct: -30, maxDrawdownPct: -45 }) }
  const won = { row: 'won', stats: stats({ totalNetProfitPct: 15, maxDrawdownPct: -12 }) }
  const never = { row: 'never-traded', stats: flat }

  it('puts a strategy that never traded below every one that did, whatever the arrival order', () => {
    // Checked across orderings because with two elements a comparator is only ever asked one
    // question, and a branch that is only right in one direction still passes that.
    for (const arrival of [
      [never, traded, lost, won],
      [traded, never, won, lost],
      [won, lost, traded, never],
      [lost, won, never, traded]
    ]) {
      const ranked = rankStrategyRows(arrival, 'totalNetProfitPct', true).map((r) => r.row)
      expect(ranked[ranked.length - 1]).toBe('never-traded')
      expect(ranked[0]).toBe('won')
    }
  })

  it('keeps it last even when the sorted column is one it appears to win', () => {
    // Sorted by drawdown, "risked nothing" is the best score on the board. It is still not a
    // strategy anyone can act on.
    const ranked = rankStrategyRows([never, traded, lost, won], 'maxDrawdownPct', false).map((r) => r.row)

    expect(ranked[ranked.length - 1]).toBe('never-traded')
  })

  it('still orders the strategies that did trade', () => {
    const ranked = rankStrategyRows([lost, won, traded], 'totalNetProfitPct', true).map((r) => r.row)

    expect(ranked).toEqual(['won', 'traded', 'lost-badly'])
  })

  it('reverses for a column where a smaller number is better', () => {
    const ranked = rankStrategyRows([won, traded, lost], 'totalNetProfitPct', false).map((r) => r.row)

    expect(ranked).toEqual(['lost-badly', 'traded', 'won'])
  })

  it('ranks drawdown so the shallowest comes first', () => {
    // Drawdown is stored negative (-45 is worse than -12), so the better figure is the LARGER
    // one. The comparison table had this column flagged the other way and sorted the worst
    // drawdown to the top while every other column sorted best-first.
    const ranked = rankStrategyRows([lost, won, traded], 'maxDrawdownPct', true).map((r) => r.row)

    expect(ranked).toEqual(['won', 'traded', 'lost-badly'])
  })

  it('treats two Infinities as equal rather than as unordered', () => {
    // Profit factor really is Infinity for a run with no losing trade. Subtracting them gives
    // NaN, which the sort spec coerces to 0 -- the same answer, but only by way of a rule nobody
    // should have to know.
    const perfectA = { row: 'a', stats: stats({ profitFactor: Number.POSITIVE_INFINITY }) }
    const perfectB = { row: 'b', stats: stats({ profitFactor: Number.POSITIVE_INFINITY }) }
    const ordinary = { row: 'ordinary', stats: stats({ profitFactor: 2 }) }
    const ranked = rankStrategyRows([ordinary, perfectA, perfectB], 'profitFactor', true).map((r) => r.row)

    expect(ranked[2]).toBe('ordinary')
    expect(ranked.slice(0, 2).sort()).toEqual(['a', 'b'])
  })

  it('leaves the caller rows untouched', () => {
    const original = [never, won]
    rankStrategyRows(original, 'totalNetProfitPct', true)

    expect(original.map((r) => r.row)).toEqual(['never-traded', 'won'])
  })
})

describe('saying why a row is empty', () => {
  it('names the candles it had to work with and calls the zero what it is', () => {
    const message = describeNoTrades('RSI Mean-Reversion', stats({ ...flat, warmupBars: 100 }), 730)

    expect(message).toContain('never opened a position')
    expect(message).toContain('630 candles')
    expect(message).toContain('first 100 are indicator warm-up')
    expect(message).toContain('absence of a result')
  })

  it('leaves out the warm-up clause when there was none', () => {
    const message = describeNoTrades('Something', stats({ ...flat, warmupBars: 0 }), 500)

    expect(message).toContain('500 candles')
    expect(message).not.toContain('warm-up')
  })

  it('never reports a negative number of tradable candles', () => {
    // A window shorter than the warm-up is a real case -- a 50-candle range against a 200-bar
    // regime filter -- and "-150 candles it could trade on" would be nonsense.
    const message = describeNoTrades('Something', stats({ ...flat, warmupBars: 200 }), 50)

    expect(message).toContain('0 candles')
    expect(message).not.toMatch(/-\d/)
  })
})

describe('the columns the comparison table offers', () => {
  it('sorts every column best-first', () => {
    // The direction flag is the whole contract of a sortable column, and drawdown is the one that
    // catches people out: it is stored negative, so "better" is the LARGER number.
    const drawdown = COMPARISON_COLUMNS.find((c) => c.key === 'maxDrawdownPct')
    expect(drawdown?.higherIsBetter).toBe(true)

    for (const key of ['totalNetProfitPct', 'winRatePct', 'sharpeRatio', 'profitFactor'] as const) {
      expect(COMPARISON_COLUMNS.find((c) => c.key === key)?.higherIsBetter).toBe(true)
    }
  })

  it('ranks a real set of rows shallowest-drawdown-first through the shipped config', () => {
    const column = COMPARISON_COLUMNS.find((c) => c.key === 'maxDrawdownPct')!
    const rows = [
      { row: 'deep', stats: stats({ maxDrawdownPct: -45 }) },
      { row: 'shallow', stats: stats({ maxDrawdownPct: -12 }) },
      { row: 'middling', stats: stats({ maxDrawdownPct: -20 }) }
    ]

    expect(rankStrategyRows(rows, column.key, column.higherIsBetter).map((r) => r.row)).toEqual(['shallow', 'middling', 'deep'])
  })
})
