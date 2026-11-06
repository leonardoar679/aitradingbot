import { describe, expect, it } from 'vitest'
import { BIG_MOVERS_LINES, bigMoverPredictionsOf, bigMoversOf, dayMoveRatesOf } from '../shared/forecast/bigMovers'
import type { ForecastBar } from '../shared/forecast/bars'
import type { MoveRates } from '../shared/forecast/moveRates'
import type { PricePrediction } from '../shared/forecast/prediction'
import { readSourcePrediction } from '../shared/evaluation/predictionRecord'

// THE BIG MOVERS (shared/forecast/bigMovers.ts; V8 Stage 10, V8-R1-SIZE, V9-SIZE-RANK): within an hour the coins with the
// widest shown P10-P90 range, within four hours and a day those whose close moved the horizon's size most often over
// their ninety days, size alone; their entries as size calls of the source 'big-movers'; and the day moves of 5% and
// 10% studied apart, read at each hour's close where a day's bars are whole.

const rates = (hour1: number, hours4: number, hours24: number): MoveRates =>
  ({
    version: 'move-rates-v1',
    from: 0,
    to: 0,
    horizons: [
      { horizon: 'hour1', moments: 2000, close: [{ pct: 1, up: hour1 / 2, down: hour1 / 2, either: hour1 }], touch: [] },
      { horizon: 'hours4', moments: 2000, close: [{ pct: 2, up: 0, down: 0, either: hours4 }], touch: [] },
      { horizon: 'hours24', moments: 2000, close: [{ pct: 5, up: 0, down: 0, either: hours24 }], touch: [] }
    ]
  }) as unknown as MoveRates

/** A forecast's shown P10-P90 width at the hour, and at four hours and a day. */
const widths = (hour1: number | null, rest = 3): PricePrediction['horizons'] =>
  ({ ...(hour1 === null ? {} : { hour1: { width80Pct: hour1 } }), hours4: { width80Pct: rest }, hours24: { width80Pct: rest } }) as unknown as PricePrediction['horizons']

describe('the list', () => {
  it('ranks the hour by the shown width, as V9-SIZE-RANK found it ranks better, and four hours and a day by the rate', () => {
    expect(BIG_MOVERS_LINES.rankers).toEqual({ hour1: 'width-p10-p90', hours4: 'move-rates-90d', hours24: 'move-rates-90d' })
    const predictions = [
      { pair: 'CCCUSDT', currentPrice: 3, moveRates: rates(0.3, 0.05, 0.2), horizons: widths(1.2) },
      { pair: 'AAAUSDT', currentPrice: 1, moveRates: rates(0.2, 0.1, 0.05), horizons: widths(2.5) },
      { pair: 'BBBUSDT', currentPrice: 2, moveRates: rates(0.3, 0.1, 0.01), horizons: widths(0.8) },
      { pair: 'DDDUSDT', currentPrice: 4, moveRates: null, horizons: widths(9) },
      { pair: 'EEEUSDT', currentPrice: 0, moveRates: rates(0.9, 0.9, 0.9), horizons: widths(9) },
      // No range at the hour: left out of the hour's list, which is ranked by it, and kept in the others.
      { pair: 'FFFUSDT', currentPrice: 5, moveRates: rates(0.9, 0.2, 0.3), horizons: widths(null) },
      ...Array.from({ length: 6 }, (_, k) => ({ pair: `Z${k}USDT`, currentPrice: 1, moveRates: rates(0.01, 0.01, 0.01), horizons: widths(0.1) }))
    ]
    const lists = bigMoversOf(predictions)
    expect(lists.hour1.map((entry) => entry.pair)).toEqual(['AAAUSDT', 'CCCUSDT', 'BBBUSDT', 'Z0USDT', 'Z1USDT'])
    expect(lists.hours4.map((entry) => entry.pair).slice(0, 4)).toEqual(['FFFUSDT', 'AAAUSDT', 'BBBUSDT', 'CCCUSDT'])
    expect(lists.hours24[0]).toEqual({ pair: 'FFFUSDT', horizon: 'hours24', sizePct: 5, rate: 0.3, widthPct: 3, price: 5 })
    // The chance an entry shows is its ninety-day rate, whatever ranked it.
    expect(lists.hour1[0]).toMatchObject({ rate: 0.2, widthPct: 2.5 })
    expect(lists.hour1).toHaveLength(BIG_MOVERS_LINES.listed)
    // A coin with no range at the hour is not ranked there at all, even with room on the list.
    expect(bigMoversOf(predictions.filter((entry) => entry.pair === 'FFFUSDT' || entry.pair === 'AAAUSDT')).hour1.map((entry) => entry.pair)).toEqual(['AAAUSDT'])
  })

  it("is recorded as size calls of the source 'big-movers', each naming its ranker, whole lines the record reads back", () => {
    const lists = bigMoversOf([{ pair: 'AAAUSDT', currentPrice: 1.5, moveRates: rates(0.2, 0.1, 0.05), horizons: widths(2.5) }])
    const made = bigMoverPredictionsOf(lists, 1_793_102_400, { engine: 'e', config: 'c' })
    expect(made.map((line) => [line.id, line.horizonSec, line.movePct, line.sourceVersion])).toEqual([
      ['big-movers:AAAUSDT:1793102400:1', 3600, 1, 'big-movers-v2@width-p10-p90'],
      ['big-movers:AAAUSDT:1793102400:2', 14_400, 2, 'big-movers-v2@move-rates-90d'],
      ['big-movers:AAAUSDT:1793102400:3', 86_400, 5, 'big-movers-v2@move-rates-90d']
    ])
    expect(made[0]).toMatchObject({ source: 'big-movers', kind: 'size', side: null, refPrice: 1.5, venue: 'binance', unit: Math.floor(1_793_102_400 / 3600) })
    expect(made[0].reason).toBe("ranked by the forecast's P10-P90 width, 2.50%; its ninety-day rate of a close 1% away either way: 20.0%")
    expect(made[1].reason).toBe('ranked by its ninety-day rate of a close 2% away either way: 10.0%')
    for (const line of made) expect(readSourcePrediction(line), line.id).not.toBeNull()
  })
})

