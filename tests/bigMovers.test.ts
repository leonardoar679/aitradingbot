import { describe, expect, it } from 'vitest'
import { BIG_MOVERS_LINES, bigMoverPredictionsOf, bigMoversOf, dayMoveRatesOf } from '../shared/forecast/bigMovers'
import type { ForecastBar } from '../shared/forecast/bars'
import type { MoveRates } from '../shared/forecast/moveRates'
import { readSourcePrediction } from '../shared/evaluation/predictionRecord'

// THE BIG MOVERS (shared/forecast/bigMovers.ts; V8 Stage 10, V8-R1-SIZE): at each horizon the coins whose close moved
// the horizon's size most often over their ninety days, size alone; their entries as size calls of the source
// 'big-movers'; and the day moves of 5% and 10% studied apart, read at each hour's close where a day's bars are whole.

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

describe('the list', () => {
  it('ranks each horizon by its own rate at the size V8-R1-SIZE targets, the name breaking ties, the first five', () => {
    const predictions = [
      { pair: 'CCCUSDT', currentPrice: 3, moveRates: rates(0.3, 0.05, 0.2) },
      { pair: 'AAAUSDT', currentPrice: 1, moveRates: rates(0.2, 0.1, 0.05) },
      { pair: 'BBBUSDT', currentPrice: 2, moveRates: rates(0.3, 0.1, 0.01) },
      { pair: 'DDDUSDT', currentPrice: 4, moveRates: null },
      { pair: 'EEEUSDT', currentPrice: 0, moveRates: rates(0.9, 0.9, 0.9) },
      ...Array.from({ length: 6 }, (_, k) => ({ pair: `Z${k}USDT`, currentPrice: 1, moveRates: rates(0.01, 0.01, 0.01) }))
    ]
    const lists = bigMoversOf(predictions)
    expect(lists.hour1.map((entry) => entry.pair)).toEqual(['BBBUSDT', 'CCCUSDT', 'AAAUSDT', 'Z0USDT', 'Z1USDT'])
    expect(lists.hours4.map((entry) => entry.pair).slice(0, 3)).toEqual(['AAAUSDT', 'BBBUSDT', 'CCCUSDT'])
    expect(lists.hours24[0]).toEqual({ pair: 'CCCUSDT', horizon: 'hours24', sizePct: 5, rate: 0.2, price: 3 })
    expect(lists.hour1).toHaveLength(BIG_MOVERS_LINES.listed)
  })

  it("is recorded as size calls of the source 'big-movers', whole lines the record reads back", () => {
    const lists = bigMoversOf([{ pair: 'AAAUSDT', currentPrice: 1.5, moveRates: rates(0.2, 0.1, 0.05) }])
    const made = bigMoverPredictionsOf(lists, 1_793_102_400, { engine: 'e', config: 'c' })
    expect(made.map((line) => [line.id, line.horizonSec, line.movePct])).toEqual([
      ['big-movers:AAAUSDT:1793102400:1', 3600, 1],
      ['big-movers:AAAUSDT:1793102400:2', 14_400, 2],
      ['big-movers:AAAUSDT:1793102400:3', 86_400, 5]
    ])
    expect(made[0]).toMatchObject({ source: 'big-movers', kind: 'size', side: null, refPrice: 1.5, venue: 'binance', unit: Math.floor(1_793_102_400 / 3600), sourceVersion: 'big-movers-v1@move-rates-90d' })
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
