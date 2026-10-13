import { describe, expect, it } from 'vitest'
import {
  FORECAST_BAR_SECONDS,
  KLINES_PAGE,
  barFromKline,
  barFromLine,
  barMonthKey,
  barToLine,
  barsUpTo,
  coarseBars,
  coarseUpTo,
  lastClosedBarTime,
  mergeBars,
  missingSpans,
  nextPageStart,
  staleMonth,
  type ForecastBar
} from '../shared/forecast/bars'

// THE FORECAST'S OWN BARS (shared/forecast/bars.ts; the V6 document, §15, §40 and §53): Binance's
// five-minute klines with their taker-buy volume and trades, kept as they closed; nothing read at a
// moment that had not closed by it; and the hours built from them the same way in training and live.

const T0 = Date.parse('2026-10-01T00:00:00Z') / 1000

function bar(time: number, close = 100, extra: Partial<ForecastBar> = {}): ForecastBar {
  return { time, open: close, high: close + 1, low: close - 1, close, volume: 10, quoteVolume: 1000, takerBuyVolume: 6, trades: 50, ...extra }
}

function run(from: number, count: number, step = FORECAST_BAR_SECONDS): ForecastBar[] {
  return Array.from({ length: count }, (_, index) => bar(from + index * step, 100 + Math.sin(index) * 3))
}

/** A small deterministic generator, so a property test's cases are the same each run. */
function lcg(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0
    return state / 2 ** 32
  }
}

describe('a kline row', () => {
  const row = [T0 * 1000, '68100.10', '68150.00', '68090.50', '68120.00', '12.5', T0 * 1000 + 299_999, '851500.25', 1234, '7.25', '493900.1', '0']

  it('reads as a bar with its quote volume, its taker-buy volume and its trades', () => {
    expect(barFromKline(row)).toEqual({ time: T0, open: 68100.1, high: 68150, low: 68090.5, close: 68120, volume: 12.5, quoteVolume: 851500.25, takerBuyVolume: 7.25, trades: 1234 })
  })

  it('is refused when it is not a bar, one rule at a time', () => {
    const withField = (index: number, value: unknown): unknown[] => row.map((cell, at) => (at === index ? value : cell))
    expect(barFromKline('nope')).toBeNull()
    // Too short: the taker-buy volume is missing.
    expect(barFromKline(row.slice(0, 9))).toBeNull()
    // Not on a second, and not on a five-minute boundary.
    expect(barFromKline(withField(0, T0 * 1000 + 1))).toBeNull()
    expect(barFromKline(withField(0, (T0 + 60) * 1000))).toBeNull()
    // Each price inside the high and the low, and above zero.
    expect(barFromKline(withField(1, '68151'))).toBeNull()
    expect(barFromKline(withField(1, '68090'))).toBeNull()
    expect(barFromKline(withField(4, '68151'))).toBeNull()
    expect(barFromKline(withField(4, '68090'))).toBeNull()
    expect(barFromKline([row[0], '0', '0', '0', '0', ...row.slice(5)])).toBeNull()
    expect(barFromKline(withField(1, 'x'))).toBeNull()
    // No negative volume, quote volume or trades, and no more taken by buyers than traded.
    expect(barFromKline(withField(5, '-1'))).toBeNull()
    expect(barFromKline(withField(7, '-1'))).toBeNull()
    expect(barFromKline(withField(8, -1))).toBeNull()
    expect(barFromKline(withField(9, '13'))).toBeNull()
    expect(barFromKline(withField(9, '-0.5'))).toBeNull()
    // At the edges it is a bar: the open at the low, the close at the high, buyers taking it all.
    expect(barFromKline([row[0], '68090.50', '68150.00', '68090.50', '68150.00', '12.5', row[6], row[7], row[8], '12.5', '0', '0'])).not.toBeNull()
  })
})

describe('a bar on file', () => {
  it('is nine figures a line, and reads back as the same bar', () => {
    const one = bar(T0, 101.25, { takerBuyVolume: 4.5, trades: 17 })
    expect(barToLine(one)).toEqual([T0, 101.25, 102.25, 100.25, 101.25, 10, 1000, 4.5, 17])
    expect(barFromLine(JSON.parse(JSON.stringify(barToLine(one))))).toEqual(one)
    expect(barFromLine([T0, 1, 2, 3])).toBeNull()
    expect(barFromLine({ time: T0 })).toBeNull()
  })

  it('is filed under the UTC month it opened in', () => {
    expect(barMonthKey(T0)).toBe('2026-10')
    expect(barMonthKey(T0 - FORECAST_BAR_SECONDS)).toBe('2026-09')
  })
})

describe('the last bar closed', () => {
  it('is the one that opened a whole bar before the current one', () => {
    expect(lastClosedBarTime(T0 + 7 * 60 + 30)).toBe(T0)
    // At the close itself the bar is closed.
    expect(lastClosedBarTime(T0 + FORECAST_BAR_SECONDS)).toBe(T0)
    expect(lastClosedBarTime(T0 + FORECAST_BAR_SECONDS - 1)).toBe(T0 - FORECAST_BAR_SECONDS)
  })
})

