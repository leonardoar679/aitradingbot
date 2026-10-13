import type { MarketRegime } from '../marketResearch'

// HOW FAR A FORECAST CAN BE TRUSTED (the V6 document, §25; V6 Stage 6, 13 October 2026): not how sure
// it is of its direction -- that is its confidence -- but whether its range has earned belief. Four
// readings, each graded by fixed lines, and the forecast as reliable as its weakest:
// - historical calibration: how far the cell's 80% range was from holding 80% of the outcomes it was
//   tested on, each week calibrated only on the weeks before it;
// - sample size: how many outcomes that was;
// - model agreement: how far apart the weighing models' medians are, against the range's half-width;
// - market stability: a panicking market is LOW, a high-volatility one at best MEDIUM, as is an hour
//   moving at twice the day's pace.

export type Reliability = 'LOW' | 'MEDIUM' | 'HIGH'

export const RELIABILITY_LINES = {
  rows: { high: 2000, medium: 500 },
  coverageError: { high: 0.03, medium: 0.06 },
  disagreement: { high: 0.15, medium: 0.3 },
  rvRatio: 2
} as const

const RANK: Record<Reliability, number> = { LOW: 0, MEDIUM: 1, HIGH: 2 }

export interface ReliabilityInput {
  /** The outcomes the forecast's cell was tested on, and its 80% range's coverage over them. */
  cellRows: number
  coverage80: number
  /** The weighing models' spread of medians, over the range's half-width. */
  disagreement: number
  regime: MarketRegime
  /** The last hour's volatility against the day's. */
  rvRatio: number
}

export function reliabilityOf(input: ReliabilityInput): { reliability: Reliability; reasons: string[] } {
  const graded: { grade: Reliability; reason: string }[] = []
  const lines = RELIABILITY_LINES
  graded.push({
    grade: input.cellRows >= lines.rows.high ? 'HIGH' : input.cellRows >= lines.rows.medium ? 'MEDIUM' : 'LOW',
    reason: `tested on ${input.cellRows} outcomes`
  })
  const error = Number.isFinite(input.coverage80) ? Math.abs(input.coverage80 - 0.8) : Number.POSITIVE_INFINITY
  graded.push({
    grade: error <= lines.coverageError.high ? 'HIGH' : error <= lines.coverageError.medium ? 'MEDIUM' : 'LOW',
    reason: Number.isFinite(input.coverage80) ? `its 80% range held ${(input.coverage80 * 100).toFixed(1)}% of them` : 'its range has not been tested'
  })
  graded.push({
    grade: input.disagreement <= lines.disagreement.high ? 'HIGH' : input.disagreement <= lines.disagreement.medium ? 'MEDIUM' : 'LOW',
    reason: input.disagreement <= lines.disagreement.high ? 'the models agree' : 'the models disagree'
  })
  const stable: Reliability = input.regime === 'panic' ? 'LOW' : input.regime === 'high-vol' || input.rvRatio >= lines.rvRatio ? 'MEDIUM' : 'HIGH'
  graded.push({ grade: stable, reason: input.regime === 'panic' ? 'the market is in panic' : stable === 'MEDIUM' ? 'the market is moving fast' : 'the market is steady' })
  const reliability = graded.reduce<Reliability>((low, entry) => (RANK[entry.grade] < RANK[low] ? entry.grade : low), 'HIGH')
  return { reliability, reasons: graded.filter((entry) => entry.grade === reliability).map((entry) => entry.reason) }
}
