import { describe, expect, it } from 'vitest'
import { R1_LINES, brierOf, brierSkillOf, isotonicByMonth, r1EitherVerdictOf, r1SizeVerdictOf, tenthsOf, topTenthOf, type R1Row } from '../shared/forecast/r1'

// V8 R1 (shared/forecast/r1.ts; V8 Stage 11): does a ranker of how far a coin may move -- the forecast's width, its
// either-way odds -- beat the coin's own ninety-day rate, mapped month by month on the months before; and are the
// either-way odds honest as stated.

/** A deterministic generator in [0, 1). */
function random(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0
    return state / 2 ** 32
  }
}

describe('the mapping', () => {
  it('maps each month on the months before it alone, the first month left out', () => {
    const points = [
      { month: '2026-03', x: 1, y: 0 as const },
      { month: '2026-03', x: 3, y: 1 as const },
      { month: '2026-04', x: 2, y: 0 as const },
      { month: '2026-04', x: 3, y: 0 as const },
      { month: '2026-05', x: 3, y: 1 as const },
      { month: '2026-05', x: Number.NaN, y: 1 as const }
    ]
    const mapped = isotonicByMonth(points)
    expect(mapped.slice(0, 2)).toEqual([null, null])
    // April from March alone: a 1 did not move and a 3 did; a 2 read halfway between.
    expect(mapped.slice(2, 4)).toEqual([0.5, 1])
    // May from March and April together: of the two 3s, one moved.
    expect(mapped[4]).toBeCloseTo(0.5, 12)
    expect(mapped[5]).toBeNull()
  })
})

describe('the figures', () => {
  const next = random(7)
  // A probability that is right as stated, and a base that knows nothing beyond the rate.
  const honest: R1Row[] = Array.from({ length: 6000 }, (_, k) => {
    const p = 0.05 + 0.9 * next()
    return { block: Math.floor(k / 10), p, base: 0.5, y: next() < p ? 1 : 0 }
  })

  it("reads a Brier skill over the base by blocks, none where the probability is the base's", () => {
    const skill = brierSkillOf(honest, 1)!
    expect(skill.value).toBeGreaterThan(0.2)
    expect(skill.low).toBeGreaterThan(0.1)
    expect(brierSkillOf(honest.map((row) => ({ ...row, p: row.base })), 1)!.value).toBeCloseTo(0, 12)
    expect(brierOf([{ p: 0.25, y: 1 }])).toBeCloseTo(0.5625, 12)
  })

  it('judges a tenth only with 100 effective outcomes, within two points of its share', () => {
    const tenths = tenthsOf(honest, 1)
    expect(tenths).toHaveLength(10)
    for (const tenth of tenths) {
      expect(tenth.effective).not.toBeNull()
      expect(tenth.within).toBe(Math.abs(tenth.stated - tenth.share) <= R1_LINES.tenthTolerance ? true : tenth.effective! >= 100 ? false : null)
    }
    // Stated ten points too high everywhere: every judged tenth is off.
    const proud = tenthsOf(
      honest.map((row) => ({ ...row, p: Math.min(1, row.p + 0.1) })),
      1
    )
    expect(proud.filter((tenth) => tenth.within !== null).every((tenth) => tenth.within === false)).toBe(true)
    // Twenty rows: no tenth judged.
    expect(tenthsOf(honest.slice(0, 20), 1).every((tenth) => tenth.within === null)).toBe(true)
  })

  it('reads the top tenth by a score, ties at its floor kept', () => {
    const rows = Array.from({ length: 20 }, (_, k) => ({ block: k, score: k < 15 ? 0 : k, y: (k >= 18 ? 1 : 0) as 0 | 1 }))
    expect(topTenthOf(rows, 1)).toMatchObject({ rows: 2, hits: { value: 1 } })
    const tied = rows.map((row) => ({ ...row, score: row.score >= 18 ? 18 : row.score }))
    expect(topTenthOf(tied, 1).rows).toBe(2)
    expect(topTenthOf([...tied, { block: 30, score: 18, y: 0 }], 1).rows).toBe(3)
  })
})

describe('the verdicts', () => {
  it('passes a ranker that beats the base on all three lines, and fails one that does not', () => {
    const next = random(11)
    // The truth is a coin-hour's own chance; the ranker reads it, the base reads its coin's average.
    const rows: R1Row[] = Array.from({ length: 20_000 }, (_, k) => {
      const chance = next() < 0.15 ? 0.6 : 0.08
      return { block: Math.floor(k / 20), p: chance, base: 0.15, y: next() < chance ? 1 : 0 }
    })
    const good = r1SizeVerdictOf(rows, 1)
    expect(good.lines).toEqual({ skill: true, tenths: true, top: true })
    expect(good.passed).toBe(true)
    const blind = r1SizeVerdictOf(
      rows.map((row) => ({ ...row, p: 0.15 })),
      1
    )
    expect(blind.lines.skill).toBe(false)
    expect(blind.passed).toBe(false)
  })

  it('passes either-way odds that are honest and beat the rate, and not odds stated too high', () => {
    const next = random(13)
    const rows: R1Row[] = Array.from({ length: 20_000 }, (_, k) => {
      const p = next() < 0.5 ? 0.15 : 0.45
      return { block: Math.floor(k / 20), p, base: 0.3, y: next() < p ? 1 : 0 }
    })
    expect(r1EitherVerdictOf(rows, 1)).toMatchObject({ lines: { tenths: true, brier: true }, passed: true })
    const loud = r1EitherVerdictOf(
      rows.map((row) => ({ ...row, p: row.p + 0.2 })),
      1
    )
    expect(loud.lines.tenths).toBe(false)
    expect(loud.passed).toBe(false)
  })
})
