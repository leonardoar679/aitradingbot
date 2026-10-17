import { describe, expect, it } from 'vitest'
import { BY_HOUR_LINES, BY_HOUR_VERSION, byHourOf, dayOfWeek, dispersionOf, hourOfDay, normalQuantile } from '../shared/forecast/byHour'
import type { ScoredRow } from '../shared/forecast/runCalibration'
import { N, scaled } from './forecastRecords'

// THE CLOCK AS A DIAGNOSTIC (shared/forecast/byHour.ts; V7.2 Stage 4): the forecast shown read by the UTC hour
// it was made at and the day of the week, in four halves, with the dispersion a coverage implies and the
// misses in a shock state; a band failing only under 70% or over 90% in all four halves with 500 outcomes each;
// rows before a release left out.

const T0 = Date.parse('2026-10-05T00:00:00Z') / 1000 // a Monday

/** A row forecast at `t` for `pair` in `week`, right (inside the 80% range) or wrong by `inside`. */
function row(t: number, pair: string, week: number, inside: boolean): ScoredRow {
  return { t, pair, cls: 'mid', regime: 'sideways', week, quantiles: scaled(1), floor: scaled(1.2), z: inside ? 0.2 : 3, raw: 0.5, pUp: null, base: null }
}

/** Eight pairs over `days` days at every hour, each hour's rows inside the range a share `holds(hour)` of the
 * time, in weeks 1-3 by the day. */
function panel(days: number, holds: (hour: number) => number, pairs = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'XRPUSDT', 'ADAUSDT', 'DOGEUSDT', 'LINKUSDT', 'AVAXUSDT']): ScoredRow[] {
  const out: ScoredRow[] = []
  const counters = new Array<number>(24).fill(0)
  for (let day = 0; day < days; day++) {
    for (let hour = 0; hour < 24; hour++) {
      for (const pair of pairs) {
        // A fixed pattern at the band's share, exact where the band's rows are a multiple of twenty: the
        // band's k-th row inside where (k mod 20) < share x 20.
        out.push(row(T0 + day * 86_400 + hour * 3600, pair, 1 + Math.floor(day / 7), (counters[hour]++ % 20) < Math.round(holds(hour) * 20)))
      }
    }
  }
  return out
}

describe('the arithmetic', () => {
  it('reads the normal quantile, the dispersion a coverage implies, the hour of the day and the day of the week', () => {
    expect(normalQuantile(0.5)).toBeCloseTo(0, 9)
    expect(normalQuantile(0.9)).toBeCloseTo(1.2815515655446004, 8)
    expect(normalQuantile(0.975)).toBeCloseTo(1.959963984540054, 8)
    expect(normalQuantile(0.01)).toBeCloseTo(-2.3263478740408408, 8)
    expect(normalQuantile(0.999)).toBeCloseTo(3.090232306167813, 7)
    expect(normalQuantile(0)).toBe(Number.NEGATIVE_INFINITY)
    expect(normalQuantile(1)).toBe(Number.POSITIVE_INFINITY)
    expect(normalQuantile(Number.NaN)).toBeNaN()
    // A range that held 80% is the right width; one that held 60% is too narrow by a third; one that held 95% too wide.
    expect(dispersionOf(0.8)).toBeCloseTo(1, 8)
    expect(dispersionOf(0.6)).toBeCloseTo(1.2815515655446004 / 0.8416212335729143, 8)
    expect(dispersionOf(0.95)).toBeCloseTo(1.2815515655446004 / 1.959963984540054, 8)
    expect(dispersionOf(1)).toBe(0)
    expect(dispersionOf(0)).toBeNaN()
    expect(hourOfDay(T0 + 7 * 3600 + 1799)).toBe(7)
    expect(dayOfWeek(T0)).toBe(1)
    expect(dayOfWeek(T0 + 6 * 86_400)).toBe(0)
  })
})

