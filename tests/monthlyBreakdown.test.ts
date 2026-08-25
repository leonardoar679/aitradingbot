import { describe, expect, it } from 'vitest'
import { runBacktest } from '../src/backtest/engine'
import type { Candle } from '../shared/ipc'

// The monthly table used to attribute a trade's whole P&L to the month it CLOSED in. For any
// position held across a month boundary that makes the table say the opposite of what happened:
// a run that gained 7-10% every month for five months reported 0.00%, 0.00%, 0.00%, 0.00%,
// +28.48%, because one trade closed in May.

const H4 = 4 * 3600
const JAN_2025 = Date.UTC(2025, 0, 1) / 1000

function series(closes: number[], startSec = JAN_2025): Candle[] {
  return closes.map((c, i) => {
    const prev = i === 0 ? c : closes[i - 1]
    return { time: startSec + i * H4, open: prev, high: Math.max(c, prev), low: Math.min(c, prev), close: c, volume: 1 }
  })
}

/** Flat, a breakout, then a steady four-month climb: ONE trade, opened in January and closed only
 * when the data runs out in May. */
const HELD_ACROSS_MONTHS = series([
  ...Array(30).fill(100),
  110,
  ...Array(700)
    .fill(0)
    .map((_, i) => 112 + i * 0.06)
])

/** Breaks out late in January and falls straight away, so January ends underwater with NO trade
 * closed in it and the exit lands in February. This is the case the whole fix is about: a month
 * that lost money without booking a loss. */
const LOSES_BEFORE_IT_EXITS = series([
  ...Array(180).fill(100),
  112,
  ...Array(200)
    .fill(0)
    .map((_, i) => 111.5 - i * 0.05)
])

function monthly(candles: Candle[]) {
  return runBacktest(candles, 'bollinger-breakout')
}

describe('a position held across several months', () => {
  it('credits each month with what the account actually did in it', () => {
    const { monthlyBreakdown } = monthly(HELD_ACROSS_MONTHS)
    const byMonth = Object.fromEntries(monthlyBreakdown.map((m) => [m.month, m]))

    // Every month of the climb gained. Under the old accounting the first four were 0.00%.
    for (const month of ['2025-01', '2025-02', '2025-03', '2025-04']) {
      expect(byMonth[month].returnPct).toBeGreaterThan(5)
    }
    // And the closing month is credited only with its own small move, not with the whole trade.
    expect(byMonth['2025-05'].returnPct).toBeLessThan(2)
  })

  it('adds up to the run total, with no month counted twice and none skipped', () => {
    // The invariant that makes the table trustworthy: each month is based on the previous month's
    // closing equity, so the gap between months belongs to exactly one of them.
    const { monthlyBreakdown, stats } = monthly(HELD_ACROSS_MONTHS)
    const summed = monthlyBreakdown.reduce((a, m) => a + m.netProfit, 0)

    expect(summed).toBeCloseTo(stats.totalNetProfit, 6)
  })

  it('still counts trades by the month they closed in', () => {
    // The one column that is genuinely about exits, and is labelled that way.
    const { monthlyBreakdown, stats } = monthly(HELD_ACROSS_MONTHS)

    expect(monthlyBreakdown.filter((m) => m.trades > 0)).toHaveLength(1)
    expect(monthlyBreakdown.reduce((a, m) => a + m.trades, 0)).toBe(stats.totalClosedTrades)
  })

  it('stops claiming the whole result came from one month', () => {
    // topThreeMonthsProfitSharePct exists to warn that a result leans on a few outlier months.
    // On this run -- five months of steady gains -- it read 100%, which is the exact opposite of
    // what it is there to say.
    const { stats } = monthly(HELD_ACROSS_MONTHS)

    expect(stats.topThreeMonthsProfitSharePct).toBeLessThan(90)
    expect(stats.topThreeMonthsProfitSharePct).toBeGreaterThan(0)
  })

  it('reports no losing months when the account grew every month', () => {
    const { stats } = monthly(HELD_ACROSS_MONTHS)

    expect(stats.losingMonthsCount).toBe(0)
    expect(stats.maxConsecutiveLosingMonths).toBe(0)
  })
})

