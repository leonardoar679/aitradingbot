import { describe, expect, it } from 'vitest'
import { HORIZONS, type Horizon } from '../shared/forecast/features'
import { FORECAST_RECORD_VERSION, type MissingOutcomeLine, type OutcomeLine, type PredictionLine } from '../shared/forecast/forecastRecord'
import { SHADOW_LINES, SHADOW_VERSION, healShadowRun, liveRowsOf, shadowVerdictOf, type LiveRecord } from '../shared/forecast/shadow'

// V7.2-R Stage 8: the challenger's shadow week judged on the two live records.

/** A quarter-hour close. */
const T0 = 1_792_000_800
const closeOf = (i: number): number => T0 + i * 900

/** The realized moves: every one of 400 values from -1.995% to +1.995% once in each 400 closes, spread across the
 * hours, so that the levels of a uniform move on [-2%, +2%] are the true ones. */
const moveOf = (i: number): number => (((i * 7919) % 400) - 199.5) / 100

/** The true levels of that move, P10 to P90; others by a factor on their width, or the tails alone set. */
const EXACT = [-1.6, -1, 0, 1, 1.6]
const widened = (factor: number): number[] => EXACT.map((level) => level * factor)
const NARROW_TAILS = [-1.4, -1, 0, 1, 1.4]

type LevelsOf = (i: number, horizon: Horizon) => number[]

function lineOf(prefix: string, i: number, levels: LevelsOf, pUp: (i: number) => number, extra: Partial<PredictionLine> = {}): PredictionLine {
  const t = closeOf(i)
  return {
    v: 'prediction-v6',
    id: `${prefix}${i}`,
    pair: 'SOLUSDT',
    t,
    at: t * 1000 + 40_000,
    price: 150,
    cls: 'large',
    regime: 'sideways',
    best: null,
    run: `run-${prefix}`,
    foldsRun: `run-${prefix}`,
    why: 'grid',
    h: Object.fromEntries(HORIZONS.map((horizon) => [horizon, { q: levels(i, horizon), pUp: pUp(i) }])),
    ...extra
  } as unknown as PredictionLine
}

const outcomeOf = (prefix: string, i: number, horizon: Horizon, move: number = moveOf(i)): OutcomeLine => ({ v: FORECAST_RECORD_VERSION, id: `${prefix}${i}`, pair: 'SOLUSDT', h: horizon, t: closeOf(i), due: closeOf(i) + 3600, move }) as unknown as OutcomeLine

/** A record of `n` quarter-hour grid forecasts of one pair, each with its outcome at every horizon. */
function recordOf(prefix: string, n: number, levels: LevelsOf = () => EXACT, pUp: (i: number) => number = () => 0.5, keep: (i: number) => boolean = () => true): LiveRecord {
  const predictions: PredictionLine[] = []
  const outcomes: OutcomeLine[] = []
  for (let i = 0; i < n; i++) {
    if (!keep(i)) continue
    predictions.push(lineOf(prefix, i, levels, pUp))
    for (const horizon of HORIZONS) outcomes.push(outcomeOf(prefix, i, horizon))
  }
  return { predictions, outcomes }
}

const WEEK = { from: closeOf(0), to: closeOf(800) }

describe('a challenger in its shadow week, as current.json keeps it', () => {
  const run = { runId: 'run-20261022-0030', foldsRunId: 'run-20261022-0030', promotions: [], since: T0, until: T0 + SHADOW_LINES.days * 86_400, championRunId: 'run-20261015-0030', summary: 'cleared the champion: better beyond noise at hour1' }

  it('is read back whole, a missing summary as none', () => {
    expect(healShadowRun(JSON.parse(JSON.stringify(run)))).toEqual(run)
    expect(healShadowRun({ ...run, summary: undefined })).toEqual({ ...run, summary: '' })
    expect(SHADOW_LINES).toEqual({ days: 7, minPairs: 200 })
  })

  it('is refused without any of its fields', () => {
    for (const field of ['runId', 'foldsRunId', 'promotions', 'since', 'until', 'championRunId'] as const) expect(healShadowRun({ ...run, [field]: undefined })).toBeNull()
    expect(healShadowRun({ ...run, promotions: 'none' })).toBeNull()
    expect(healShadowRun({ ...run, until: '1792000800' })).toBeNull()
    expect(healShadowRun(null)).toBeNull()
    expect(healShadowRun('run-20261022-0030')).toBeNull()
  })
})

