import { describe, expect, it } from 'vitest'
import type { ForecastBar } from '../shared/forecast/bars'
import { HYPOTHESIS_LINES, breakoutAt, catalystCall, gainersAt, hourIndex, hourlyOf, hypothesisFiguresOf, leadersAt, moveAfterPct, recoveryAt, type HourlySeries, type JudgedCall } from '../shared/forecast/hypotheses'
import { pairHalfOf } from '../shared/forecast/runCalibration'

// THE USER'S DIRECTION HYPOTHESES AS RULES (shared/forecast/hypotheses.ts; V7.2-R Stage 6): each rule's call on bars
// whose answer is known, and the bar its calls are judged by -- the direction bar's lines for calls.

const T0 = Date.parse('2026-03-01T00:00:00Z') / 1000

/** Five-minute bars from a list of each bar's close, each bar opening at the last's close; volume 1, the quote volume the close. */
function barsFrom(closes: readonly number[], from = T0, volume = (_: number) => 1): ForecastBar[] {
  let open = closes[0]
  return closes.map((close, k) => {
    const bar = { time: from + k * 300, open, high: Math.max(open, close) * 1.0001, low: Math.min(open, close) * 0.9999, close, volume: volume(k), quoteVolume: volume(k) * close, takerBuyVolume: volume(k) / 2, trades: 1 }
    open = close
    return bar
  })
}

/** An hourly series made by hand: closes, highs, lows and volumes by hour, the close fifteen minutes before each end
 * where given, and a constant five-minute volatility. */
function hours(pair: string, closes: readonly number[], extra: Partial<Pick<HourlySeries, 'high' | 'low' | 'quoteVolume' | 'close15' | 'rv5m'>> = {}): HourlySeries {
  const n = closes.length
  const of = (values: readonly number[] | Float64Array | undefined, fill: (k: number) => number): Float64Array => Float64Array.from({ length: n }, (_, k) => (values === undefined ? fill(k) : values[k]))
  return {
    pair,
    start: T0 + 3600,
    close: Float64Array.from(closes),
    high: of(extra.high, (k) => closes[k] * 1.001),
    low: of(extra.low, (k) => closes[k] * 0.999),
    quoteVolume: of(extra.quoteVolume, () => 1000),
    close15: of(extra.close15, (k) => closes[k]),
    rv5m: of(extra.rv5m, () => 0.002)
  }
}

describe("a pair's hours", () => {
  it('are built from its five-minute bars: the close, the range, the volume, the close fifteen minutes before the end', () => {
    const closes = Array.from({ length: 12 * 30 }, (_, k) => 100 + k * 0.01)
    const series = hourlyOf('SOLUSDT', barsFrom(closes))!
    expect(series.start).toBe(T0 + 3600)
    expect(series.close.length).toBe(30)
    expect(series.close[0]).toBeCloseTo(closes[11], 12)
    expect(series.close15[0]).toBeCloseTo(closes[8], 12)
    expect(series.quoteVolume[1]).toBeCloseTo(closes.slice(12, 24).reduce((sum, close) => sum + close, 0), 9)
    expect(series.high[1]).toBeCloseTo(Math.max(...closes.slice(11, 24)) * 1.0001, 9)
    // A day of five-minute moves before an hour's end: the volatility read from the 25th hour on.
    expect(Number.isNaN(series.rv5m[22])).toBe(true)
    expect(series.rv5m[24]).toBeGreaterThan(0)
    expect(hourIndex(series, T0 + 3600 * 3)).toBe(2)
    expect(hourIndex(series, T0 + 3600 * 3 + 60)).toBe(-1)
    expect(moveAfterPct(series, 0, 1)).toBeCloseTo((closes[23] / closes[11] - 1) * 100, 9)
    expect(moveAfterPct(series, 29, 1)).toBeNull()
  })

  it('leave an hour missing a bar as a gap', () => {
    const bars = barsFrom(Array.from({ length: 12 * 3 }, () => 100)).filter((_, k) => k !== 15)
    const series = hourlyOf('SOLUSDT', bars)!
    expect(Number.isNaN(series.close[1])).toBe(true)
    expect(series.close[0]).toBe(100)
    expect(series.close[2]).toBe(100)
  })
})

