import type { MarketRegime } from '../marketResearch'
import type { Direction } from './direction'
import type { Horizon } from './features'
import type { ForecastRange, PricePrediction } from './prediction'
import { storyKindWord, type NewsEventType } from '../newsFeed'
import { HORIZON_ADJECTIVE, REGIME_NAME, forecastModelName } from './words'
import { ENGLISH, type I18n } from '../i18n/translate'

// PREDICTION CHANGED (the V6 document, §71; V6 Stage 10, 13 October 2026). A coin the person watches --
// one of the top ten, one held, one traded -- whose forecast at its best horizon turns from BULLISH to
// BEARISH, or back, is told so: the call it had and the one it has, the ranges before and after, and
// why, as far as the forecast can say -- the model whose median moved most, the story now moving it,
// the market's regime turning. A call counts once it has held for two passes running, so that one
// close's wobble is not a change; a NEUTRAL between them starts over, and a NEUTRAL is never a change
// told. Once a coin an hour, on its own thread.

export const CHANGE_LINES = { holdPasses: 2, threadSeconds: 3600 } as const

/** What a coin's call was, as held: its way, its horizon and its range then. */
export interface HeldCall {
  direction: Direction
  horizon: Horizon
  lowPct: number
  highPct: number
  regime: MarketRegime
  medians: Record<string, number>
}

export interface CallTrack {
  held: HeldCall | null
  pending: { call: HeldCall; passes: number } | null
}

/** Why a call turned, as codes, worded in any language by changeReasonText (V6 Stage 14). */
export type ChangeReason =
  | { code: 'median'; model: string; change: number }
  | { code: 'story'; kind: NewsEventType; title: string }
  | { code: 'regime'; from: MarketRegime; to: MarketRegime }
  | { code: 'market' }

export interface CallChange {
  pair: string
  from: HeldCall
  to: HeldCall
  /** In English, as recorded. */
  reasons: string[]
  reasonCodes?: ChangeReason[]
}

export function changeReasonText(reason: ChangeReason, i18n: I18n = ENGLISH): string {
  const { t } = i18n
  switch (reason.code) {
    case 'median':
      return t("the {model} model's median moved {move}", { model: forecastModelName(reason.model, i18n), move: i18n.pct(reason.change, 2) })
    case 'story':
      return t('a {kind} story: {title}', { kind: storyKindWord(reason.kind, i18n), title: reason.title })
    case 'regime':
      return t('the market turned from {from} to {to}', { from: t(REGIME_NAME[reason.from]), to: t(REGIME_NAME[reason.to]) })
    case 'market':
      return t('the market moved against the call')
  }
}

function callOf(prediction: PricePrediction): HeldCall | null {
  const horizon = prediction.bestHorizon
  const range: ForecastRange | undefined = horizon === null ? undefined : prediction.horizons[horizon]
  if (horizon === null || range === undefined) return null
  return {
    direction: range.direction,
    horizon,
    lowPct: range.lowPct,
    highPct: range.highPct,
    regime: prediction.regime,
    medians: Object.fromEntries(range.contributions.map((member) => [member.model, member.medianLogPct]))
  }
}

const opposite = (a: Direction, b: Direction): boolean => (a === 'BULLISH' && b === 'BEARISH') || (a === 'BEARISH' && b === 'BULLISH')

/** Why the call turned, as far as the forecast can say. */
function reasonsOf(from: HeldCall, to: HeldCall, prediction: PricePrediction): ChangeReason[] {
  const out: ChangeReason[] = []
  const moved = Object.keys(to.medians)
    .map((model) => ({ model, change: to.medians[model] - (from.medians[model] ?? 0) }))
    .sort((a, b) => Math.abs(b.change) - Math.abs(a.change))[0]
  if (moved !== undefined && moved.change !== 0) out.push({ code: 'median', model: moved.model, change: moved.change })
  const story = prediction.horizons[to.horizon]?.news.v4
  if (story !== null && story !== undefined) out.push({ code: 'story', kind: story.kind as NewsEventType, title: story.title })
  if (from.regime !== to.regime) out.push({ code: 'regime', from: from.regime, to: to.regime })
  return out.length > 0 ? out : [{ code: 'market' }]
}

/** One pass of a coin's call: the track after it, and the change to tell, if the call turned. */
export function stepCall(track: CallTrack | undefined, prediction: PricePrediction): { track: CallTrack; change: CallChange | null } {
  const call = callOf(prediction)
  const current: CallTrack = track ?? { held: null, pending: null }
  if (call === null) return { track: current, change: null }
  if (current.held !== null && call.direction === current.held.direction) return { track: { held: { ...call }, pending: null }, change: null }
  const passes = current.pending !== null && current.pending.call.direction === call.direction ? current.pending.passes + 1 : 1
  if (passes < CHANGE_LINES.holdPasses && current.held !== null) return { track: { held: current.held, pending: { call, passes } }, change: null }
  // Held long enough (or the first call ever read): it is the call now.
  const codes = current.held !== null && opposite(current.held.direction, call.direction) ? reasonsOf(current.held, call, prediction) : null
  const change = current.held !== null && codes !== null ? { pair: prediction.pair, from: current.held, to: call, reasons: codes.map((reason) => changeReasonText(reason)), reasonCodes: codes } : null
  return { track: { held: call, pending: null }, change }
}

const pairWords = (pair: string): string => (pair.endsWith('USDT') ? `${pair.slice(0, -4)}/USDT` : pair)

/** A call's way, as a notice says it. */
const CALL_WORDS: Record<Direction, string> = { BULLISH: 'BULLISH', BEARISH: 'BEARISH', NEUTRAL: 'NEUTRAL' }

/** What the desktop is told of a change, on the coin's own thread, in a language: English unless handed
 * the person's. */
export function predictionChangedNotice(change: CallChange, i18n: I18n = ENGLISH): { title: string; body: string; extra: { kind: 'PREDICTION_CHANGED'; severity: 'high'; thread: string; threadSeconds: number } } {
  const { t, pct } = i18n
  const range = (call: HeldCall): string => t('{low} ~ {high}', { low: pct(call.lowPct, 2), high: pct(call.highPct, 2) })
  const reasons = change.reasonCodes === undefined ? change.reasons : change.reasonCodes.map((reason) => changeReasonText(reason, i18n))
  return {
    title: t('PREDICTION CHANGED: {pair} {from} → {to}', { pair: pairWords(change.pair), from: t(CALL_WORDS[change.from.direction]), to: t(CALL_WORDS[change.to.direction]) }),
    body: t('Previous: {previous} ({previousHorizon}). Current: {current} ({currentHorizon}). Reason: {reasons}. Nothing was placed or sold.', {
      previous: range(change.from),
      previousHorizon: t(HORIZON_ADJECTIVE[change.from.horizon]),
      current: range(change.to),
      currentHorizon: t(HORIZON_ADJECTIVE[change.to.horizon]),
      reasons: reasons.join(t('; '))
    }),
    extra: { kind: 'PREDICTION_CHANGED', severity: 'high', thread: `prediction:${change.pair}`, threadSeconds: CHANGE_LINES.threadSeconds }
  }
}
