import { describe, expect, it } from 'vitest'
import type { ForecastBar } from '../shared/forecast/bars'
import { R2_CONFIRM_LEVEL, R2_LINES, analogCallsOf, normalQuantile, r2FiguresOf, tQuantile, tailCallsOf, widthCallsOf, type R2Call, type R2Row } from '../shared/forecast/r2'

// V8 R2 (shared/forecast/r2.ts; V8 Stage 11): the three direction hypotheses' call rules and the direction bar they are
// judged by -- WIDTH in its month's widest tenth where the shown P(up) agrees, ANALOG by the 50 nearest rows at least a
// week earlier, TAIL after an hour's move of 5% or 10% -- each one call a coin a horizon (TAIL one in 24 hours).

const T0 = Date.UTC(2026, 2, 1) / 1000
const HOUR = 3600

const row = (over: Partial<R2Row>): R2Row => ({
  t: T0,
  pair: 'AAAUSDT',
  fold: 1,
  z: 1,
  movePct: 1,
  prevZ: 0,
  rv24h: 0.03,
  btc15: 0,
  state: 0,
  cls: 2,
  shownZ: [-1.2, -0.6, 0, 0.6, 1.2],
  shownPct: [-1, -0.5, 0, 0.5, 1],
  pUp: 0.5,
  baseUp: 0.5,
  ...over
})

describe('WIDTH', () => {
  it("calls only the month's widest tenth, the median's way where P(up) agrees, one call a coin a horizon", () => {
    const rows: R2Row[] = []
    // Twenty coin-hours in March: two wide ones, eighteen narrow; and a wide one in April, its own month's widest.
    for (let k = 0; k < 18; k++) rows.push(row({ t: T0 + k * HOUR, pair: `N${k}USDT` }))
    rows.push(row({ t: T0 + HOUR, pair: 'UPUSDT', shownPct: [-2, -1, 0.5, 2, 4], pUp: 0.6, baseUp: 0.52, movePct: 3 }))
    rows.push(row({ t: T0 + 2 * HOUR, pair: 'DNUSDT', shownPct: [-4, -2, -0.5, 1, 2], pUp: 0.4, baseUp: 0.52, movePct: 1 }))
    rows.push(row({ t: T0 + 31 * 86_400, pair: 'APRUSDT', shownPct: [-0.3, -0.1, 0.05, 0.2, 0.4], pUp: 0.7, movePct: -1 }))
    const calls = widthCallsOf(rows, HOUR)
    expect(calls.map((call) => [call.pair, call.way, call.movePct])).toEqual([
      ['UPUSDT', 1, 3],
      ['DNUSDT', -1, 1],
      ['APRUSDT', 1, -1]
    ])
    // The base of a call down is the share that went down.
    expect(calls[0].base).toBe(0.52)
    expect(calls[1].base).toBeCloseTo(0.48, 12)
    // A wide row whose P(up) does not agree with its median, or has none yet, is not called; and a coin called is not
    // called again within its horizon.
    const again = widthCallsOf(
      [
        ...rows,
        row({ t: T0 + 30 * 60, pair: 'UPUSDT', shownPct: [-2, -1, 0.5, 2, 4], pUp: 0.4 }),
        row({ t: T0 + 3 * HOUR, pair: 'NOPUSDT', shownPct: [-2, -1, 0.5, 2, 4], pUp: null }),
        row({ t: T0 + HOUR + 1800, pair: 'UPUSDT', shownPct: [-2, -1, 0.5, 2, 4], pUp: 0.9 })
      ],
      HOUR
    )
    expect(again.filter((call) => call.pair === 'UPUSDT').map((call) => call.t)).toEqual([T0 + HOUR])
    expect(again.some((call) => call.pair === 'NOPUSDT')).toBe(false)
  })
})

