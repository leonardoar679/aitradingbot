import type { MarketRegime } from '../marketResearch'
import type { Direction } from './direction'
import type { Horizon } from './features'
import type { ForecastRange, PricePrediction } from './prediction'

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

export interface CallChange {
  pair: string
  from: HeldCall
  to: HeldCall
  reasons: string[]
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
function reasonsOf(from: HeldCall, to: HeldCall, prediction: PricePrediction): string[] {
  const out: string[] = []
  const moved = Object.keys(to.medians)
    .map((model) => ({ model, change: to.medians[model] - (from.medians[model] ?? 0) }))
    .sort((a, b) => Math.abs(b.change) - Math.abs(a.change))[0]
  if (moved !== undefined && moved.change !== 0) out.push(`the ${moved.model} model's median moved ${moved.change >= 0 ? '+' : ''}${moved.change.toFixed(2)}%`)
  const story = prediction.horizons[to.horizon]?.news.v4
  if (story !== null && story !== undefined) out.push(`a ${story.kind.toLowerCase()} story: ${story.title}`)
  if (from.regime !== to.regime) out.push(`the market turned from ${from.regime} to ${to.regime}`)
  return out.length > 0 ? out : ['the market moved against the call']
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
  const change = current.held !== null && opposite(current.held.direction, call.direction) ? { pair: prediction.pair, from: current.held, to: call, reasons: reasonsOf(current.held, call, prediction) } : null
  return { track: { held: call, pending: null }, change }
}

const HORIZON_WORDS: Record<Horizon, string> = { minutes5: '5-minute', minutes15: '15-minute', hour1: '1-hour', hours4: '4-hour', hours24: '24-hour' }
const pct = (value: number): string => `${value >= 0 ? '+' : ''}${value.toFixed(2)}%`
const pairWords = (pair: string): string => (pair.endsWith('USDT') ? `${pair.slice(0, -4)}/USDT` : pair)

/** What the desktop is told of a change, on the coin's own thread. */
export function predictionChangedNotice(change: CallChange): { title: string; body: string; extra: { kind: 'PREDICTION_CHANGED'; severity: 'high'; thread: string; threadSeconds: number } } {
  return {
    title: `PREDICTION CHANGED: ${pairWords(change.pair)} ${change.from.direction} → ${change.to.direction}`,
    body: `Previous: ${pct(change.from.lowPct)} ~ ${pct(change.from.highPct)} (${HORIZON_WORDS[change.from.horizon]}). Current: ${pct(change.to.lowPct)} ~ ${pct(change.to.highPct)} (${HORIZON_WORDS[change.to.horizon]}). Reason: ${change.reasons.join('; ')}. Nothing was placed or sold.`,
    extra: { kind: 'PREDICTION_CHANGED', severity: 'high', thread: `prediction:${change.pair}`, threadSeconds: CHANGE_LINES.threadSeconds }
  }
}
