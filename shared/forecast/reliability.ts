import type { MarketRegime } from '../marketResearch'
import { ENGLISH, type I18n } from '../i18n/translate'

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

/** Why a forecast is as reliable as it is, as a code and its figure, worded in any language by
 * reliabilityReasonText (V6 Stage 14): the window says it in the person's. */
export type ReliabilityReason =
  | { code: 'tested'; rows: number }
  | { code: 'held'; coverage80: number }
  | { code: 'untested' }
  | { code: 'agree' }
  | { code: 'disagree' }
  | { code: 'panic' }
  | { code: 'fast' }
  | { code: 'steady' }

export function reliabilityReasonText(reason: ReliabilityReason, { t, num, pctPlain }: I18n = ENGLISH): string {
  switch (reason.code) {
    case 'tested':
      return t('tested on {rows} outcomes', { rows: num(reason.rows, 0, 0) })
    case 'held':
      return t('its 80% range held {share} of them', { share: pctPlain(reason.coverage80 * 100, 1) })
    case 'untested':
      return t('its range has not been tested')
    case 'agree':
      return t('the models agree')
    case 'disagree':
      return t('the models disagree')
    case 'panic':
      return t('the market is in panic')
    case 'fast':
      return t('the market is moving fast')
    case 'steady':
      return t('the market is steady')
  }
}

export function reliabilityOf(input: ReliabilityInput): { reliability: Reliability; reasons: string[]; codes: ReliabilityReason[] } {
  const graded: { grade: Reliability; reason: ReliabilityReason }[] = []
  const lines = RELIABILITY_LINES
  graded.push({
    grade: input.cellRows >= lines.rows.high ? 'HIGH' : input.cellRows >= lines.rows.medium ? 'MEDIUM' : 'LOW',
    reason: { code: 'tested', rows: input.cellRows }
  })
  const error = Number.isFinite(input.coverage80) ? Math.abs(input.coverage80 - 0.8) : Number.POSITIVE_INFINITY
  graded.push({
    grade: error <= lines.coverageError.high ? 'HIGH' : error <= lines.coverageError.medium ? 'MEDIUM' : 'LOW',
    reason: Number.isFinite(input.coverage80) ? { code: 'held', coverage80: input.coverage80 } : { code: 'untested' }
  })
  graded.push({
    grade: input.disagreement <= lines.disagreement.high ? 'HIGH' : input.disagreement <= lines.disagreement.medium ? 'MEDIUM' : 'LOW',
    reason: { code: input.disagreement <= lines.disagreement.high ? 'agree' : 'disagree' }
  })
  const stable: Reliability = input.regime === 'panic' ? 'LOW' : input.regime === 'high-vol' || input.rvRatio >= lines.rvRatio ? 'MEDIUM' : 'HIGH'
  graded.push({ grade: stable, reason: { code: input.regime === 'panic' ? 'panic' : stable === 'MEDIUM' ? 'fast' : 'steady' } })
  const reliability = graded.reduce<Reliability>((low, entry) => (RANK[entry.grade] < RANK[low] ? entry.grade : low), 'HIGH')
  const codes = graded.filter((entry) => entry.grade === reliability).map((entry) => entry.reason)
  return { reliability, reasons: codes.map((code) => reliabilityReasonText(code)), codes }
}
