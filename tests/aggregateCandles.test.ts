import { describe, expect, it } from 'vitest'
import { aggregateCandles, bucketTimeFor } from '../electron/services/exchanges/aggregate'
import type { Candle } from '../shared/ipc'

// Bithumb, Coinbase and GOPAX have no native 4h or 1w endpoint, so they build those bars here
// from finer real ones. Every bot dry run runs on 4h, and the Backtest page offers both — so a
// wrong bar here is a wrong signal everywhere downstream, on three of the seven exchanges.

const HOUR = 3600
/** 2024-01-01 00:00:00 UTC — a Monday, so it is both 4h- and 1w-aligned. */
const MONDAY_MIDNIGHT = 1_704_067_200

function hourly(startSec: number, closes: number[]): Candle[] {
  return closes.map((close, i) => ({
    time: startSec + i * HOUR,
    open: close - 1,
    high: close + 2,
    low: close - 3,
    close,
    volume: 10
  }))
}

describe('bucketTimeFor', () => {
  it('floors to the interval width', () => {
    expect(bucketTimeFor(MONDAY_MIDNIGHT + 2 * HOUR, '4h')).toBe(MONDAY_MIDNIGHT)
    expect(bucketTimeFor(MONDAY_MIDNIGHT + 5 * HOUR, '4h')).toBe(MONDAY_MIDNIGHT + 4 * HOUR)
  })

  it('anchors weekly buckets to Monday 00:00 UTC', () => {
    expect(bucketTimeFor(MONDAY_MIDNIGHT, '1w')).toBe(MONDAY_MIDNIGHT)
    expect(new Date(MONDAY_MIDNIGHT * 1000).getUTCDay()).toBe(1)
    // Any moment later that week maps back to the same Monday.
    expect(bucketTimeFor(MONDAY_MIDNIGHT + 6 * 86400 + 3 * HOUR, '1w')).toBe(MONDAY_MIDNIGHT)
    expect(bucketTimeFor(MONDAY_MIDNIGHT + 7 * 86400, '1w')).toBe(MONDAY_MIDNIGHT + 7 * 86400)
  })
})

describe('aggregateCandles', () => {
  it('rolls four aligned hours into one 4h bar', () => {
    const bars = aggregateCandles(hourly(MONDAY_MIDNIGHT, [100, 110, 90, 105]), '4h')

    expect(bars).toHaveLength(1)
    expect(bars[0]).toMatchObject({
      time: MONDAY_MIDNIGHT,
      open: 99, // first candle's open
      close: 105, // last candle's close
      high: 112, // highest high (110 + 2)
      low: 87, // lowest low (90 - 3)
      volume: 40
    })
  })

  it('drops a leading bucket the input only partly covers', () => {
    // Starts at 02:00 — two of the 00:00 bucket's four hours are missing. A bar labelled 00:00
    // built from them would claim an open and a high/low the period never had.
    const bars = aggregateCandles(hourly(MONDAY_MIDNIGHT + 2 * HOUR, [100, 110, 90, 105, 95, 99]), '4h')

    expect(bars.map((b) => b.time)).toEqual([MONDAY_MIDNIGHT + 4 * HOUR])
    expect(bars[0].open).toBe(89) // opens with the 04:00 candle, not the 02:00 one
  })

  it('keeps a trailing bucket that is only partly covered', () => {
    // The final period is still in progress — that is exactly what an exchange's own native
    // endpoint returns for the current bar, so dropping it would lose the live price.
    const bars = aggregateCandles(hourly(MONDAY_MIDNIGHT, [100, 110, 90, 105, 95, 99]), '4h')

    expect(bars.map((b) => b.time)).toEqual([MONDAY_MIDNIGHT, MONDAY_MIDNIGHT + 4 * HOUR])
    expect(bars[1]).toMatchObject({ close: 99, volume: 20 })
  })

  it('is not fooled by an exchange that returns newest-first', () => {
    const ascending = hourly(MONDAY_MIDNIGHT, [100, 110, 90, 105])
    const descending = [...ascending].reverse()

    // Bithumb's adapter passes its rows straight through without sorting; a feed that flipped
    // order would otherwise swap every aggregated bar's open and close and nothing would warn.
    expect(aggregateCandles(descending, '4h')).toEqual(aggregateCandles(ascending, '4h'))
  })

  it('does not mutate or reorder the caller-supplied array', () => {
    const input = [...hourly(MONDAY_MIDNIGHT, [100, 110, 90, 105])].reverse()
    const before = input.map((c) => c.time)

    aggregateCandles(input, '4h')

    expect(input.map((c) => c.time)).toEqual(before)
  })

  it('builds a weekly bar from seven aligned daily bars', () => {
    const daily = Array.from({ length: 7 }, (_, i) => ({
      time: MONDAY_MIDNIGHT + i * 86400,
      open: 100 + i,
      high: 200 + i,
      low: 50 - i,
      close: 150 + i,
      volume: 5
    }))

    const bars = aggregateCandles(daily, '1w')

    expect(bars).toHaveLength(1)
    expect(bars[0]).toMatchObject({ time: MONDAY_MIDNIGHT, open: 100, close: 156, high: 206, low: 44, volume: 35 })
  })

  it('drops a weekly bar that does not start on its Monday', () => {
    // A requested range starting mid-week is the normal case, not an edge case: nothing about
    // the Backtest page's date picker or a bot's lookback window lands on a Monday.
    const daily = Array.from({ length: 9 }, (_, i) => ({
      time: MONDAY_MIDNIGHT + 3 * 86400 + i * 86400,
      open: 100,
      high: 200,
      low: 50,
      close: 150,
      volume: 5
    }))

    const bars = aggregateCandles(daily, '1w')

    expect(bars.map((b) => b.time)).toEqual([MONDAY_MIDNIGHT + 7 * 86400])
  })

  it('returns nothing for empty input', () => {
    expect(aggregateCandles([], '4h')).toEqual([])
  })
})