describe('bars merged', () => {
  it('are oldest first, each time once, the one read later kept', () => {
    const merged = mergeBars([bar(T0 + 300, 1), bar(T0, 2)], [bar(T0 + 300, 3), bar(T0 + 600, 4)])
    expect(merged.map((entry) => [entry.time, entry.close])).toEqual([
      [T0, 2],
      [T0 + 300, 3],
      [T0 + 600, 4]
    ])
  })
})

describe('the gaps', () => {
  it('are the stretches of bars missing between two moments, both ends included', () => {
    const bars = [bar(T0), bar(T0 + 300), bar(T0 + 1500), bar(T0 + 1800)]
    expect(missingSpans(bars, T0, T0 + 1800)).toEqual([{ from: T0 + 600, to: T0 + 1200 }])
    expect(missingSpans(bars, T0, T0 + 2400)).toEqual([
      { from: T0 + 600, to: T0 + 1200 },
      { from: T0 + 2100, to: T0 + 2400 }
    ])
    expect(missingSpans(bars, T0 - 600, T0 + 300)).toEqual([{ from: T0 - 600, to: T0 - 300 }])
    expect(missingSpans(run(T0, 10), T0, T0 + 9 * 300)).toEqual([])
  })
})

describe('the bars read at a moment (§53)', () => {
  it('are every bar that had closed by it, and none that had not', () => {
    const bars = run(T0, 500)
    const next = lcg(7)
    for (let k = 0; k < 300; k++) {
      const t = T0 - 600 + Math.floor(next() * 520 * FORECAST_BAR_SECONDS)
      const read = barsUpTo(bars, t)
      expect(read.every((entry) => entry.time + FORECAST_BAR_SECONDS <= t)).toBe(true)
      expect(bars.filter((entry) => entry.time + FORECAST_BAR_SECONDS <= t)).toHaveLength(read.length)
    }
    // A bar still forming at the moment is not read; at its close it is.
    expect(barsUpTo(bars, T0 + 299)).toHaveLength(0)
    expect(barsUpTo(bars, T0 + 300)).toHaveLength(1)
  })
})

describe('the coarser bars', () => {
  it('merge twelve five-minute bars into the hour exactly', () => {
    const bars = run(T0, 12).map((entry, index) => ({ ...entry, high: 110 + index, low: 90 - index, volume: index + 1, takerBuyVolume: (index + 1) / 2, trades: 10 }))
    const [hour] = coarseBars(bars, '1h', T0 + 3600)
    expect(hour).toEqual({
      time: T0,
      open: bars[0].open,
      high: 121,
      low: 79,
      close: bars[11].close,
      volume: 78,
      quoteVolume: 12_000,
      takerBuyVolume: 39,
      trades: 120,
      parts: 12
    })
  })

  it('leave out an hour that had not ended by the moment, and one the bars start partway into', () => {
    const bars = run(T0 + 1800, 36)
    const hours = coarseBars(bars, '1h', T0 + 1800 + 36 * 300)
    // The bars start at half past: that hour is left out; the last ends with the bars.
    expect(hours.map((entry) => (entry.time - T0) / 3600)).toEqual([1, 2])
    expect(coarseBars(bars, '1h', T0 + 3 * 3600 - 1).map((entry) => (entry.time - T0) / 3600)).toEqual([1])
  })

  it('count the bars an hour was built from, where the exchange left a gap', () => {
    const bars = run(T0, 12).filter((_, index) => index !== 5)
    expect(coarseBars(bars, '1h', T0 + 3600)[0].parts).toBe(11)
  })

  it('are the same built once and read at a moment as built at that moment', () => {
    const bars = run(T0 + 600, 2000).filter((_, index) => index % 97 !== 3)
    const next = lcg(11)
    for (const width of ['15m', '1h', '4h', '1d'] as const) {
      const whole = coarseBars(bars, width, Number.POSITIVE_INFINITY)
      for (let k = 0; k < 60; k++) {
        const t = T0 + Math.floor(next() * 2100 * FORECAST_BAR_SECONDS)
        expect(coarseUpTo(whole, width, t)).toEqual(coarseBars(bars, width, t))
      }
    }
  })
})

describe('a backfill', () => {
  const now = T0 + 90 * 86_400 + 130

  it('starts ninety days back when nothing is stored, or what is stored is older than that', () => {
    expect(nextPageStart(null, now)).toBe(T0)
    expect(nextPageStart(T0 - 86_400, now)).toBe(T0)
  })

  it('carries on at the bar after the last stored, and stops once the last closed bar is', () => {
    expect(nextPageStart(T0 + 5 * 86_400, now)).toBe(T0 + 5 * 86_400 + FORECAST_BAR_SECONDS)
    const last = lastClosedBarTime(now)
    expect(nextPageStart(last - FORECAST_BAR_SECONDS, now)).toBe(last)
    expect(nextPageStart(last, now)).toBeNull()
    expect(KLINES_PAGE).toBe(1000)
  })
})

describe('a month file', () => {
  it('is stale once its month ended before the history kept, and never when it is not a month', () => {
    const now = Date.parse('2026-10-14T00:00:00Z') / 1000
    expect(staleMonth('2026-06', now)).toBe(true)
    expect(staleMonth('2026-07', now)).toBe(false)
    expect(staleMonth('2026-10', now)).toBe(false)
    expect(staleMonth('not-a-month', now)).toBe(false)
  })
})
