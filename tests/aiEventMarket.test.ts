import { describe, expect, it } from 'vitest'
import {
  BTC_REGIME_PCT,
  MARKET_BARS_15M,
  MARKET_BARS_1M,
  WITH_MARKET_SHARE,
  btcRegimeOf,
  buildMarketBlock,
  eventCompanyOf,
  referenceReturns,
  type AiMarketReturns,
  type ReferenceCandles
} from '../shared/aiEventMarket'
import type { Candle } from '../shared/ipc'

// The market around an event: what the two reference markets did up to its minute, rebuilt from
// candles. The same three properties the event and the snapshot keep, and the two labels.

/** An event whose call executes on the minute that opens here. A quarter-hour boundary plus
 * seven minutes, so that "the last closed fifteen-minute bar" is not also the last minute. */
const T = Date.parse('2026-10-02T14:07:00Z') / 1000

/** Minute bars ending at the minute before `eventTime`, with the close a function of how many
 * minutes before the event's bar each one is (0 is the last). */
function minutes(closeAt: (back: number) => number, count = MARKET_BARS_1M, eventTime = T): Candle[] {
  return Array.from({ length: count }, (_, i) => {
    const back = count - 1 - i
    const close = closeAt(back)
    return { time: eventTime - 60 - back * 60, open: close, high: close * 1.0005, low: close * 0.9995, close, volume: 10 }
  })
}

/** Fifteen-minute bars ending at the last one closed by `eventTime`. */
function quarters(closeAt: (back: number) => number, count = MARKET_BARS_15M, eventTime = T): Candle[] {
  const lastOpen = Math.floor(eventTime / 900) * 900 - 900
  return Array.from({ length: count }, (_, i) => {
    const back = count - 1 - i
    const close = closeAt(back)
    return { time: lastOpen - back * 900, open: close, high: close * 1.001, low: close * 0.999, close, volume: 100 }
  })
}

/** 100 now; 99 fifteen minutes ago; 98 an hour ago; 96 four hours ago. */
const stepped = (back: number): number => (back >= 240 ? 96 : back >= 60 ? 98 : back >= 15 ? 99 : 100)
/** 100 at the last closed quarter hour, 80 a day before it. */
const dayUp = (back: number): number => (back >= 96 ? 80 : 100)
const reference = (overrides: Partial<ReferenceCandles> = {}): ReferenceCandles => ({ candles1m: minutes(stepped), candles15m: quarters(dayUp), ...overrides })

describe('referenceReturns', () => {
  it('measures the fifteen minutes, the hour and the four hours that end at the event\'s minute, and the day to the last closed quarter hour', () => {
    const returns = referenceReturns(reference(), T)
    expect(returns?.m15).toBeCloseTo((100 / 99 - 1) * 100, 4)
    expect(returns?.h1).toBeCloseTo((100 / 98 - 1) * 100, 4)
    expect(returns?.h4).toBeCloseTo((100 / 96 - 1) * 100, 4)
    expect(returns?.h24).toBeCloseTo(25, 6)
  })

  it('reads nothing at or after the minute a call on the event executes on', () => {
    const before = referenceReturns(reference(), T)
    // The future, appended: the event's own minute and the hour after it, at ten times the price,
    // and the quarter hour the event falls in, which has not closed.
    const later1m = [...minutes(stepped), ...Array.from({ length: 60 }, (_, i) => ({ time: T + i * 60, open: 1000, high: 1001, low: 999, close: 1000, volume: 9e9 }))]
    const later15m = [...quarters(dayUp), { time: Math.floor(T / 900) * 900, open: 1000, high: 1001, low: 999, close: 1000, volume: 9e9 }]
    expect(referenceReturns({ candles1m: later1m, candles15m: later15m }, T)).toEqual(before)
  })

  it('does not depend on how much history came before', () => {
    const long1m = minutes((back) => (back >= MARKET_BARS_1M ? 5 : stepped(back)), MARKET_BARS_1M + 500)
    const long15m = quarters((back) => (back >= MARKET_BARS_15M ? 5 : dayUp(back)), MARKET_BARS_15M + 300)
    expect(referenceReturns({ candles1m: long1m, candles15m: long15m }, T)).toEqual(referenceReturns(reference(), T))
  })

  it('gives the same numbers for the same candles, to six significant digits', () => {
    const wobbly = minutes((back) => 100 + Math.sin(back / 7) * 3.123456789)
    const first = referenceReturns(reference({ candles1m: wobbly }), T)
    expect(JSON.stringify(first)).toBe(JSON.stringify(referenceReturns(reference({ candles1m: [...wobbly] }), T)))
    for (const value of [first?.m15, first?.h1, first?.h4]) expect(String(value).replace(/[-.]/g, '').replace(/^0+/, '').length).toBeLessThanOrEqual(6)
  })

  it('is nothing when the minutes stop short of the event, have a hole, or are too few', () => {
    // The newest bar is two minutes before the event: these are returns up to an earlier moment.
    expect(referenceReturns(reference({ candles1m: minutes(stepped).slice(0, -1) }), T)).toBeNull()
    expect(referenceReturns(reference({ candles1m: minutes(stepped, MARKET_BARS_1M + 1).filter((_, i) => i !== 100) }), T)).toBeNull()
    expect(referenceReturns(reference({ candles1m: minutes(stepped, MARKET_BARS_1M - 1) }), T)).toBeNull()
    expect(referenceReturns(reference({ candles1m: [] }), T)).toBeNull()
    // And one bar more than is needed is enough, whichever end the extra one is on.
    expect(referenceReturns(reference({ candles1m: minutes(stepped, MARKET_BARS_1M + 1) }), T)).not.toBeNull()
    // Plenty of unbroken minutes that end two minutes early are returns up to another moment.
    expect(referenceReturns(reference({ candles1m: minutes(stepped, MARKET_BARS_1M + 5, T - 120) }), T)).toBeNull()
  })

  it('leaves the day out, and keeps the rest, when the quarter hours cannot measure it', () => {
    const short = referenceReturns(reference({ candles15m: quarters(dayUp, MARKET_BARS_15M - 1) }), T)
    expect(short).toMatchObject({ h24: null })
    expect(short?.m15).toBeCloseTo((100 / 99 - 1) * 100, 4)
    const holed = quarters(dayUp, MARKET_BARS_15M + 1).filter((_, i) => i !== 40)
    expect(referenceReturns(reference({ candles15m: holed }), T)?.h24).toBeNull()
    // Bars that end an hour before the event are a day up to some earlier market.
    const stale = quarters(dayUp, MARKET_BARS_15M, T - 3600)
    expect(referenceReturns(reference({ candles15m: stale }), T)?.h24).toBeNull()
  })

  it('is nothing for a market whose price is not a price', () => {
    expect(referenceReturns(reference({ candles1m: minutes((back) => (back === 15 ? 0 : 100)) }), T)).toBeNull()
  })
})