describe('ANALOG', () => {
  it('calls the way 60% of the 50 nearest rows at least a week earlier went, and nothing without 50 of them', () => {
    const rows: R2Row[] = []
    // A first week of 60 rows like the one asked about: 40 up, 20 down; then 60 unlike it, all down.
    for (let k = 0; k < 60; k++) rows.push(row({ t: T0 + k * 600, pair: `S${k % 7}USDT`, prevZ: 1, z: k % 3 === 2 ? -1 : 1, fold: 1 }))
    for (let k = 0; k < 60; k++) rows.push(row({ t: T0 + k * 600 + 300, pair: `U${k % 7}USDT`, prevZ: -3, rv24h: 0.09, z: -1, fold: 1 }))
    // Asked a week and a day on: like the first kind, it goes the first kind's majority's way.
    const asked = row({ t: T0 + 8 * 86_400, pair: 'QUSDT', prevZ: 1, fold: 2, movePct: 0.4 })
    const made = analogCallsOf([...rows, asked], HOUR)
    expect(made.calls).toEqual([{ t: asked.t, pair: 'QUSDT', way: 1, movePct: 0.4, base: 0.5 }])
    // Under 60% one way among the 50 nearest: no call.
    const even = rows.map((entry, k) => (k < 60 ? { ...entry, z: k % 2 === 0 ? 1 : -1 } : entry))
    expect(analogCallsOf([...even, asked], HOUR).calls).toEqual([])
    // Asked within a week of every row: none is read, no call.
    expect(analogCallsOf([...rows, { ...asked, t: T0 + 3 * 86_400 }], HOUR).calls).toEqual([])
    // A row whose move up to the moment is not held is not asked.
    expect(analogCallsOf([...rows, { ...asked, prevZ: null }], HOUR).asked).toBe(0)
  })
})

describe('TAIL', () => {
  // A coin's five-minute bars over two days: flat at 100, then up 6% into the hour at T0 + 10 h, and on to 110 by
  // T0 + 14 h; another 6% hour at T0 + 20 h, inside 24 hours of the first.
  const bars: ForecastBar[] = []
  for (let k = 0; k < 2 * 288; k++) {
    const time = T0 + k * 300
    let price = 100
    if (time >= T0 + 10 * HOUR - 300) price = 106
    if (time >= T0 + 11 * HOUR) price = 108
    if (time >= T0 + 14 * HOUR - 300) price = 110
    if (time >= T0 + 20 * HOUR - 300) price = 117
    bars.push({ time, open: price, high: price, low: price, close: price, volume: 1, quoteVolume: price, takerBuyVolume: 0.5, trades: 1 })
  }
  // The entry bar opens at the hour at 106, a little above where the last one closed.
  const entry = bars.findIndex((bar) => bar.time === T0 + 10 * HOUR)
  bars[entry] = { ...bars[entry], open: 106.5 }
  const rows = Array.from({ length: 30 }, (_, k) => ({ t: T0 + k * HOUR, pair: 'TAILUSDT', baseUp: 0.45 }))

  it("calls the move's way or the other after an hour's move of 5%, entered at the next bar's open, one call in 24 hours", () => {
    const continued = tailCallsOf(rows, () => bars, 4 * HOUR, 5, 'continuation')
    expect(continued.calls).toHaveLength(1)
    expect(continued.calls[0]).toMatchObject({ t: T0 + 10 * HOUR, pair: 'TAILUSDT', way: 1, base: 0.45 })
    expect(continued.calls[0].movePct).toBeCloseTo((110 / 106.5 - 1) * 100, 9)
    const reversed = tailCallsOf(rows, () => bars, HOUR, 5, 'reversal')
    expect(reversed.calls.map((call) => [call.way, call.base])).toEqual([[-1, 0.55]])
    // Held an hour: out at the close of the bar that ends at T0 + 11 h, still 106.
    expect(reversed.calls[0].movePct).toBeCloseTo((106 / 106.5 - 1) * 100, 9)
    // A 6% hour is not a 10% one.
    expect(tailCallsOf(rows, () => bars, HOUR, 10, 'continuation').calls).toEqual([])
    // A call whose exit bar is not there is not made, and counted.
    const short = tailCallsOf(rows, () => bars.filter((bar) => bar.time !== T0 + 14 * HOUR - 300), 4 * HOUR, 5, 'continuation')
    expect(short).toMatchObject({ calls: [{ t: T0 + 20 * HOUR }], missing: 1 })
  })
})