describe('the rules', () => {
  const t = T0 + 3600 * 25
  const dayMove = (pair: string, pct: number): HourlySeries => hours(pair, Array.from({ length: 26 }, (_, k) => (k <= 0 ? 100 : k >= 24 ? 100 * (1 + pct / 100) : 100)))

  it('GAINERS: the five that rose most over the day, each at least 3%, called up', () => {
    const universe = [dayMove('A', 10), dayMove('B', 8), dayMove('C', 5), dayMove('D', 4), dayMove('E', 3), dayMove('F', 2.9), dayMove('G', 3.5)]
    expect(gainersAt(universe, t).map((call) => [call.pair, call.way])).toEqual([['A', 1], ['B', 1], ['C', 1], ['D', 1], ['G', 1]])
    // Under 3% is no gainer even among the five.
    expect(gainersAt([dayMove('A', 10), dayMove('F', 2.9), dayMove('H', -4)], t).map((call) => call.pair)).toEqual(['A'])
    expect(HYPOTHESIS_LINES.gainers).toEqual({ top: 5, minPct: 3, windowHours: 24 })
  })

  it("LEADERS: Bitcoin and ether both 1% or more the same way over four hours, every other pair called that way", () => {
    const fourHours = (pair: string, pct: number): HourlySeries => hours(pair, Array.from({ length: 26 }, (_, k) => (k >= 24 ? 100 * (1 + pct / 100) : 100)))
    const others = [fourHours('SOLUSDT', 0), fourHours('XRPUSDT', -3)]
    expect(leadersAt([fourHours('BTCUSDT', 1.2), fourHours('ETHUSDT', 1), ...others], t).map((call) => [call.pair, call.way])).toEqual([['SOLUSDT', 1], ['XRPUSDT', 1]])
    expect(leadersAt([fourHours('BTCUSDT', -1.5), fourHours('ETHUSDT', -2), ...others], t).map((call) => call.way)).toEqual([-1, -1])
    expect(leadersAt([fourHours('BTCUSDT', 1.2), fourHours('ETHUSDT', 0.9), ...others], t)).toEqual([])
    expect(leadersAt([fourHours('BTCUSDT', 1.2), fourHours('ETHUSDT', -1.2), ...others], t)).toEqual([])
    expect(leadersAt([fourHours('BTCUSDT', 1.2), ...others], t)).toEqual([])
  })

  it('BREAKOUT: through the day\'s high on twice the usual volume, still moving its way at the end; the same through the low', () => {
    // The hour at t is the 25th (index 24); the 24 before it set the day's range and its usual hour's volume.
    const n = 26
    const base = Array.from({ length: n }, () => 100)
    const make = (last: number, close15: number, volume: number): HourlySeries => {
      const closes = [...base]
      closes[24] = last
      return hours('SOLUSDT', closes, { high: Float64Array.from({ length: n }, (_, k) => (k === 24 ? Math.max(last, 100) : 100.5)), low: Float64Array.from({ length: n }, (_, k) => (k === 24 ? Math.min(last, 100) : 99.5)), quoteVolume: Float64Array.from({ length: n }, (_, k) => (k === 24 ? volume : 1000)), close15: Float64Array.from({ length: n }, (_, k) => (k === 24 ? close15 : 100)) })
    }
    expect(breakoutAt(make(101, 101 / 1.003, 2000), t)).toEqual({ pair: 'SOLUSDT', t, way: 1 })
    expect(breakoutAt(make(101, 101 / 1.003, 1999), t)).toBeNull()
    expect(breakoutAt(make(101, 101 / 1.002, 2000), t)).toBeNull()
    expect(breakoutAt(make(100.4, 100.4 / 1.003, 3000), t)).toBeNull()
    expect(breakoutAt(make(99, 99 / 0.997, 2000), t)).toEqual({ pair: 'SOLUSDT', t, way: -1 })
    expect(breakoutAt(make(99, 99 / 0.998, 2000), t)).toBeNull()
  })

  it('RECOVERY: a fall of two usual hourly moves or more in the last hour, called up', () => {
    const usual = 0.002 * Math.sqrt(12)
    const fall = (k: number): HourlySeries => hours('SOLUSDT', [...Array.from({ length: 24 }, () => 100), 100 * Math.exp(-k * usual), 100])
    expect(recoveryAt(fall(2.01), t)).toEqual({ pair: 'SOLUSDT', t, way: 1 })
    expect(recoveryAt(fall(1.99), t)).toBeNull()
    expect(recoveryAt(hours('SOLUSDT', [...Array.from({ length: 24 }, () => 100), 90, 100], { rv5m: Float64Array.from({ length: 26 }, () => Number.NaN) }), t)).toBeNull()
  })

  it("CATALYST: each kind its way, from the first hour's close a minute after the release", () => {
    expect(catalystCall('ABCUSDT', 'DELISTING', T0 + 59)).toEqual({ pair: 'ABCUSDT', t: T0 + 3600, way: -1 })
    expect(catalystCall('ABCUSDT', 'MONITORING_TAG', T0 + 3540)).toEqual({ pair: 'ABCUSDT', t: T0 + 3600, way: -1 })
    expect(catalystCall('ABCUSDT', 'MONITORING_TAG', T0 + 3541)).toEqual({ pair: 'ABCUSDT', t: T0 + 7200, way: -1 })
    expect(catalystCall('ABCUSDT', 'SPOT_LISTING', T0)).toEqual({ pair: 'ABCUSDT', t: T0 + 3600, way: 1 })
    expect(catalystCall('ABCUSDT', 'FUTURES_LAUNCH', T0)!.way).toBe(1)
    expect(catalystCall('ABCUSDT', 'SOMETHING_ELSE', T0)).toBeNull()
  })
})

