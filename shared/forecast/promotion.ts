import type { Horizon, PairClass } from './features'
import type { DirectionModelId, ForecastModelId } from './models'
import type { DirectionScore } from './runCalibration'
import type { ModelScore } from './walkForward'
import { HORIZON_SPAN } from './words'
import { ENGLISH, type I18n } from '../i18n/translate'

// PROMOTION AND DEGRADATION (the V6 document, §104-105; V6 Stage 5, 13 October 2026).
//
// A model weighs in the forecast only once its out-of-sample record earns it, line by line, every line
// written before any result was looked at: enough outcomes, an 80% interval that held about 80% of
// them, a pinball loss below persistence's on the same outcomes -- it knows more than "the move will be
// as big as usual" -- and, for a horizon the forecast trader takes (V6 Stage 11), a positive net after
// costs over thirty replayed trades. Not yet promoted, a model is still computed and kept on record; it
// only does not weigh. Persistence itself needs no promotion: it is the floor everything stands on.
//
// DEGRADED when its last week went wrong on any count: coverage gone more than ten points from 80%,
// a pinball loss above persistence's, the median biased by more than a quarter of the usual move, or
// the trader's last thirty trades on it losing. Flagged and told once a day; never deleted or switched
// off by the app -- its weight in the forecast falls with its own score.
//
// THE DIRECTION BAR (V7.2 Stage 2, 17 October 2026). V7.1's checklist for a direction model asked for 5,000
// outcomes, a Brier skill above zero and, where both it and the distribution's P(up) made thirty calls,
// calls no less often right; on the record of 16 October it promoted skills of a few hundredths of a
// percent, and under a null where the outcomes were shifted by whole days it promoted noise in 3-26% of
// shifts (research/directionNull.ts). The lines below were fixed before that null was run again on them:
// a skill of at least the hundredth a P(up) source needs, so "promoted" and "a source" agree; at least 200
// calls, whose precision's lower 95% bound clears an even chance; a skill above zero in both halves of the
// weeks and both halves of the pairs; no class with 2,000 outcomes under -1%; and, for the model to be
// TRADEABLE, the mean realized move in the way its calls called, less the round trip's cost, above zero
// with its interval's lower bound above zero. A line that cannot be read holds a direction model back: what
// cannot be measured is not held. A model is a P(up) source only where it was tradeable on two walk
// forwards in a row (shared/forecast/runCalibration.ts directionSourceOf).

export const PROMOTION_LINES = { minOutcomes: 5000, coverageTolerance: 0.05, minTrades: 30 } as const
export const DEGRADATION_LINES = { coverageTolerance: 0.1, biasLimit: 0.25, minOutcomes: 200, trades: 30 } as const
/** A direction model's lines (V7.2 Stage 2; V7.1's were 5,000 outcomes, a skill above zero and 30 calls). */
export const DIRECTION_PROMOTION_LINES = {
  minOutcomes: 5000,
  /** The skill a model needs: the hundredth a P(up) source needs (DIRECTION_LINES.minDirectionSkill). */
  minSkill: 0.01,
  /** The calls at the lines a model needs before its precision is read. */
  minCalls: 200,
  /** Its precision's lower 95% bound must clear an even chance. */
  precisionLowerBound: 0.5,
  /** Its skill must be above this in both halves of the weeks and both halves of the pairs. */
  halvesAbove: 0,
  /** No class with this many outcomes may read under this skill. */
  classFloor: { minOutcomes: 2000, minSkill: -0.01 },
  /** Tradeable: the calls' mean move in the way called, less the round trip, above this with its lower bound. */
  edgeAbovePct: 0
} as const

export interface CheckLine {
  id: 'outcomes' | 'coverage' | 'pinball' | 'trades' | 'skill' | 'calls' | 'precision' | 'halves' | 'classes' | 'edge'
  ok: boolean | null
  text: string
}

const skillPct = (value: number | null): string => (value === null || !Number.isFinite(value) ? '-' : `${(value * 100).toFixed(2)}%`)
const signedPct = (value: number): string => (Number.isFinite(value) ? `${value >= 0 ? '+' : ''}${value.toFixed(3)}%` : '-')

/** The checklist for one direction model at one horizon (V7.2 Stage 2), every line written before any
 * result was looked at by it; `byClass` is the model's score in each pair class with a score of its own.
 * Promoted by every line but the edge's, each measured and held; tradeable where the edge's holds too. A
 * line that cannot be read (no interval, a half with nothing in it, no moves) holds the model back. */
