import { describe, expect, it } from 'vitest'
import { CALIBRATION_LINES, aciUpdate, buildCell, calibrate, shiftAt } from '../shared/forecast/calibration'
import { CALIBRATION_FILE_VERSION, parseRunCalibration, serializeRunCalibration } from '../shared/forecast/calibrationFile'
import { DIRECTION_LINES, calibratedPUp, fitPUp, mergeSmallSteps, rawPUp } from '../shared/forecast/direction'
import { ENSEMBLE_LINES, combine, halfWidth, lossesOf, weightsFromLosses, widenAround } from '../shared/forecast/ensemble'
import { PAIR_CLASSES } from '../shared/forecast/features'
import { QUANTILE_LEVELS, meanPinball } from '../shared/forecast/ml/quantile'
import { RUN_CALIBRATION_VERSION, buildRunCalibration, cellOf, honestScore, rowsOf, scoreOutOfSample, type ScoredRow } from '../shared/forecast/runCalibration'
import { N, gaussOf, promoted, recordOf, rng, scaled } from './forecastRecords'

// THE ENSEMBLE AND ITS CALIBRATION (shared/forecast/{ensemble,calibration,direction,runCalibration,
// calibrationFile}.ts; the V6 document, §14, §26, §56-57 and §59): who weighs and how much, the
// models' quantiles combined, a range made to hold what it says, a P(up) made to mean what it says,
// all scored on weeks the part scored never saw.

describe('the weights', () => {
  it('go to the promoted models that beat persistence, by how much they beat it', () => {
    const weights = weightsFromLosses({ persistence: 0.3, gbt: 0.28, 'quantile-gbt': 0.29, technical: 0.31, volatility: 0.25 }, new Set(['persistence', 'gbt', 'quantile-gbt', 'technical']))
    expect(weights.map((member) => member.model)).toEqual(['gbt', 'quantile-gbt'])
    expect(weights[0].weight).toBeCloseTo(2 / 3)
    expect(weights[1].weight).toBeCloseTo(1 / 3)
    // Better than every other but not promoted: no weight.
    expect(weights.some((member) => member.model === 'volatility')).toBe(false)
  })

  it('are persistence alone where no promoted model beat it', () => {
    expect(weightsFromLosses({ persistence: 0.3, gbt: 0.3, technical: 0.4 }, new Set(['gbt', 'technical']))).toEqual([{ model: 'persistence', weight: 1 }])
    expect(weightsFromLosses({ gbt: 0.2 }, new Set(['gbt']))).toEqual([{ model: 'persistence', weight: 1 }])
  })

  it('are read from each model\'s mean pinball loss', () => {
    const losses = lossesOf([
      { quantiles: { persistence: scaled(1), gbt: scaled(1, 0.5) }, z: 0.5 },
      { quantiles: { persistence: scaled(1), gbt: scaled(1, 0.5) }, z: 0.5 }
    ])
    expect(losses.gbt).toBeLessThan(losses.persistence!)
    expect(losses.technical).toBeUndefined()
  })
})