describe('the bar a rule is judged by', () => {
  const split = T0 + 86_400 * 100
  /** Calls spread over 200 days and two pair halves; `right` decides whether each went its way, by `size` percent. */
  const calls = (n: number, right: (k: number) => boolean, size: (k: number) => number, base = 0.5): JudgedCall[] =>
    Array.from({ length: n }, (_, k) => ({ pair: k % 2 === 0 ? 'SOLUSDT' : 'DOGEUSDT', t: T0 + 3600 * (24 * Math.floor((k * 200) / n) + (k % 24)), way: 1, movePct: right(k) ? size(k) : -size(k), base }))

  it('promotes a rule right beyond an even chance and its base rate in every half, and calls it tradeable where its moves pay the round trip', () => {
    expect(pairHalfOf('SOLUSDT')).not.toBe(pairHalfOf('DOGEUSDT'))
    const strong = hypothesisFiguresOf('gainers', 'hour1', calls(600, (k) => k % 10 < 8, () => 1), split)
    expect(strong.calls).toBe(600)
    expect(strong.precision!.value).toBeCloseTo(0.8, 12)
    expect(strong.skill!.value).toBeCloseTo(0.3, 12)
    expect(strong.edgePct!.value).toBeCloseTo(0.8 * 1 - 0.2 * 1 - HYPOTHESIS_LINES.bar.roundTripPct, 9)
    expect(strong.lines.every((line) => line.ok === true)).toBe(true)
    expect(strong).toMatchObject({ promoted: true, tradeable: true })
    // Right as often, by moves under the round trip: promoted, not tradeable.
    const small = hypothesisFiguresOf('gainers', 'hour1', calls(600, (k) => k % 10 < 8, () => 0.2), split)
    expect(small).toMatchObject({ promoted: true, tradeable: false })
    expect(small.lines.find((line) => line.id === 'edge')!.ok).toBe(false)
  })

  it('holds back a rule with too few calls, a precision near an even chance, no skill over its base rate, or a half without skill', () => {
    expect(hypothesisFiguresOf('gainers', 'hour1', calls(199, () => true, () => 1), split).lines.find((line) => line.id === 'calls')!.ok).toBe(false)
    const even = hypothesisFiguresOf('gainers', 'hour1', calls(600, (k) => k % 2 === 0, () => 1), split)
    expect(even.lines.find((line) => line.id === 'precision')!.ok).toBe(false)
    expect(even.promoted).toBe(false)
    // Right 55% of 300 times: above an even chance by its point, not by its lower bound.
    const thin = hypothesisFiguresOf('gainers', 'hour1', calls(300, (k) => k % 20 < 11, () => 1), split)
    expect(thin.precision!.value).toBeGreaterThan(0.5)
    expect(thin.precision!.low).toBeLessThan(0.5)
    expect(thin.lines.find((line) => line.id === 'precision')!.ok).toBe(false)
    // Right 70% where 69.5% of the month's coin-hours went the same way: no skill to speak of.
    const drift = hypothesisFiguresOf('gainers', 'hour1', calls(600, (k) => k % 10 < 7, () => 1, 0.695), split)
    expect(drift.lines.find((line) => line.id === 'skill')!.ok).toBe(false)
    expect(drift.promoted).toBe(false)
    // Right in the first half of the year only.
    const early = hypothesisFiguresOf('gainers', 'hour1', calls(600, (k) => (k < 300 ? true : k % 2 === 0), () => 1), split)
    expect(early.halves.year[0]).toBeGreaterThan(0)
    expect(early.halves.year[1]).toBeCloseTo(0, 12)
    expect(early.lines.find((line) => line.id === 'halves')!.ok).toBe(false)
    expect(early.promoted).toBe(false)
  })

  it('reads a down call right where the move went down, against the base rate of falls', () => {
    const down = calls(400, (k) => k % 4 !== 0, () => 1, 0.4).map((call) => ({ ...call, way: -1 as const, movePct: -call.movePct }))
    const made = hypothesisFiguresOf('leaders', 'hours4', down, split)
    expect(made.precision!.value).toBeCloseTo(0.75, 12)
    expect(made.skill!.value).toBeCloseTo(0.35, 12)
  })

  it('resamples by calendar hour: calls bunched in one hour a day still read their intervals at a day', () => {
    // Thirty calls a day for 21 days, all at the same hour: 21 hours that hold a call, 504 calendar hours.
    const bunched: JudgedCall[] = Array.from({ length: 21 * 30 }, (_, k) => ({ pair: k % 2 === 0 ? 'SOLUSDT' : 'DOGEUSDT', t: T0 + 86_400 * Math.floor(k / 30), way: 1, movePct: k % 10 < 7 ? 1 : -1, base: 0.5 }))
    const made = hypothesisFiguresOf('leaders', 'hours24', bunched, T0 + 86_400 * 10)
    expect(made.precision).not.toBeNull()
    expect(made.precision!.value).toBeCloseTo(0.7, 12)
    expect(made.lines.find((line) => line.id === 'precision')!.ok).not.toBeNull()
  })

  it('counts each month\'s calls and their mean move in the way called', () => {
    const made = hypothesisFiguresOf('gainers', 'hour1', calls(300, () => true, () => 1), split)
    const months = Object.values(made.byMonth)
    expect(months.reduce((sum, month) => sum + month.calls, 0)).toBe(300)
    expect(months.every((month) => Math.abs(month.meanMovePct - 1) < 1e-12)).toBe(true)
  })
})
