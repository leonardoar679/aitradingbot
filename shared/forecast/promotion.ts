import type { Horizon } from './features'
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

export const PROMOTION_LINES = { minOutcomes: 5000, coverageTolerance: 0.05, minTrades: 30 } as const
export const DEGRADATION_LINES = { coverageTolerance: 0.1, biasLimit: 0.25, minOutcomes: 200, trades: 30 } as const
/** A direction model's lines (V7.1 Stage 2): the outcomes it needs, and the calls both it and the
 * distribution's P(up) need before their calls are set against each other. */
export const DIRECTION_PROMOTION_LINES = { minOutcomes: 5000, minCalls: 30 } as const

export interface CheckLine {
  id: 'outcomes' | 'coverage' | 'pinball' | 'trades' | 'skill' | 'calls'
  ok: boolean | null
  text: string
}

/** The checklist for one direction model at one horizon (V7.1 Stage 2), every line written before any
 * result was looked at: enough outcomes scored out of sample; a Brier skill above zero -- it knew more than
 * the better of an even chance and the weeks-before base rate; and, where both it and the distribution's
 * P(up) called a way often enough, its calls at the forecast's lines not less often right than the
 * distribution's on the same weeks. A line not yet measured does not block; one measured and failed does. */
export function directionChecklist(score: DirectionScore | null, baseline: DirectionScore | null): { promoted: boolean; lines: CheckLine[] } {
  if (score === null) return { promoted: false, lines: [{ id: 'outcomes', ok: false, text: `no outcomes scored out of sample (${DIRECTION_PROMOTION_LINES.minOutcomes} needed)` }] }
  const enoughCalls = score.calls >= DIRECTION_PROMOTION_LINES.minCalls && baseline !== null && baseline.calls >= DIRECTION_PROMOTION_LINES.minCalls
  const lines: CheckLine[] = [
    { id: 'outcomes', ok: score.n >= DIRECTION_PROMOTION_LINES.minOutcomes, text: `${score.n} outcomes out of sample (${DIRECTION_PROMOTION_LINES.minOutcomes} needed)` },
    { id: 'skill', ok: score.directionSkill > 0, text: `a Brier skill of ${(score.directionSkill * 100).toFixed(2)}% over the base rate (above zero needed)` },
    enoughCalls
      ? { id: 'calls', ok: score.precision >= baseline.precision, text: `${score.calls} calls at the lines, ${(score.precision * 100).toFixed(1)}% right, against the distribution's ${baseline.calls} at ${(baseline.precision * 100).toFixed(1)}%` }
      : { id: 'calls', ok: null, text: `${score.calls} calls at the lines, the distribution's ${baseline?.calls ?? 0} (${DIRECTION_PROMOTION_LINES.minCalls} each needed to set them against each other)` }
  ]
  return { promoted: lines.every((line) => line.ok !== false), lines }
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
