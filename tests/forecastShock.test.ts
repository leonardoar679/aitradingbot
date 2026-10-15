import { describe, expect, it } from 'vitest'
import { FEATURE_NAMES } from '../shared/forecast/features'
import { SHOCK_LINES, btc15ByTime, liveBtc15, noShockRecord, shockFactors, shockFor, shockRuleOf, stretchShock, type ShockRow } from '../shared/forecast/shock'
import { usualMove } from '../shared/forecast/targets'
import { gaussOf, rng } from './forecastRecords'

// AFTER A SHARP MOVE OF BITCOIN'S (shared/forecast/shock.ts; V6.1, 15 October 2026): the factors that would
// have held the walk forward's rows past the line, the stretch they make, the rule adopted only where it
// held cross-fitted, and Bitcoin's last fifteen minutes read from its rows and from its live minutes.

/** Five levels of a normal of scale `sigma` about `mu`, in usual moves. */
const levels = (mu = 0, sigma = 1): number[] => [-1.2816, -0.6745, 0, 0.6745, 1.2816].map((z) => mu + sigma * z)

/** A walk forward's rows: `moments` moments a week for `weeks` weeks of `pairs` pairs, past the line with
 * outcomes `spread` times as dispersed as their levels say, and as many calm moments, held as they say. */
function world(options: { weeks?: number; moments?: number; pairs?: number; spread?: number | ((week: number) => number); seed?: number } = {}): ShockRow[] {
  const gauss = gaussOf(rng(options.seed ?? 7))
  const rows: ShockRow[] = []
  const weeks = options.weeks ?? 3
  const pairs = options.pairs ?? 20
  for (let week = 1; week <= weeks; week++) {
    const spread = typeof options.spread === 'function' ? options.spread(week) : (options.spread ?? 2)
    for (let moment = 0; moment < (options.moments ?? 5); moment++) {
      const t = week * 604_800 + moment * 3600
      for (let pair = 0; pair < pairs; pair++) {
        rows.push({ z: spread * gauss(), q: levels(), week, t, btc15: moment % 2 === 0 ? 2.6 : -3.1 })
        rows.push({ z: gauss(), q: levels(), week, t: t + 1800, btc15: 0.4 })
      }
    }
  }
  return rows
}

describe("the factors and the stretch", () => {
  it('reads the share of rows each range must hold off their distances over the half widths, at least 1', () => {
    // Distances over the outer half width of 0.5, 1, 1.5 ... 5: the 80th percentile is 4.5 (index 8 of 10).
    const rows = Array.from({ length: 10 }, (_, k) => ({ z: 0.5 * (k + 1) * 1.2816, q: levels() }))
    expect(shockFactors(rows).k80).toBeCloseTo(4.5, 6)
    // Inner: the same distances over 0.6745: the 50th percentile (index 5) is 3 x 1.2816 / 0.6745.
    expect(shockFactors(rows).k50).toBeCloseTo((3 * 1.2816) / 0.6745, 6)
    // A row below the median reads the lower half width.
    expect(shockFactors([{ z: -2 * 1.2816, q: levels() }]).k80).toBeCloseTo(2, 6)
    // Never below 1: rows inside their ranges ask for no narrowing.
    expect(shockFactors(Array.from({ length: 10 }, () => ({ z: 0.1, q: levels() })))).toEqual({ k80: 1, k50: 1 })
    expect(shockFactors([])).toEqual({ k80: 1, k50: 1 })
  })

  it('stretches the outer pair by k80 and the inner by k50 about the median, which stays, keeping the order', () => {
    const q = [-2, -1, 0.5, 1.5, 3]
    expect(stretchShock(q, 2, 1.5)).toEqual([0.5 - 2 * 2.5, 0.5 - 1.5 * 1.5, 0.5, 0.5 + 1.5 * 1, 0.5 + 2 * 2.5])
    expect(stretchShock(q, 1, 1)).toEqual(q)
    // An inner factor beyond the outer cannot cross them over.
    const crossed = stretchShock([-1, -0.9, 0, 0.9, 1], 1, 2)
    expect(crossed[0]).toBe(crossed[1])
    expect(crossed[4]).toBe(crossed[3])
    expect(crossed[1]).toBeCloseTo(-1.8, 12)
  })
})