export function directionChecklist(score: DirectionScore | null, byClass: Partial<Record<PairClass, DirectionScore>> = {}): { promoted: boolean; tradeable: boolean; lines: CheckLine[] } {
  const L = DIRECTION_PROMOTION_LINES
  if (score === null) return { promoted: false, tradeable: false, lines: [{ id: 'outcomes', ok: false, text: `no outcomes scored out of sample (${L.minOutcomes} needed)` }] }
  const precisionLow = score.ci?.precision?.low ?? null
  const halves = score.halves
  const halvesRead = halves !== undefined && halves.weeks.every((value) => value !== null) && halves.pairs.every((value) => value !== null)
  const failing = (Object.entries(byClass) as [PairClass, DirectionScore | undefined][]).filter(([, mine]) => mine !== undefined && mine.n >= L.classFloor.minOutcomes && mine.directionSkill < L.classFloor.minSkill).map(([cls]) => cls)
  const edge = score.edge
  const lines: CheckLine[] = [
    { id: 'outcomes', ok: score.n >= L.minOutcomes, text: `${score.n} outcomes out of sample (${L.minOutcomes} needed)` },
    { id: 'skill', ok: score.directionSkill >= L.minSkill, text: `a Brier skill of ${skillPct(score.directionSkill)} over the base rate (${skillPct(L.minSkill)} needed)` },
    { id: 'calls', ok: score.calls >= L.minCalls, text: `${score.calls} calls at the lines (${L.minCalls} needed)` },
    precisionLow === null
      ? { id: 'precision', ok: null, text: 'the calls\' precision has no interval: not read' }
      : { id: 'precision', ok: precisionLow > L.precisionLowerBound, text: `${(score.precision * 100).toFixed(1)}% of the calls right, at least ${(precisionLow * 100).toFixed(1)}% (above ${(L.precisionLowerBound * 100).toFixed(0)}% needed)` },
    halvesRead
      ? {
          id: 'halves',
          ok: halves.weeks.every((value) => value! > L.halvesAbove) && halves.pairs.every((value) => value! > L.halvesAbove),
          text: `skill ${skillPct(halves.weeks[0])} and ${skillPct(halves.weeks[1])} in the two halves of the weeks, ${skillPct(halves.pairs[0])} and ${skillPct(halves.pairs[1])} in the two halves of the pairs (each above zero needed)`
        }
      : { id: 'halves', ok: null, text: 'a half of the weeks or of the pairs holds no outcome: not read' },
    { id: 'classes', ok: failing.length === 0, text: failing.length === 0 ? `no class with ${L.classFloor.minOutcomes} outcomes under ${skillPct(L.classFloor.minSkill)}` : `${failing.join(', ')} under ${skillPct(L.classFloor.minSkill)} on ${L.classFloor.minOutcomes} outcomes or more` },
    edge === undefined
      ? { id: 'edge', ok: null, text: 'the calls\' realized moves were not read' }
      : edge.ci === null
        ? { id: 'edge', ok: null, text: `the calls' mean move in the way called, less the round trip, ${signedPct(edge.meanPct)}, has no interval: not read` }
        : { id: 'edge', ok: edge.meanPct > L.edgeAbovePct && edge.ci.low > L.edgeAbovePct, text: `the calls' mean move in the way called, less the round trip, ${signedPct(edge.meanPct)} [${signedPct(edge.ci.low)}, ${signedPct(edge.ci.high)}] (above zero with its lower bound needed)` }
  ]
  // A line not read holds a direction model back: what cannot be measured is not held.
  const promoted = lines.filter((line) => line.id !== 'edge').every((line) => line.ok === true)
  const tradeable = promoted && lines.find((line) => line.id === 'edge')!.ok === true
  return { promoted, tradeable, lines }
}

const pct = (share: number): string => `${(share * 100).toFixed(1)}%`
/** A distance from 80% within a tolerance, the tolerance itself included whatever the doubles say (|0.75 - 0.8| is 0.05000000000000004). */
const within = (share: number, tolerance: number): boolean => Math.abs(share - 0.8) <= tolerance + 1e-9

/** The checklist for one model at one horizon. `tradesNet` is the forecast trader's net after costs
 * over its replayed trades on the model, and their count; null until the trader has replayed it. */