describe("a live record's rows", () => {
  it('are its grid forecasts in the week joined to their measured outcomes at the horizon, keyed by pair and close', () => {
    const predictions = [
      lineOf('a', 0, () => EXACT, () => 0.62),
      // Made again between closes at the same close: not the grid's, not read.
      lineOf('a', 100, () => widened(3), () => 0.9, { id: 'refresh0', t: closeOf(0), why: 'refresh' }),
      lineOf('a', 1, () => EXACT, () => 0.5),
      lineOf('a', 2, () => EXACT, () => 0.5, { h: { minutes5: { q: EXACT, pUp: 0.5 } } as PredictionLine['h'] }),
      lineOf('a', 3, () => EXACT.slice(0, 4), () => 0.5),
      lineOf('a', 4, () => EXACT, () => 0.5, { pair: 'ETHUSDT', t: closeOf(0) }),
      lineOf('a', 5, () => EXACT, () => 0.5)
    ]
    const missing: MissingOutcomeLine = { v: FORECAST_RECORD_VERSION, id: 'a1', pair: 'SOLUSDT', h: 'hour1', t: closeOf(1), due: closeOf(1) + 3600, missing: 'no bars' }
    const outcomes = [outcomeOf('a', 0, 'hour1', 1.25), outcomeOf('a', 0, 'hours4', -3), outcomeOf('refresh', 0, 'hour1'), missing, outcomeOf('a', 2, 'hour1'), outcomeOf('a', 3, 'hour1'), outcomeOf('a', 4, 'hour1', -0.5), outcomeOf('a', 5, 'hour1')]
    const rows = liveRowsOf(predictions, outcomes, 'hour1', closeOf(0), closeOf(5))
    // The last close is the week's end, not in it; the one without an outcome, without the horizon or with four levels, not read.
    expect([...rows.keys()]).toEqual([`SOLUSDT|${closeOf(0)}`, `ETHUSDT|${closeOf(0)}`])
    expect(rows.get(`SOLUSDT|${closeOf(0)}`)).toEqual({ t: closeOf(0), pair: 'SOLUSDT', cls: 'large', regime: 'sideways', week: 0, quantiles: EXACT, floor: [], z: 1.25, raw: 0, pUp: 0.62, base: 0.5 })
    expect(rows.get(`ETHUSDT|${closeOf(0)}`)?.z).toBe(-0.5)
    expect(liveRowsOf(predictions, outcomes, 'hours4', closeOf(0), closeOf(5)).get(`SOLUSDT|${closeOf(0)}`)?.z).toBe(-3)
    expect(liveRowsOf(predictions, outcomes, 'hour1', closeOf(1), closeOf(6)).has(`SOLUSDT|${closeOf(0)}`)).toBe(false)
    expect(liveRowsOf(predictions, outcomes, 'hour1', closeOf(1), closeOf(6)).has(`SOLUSDT|${closeOf(5)}`)).toBe(true)
  })
})