describe('months where nothing happened at all', () => {
  it('reports a flat month as flat rather than as missing', () => {
    // Never breaks out, so no trade is ever opened and equity never moves.
    const { monthlyBreakdown, stats } = monthly(series(Array(400).fill(100)))

    expect(monthlyBreakdown.length).toBeGreaterThan(1)
    for (const month of monthlyBreakdown) {
      expect(month.netProfit).toBe(0)
      expect(month.returnPct).toBe(0)
      expect(month.trades).toBe(0)
    }
    expect(stats.losingMonthsCount).toBe(0)
  })

  it('gives every month in the range a row, traded or not', () => {
    const { monthlyBreakdown } = monthly(HELD_ACROSS_MONTHS)

    expect(monthlyBreakdown.map((m) => m.month)).toEqual(['2025-01', '2025-02', '2025-03', '2025-04', '2025-05'])
  })

  it('never reports a percentage it cannot compute', () => {
    // A run wiped out to zero equity has no base to divide the next month by. NaN in this column
    // would render as "NaN%" across the whole table.
    const { monthlyBreakdown } = runBacktest(
      series([...Array(30).fill(100), 110, ...Array(200).fill(112), ...Array(200).fill(1)]),
      'bollinger-breakout',
      { leverage: 50 }
    )

    for (const month of monthlyBreakdown) {
      expect(Number.isFinite(month.returnPct)).toBe(true)
      expect(Number.isFinite(month.netProfit)).toBe(true)
    }
  })
})

describe('a month that lost money without closing a trade', () => {
  it('counts as a losing month', () => {
    // Under the old accounting a month only ever showed a loss if a trade happened to close in
    // it, so a position bleeding across a month boundary showed 0.00% and the month was counted
    // as fine.
    const { monthlyBreakdown, stats } = monthly(LOSES_BEFORE_IT_EXITS)
    const january = monthlyBreakdown.find((m) => m.month === '2025-01') as (typeof monthlyBreakdown)[number]

    expect(january.trades).toBe(0)
    expect(january.netProfit).toBeLessThan(0)
    expect(january.returnPct).toBeLessThan(0)
    // Exactly two, not "at least one": January lost without closing anything and February lost
    // with the exit in it. Counting only months that booked a loss finds one of the two, and a
    // loose assertion here passes for both answers.
    expect(stats.losingMonthsCount).toBe(2)
    expect(stats.maxConsecutiveLosingMonths).toBe(2)
  })

  it('books the trade in the month it closed, not the month it opened', () => {
    const { monthlyBreakdown } = monthly(LOSES_BEFORE_IT_EXITS)
    const byMonth = Object.fromEntries(monthlyBreakdown.map((m) => [m.month, m]))

    expect(byMonth['2025-01'].trades).toBe(0)
    expect(byMonth['2025-02'].trades).toBe(1)
  })

  it('divides by the equity the month opened with, not the equity it closed with', () => {
    // Same sign either way, so only an exact check separates them.
    const { monthlyBreakdown, equityCurve } = monthly(LOSES_BEFORE_IT_EXITS)
    const january = monthlyBreakdown.find((m) => m.month === '2025-01') as (typeof monthlyBreakdown)[number]
    const openingEquity = equityCurve[0].value

    expect(january.returnPct).toBeCloseTo((january.netProfit / openingEquity) * 100, 10)
  })

  it('bases February on what January closed at', () => {
    const { monthlyBreakdown } = monthly(LOSES_BEFORE_IT_EXITS)
    const [january, february] = monthlyBreakdown
    const januaryClose = 10_000 + january.netProfit

    expect(february.returnPct).toBeCloseTo((february.netProfit / januaryClose) * 100, 8)
  })
})