describe('the combination', () => {
  it('averages the models level by level by their weights', () => {
    const out = combine({ gbt: scaled(1), technical: scaled(1) }, [
      { model: 'gbt', weight: 0.75 },
      { model: 'technical', weight: 0.25 }
    ])
    out.quantiles.forEach((q, index) => expect(q).toBeCloseTo(N[index], 9))
    expect(out.disagreement).toBe(0)
    expect(out.members.map((member) => member.weight)).toEqual([0.75, 0.25])
  })

  it('puts back the spread between the models\' centres, as a mixture would', () => {
    const out = combine({ gbt: scaled(1, -0.5), technical: scaled(1, 0.5) }, [
      { model: 'gbt', weight: 0.5 },
      { model: 'technical', weight: 0.5 }
    ])
    expect(out.disagreement).toBeCloseTo(0.5, 9)
    // A mixture of N(-0.5, 1) and N(0.5, 1) has variance 1.25.
    expect(halfWidth(out.quantiles)).toBeCloseTo(N[4] * Math.sqrt(1.25), 9)
    expect(out.quantiles[2]).toBeCloseTo(0, 9)
  })

  it('measures a forecast in its half-width, never less than the floor', () => {
    expect(halfWidth(scaled(2))).toBeCloseTo(2 * N[4], 12)
    expect(halfWidth([0.3, 0.3, 0.3, 0.3, 0.3])).toBe(ENSEMBLE_LINES.scaleFloor)
  })

  it('widens about the median by a variance added, and not at all by none', () => {
    expect(widenAround(scaled(1, 0.3), 0)).toEqual(scaled(1, 0.3))
    const wide = widenAround(scaled(1, 0.3), 1)
    expect(wide[2]).toBeCloseTo(0.3, 9)
    expect(halfWidth(wide)).toBeCloseTo(N[4] * Math.SQRT2, 9)
  })
})