describe('the day moves', () => {
  const bars = (closes: (index: number) => number, count: number, startSec = 1_790_000_000 - (1_790_000_000 % 3600)): ForecastBar[] =>
    Array.from({ length: count }, (_, i) => ({ time: startSec + i * 300, open: closes(i), high: closes(i), low: closes(i), close: closes(i), volume: 1 }) as ForecastBar)

  it("counts, at every hour's close, a day's close 5% and 10% away either way; none under thirty days of hours", () => {
    // A price that steps up 6% every day and 12% every fourth: each day's close is at least 5% away, a quarter of them
    // 10%.
    const days = 40
    const perDay = 288
    let price = 100
    const closes: number[] = []
    for (let d = 0; d < days; d++) {
      for (let k = 0; k < perDay; k++) closes.push(price)
      price *= d % 4 === 3 ? 1.12 : 1.06
    }
    const series = bars((i) => closes[i], closes.length)
    const atSec = series[series.length - 1].time + 300
    const read = dayMoveRatesOf(series, atSec)
    expect(read).not.toBeNull()
    expect(read!.moments).toBe((days - 1) * 24)
    expect(read!.rates[5]).toBeCloseTo(1, 9)
    expect(read!.rates[10]).toBeGreaterThan(0.2)
    expect(read!.rates[10]).toBeLessThan(0.3)
    expect(dayMoveRatesOf(series.slice(0, 20 * perDay), atSec)).toBeNull()
  })

  it('counts a fall as a rise, and no day across a gap in the bars', () => {
    const perDay = 288
    const closes: number[] = []
    let price = 100
    for (let d = 0; d < 40; d++) {
      for (let k = 0; k < perDay; k++) closes.push(price)
      price *= d % 2 === 0 ? 1.07 : 1 / 1.07
    }
    const whole = bars((i) => closes[i], closes.length)
    const atSec = whole[whole.length - 1].time + 300
    expect(dayMoveRatesOf(whole, atSec)!.rates[5]).toBeCloseTo(1, 9)
    // Five days' bars missing: no hour before the gap is read against a bar more than a day on.
    const gapped = [...whole.slice(0, 20 * perDay), ...whole.slice(25 * perDay)]
    expect(dayMoveRatesOf(gapped, atSec)!.moments).toBe((20 - 1) * 24 + (15 - 1) * 24)
  })
})