describe('the rule, judged cross-fitted', () => {
  it('is adopted where widening brings the moments past the line nearer 80% and their loss no worse', () => {
    const rule = shockRuleOf(world())
    expect(rule).toMatchObject({ adopted: true, refusal: null, line: SHOCK_LINES.line, moments: 15, rows: 300 })
    expect(rule.k80).toBeGreaterThan(1.6)
    expect(rule.k80).toBeLessThan(2.4)
    expect(rule.before!.in80).toBeLessThan(0.6)
    expect(Math.abs(rule.after!.in80 - 0.8)).toBeLessThan(Math.abs(rule.before!.in80 - 0.8))
    expect(rule.after!.pinball).toBeLessThan(rule.before!.pinball)
  })

  it('is not adopted with fewer than eight moments, or 150 rows, past the line', () => {
    expect(shockRuleOf(world({ weeks: 1, moments: 7 }))).toMatchObject({ adopted: false, refusal: 'too_few', moments: 7, k80: 1, k50: 1, before: null, after: null })
    expect(shockRuleOf(world({ weeks: 2, moments: 4, pairs: 18 }))).toMatchObject({ adopted: false, refusal: 'too_few', moments: 8, rows: 144 })
    expect(shockRuleOf(world({ weeks: 2, moments: 4, pairs: 19 }))).toMatchObject({ refusal: null, moments: 8, rows: 152 })
  })

  it('is not adopted where the ranges already held: widening takes them past 80%', () => {
    expect(shockRuleOf(world({ spread: 0.9 }))).toMatchObject({ adopted: false, refusal: 'coverage' })
  })

  it('fits each week on the other weeks alone', () => {
    // Week 1's moves land three outer half widths out, week 2's half of one in. Cross-fitted, week 1 is
    // widened by week 2's factor (1) and stays out, week 2 by week 1's (3): half held, as before -- not
    // nearer 80%. Fitted with its own rows, every week would take 3, and all would be held.
    const rows: ShockRow[] = []
    for (const [week, distance] of [
      [1, 3],
      [2, 0.5]
    ] as const) {
      for (let moment = 0; moment < 4; moment++) for (let pair = 0; pair < 20; pair++) rows.push({ z: distance * 1.2816, q: levels(), week, t: week * 604_800 + moment * 3600, btc15: 3 })
    }
    const rule = shockRuleOf(rows)
    expect(rule).toMatchObject({ moments: 8, rows: 160, k80: 3, adopted: false, refusal: 'coverage' })
    expect(rule.before!.in80).toBe(0.5)
    expect(rule.after!.in80).toBe(0.5)
  })

  it('reads the line inclusively and every side of it, and leaves a row without Bitcoin out', () => {
    const at = (btc15: number): ShockRow[] => world().map((row) => (Math.abs(row.btc15) > 1 ? { ...row, btc15 } : row))
    expect(shockRuleOf(at(2.5)).rows).toBe(300)
    expect(shockRuleOf(at(-2.5)).rows).toBe(300)
    expect(shockRuleOf(at(2.4999)).rows).toBe(0)
    expect(shockRuleOf(at(Number.NaN)).rows).toBe(0)
  })

  it('says why there is none on a walk forward from before the rule', () => {
    expect(noShockRecord()).toMatchObject({ adopted: false, refusal: 'no_record', k80: 1, k50: 1, moments: 0 })
  })
})

describe('when a range is widened', () => {
  const adopted = { ...noShockRecord(), adopted: true, refusal: null, k80: 1.4, k50: 1.2 }
  it('only with an adopted rule, Bitcoin at or past its line either way', () => {
    expect(shockFor(adopted, 2.5)).toEqual({ k80: 1.4, k50: 1.2 })
    expect(shockFor(adopted, -3)).toEqual({ k80: 1.4, k50: 1.2 })
    expect(shockFor(adopted, 2.49)).toBeNull()
    expect(shockFor({ ...adopted, adopted: false, refusal: 'pinball' }, 4)).toBeNull()
    expect(shockFor(undefined, 4)).toBeNull()
    expect(shockFor(adopted, null)).toBeNull()
    expect(shockFor(adopted, Number.NaN)).toBeNull()
  })
})

describe("Bitcoin's last fifteen minutes", () => {
  it('is its own z_15m figure at each moment of a panel', () => {
    const cols = FEATURE_NAMES.length
    const z15 = FEATURE_NAMES.indexOf('z_15m')
    const x = new Float32Array(4 * cols)
    x[0 * cols + z15] = 2.75
    x[1 * cols + z15] = -0.5
    x[2 * cols + z15] = 9
    x[3 * cols + z15] = 1.25
    const map = btc15ByTime({ rows: 4, cols, x, time: Uint32Array.from([100, 100, 200, 200]), pair: Uint16Array.from([0, 1, 1, 0]), symbols: ['BTCUSDT', 'ETHUSDT'] })
    expect([...map.entries()]).toEqual([
      [100, 2.75],
      [200, 1.25]
    ])
    expect(btc15ByTime({ rows: 1, cols, x, time: Uint32Array.from([100]), pair: Uint16Array.from([0]), symbols: ['ETHUSDT'] }).size).toBe(0)
  })

  it('is read live from the minute forming against the close fifteen minutes before it began', () => {
    const rv24h = 0.024
    const minutes = Array.from({ length: 20 }, (_, k) => ({ time: 6000 + k * 60, close: 100 }))
    minutes[minutes.length - 1] = { ...minutes[minutes.length - 1], close: 98 }
    expect(liveBtc15(minutes, rv24h)).toBeCloseTo(Math.log(98 / 100) / usualMove(rv24h, 3), 9)
    // The minute that ended fifteen minutes before is the one that began sixteen before.
    const moved = minutes.map((minute) => (minute.time === minutes[minutes.length - 1].time - 960 ? { ...minute, close: 99 } : minute))
    expect(liveBtc15(moved, rv24h)).toBeCloseTo(Math.log(98 / 99) / usualMove(rv24h, 3), 9)
    expect(liveBtc15(minutes.slice(-15), rv24h)).toBeNull()
    expect(liveBtc15([], rv24h)).toBeNull()
    expect(liveBtc15(minutes, 0)).toBeNull()
  })
})
