import { describe, expect, it } from 'vitest'
import type { Candle } from '../shared/ipc'
import { coinVenueOf, minuteSpansOf, readTraderAnalysis, readTraderMeta, seriesOf } from '../shared/traders/traderAnalysis'
import { traderTestsOf } from '../shared/traders/traderTests'

// THE ANALYSIS'S HELPERS (shared/traders/traderAnalysis.ts; V8 Stage 6): a coin's perpetual, Binance's first; bars as
// a close series, a missing bar taking the close before it; the minutes a delay test reads, joined into few requests;
// a stored analysis read back only in its version; and the two tests' task run only on an input in its shape.

const bar = (time: number, close: number): Candle => ({ time, open: close, high: close, low: close, close, volume: 1 })

describe("a coin's perpetual", () => {
  it("is Binance's where Binance lists one, Bitget's where only Bitget does, and none where neither does", () => {
    expect(coinVenueOf('BTC', new Set(['BTCUSDT']), new Set(['BTCUSDT']))).toEqual({ coin: 'BTC', venue: 'binance', symbol: 'BTCUSDT' })
    expect(coinVenueOf('kPEPE', new Set(['PEPEUSDT', '1000PEPEUSDT']), new Set())).toEqual({ coin: 'kPEPE', venue: 'binance', symbol: '1000PEPEUSDT' })
    expect(coinVenueOf('ABC', new Set(), new Set(['ABCUSDT']))).toEqual({ coin: 'ABC', venue: 'bitget', symbol: 'ABCUSDT' })
    expect(coinVenueOf('ABC', new Set(), new Set())).toBeNull()
    expect(coinVenueOf('@107', new Set(['@107USDT']), new Set())).toBeNull()
  })
})

describe('bars as a close series', () => {
  it('runs from the first bar at its step, a missing bar taking the close before it', () => {
    const series = seriesOf([bar(1000, 3), bar(880, 1), bar(940, 2), bar(1180, 5)], 60)
    expect(series?.startSec).toBe(880)
    expect(Array.from(series?.closes ?? [])).toEqual([1, 2, 3, 3, 3, 5])
    expect(seriesOf([], 60)).toBeNull()
    expect(seriesOf([bar(0, 0)], 60)).toBeNull()
  })
})

describe('the minutes a delay test reads', () => {
  it('joins windows that overlap or nearly meet, and starts a new request past an hour apart or a page of bars', () => {
    const t = 1_790_000_000 - (1_790_000_000 % 60)
    expect(minuteSpansOf([t, t + 600, t + 7200])).toEqual([
      { fromSec: t, toSec: t + 600 + 18 * 60 },
      { fromSec: t + 7200, toSec: t + 7200 + 18 * 60 }
    ])
    // Windows every half hour for two days: joined, but no span past 1,500 minutes.
    const many = Array.from({ length: 96 }, (_, k) => t + k * 1800)
    const spans = minuteSpansOf(many)
    expect(spans.length).toBe(2)
    for (const span of spans) expect((span.toSec - span.fromSec) / 60).toBeLessThanOrEqual(1500)
    expect(spans[0].fromSec).toBe(t)
    expect(spans[1].toSec).toBe(t + 95 * 1800 + 18 * 60)
    expect(minuteSpansOf([t + 30, t + 59])).toEqual([{ fromSec: t, toSec: t + 18 * 60 }])
  })
})

describe('a stored analysis', () => {
  it('is read back only in its own version', () => {
    expect(readTraderAnalysis({ v: 'trader-analysis-v2', key: 'k', at: 1, figures: {} })).not.toBeNull()
    expect(readTraderAnalysis({ v: 'trader-analysis-v1', key: 'k', at: 1, figures: {} })).toBeNull()
    expect(readTraderAnalysis({ v: 'trader-analysis-v2', key: 'k', at: 'now', figures: {} })).toBeNull()
    // A trader's meta.json likewise: only in its own version, with its count and its key.
    const meta = { v: 'trader-store-v2', ref: { venue: 'okx', id: 'AB12CD34EF56GH78', key: 'okx-AB12CD34EF56GH78' }, records: 3 }
    expect(readTraderMeta(meta)).not.toBeNull()
    expect(readTraderMeta({ ...meta, v: 'trader-store-v1' })).toBeNull()
    expect(readTraderMeta({ ...meta, records: '3' })).toBeNull()
    expect(readTraderMeta({ ...meta, ref: null })).toBeNull()
    expect(readTraderAnalysis(null)).toBeNull()
  })
})

describe("the tests' task", () => {
  it('runs the three tests on an input in its shape, and says which test an input is not shaped for', () => {
    const skill = { trips: [], bars: new Map(), hourly: new Map(), key: 'k' }
    const delay = { trips: [], costs: new Map(), bars: new Map(), funding: new Map(), nowMs: 1 }
    const clone = { trips: [], bars: new Map(), hourly: new Map(), costs: new Map(), key: 'k' }
    expect(traderTestsOf({ skill, delay, clone })).toMatchObject({ skill: { verdict: 'TOO FEW', trips: 0 }, delay: { trips: 0 }, clone: { verdict: 'TOO FEW', entries: 0 } })
    // A payload sent through JSON has lost its maps.
    expect(() => traderTestsOf(JSON.parse(JSON.stringify({ skill, delay, clone })))).toThrow("The skill test's input is not in its shape.")
    expect(() => traderTestsOf({ skill: { ...skill, key: 7 }, delay, clone })).toThrow("The skill test's input is not in its shape.")
    expect(() => traderTestsOf({ skill: { ...skill, trips: 'none' }, delay, clone })).toThrow("The skill test's input is not in its shape.")
    expect(() => traderTestsOf({ skill, delay: { ...delay, funding: {} }, clone })).toThrow("The delay test's input is not in its shape.")
    expect(() => traderTestsOf({ skill, delay: { ...delay, nowMs: '1' }, clone })).toThrow("The delay test's input is not in its shape.")
    expect(() => traderTestsOf({ skill, delay, clone: { ...clone, costs: {} } })).toThrow("The clone's input is not in its shape.")
    expect(() => traderTestsOf({ skill, delay })).toThrow("The clone's input is not in its shape.")
    expect(() => traderTestsOf(null)).toThrow("The skill test's input is not in its shape.")
  })
})