describe('the calibration', () => {
  /** Rows from a model whose ranges are `narrow` times too narrow and whose median is off by `bias`. */
  function rowsFrom(seed: number, count: number, narrow: number, bias: number): { quantiles: number[]; z: number }[] {
    const random = rng(seed)
    const gauss = gaussOf(random)
    return Array.from({ length: count }, () => {
      const sigma = 0.5 + random()
      return { quantiles: scaled(sigma / narrow, bias), z: sigma * gauss() }
    })
  }
  const coverage = (rows: { quantiles: number[]; z: number }[], cell: ReturnType<typeof buildCell>): { c80: number; c50: number; below: number[] } => {
    const calibrated = rows.map((row) => ({ q: calibrate(row.quantiles, cell), z: row.z }))
    return {
      c80: calibrated.filter((row) => row.z >= row.q[0] && row.z <= row.q[4]).length / rows.length,
      c50: calibrated.filter((row) => row.z >= row.q[1] && row.z <= row.q[3]).length / rows.length,
      below: QUANTILE_LEVELS.map((_, level) => calibrated.filter((row) => row.z <= row.q[level]).length / rows.length)
    }
  }

  it('makes a range that was too narrow and off-centre hold what it says on new outcomes', () => {
    const cell = buildCell(rowsFrom(1, 6000, 1.6, 0.4))
    expect(cell.n).toBe(6000)
    expect(cell.grid).toHaveLength(5)
    expect(cell.grid.every((level) => level.length === CALIBRATION_LINES.gridLevels)).toBe(true)
    const fresh = rowsFrom(2, 6000, 1.6, 0.4)
    const raw = coverage(fresh, { n: 0, grid: [] })
    expect(raw.c80).toBeLessThan(0.65)
    const after = coverage(fresh, cell)
    expect(Math.abs(after.c80 - 0.8)).toBeLessThan(0.02)
    expect(Math.abs(after.c50 - 0.5)).toBeLessThan(0.02)
    after.below.forEach((share, level) => expect(Math.abs(share - QUANTILE_LEVELS[level])).toBeLessThan(0.02))
  })

  it('narrows a range that was too wide, and leaves a right one about where it was', () => {
    const wide = buildCell(rowsFrom(3, 6000, 0.6, 0))
    expect(Math.abs(coverage(rowsFrom(4, 6000, 0.6, 0), wide).c80 - 0.8)).toBeLessThan(0.02)
    const right = buildCell(rowsFrom(5, 6000, 1, 0))
    const q = calibrate(scaled(1), right)
    q.forEach((value, index) => expect(Math.abs(value - N[index])).toBeLessThan(0.08))
  })

  it('puts levels the shifts crossed back in order', () => {
    // A cell that moves the P10 up by two half-widths and the P25 not at all.
    const cell = { n: 1000, grid: QUANTILE_LEVELS.map((_, level) => Array.from({ length: 99 }, () => (level === 0 ? 2 : 0))) }
    const q = calibrate(scaled(1), cell)
    expect(q.every((value, index) => index === 0 || value >= q[index - 1])).toBe(true)
    expect(q[4]).toBeCloseTo(N[0] + 2 * N[4], 9)
  })

  it('reads each level off its grid, between the grid\'s ends', () => {
    const cell = { n: 99, grid: QUANTILE_LEVELS.map(() => Array.from({ length: 99 }, (_, index) => index + 1)) }
    expect(shiftAt(cell, 0, 0.1)).toBeCloseTo(10, 9)
    expect(shiftAt(cell, 0, 0.105)).toBeCloseTo(10.5, 9)
    expect(shiftAt(cell, 0, 0.001)).toBe(1)
    expect(shiftAt(cell, 0, 0.999)).toBe(99)
  })

  it('follows a market that changes: the adaptive step brings the share below each level back', () => {
    const cell = buildCell(rowsFrom(6, 6000, 1, 0))
    const random = rng(7)
    const gauss = gaussOf(random)
    let taus: number[] = [...QUANTILE_LEVELS]
    let staticBelow = 0
    let adaptiveBelow = 0
    let counted = 0
    // The market doubles its moves; 400 moments of 20 pairs each.
    for (let moment = 0; moment < 400; moment++) {
      const outcomes = Array.from({ length: 20 }, () => ({ sigma: 0.5 + random(), e: gauss() }))
      const share = QUANTILE_LEVELS.map(() => 0)
      for (const { sigma, e } of outcomes) {
        const z = 2 * sigma * e
        const fixed = calibrate(scaled(sigma), cell)
        const moving = calibrate(scaled(sigma), cell, taus)
        moving.forEach((q, level) => (share[level] += z <= q ? 1 / outcomes.length : 0))
        if (moment >= 200) {
          staticBelow += z <= fixed[0] ? 1 : 0
          adaptiveBelow += z <= moving[0] ? 1 : 0
          counted++
        }
      }
      taus = aciUpdate(taus, share, 0.02)
    }
    // Without it a fifth of the outcomes fall under the P10; with it, about a tenth.
    expect(staticBelow / counted).toBeGreaterThan(0.18)
    expect(Math.abs(adaptiveBelow / counted - 0.1)).toBeLessThan(0.035)
  })

  it('moves a level the right way, by one step a moment, within its bounds', () => {
    const next = aciUpdate([0.1, 0.25, 0.5, 0.75, 0.9], [0.3, 0.25, 0.5, 0.75, 0.9])
    expect(next[0]).toBeCloseTo(0.1 - CALIBRATION_LINES.aciGamma * 0.2, 12)
    expect(next.slice(1)).toEqual([0.25, 0.5, 0.75, 0.9])
    expect(aciUpdate([0.0101, 0.25, 0.5, 0.75, 0.9], [1, 0.25, 0.5, 0.75, 0.9], 1)[0]).toBe(CALIBRATION_LINES.aciLow)
    expect(aciUpdate([0.1, 0.25, 0.5, 0.75, 0.9], [Number.NaN, 0.25, 0.5, 0.75, 0.9])[0]).toBe(0.1)
  })
})