describe('the direction bar', () => {
  const calls = (count: number, right: (k: number) => boolean, move = 1, spreadDays = 60): R2Call[] =>
    Array.from({ length: count }, (_, k) => ({
      t: T0 + Math.floor((k * spreadDays * 86_400) / count),
      pair: `P${k % 40}USDT`,
      way: 1 as const,
      movePct: right(k) ? move : -move,
      base: 0.5
    }))

  it('passes a cell that clears every line, and says which line a cell misses', () => {
    const strong = r2FiguresOf(calls(1200, (k) => k % 10 < 7), { split: T0 + 30 * 86_400, precisionLevel: 0.95, byHour: false })
    expect(strong.lines.map((line) => [line.id, line.ok])).toEqual([
      ['calls', true],
      ['precision', true],
      ['skill', true],
      ['halves', true],
      ['edge', true]
    ])
    expect(strong.passed).toBe(true)
    expect(strong.precision!.value).toBeCloseTo(0.7, 9)
    expect(strong.skill!.value).toBeCloseTo(0.2, 9)
    expect(strong.edgePct!.value).toBeCloseTo(0.7 - 0.3 - R2_LINES.bar.roundTripPct, 9)
    expect(strong.detectable).toBeGreaterThan(0)
    const few = r2FiguresOf(calls(150, (k) => k % 10 < 7), { split: T0 + 30 * 86_400, precisionLevel: 0.95, byHour: false })
    expect(few.lines[0]).toMatchObject({ id: 'calls', ok: false })
    expect(few.passed).toBe(false)
    // Right only in the first half of the year: the halves line fails.
    const fading = r2FiguresOf(calls(1200, (k) => k < 600 || k % 2 === 0), { split: T0 + 30 * 86_400, precisionLevel: 0.95, byHour: false })
    expect(fading.lines.find((line) => line.id === 'halves')!.ok).toBe(false)
  })

  it("reads the second year's precision at 1 - 0.05/m, lower than at 95%", () => {
    const set = calls(300, (k) => k % 20 < 11, 1, 90)
    const at95 = r2FiguresOf(set, { split: T0 + 45 * 86_400, precisionLevel: 0.95, byHour: false })
    const strict = r2FiguresOf(set, { split: T0 + 45 * 86_400, precisionLevel: R2_CONFIRM_LEVEL, byHour: false })
    expect(R2_CONFIRM_LEVEL).toBeCloseTo(1 - 0.05 / 12, 12)
    expect(strict.precision!.low).toBeLessThan(at95.precision!.low)
    expect(strict.precision!.value).toBeCloseTo(at95.precision!.value, 12)
  })

  it('holds a TAIL line only where it holds by t on the hours\' means too', () => {
    // Every call in two hours of the same day: the whole-day read has one block, the hours' read two observations.
    const bunched: R2Call[] = Array.from({ length: 300 }, (_, k) => ({ t: T0 + (k < 150 ? 0 : HOUR), pair: `P${k % 40}USDT`, way: 1, movePct: k < 150 || k % 2 === 0 ? 1 : -1, base: 0.5 }))
    const read = r2FiguresOf(bunched, { split: T0 + 30 * 86_400, precisionLevel: 0.95, byHour: true })
    expect(read.byHour).not.toBeNull()
    expect(read.lines.find((line) => line.id === 'precision')!.ok).not.toBe(true)
  })

  it("reads the normal's and Student's quantiles", () => {
    expect(normalQuantile(0.975)).toBeCloseTo(1.959964, 5)
    expect(normalQuantile(0.025)).toBeCloseTo(-1.959964, 5)
    expect(normalQuantile(0.5)).toBeCloseTo(0, 9)
    expect(tQuantile(0.975, 10)).toBeCloseTo(2.228, 2)
    expect(tQuantile(0.975, 1000)).toBeCloseTo(1.962, 3)
  })
})
