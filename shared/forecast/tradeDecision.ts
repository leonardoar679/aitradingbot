import { MAX_SPREAD_PCT, STALE_PRICE_MS } from '../liveMarket'
import { edgeOf, type Edge } from './edge'
import type { Horizon } from './features'
import { classTradable, type ClassVerdict } from './opportunityClass'
import type { PricePrediction } from './prediction'
import { reliabilityReasonText, type ReliabilityReason } from './reliability'
import { classKeyWords, HORIZON_ADJECTIVE } from './words'
import { ENGLISH, msg, type I18n } from '../i18n/translate'
import type { MarketRegime } from '../marketResearch'

// THE FORECAST AND THE TRADE ARE TWO THINGS (the V6 document, §29-30, §62-63; V6 Stage 9, 13 October
// 2026). A forecast says what may happen; a TradeDecision says whether it is worth trading, and where
// it is not, why -- every reason that holds, by fixed lines:
// - NO_CALL: the forecast calls no way (shared/forecast/direction.ts);
// - UNCERTAIN: its range is too wide to know enough (§30);
// - EDGE_UNDER_COSTS: the move it expects does not clear a round trip's cost (shared/forecast/edge.ts),
//   UNLIKELY_PROFIT: or clears it less than 55 times in a hundred;
// - SPREAD: the live spread is over the 0.1% a trade is entered at; STALE_PRICE: there is no live price
//   newer than ten seconds; STALE_BARS: the close it was read at is more than two bars old;
// - REGIME_AGAINST: a BUY in a falling or panicking market, a SELL in a rising or recovering one;
// - RELIABILITY_LOW, QUALITY_LOW: under 60 (shared/forecast/quality.ts);
// - CLASS_NOT_APPROVED: its opportunity class (shared/forecast/opportunityClass.ts, V6 Stage 12) is
//   not APPROVED or on PROBATION: not traded enough on the replayed weeks to be judged, or it lost.
//   Where no class is read, it is not judged.
// TRADE where none holds. A SELL is a paper trade only, as every short in the app is.

export const DECISION_VERSION = 'decision-v2'

export const DECISION_LINES = {
  minProfitChance: 0.55,
  maxSpreadPct: MAX_SPREAD_PCT,
  staleBarsSec: 600,
  minQuality: 60
} as const

export type NoTradeReason =
  | 'NO_CALL'
  | 'UNCERTAIN'
  | 'EDGE_UNDER_COSTS'
  | 'UNLIKELY_PROFIT'
  | 'SPREAD'
  | 'STALE_PRICE'
  | 'STALE_BARS'
  | 'REGIME_AGAINST'
  | 'RELIABILITY_LOW'
  | 'QUALITY_LOW'
  | 'CLASS_NOT_APPROVED'

/** What a reason was read from, so the window can word it in the person's language (V6 Stage 14):
 * absent on a decision made before. */
export interface ReasonValues {
  /** NO_CALL: there was no forecast at the horizon at all. */
  missing?: boolean
  expectedPct?: number
  costPct?: number
  pProfit?: number
  side?: 'BUY' | 'SELL'
  regime?: MarketRegime
  reliability?: ReliabilityReason[]
  score?: number
  spreadPct?: number
  classKey?: string
  verdict?: ClassVerdict
}

export interface DecisionReason {
  code: NoTradeReason
  /** In English, as recorded. */
  text: string
  values?: ReasonValues
}

export interface TradeDecision {
  version: string
  pair: string
  horizon: Horizon
  side: 'BUY' | 'SELL' | null
  decision: 'TRADE' | 'NO_TRADE'
  reasons: DecisionReason[]
  edge: Edge | null
  quality: number
  /** Its opportunity class and the class's verdict (V6 Stage 12); null where none was read. */
  classKey: string | null
  classVerdict: ClassVerdict | null
  /** Unix milliseconds. */
  at: number
}

export interface DecisionInput {
  prediction: PricePrediction
  horizon: Horizon
  nowMs: number
  /** The live book's mid and when it came, and its spread, where the stream holds it. */
  live: { price: number; updatedAt: number; spreadPct: number | null } | null
  /** The opportunity class a trade on its side falls in, and how the class stands; null where none is
   * read, and then it is not judged. */
  classOf: ((side: 'BUY' | 'SELL') => { key: string; verdict: ClassVerdict }) | null
}

const VERDICT_SENTENCES: Record<ClassVerdict, string> = {
  APPROVED: msg('Its kind of opportunity ({kind}) has earned trading.'),
  PROBATION: msg('Its kind of opportunity ({kind}) is on probation.'),
  NOT_ENOUGH: msg('Its kind of opportunity ({kind}) has not been traded enough on the replayed weeks to be judged.'),
  DISABLED: msg('Its kind of opportunity ({kind}) lost on the replayed weeks or on live paper.')
}

/** A trade against the market's way, side by side: a buy in a falling or panicking market, a sell in a
 * rising or recovering one. */
const REGIME_AGAINST: Record<string, string> = {
  'BUY:bear': msg('A BUY against a bear market.'),
  'BUY:panic': msg('A BUY against a panic market.'),
  'SELL:bull': msg('A SELL against a bull market.'),
  'SELL:recovery': msg('A SELL against a recovery market.')
}

/** A reason in a language, from its code and what it was read from; one made before it carried its
 * values reads as recorded. */
