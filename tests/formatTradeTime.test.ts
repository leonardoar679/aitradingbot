import { describe, expect, it } from 'vitest'
import {
  formatHoldingDuration,
  formatUtcDate,
  formatUtcShort,
  formatUtcTime
} from '../src/backtest/formatTradeTime'

// These render next to a lightweight-charts axis that formats the same timestamps in UTC, so the
// property that actually matters is that nothing here quietly applies a local offset. A test
// written in a UTC+0 environment would pass either way, so the cases below use times where a
// timezone shift would change the DATE, not just the clock.

const AUG_28_2026_1445 = Date.UTC(2026, 7, 28, 14, 45, 30) / 1000

describe('formatUtcDate', () => {
  it('formats the calendar date in UTC', () => {
    expect(formatUtcDate(AUG_28_2026_1445)).toBe('2026-08-28')
  })

  it('does not shift the date into the neighbouring day', () => {
    // 23:30 UTC is the previous day in the Americas and the next day east of GMT+1. If this ever
    // started using local getters, one of these two would move.
    expect(formatUtcDate(Date.UTC(2026, 0, 1, 23, 30) / 1000)).toBe('2026-01-01')
    expect(formatUtcDate(Date.UTC(2026, 0, 1, 0, 30) / 1000)).toBe('2026-01-01')
  })

  it('returns an empty string rather than "Invalid Date" for an unusable stamp', () => {
    expect(formatUtcDate(NaN)).toBe('')
    expect(formatUtcDate(0)).toBe('')
    expect(formatUtcDate(-1)).toBe('')
  })
})

describe('formatUtcTime', () => {
  it('formats hours and minutes in UTC, dropping seconds', () => {
    expect(formatUtcTime(AUG_28_2026_1445)).toBe('14:45')
  })

  it('keeps midnight as 00:00 rather than blank', () => {
    expect(formatUtcTime(Date.UTC(2026, 0, 1, 0, 0) / 1000)).toBe('00:00')
  })

  it('is empty for an unusable stamp', () => {
    expect(formatUtcTime(NaN)).toBe('')
  })
})

describe('formatUtcShort', () => {
  it('drops the year but keeps month, day and clock', () => {
    expect(formatUtcShort(AUG_28_2026_1445)).toBe('08-28 14:45')
  })

  it('is empty for an unusable stamp', () => {
    expect(formatUtcShort(0)).toBe('')
  })
})

describe('formatHoldingDuration', () => {
  it('uses two units at most, coarsest first', () => {
    expect(formatHoldingDuration(5 * 86_400 + 4 * 3600 + 30 * 60)).toBe('5d 4h')
    expect(formatHoldingDuration(18 * 3600 + 45 * 60)).toBe('18h 45m')
    expect(formatHoldingDuration(45 * 60)).toBe('45m')
  })

  it('drops a zero unit instead of printing it', () => {
    expect(formatHoldingDuration(3 * 86_400)).toBe('3d')
    expect(formatHoldingDuration(2 * 3600)).toBe('2h')
  })

  it('never hides days behind a large hour count', () => {
    // 38 days is a normal hold for the slow strategy. "918h" would be technically right and
    // unreadable, which is the failure this format exists to avoid.
    expect(formatHoldingDuration(38 * 86_400 + 6 * 3600)).toBe('38d 6h')
  })

  it('shows a sub-minute hold as <1m, not 0m', () => {
    // A zero-length hold reads as an engine bug rather than a very short trade.
    expect(formatHoldingDuration(30)).toBe('<1m')
    expect(formatHoldingDuration(0)).toBe('<1m')
  })

  it('is empty for a negative or unusable span', () => {
    expect(formatHoldingDuration(-60)).toBe('')
    expect(formatHoldingDuration(NaN)).toBe('')
  })

  it('matches the holding time a real backtest produces', () => {
    // The 4h strategy's typical hold, cross-checked against the figure the CSV export writes.
    const entry = Date.UTC(2026, 5, 12, 14, 45) / 1000
    const exit = Date.UTC(2026, 5, 17, 19, 30) / 1000
    expect((exit - entry) / 3600).toBeCloseTo(124.75, 6)
    expect(formatHoldingDuration(exit - entry)).toBe('5d 4h')
  })
})