export function promotionChecklist(score: ModelScore, persistence: ModelScore, trades: { count: number; net: number } | null): { promoted: boolean; lines: CheckLine[] } {
  const lines: CheckLine[] = [
    { id: 'outcomes', ok: score.n >= PROMOTION_LINES.minOutcomes, text: `${score.n} outcomes out of sample (${PROMOTION_LINES.minOutcomes} needed)` },
    {
      id: 'coverage',
      ok: within(score.coverage80, PROMOTION_LINES.coverageTolerance),
      text: `the 80% interval held ${pct(score.coverage80)} (within ${PROMOTION_LINES.coverageTolerance * 100} points of 80% needed)`
    },
    { id: 'pinball', ok: score.pinball < persistence.pinball, text: `pinball loss ${score.pinball.toFixed(4)} against persistence's ${persistence.pinball.toFixed(4)}` },
    trades === null || trades.count < PROMOTION_LINES.minTrades
      ? { id: 'trades', ok: null, text: `the forecast trader has not replayed ${PROMOTION_LINES.minTrades} trades on it yet` }
      : { id: 'trades', ok: trades.net > 0, text: `${trades.count} replayed trades netted ${(trades.net * 100).toFixed(2)}% after costs` }
  ]
  // A line not yet measured does not block; one measured and failed does.
  return { promoted: lines.every((line) => line.ok !== false), lines }
}

/** Whether a model's last week went wrong, and why. `recentTradesNet` is its last thirty trades' net,
 * or null without thirty. Too few outcomes in the week to say: not degraded. */
/** Why a model is degraded, as a code and its figures, worded in any language by degradationText (V6
 * Stage 14). */
export type DegradationReason =
  | { code: 'coverage'; coverage80: number }
  | { code: 'pinball'; pinball: number; persistence: number }
  | { code: 'bias'; bias: number }
  | { code: 'trades'; lostPct: number }
  | { code: 'direction'; skill: number }

export function degradationText(reason: DegradationReason, { t, num, pctPlain }: I18n = ENGLISH): string {
  switch (reason.code) {
    case 'coverage':
      return t("its 80% interval held {share} of the week's outcomes", { share: pctPlain(reason.coverage80 * 100, 1) })
    case 'pinball':
      return t("its pinball loss ({loss}) was above persistence's ({floor})", { loss: num(reason.pinball, 4, 4), floor: num(reason.persistence, 4, 4) })
    case 'bias':
      return t('its median was off by {bias} of the usual move on average', { bias: num(reason.bias, 2, 2) })
    case 'trades':
      return t("the trader's last {count} trades on it lost {loss}", { count: DEGRADATION_LINES.trades, loss: pctPlain(reason.lostPct, 2) })
    case 'direction':
      return t('its chance of up knew less than the base rate ({skill} of skill)', { skill: pctPlain(reason.skill * 100, 2) })
  }
}

export function degradationOf(recent: ModelScore, persistenceRecent: ModelScore, recentTradesNet: number | null): { degraded: boolean; reasons: string[]; codes: DegradationReason[] } {
  if (recent.n < DEGRADATION_LINES.minOutcomes) return { degraded: false, reasons: [], codes: [] }
  const codes: DegradationReason[] = []
  if (!within(recent.coverage80, DEGRADATION_LINES.coverageTolerance)) codes.push({ code: 'coverage', coverage80: recent.coverage80 })
  if (recent.pinball > persistenceRecent.pinball) codes.push({ code: 'pinball', pinball: recent.pinball, persistence: persistenceRecent.pinball })
  if (Math.abs(recent.bias) > DEGRADATION_LINES.biasLimit) codes.push({ code: 'bias', bias: recent.bias })
  if (recentTradesNet !== null && recentTradesNet < 0) codes.push({ code: 'trades', lostPct: -recentTradesNet * 100 })
  return { degraded: codes.length > 0, reasons: codes.map((code) => degradationText(code)), codes }
}

/** A day: a degraded model is told once a day on its thread. */
export const DEGRADED_THREAD_SECONDS = 86_400

/** What the desktop is told of a degraded model, once a day on its thread. */
export function degradedForecastNotice(
  model: ForecastModelId | DirectionModelId,
  horizon: Horizon,
  reasons: readonly (string | DegradationReason)[],
  i18n: I18n = ENGLISH
): { title: string; body: string; thread: string; extra: { kind: 'MODEL_DEGRADED'; severity: 'watch'; thread: string; threadSeconds: number } } {
  const { t } = i18n
  const thread = `degraded:forecast:${model}:${horizon}`
  const worded = reasons.map((reason) => (typeof reason === 'string' ? reason : degradationText(reason, i18n)))
  return {
    title: t('Forecast model degraded: {model}, {horizon}', { model, horizon: t(HORIZON_SPAN[horizon]) }),
    body: t('Over the last week {reasons}. It stays computed and on record; its weight in the forecast falls with its score. Nothing was placed or sold.', { reasons: worded.join(t('; ')) }),
    thread,
    extra: { kind: 'MODEL_DEGRADED', severity: 'watch', thread, threadSeconds: DEGRADED_THREAD_SECONDS }
  }
}