export function reasonText(reason: DecisionReason, horizon: Horizon, i18n: I18n = ENGLISH): string {
  const values = reason.values
  if (values === undefined) return reason.text
  const { t, pct, pctPlain, num } = i18n
  const words = t(HORIZON_ADJECTIVE[horizon])
  switch (reason.code) {
    case 'NO_CALL':
      return values.missing === true ? t('There is no {horizon} forecast.', { horizon: words }) : t('The {horizon} forecast calls no way.', { horizon: words })
    case 'UNCERTAIN':
      return t("The {horizon} range is over three times as wide as this kind of coin's usual: the forecast does not know enough.", { horizon: words })
    case 'EDGE_UNDER_COSTS':
      return t("The move it expects ({expected}) does not clear a round trip's {cost}.", { expected: pct(values.expectedPct ?? Number.NaN, 2), cost: pctPlain(values.costPct ?? Number.NaN, 2) })
    case 'UNLIKELY_PROFIT':
      return t('It clears its costs only {count} times in a hundred.', { count: Math.round((values.pProfit ?? 0) * 100) })
    case 'REGIME_AGAINST':
      return t(REGIME_AGAINST[`${values.side ?? 'BUY'}:${values.regime ?? 'bear'}`] ?? REGIME_AGAINST['BUY:bear'])
    case 'RELIABILITY_LOW':
      return t('Its reliability is LOW: {reasons}.', { reasons: (values.reliability ?? []).map((entry) => reliabilityReasonText(entry, i18n)).join(t('; ')) })
    case 'QUALITY_LOW':
      return t('Its quality is {score}, under {line}.', { score: num(values.score ?? 0, 0, 0), line: num(DECISION_LINES.minQuality, 0, 0) })
    case 'STALE_PRICE':
      return t('There is no live price newer than ten seconds.')
    case 'SPREAD':
      return t('The spread is {spread}, over the {line} a trade is entered at.', { spread: pctPlain(values.spreadPct ?? Number.NaN, 3), line: pctPlain(DECISION_LINES.maxSpreadPct, 1) })
    case 'STALE_BARS':
      return t('The bars it was read from are more than two closes old.')
    case 'CLASS_NOT_APPROVED':
      return t(VERDICT_SENTENCES[values.verdict ?? 'NOT_ENOUGH'], { kind: classKeyWords(values.classKey ?? '', i18n) })
  }
}

export function decideTrade(input: DecisionInput): TradeDecision {
  const { prediction, horizon } = input
  const range = prediction.horizons[horizon]
  const reasons: TradeDecision['reasons'] = []
  const add = (code: NoTradeReason, values: ReasonValues = {}): void => {
    reasons.push({ code, text: reasonText({ code, text: '', values }, horizon), values })
  }
  // A forecast made before its reliability carried codes: its reasons as they were worded.
  const addWorded = (code: NoTradeReason, text: string): void => void reasons.push({ code, text })
  const side = range === undefined ? null : range.direction === 'BULLISH' ? 'BUY' : range.direction === 'BEARISH' ? 'SELL' : null
  let edge: Edge | null = null
  if (range === undefined) add('NO_CALL', { missing: true })
  else {
    if (range.uncertain) add('UNCERTAIN')
    if (side === null) add('NO_CALL')
    else {
      edge = edgeOf(range.quantilesPct, side, input.live?.spreadPct ?? null)
      if (edge.edgePct <= 0) add('EDGE_UNDER_COSTS', { expectedPct: edge.expectedPct, costPct: edge.costPct })
      else if (edge.pProfit < DECISION_LINES.minProfitChance) add('UNLIKELY_PROFIT', { pProfit: edge.pProfit })
      const regime = prediction.regime
      if ((side === 'BUY' && (regime === 'bear' || regime === 'panic')) || (side === 'SELL' && (regime === 'bull' || regime === 'recovery'))) add('REGIME_AGAINST', { side, regime })
    }
    if (range.reliability === 'LOW') {
      if (range.reliabilityCodes === undefined) addWorded('RELIABILITY_LOW', `Its reliability is LOW: ${range.reliabilityReasons.join('; ')}.`)
      else add('RELIABILITY_LOW', { reliability: range.reliabilityCodes })
    }
    if (range.quality.score < DECISION_LINES.minQuality) add('QUALITY_LOW', { score: range.quality.score })
  }
  const live = input.live
  if (live === null || input.nowMs - live.updatedAt > STALE_PRICE_MS) add('STALE_PRICE')
  else if (live.spreadPct !== null && live.spreadPct > DECISION_LINES.maxSpreadPct) add('SPREAD', { spreadPct: live.spreadPct })
  if (input.nowMs / 1000 - prediction.barTime > DECISION_LINES.staleBarsSec) add('STALE_BARS')
  const opportunity = side === null || input.classOf === null ? null : input.classOf(side)
  if (opportunity !== null && !classTradable(opportunity.verdict)) add('CLASS_NOT_APPROVED', { classKey: opportunity.key, verdict: opportunity.verdict })
  return {
    version: DECISION_VERSION,
    pair: prediction.pair,
    horizon,
    side,
    decision: reasons.length === 0 ? 'TRADE' : 'NO_TRADE',
    reasons,
    edge,
    quality: range?.quality.score ?? 0,
    classKey: opportunity?.key ?? null,
    classVerdict: opportunity?.verdict ?? null,
    at: input.nowMs
  }
}