describe('P(up)', () => {
  it('is the share of the forecast above zero', () => {
    expect(rawPUp(scaled(1))).toBeCloseTo(0.5, 9)
    expect(rawPUp(scaled(1, N[3]))).toBeCloseTo(0.75, 9)
    expect(rawPUp(scaled(1, -10))).toBe(0)
  })

  it('is mapped to the share that went up, every step holding at least its least', () => {
    const random = rng(11)
    const points = Array.from({ length: 3000 }, () => {
      const raw = random()
      return { raw, up: random() < 0.3 + 0.4 * raw }
    })
    const map = fitPUp(points)
    expect(map.n.every((n) => n >= DIRECTION_LINES.pUpMinBlock)).toBe(true)
    expect(map.y.every((value, index) => index === 0 || value >= map.y[index - 1])).toBe(true)
    expect(calibratedPUp(map, 0.05)).toBeLessThan(0.4)
    expect(calibratedPUp(map, 0.95)).toBeGreaterThan(0.6)
    expect(calibratedPUp({ x: [], y: [], n: [] }, 0.42)).toBe(0.42)
  })

  it('joins a small step to the neighbour nearest its rate, keeping the line non-decreasing', () => {
    const merged = mergeSmallSteps({ x: [0.1, 0.3, 0.5, 0.7], y: [0.2, 0.45, 0.5, 0.9], n: [300, 50, 300, 300] }, 200)
    expect(merged.n).toEqual([300, 350, 300])
    expect(merged.y[1]).toBeCloseTo((0.45 * 50 + 0.5 * 300) / 350, 12)
    expect(merged.x[1]).toBeCloseTo((0.3 * 50 + 0.5 * 300) / 350, 12)
    expect(mergeSmallSteps({ x: [0.5], y: [0.5], n: [3] }, 200).n).toEqual([3])
  })
})

describe('the honest score', () => {
  const row = (patch: Partial<ScoredRow>): ScoredRow => ({ cls: 'mid', regime: 'sideways', week: 2, quantiles: scaled(1), floor: scaled(1.2), z: 0.3, raw: 0.5, pUp: 0.6, base: 0.5, ...patch })

  it('counts edges inside, scores against calibrated persistence, and P(up) against the better of what knows nothing', () => {
    const score = honestScore([row({ z: N[4] }), row({ z: N[0], pUp: 0.4 }), row({ z: 3, pUp: null, base: null })])!
    expect(score.n).toBe(3)
    expect(score.nDirection).toBe(2)
    expect(score.coverage80).toBeCloseTo(2 / 3, 12)
    expect(score.coverage50).toBe(0)
    const loss = (q: number[]): number => [N[4], N[0], 3].reduce((sum, z) => sum + meanPinball(z, q), 0)
    expect(score.skill).toBeCloseTo(1 - loss(scaled(1)) / loss(scaled(1.2)), 12)
    // Both called rightly at 0.6: Brier 0.16 against an even chance's 0.25.
    expect(score.brier).toBeCloseTo(0.16, 12)
    expect(score.directionSkill).toBeCloseTo(1 - 0.16 / 0.25, 12)
    expect(score.direction).toBe(1)
    expect(score.upShare).toBe(0.5)
    // A base rate that scored better than an even chance is the one to beat, and an even chance where
    // the base rate scored worse.
    const sharp = honestScore([row({ z: 1, pUp: 0.7, base: 0.9 })])!
    expect(sharp.directionSkill).toBeCloseTo(1 - 0.09 / 0.01, 12)
    const turned = honestScore([row({ z: -1, pUp: 0.3, base: 0.9 })])!
    expect(turned.directionSkill).toBeCloseTo(1 - 0.09 / 0.25, 12)
    expect(honestScore([])).toBeNull()
  })

  it('makes no call at exactly an even chance, nor on an outcome that did not move', () => {
    const score = honestScore([row({ pUp: 0.5, z: 1 }), row({ pUp: 0.7, z: 0 }), row({ pUp: 0.7, z: 1 })])!
    expect(score.direction).toBe(1)
  })
})