describe('the bands', () => {
  it('reads each hour in four halves, pooled, and the weekdays, leaving rows before a release out', () => {
    const shown = panel(20, (hour) => (hour === 3 ? 0.5 : 0.8))
    const preEvent = new Set(shown.filter((entry) => hourOfDay(entry.t!) === 12 && entry.week === 2).map((entry) => entry.t!))
    const report = byHourOf(shown, 'hour1', (entry) => (preEvent.has(entry.t!) ? 'PRE_EVENT' : entry.z > 2 && hourOfDay(entry.t!) === 3 ? 'POST_EVENT_SHOCK' : 'NORMAL'))
    expect(report.version).toBe(BY_HOUR_VERSION)
    expect(report.horizon).toBe('hour1')
    expect(report.preEventOut).toBe(7 * 8)
    expect(report.rows).toBe(20 * 24 * 8 - 56)
    expect(report.firstWeeks).toEqual([1, 2])
    expect(report.hours.length).toBe(24)
    const three = report.hours[3]
    expect(three.pooled.n).toBe(20 * 8)
    expect(three.pooled.coverage80).toBeCloseTo(0.5, 9)
    expect(three.pooled.dispersion).toBeCloseTo(dispersionOf(0.5), 9)
    // Every miss at three o'clock was forecast in a shock state; none elsewhere.
    expect(three.pooled.missesInShock).toBe(1)
    expect(report.hours[5].pooled.missesInShock).toBe(0)
    // The four halves: the pairs' halves by the hash, the weeks' halves by the first two weeks against the third.
    const halves = three.halves.map((cell) => cell!.n)
    expect(halves.reduce((a, b) => a + b, 0)).toBe(three.pooled.n)
    expect(halves[0] + halves[1]).toBeGreaterThan(0)
    expect(halves[2] + halves[3]).toBeGreaterThan(0)
    expect(halves[0] + halves[2]).toBe(14 * 8)
    expect(halves[1] + halves[3]).toBe(6 * 8)
    // Noon lost its second week's rows to the release.
    expect(report.hours[12].pooled.n).toBe(13 * 8)
    expect(report.weekdays.map((entry) => entry.day)).toEqual([0, 1, 2, 3, 4, 5, 6])
    expect(report.weekdays.find((entry) => entry.day === 1)!.pooled.n).toBe(3 * 24 * 8 - 8)
    // Too few rows a half for the line: no band fails.
    expect(report.failing).toEqual([])
    expect(report.hours[3].failing).toBe(false)
  })

  it('calls a band failing only under 70% or over 90% in all four halves with 500 outcomes each', () => {
    // Enough rows a half: 32 pairs over 70 days give 560 at each hour in the smaller halves.
    const pairs = Array.from({ length: 32 }, (_, at) => `P${at}USDT`)
    const shown = panel(70, (hour) => (hour === 3 ? 0.6 : hour === 4 ? 0.95 : 0.8), pairs)
    const report = byHourOf(shown, 'minutes5', () => undefined)
    expect(report.hours[3].halves.every((cell) => cell !== null && cell.n >= BY_HOUR_LINES.minCell)).toBe(true)
    expect(report.failing).toEqual([3, 4])
    expect(report.hours[3].failing).toBe(true)
    expect(report.hours[4].failing).toBe(true)
    expect(report.hours[5].failing).toBe(false)
    // Without states, the misses in shock are not read.
    expect(report.hours[3].pooled.missesInShock).toBeNull()
    // One half holding 80%: the band stands.
    const mixed = shown.map((entry) => (hourOfDay(entry.t!) === 3 && entry.week >= 6 ? { ...entry, z: 0.2 } : entry))
    expect(byHourOf(mixed, 'minutes5', () => undefined).failing).toEqual([4])
    // Under the line's rows a half: not read as failing however it held.
    expect(byHourOf(shown.filter((entry) => entry.week <= 2), 'minutes5', () => undefined).failing).toEqual([])
    // Rows without a pair count in the pooled band and in no half.
    const unpaired = byHourOf(shown.map((entry) => ({ ...entry, pair: undefined })), 'minutes5', () => undefined)
    expect(unpaired.hours[3].pooled.n).toBe(70 * 32)
    expect(unpaired.hours[3].halves).toEqual([null, null, null, null])
    expect(unpaired.failing).toEqual([])
    expect(byHourOf([], 'minutes5', () => undefined)).toMatchObject({ rows: 0, hours: expect.any(Array), weekdays: [], failing: [] })
  })
})

// N and the fixture's levels are the standard normal's: a move of 0.2 is inside the 80% range, one of 3 outside.
void N