describe('buildMarketBlock', () => {
  const pair: AiMarketReturns = { m15: 3, h1: 3.5, h4: 2, h24: -4 }
  const flat = (): ReferenceCandles => ({ candles1m: minutes(() => 50), candles15m: quarters(() => 50) })

  it('sets the pair against both markets: their returns, and its own less each of theirs', () => {
    const block = buildMarketBlock(pair, { btc: reference(), eth: flat() }, T)
    if (block === null) throw new Error('expected a block')
    expect(Object.keys(block)).toEqual(['btc', 'eth', 'vsBtc', 'vsEth'])
    expect(block.eth).toEqual({ m15: 0, h1: 0, h4: 0, h24: 0 })
    expect(block.vsEth).toEqual(pair)
    expect(block.vsBtc.m15).toBeCloseTo(3 - (100 / 99 - 1) * 100, 4)
    expect(block.vsBtc.h1).toBeCloseTo(3.5 - (100 / 98 - 1) * 100, 4)
    expect(block.vsBtc.h4).toBeCloseTo(2 - (100 / 96 - 1) * 100, 4)
    expect(block.vsBtc.h24).toBeCloseTo(-4 - 25, 6)
  })

  it('is nothing with either market missing: half a block would be a third kind of question', () => {
    expect(buildMarketBlock(pair, { btc: reference(), eth: { candles1m: [], candles15m: [] } }, T)).toBeNull()
    expect(buildMarketBlock(pair, { btc: { candles1m: minutes(stepped).slice(0, -1), candles15m: quarters(dayUp) }, eth: flat() }, T)).toBeNull()
  })

  it('leaves a day it cannot compare as unknown, not as zero', () => {
    const noDay = buildMarketBlock({ ...pair, h24: null }, { btc: reference(), eth: flat() }, T)
    expect(noDay?.vsBtc.h24).toBeNull()
    expect(noDay?.btc.h24).toBeCloseTo(25, 6)
    const noRefDay = buildMarketBlock(pair, { btc: reference({ candles15m: [] }), eth: flat() }, T)
    expect(noRefDay?.btc.h24).toBeNull()
    expect(noRefDay?.vsBtc.h24).toBeNull()
    expect(noRefDay?.vsEth.h24).toBe(-4)
  })

  it('survives a trip through a file unchanged, and is the same bytes for the same candles', () => {
    const block = buildMarketBlock(pair, { btc: reference(), eth: flat() }, T)
    expect(JSON.parse(JSON.stringify(block))).toEqual(block)
    expect(JSON.stringify(buildMarketBlock(pair, { btc: reference(), eth: flat() }, T))).toBe(JSON.stringify(block))
  })
})

describe('the two labels results are cut by', () => {
  const btc = (m15: number, h4: number): { btc: AiMarketReturns } => ({ btc: { m15, h1: 0, h4, h24: null } })

  it('calls Bitcoin rising or falling by one percent over four hours, and flat inside that', () => {
    expect(BTC_REGIME_PCT).toBe(1)
    expect(btcRegimeOf(btc(0, 1))).toBe('rising')
    expect(btcRegimeOf(btc(0, 0.99))).toBe('flat')
    expect(btcRegimeOf(btc(0, -0.99))).toBe('flat')
    expect(btcRegimeOf(btc(0, -1))).toBe('falling')
    expect(btcRegimeOf(btc(5, 0))).toBe('flat')
  })

  it('says a pair moved with the market when Bitcoin went the same way by at least half as much', () => {
    expect(WITH_MARKET_SHARE).toBe(0.5)
    expect(eventCompanyOf(3, btc(1.5, 0))).toBe('with the market')
    expect(eventCompanyOf(3, btc(1.49, 0))).toBe('on its own')
    expect(eventCompanyOf(3, btc(4, 0))).toBe('with the market')
    // The same for a fall.
    expect(eventCompanyOf(-3, btc(-1.5, 0))).toBe('with the market')
    expect(eventCompanyOf(-3, btc(-1, 0))).toBe('on its own')
    // Bitcoin going the other way is as far from "with" as it gets.
    expect(eventCompanyOf(3, btc(-2, 0))).toBe('on its own')
    expect(eventCompanyOf(-3, btc(2, 0))).toBe('on its own')
    // Bitcoin's own event is the market's.
    expect(eventCompanyOf(2.2, btc(2.2, 0))).toBe('with the market')
    // And a move of nothing is nobody's.
    expect(eventCompanyOf(0, btc(1, 0))).toBe('on its own')
  })
})