describe('the run\'s calibration', () => {
  const RECORD = recordOf({ rows: 14_000, seed: 21 })
  const PROMOTIONS = promoted('hour1', ['persistence', 'gbt'])

  it('scores each week only with what the weeks before it gave, and P(up) from the week after', () => {
    // A record whose last week's moves are three times its others': had the last week been calibrated
    // on itself its range would hold 80%; calibrated on the weeks before, it cannot.
    const record = recordOf({ rows: 12_000, seed: 22 })
    for (let row = 0; row < record.rows; row++) if (record.fold[row] === 3) record.z[row] *= 3
    const scored = scoreOutOfSample(rowsOf(record), 'v2', new Set(['persistence', 'gbt']))
    expect([...new Set(scored.map((entry) => entry.week))]).toEqual([1, 2, 3])
    const last = honestScore(scored.filter((entry) => entry.week === 3))!
    expect(last.coverage80).toBeLessThan(0.55)
    const second = honestScore(scored.filter((entry) => entry.week === 2))!
    expect(Math.abs(second.coverage80 - 0.8)).toBeLessThan(0.04)
    expect(scored.filter((entry) => entry.week === 1).every((entry) => entry.pUp === null)).toBe(true)
    expect(scored.filter((entry) => entry.week >= 2).every((entry) => entry.pUp !== null && entry.base !== null)).toBe(true)
  })

  it("forecasts a week the same, P(up) and base rate too, whatever that week's own outcomes were", () => {
    const record = recordOf({ rows: 12_000, seed: 26 })
    const other = { ...record, z: Float32Array.from(record.z, (value, row) => (record.fold[row] === 3 ? -3 * value + 1 : value)) }
    const weekOf = (scored: ScoredRow[], week: number): ScoredRow[] => scored.filter((entry) => entry.week === week)
    const a = weekOf(scoreOutOfSample(rowsOf(record), 'v2', new Set(['persistence', 'gbt'])), 3)
    const b = weekOf(scoreOutOfSample(rowsOf(other), 'v2', new Set(['persistence', 'gbt'])), 3)
    expect(a.length).toBeGreaterThan(2000)
    expect(b.map((entry) => entry.quantiles)).toEqual(a.map((entry) => entry.quantiles))
    expect(b.map((entry) => entry.floor)).toEqual(a.map((entry) => entry.floor))
    expect(b.map((entry) => entry.pUp)).toEqual(a.map((entry) => entry.pUp))
    expect(b.map((entry) => entry.base)).toEqual(a.map((entry) => entry.base))
  })

  it("maps a week's P(up), and takes its base rate, only from the weeks before it", () => {
    // Moves down for three weeks and up in the last: what the last week's P(up) and base rate say is
    // what the weeks before it did.
    const record = recordOf({ rows: 12_000, seed: 25 })
    for (let row = 0; row < record.rows; row++) record.z[row] = (record.fold[row] === 3 ? 1 : -1) * (0.2 + Math.abs(record.z[row]))
    const scored = scoreOutOfSample(rowsOf(record), 'v2', new Set(['persistence', 'gbt']))
    const last = scored.filter((entry) => entry.week === 3)
    expect(last.every((entry) => entry.pUp !== null && entry.pUp < 0.2)).toBe(true)
    expect(last.every((entry) => entry.base === 0)).toBe(true)
  })

  it('weighs the model that knew the scale, holds its range, and beats persistence honestly', () => {
    const calibration = buildRunCalibration(new Map([['hour1', RECORD]]), PROMOTIONS, 'run-test')
    expect(calibration.version).toBe(RUN_CALIBRATION_VERSION)
    const v2 = calibration.horizons.hour1!.variants.v2
    expect(v2.weights.pooled).toEqual([{ model: 'gbt', weight: 1 }])
    const honest = v2.honest.pooled!
    expect(v2.honest.weeks).toEqual([1, 2, 3])
    expect(Math.abs(honest.coverage80 - 0.8)).toBeLessThan(0.03)
    expect(honest.skill).toBeGreaterThan(0.02)
    // There was no direction to learn: P(up) did not beat what knows nothing.
    expect(honest.directionSkill).toBeLessThan(DIRECTION_LINES.minDirectionSkill)
    // V1 is gbt on the price figures, whatever was promoted.
    expect(calibration.horizons.hour1!.variants.v1.weights.pooled).toEqual([{ model: 'gbt-price', weight: 1 }])
    // Each class of the record had enough outcomes for a cell of its own.
    expect(Object.keys(v2.cells.byClass).sort()).toEqual([...PAIR_CLASSES].sort())
  })

  it('finds direction where a model knew it', () => {
    const calibration = buildRunCalibration(new Map([['hour1', recordOf({ rows: 14_000, seed: 23, drift: 0.6 })]]), PROMOTIONS, 'run-test')
    const honest = calibration.horizons.hour1!.variants.v2.honest.pooled!
    expect(honest.directionSkill).toBeGreaterThan(0.05)
    expect(honest.direction).toBeGreaterThan(0.6)
  })

  it('falls back from a class with too few outcomes to the horizon\'s', () => {
    const record = recordOf({ rows: 14_000, seed: 24 })
    // Every row a mid-cap but a few hundred BTC rows.
    for (let row = 0; row < record.rows; row++) record.cls[row] = row % 40 === 0 ? 0 : 3
    const v2 = buildRunCalibration(new Map([['hour1', record]]), PROMOTIONS, 'run-test').horizons.hour1!.variants.v2
    expect(v2.cells.byClass.btc).toBeUndefined()
    expect(v2.cells.byClass.mid).toBeDefined()
    const btc = cellOf(v2, 'btc')
    expect(btc.ownClass).toBe(false)
    expect(btc.cell).toBe(v2.cells.pooled)
    expect(btc.weights).toBe(v2.weights.pooled)
    expect(btc.honest).toBe(v2.honest.pooled)
    expect(cellOf(v2, 'mid').cell).toBe(v2.cells.byClass.mid)
    expect(ENSEMBLE_LINES.minCellRows).toBe(2000)
  })

  it('reads back from its file as written, and is refused damaged anywhere', () => {
    const calibration = buildRunCalibration(new Map([['hour1', RECORD]]), PROMOTIONS, 'run-test')
    const text = serializeRunCalibration(calibration)
    expect(serializeRunCalibration(calibration)).toBe(text)
    const back = parseRunCalibration(text)
    expect(back).not.toBeNull()
    expect(serializeRunCalibration(back!)).toBe(text)
    expect(back!.horizons.hour1!.variants.v2.cells.pooled.grid[0][5]).toBeCloseTo(calibration.horizons.hour1!.variants.v2.cells.pooled.grid[0][5], 5)
    const raw = JSON.parse(text)
    expect(raw.file).toBe(CALIBRATION_FILE_VERSION)
    const damage = (edit: (copy: typeof raw) => void): unknown => {
      const copy = structuredClone(raw)
      edit(copy)
      return parseRunCalibration(JSON.stringify(copy))
    }
    expect(damage((copy) => (copy.version = 'run-calibration-v1'))).toBeNull()
    expect(damage((copy) => copy.horizons.hour1.variants.v2.cells.pooled.grid[2].pop())).toBeNull()
    expect(damage((copy) => (copy.horizons.hour1.variants.v2.weights.pooled[0].model = 'lstm'))).toBeNull()
    expect(damage((copy) => (copy.horizons.hour1.variants.v1.pUp.y = [0.5]))).toBeNull()
    expect(damage((copy) => (copy.horizons.hour1.variants.v2.cells.byClass.whales = copy.horizons.hour1.variants.v2.cells.pooled))).toBeNull()
    expect(damage((copy) => delete copy.horizons.hour1.variants.v1)).toBeNull()
    expect(parseRunCalibration('not json')).toBeNull()
    // A figure that could not be measured is written as null and read back as one that was not.
    const unmeasured = damage((copy) => (copy.horizons.hour1.variants.v2.honest.pooled.direction = null)) as ReturnType<typeof parseRunCalibration>
    expect(unmeasured!.horizons.hour1!.variants.v2.honest.pooled!.direction).toBeNaN()
  })
})