describe("the shadow week's verdict", () => {
  it('is unread with fewer paired outcomes than its line at every horizon, and read from the line', () => {
    const under = shadowVerdictOf(recordOf('a', 199), recordOf('b', 199), WEEK.from, WEEK.to)
    expect(under).toMatchObject({ version: SHADOW_VERSION, adopted: false, why: 'unread', summary: 'too few paired live outcomes at every horizon to judge it' })
    for (const horizon of HORIZONS) expect(under.horizons[horizon]).toEqual({ pairs: 199, paired: null, worse: false, better: false })
    const at = shadowVerdictOf(recordOf('a', 200), recordOf('b', 200), WEEK.from, WEEK.to)
    expect(at).toMatchObject({ version: SHADOW_VERSION, adopted: true, why: 'not-worse', summary: 'no worse live than the run in use at 5 horizons read' })
    expect(at.horizons.hour1).toMatchObject({ pairs: 200, worse: false, better: false, paired: { pinball: { difference: 0 } } })
  })

  it('pairs only the closes both records hold within the week', () => {
    const verdict = shadowVerdictOf(recordOf('a', 800), recordOf('b', 800, undefined, undefined, (i) => i % 2 === 0), closeOf(100), closeOf(700))
    for (const horizon of HORIZONS) expect(verdict.horizons[horizon]?.pairs).toBe(300)
    expect(verdict.why).toBe('not-worse')
  })

  it('drops a challenger whose levels were worse live beyond noise', () => {
    const verdict = shadowVerdictOf(recordOf('a', 800), recordOf('b', 800, () => widened(2)), WEEK.from, WEEK.to)
    expect(verdict).toMatchObject({ adopted: false, why: 'worse', summary: 'worse live than the run in use beyond noise at minutes5, minutes15, hour1, hours4, hours24' })
    for (const horizon of HORIZONS) expect(verdict.horizons[horizon]).toMatchObject({ pairs: 800, worse: true, better: false, paired: { pinball: { worse: true }, coverageDistance: { worse: true } } })
  })

  it('drops one whose 80% range alone was worse, its pinball within its floor', () => {
    const verdict = shadowVerdictOf(recordOf('a', 800), recordOf('b', 800, () => NARROW_TAILS), WEEK.from, WEEK.to)
    expect(verdict).toMatchObject({ adopted: false, why: 'worse' })
    expect(verdict.horizons.hour1).toMatchObject({ worse: true, paired: { pinball: { worse: false }, coverageDistance: { worse: true } } })
    expect(verdict.horizons.hour1!.paired!.coverageDistance.difference).toBeCloseTo(0.1, 6)
  })

  it('drops one whose levels inside the range alone were worse, its 80% range the same', () => {
    const verdict = shadowVerdictOf(recordOf('a', 800), recordOf('b', 800, () => [-1.6, 1.5, 1.5, 1.5, 1.6]), WEEK.from, WEEK.to)
    expect(verdict).toMatchObject({ adopted: false, why: 'worse' })
    expect(verdict.horizons.minutes15).toMatchObject({ worse: true, paired: { pinball: { worse: true }, coverageDistance: { worse: false, difference: 0 } } })
  })

  it('drops one whose P(up) alone was worse', () => {
    const wrong = (i: number): number => (moveOf(i) > 0 ? 0.2 : 0.8)
    const verdict = shadowVerdictOf(recordOf('a', 800), recordOf('b', 800, undefined, wrong), WEEK.from, WEEK.to)
    expect(verdict).toMatchObject({ adopted: false, why: 'worse' })
    expect(verdict.horizons.hours4).toMatchObject({ worse: true, paired: { pinball: { worse: false, difference: 0 }, coverageDistance: { worse: false }, directionSkill: { worse: true } } })
  })

  it('adopts one better live, and says where', () => {
    const verdict = shadowVerdictOf(recordOf('a', 800, () => widened(1.5)), recordOf('b', 800), WEEK.from, WEEK.to)
    expect(verdict).toMatchObject({ adopted: true, why: 'not-worse', summary: 'no worse live than the run in use at 5 horizons read, better at minutes5, minutes15, hour1, hours4, hours24' })
    for (const horizon of HORIZONS) expect(verdict.horizons[horizon]).toMatchObject({ worse: false, better: true })
    // Better by its P(up) alone: the run in use's confidently wrong, the challenger's an even chance.
    const wrong = (i: number): number => (moveOf(i) > 0 ? 0.2 : 0.8)
    const byWay = shadowVerdictOf(recordOf('a', 800, undefined, wrong), recordOf('b', 800), WEEK.from, WEEK.to)
    expect(byWay).toMatchObject({ adopted: true, why: 'not-worse' })
    expect(byWay.horizons.hour1).toMatchObject({ worse: false, better: true, paired: { pinball: { better: false }, coverageDistance: { better: false }, directionSkill: { better: true } } })
  })

  it('reads a horizon worse by one figure as worse, however much better by the others', () => {
    const wrong = (i: number): number => (moveOf(i) > 0 ? 0.2 : 0.8)
    const verdict = shadowVerdictOf(recordOf('a', 800, () => widened(1.5)), recordOf('b', 800, undefined, wrong), WEEK.from, WEEK.to)
    expect(verdict).toMatchObject({ adopted: false, why: 'worse' })
    expect(verdict.horizons.hour1).toMatchObject({ worse: true, better: false, paired: { pinball: { better: true }, directionSkill: { worse: true } } })
  })

  it('drops one worse at a single horizon, however much better at the others', () => {
    const levels: LevelsOf = (_i, horizon) => (horizon === 'hour1' ? widened(2) : EXACT)
    const verdict = shadowVerdictOf(recordOf('a', 800, () => widened(1.5)), recordOf('b', 800, levels), WEEK.from, WEEK.to)
    expect(verdict).toMatchObject({ adopted: false, why: 'worse', summary: 'worse live than the run in use beyond noise at hour1' })
    expect(verdict.horizons.minutes5).toMatchObject({ worse: false, better: true })
    expect(verdict.horizons.hour1).toMatchObject({ worse: true, better: false })
  })

  it('leaves a horizon unread whose hours are too few for an interval, and judges by the others', () => {
    // Three pairs at 80 closes: 240 paired outcomes in 20 hours, five blocks of four hours and one of a day.
    const asPair = (record: LiveRecord, pair: string): LiveRecord => ({
      predictions: record.predictions.map((line) => ({ ...line, pair, id: `${pair}-${line.id}` })),
      outcomes: record.outcomes.map((line) => ({ ...line, pair, id: `${pair}-${line.id}` }))
    })
    const threeOf = (record: LiveRecord): LiveRecord => {
      const pairs = ['SOLUSDT', 'ETHUSDT', 'XRPUSDT'].map((pair) => asPair(record, pair))
      return { predictions: pairs.flatMap((one) => one.predictions), outcomes: pairs.flatMap((one) => one.outcomes) }
    }
    const verdict = shadowVerdictOf(threeOf(recordOf('a', 80)), threeOf(recordOf('b', 80)), WEEK.from, WEEK.to)
    expect(verdict.horizons.hours24).toEqual({ pairs: 240, paired: null, worse: false, better: false })
    expect(verdict.horizons.hours4).toMatchObject({ pairs: 240, paired: { blocks: 5 } })
    expect(verdict).toMatchObject({ adopted: true, why: 'not-worse', summary: 'no worse live than the run in use at 4 horizons read' })
  })
})
