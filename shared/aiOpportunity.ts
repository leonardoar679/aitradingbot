import { ENGLISH, type I18n } from './i18n/translate'
import {
  AI_HORIZON_BARS,
  AI_MARKET_REGIMES,
  AI_MAX_REASON_CODES,
  AI_REASON_CODES,
  AI_RISK_LEVELS,
  GPT_MIN_CONFIDENCE,
  parseAiSignalResponse,
  type AiCallSource,
  type AiReasonCode,
  type AiSignalDecision,
  type AiSignalDetail,
  type AiSignalEstimate,
  type ParsedAiSignal
} from './aiSignal'
import type { EventReference } from './aiEventMarket'
import { INTERVAL_SECONDS, type Candle, type Exchange } from './ipc'

// A RECOMMENDATION WITH A PRICE AND A CLOCK ON IT.
//
// A signal says "buy" about a candle. An opportunity says where to enter, where the call is wrong,
// where it is done, how long the entry is good for and how long to hold -- about an event the
// scanner raised (shared/marketEvent.ts), with the account holding nothing.
//
// IT IS THE SIGNAL'S ANSWER WITH THREE FIELDS ADDED: an entry range and how many minutes it stays
// valid. Everything else -- the action, the confidence, the regime, the risk, the stop, the
// target, the horizon, the reason codes -- is the field it already was, so one cache, one ledger
// and one benchmark loop hold both. On the wire "buy" opens a long, "sell" opens a short, and
// "hold" is NO TRADE, the way a veto already is.
//
// A SHORT IS PAPER ONLY. The user chose, on 2026-10-03, to let a model call one: it is scored like
// a long, mirrored, and can be paper traded. It can never be placed -- this app places no short or
// leveraged order, and the order form refuses Live for anything but a buy.
//
// THE MODEL DOES NOT SET THE CLOCK. It says how many minutes its entry is good for; when the
// recommendation was made and when it expires are stamped here, from the event's own time.
//
// HERE THE LEVELS ARE THE PRODUCT. A signal whose stop made no sense kept its action and lost the
// stop, because nothing read it. An opportunity is nothing but its levels, so one whose levels do
// not hold together is refused whole.

export const AI_OPPORTUNITY_PROMPT_VERSION = 'opportunity-v1'
export const AI_OPPORTUNITY_SCHEMA_VERSION = 'opportunity-schema-v1'
/** The same question with the market around the event in it (shared/aiEventMarket.ts): what
 * Bitcoin and ether did over the same stretches. A question of its own, with its own prompt and
 * its own cache keys, so that no answer bought under the first one moves. The answer's shape is
 * the same, and so is its schema. */
export const AI_OPPORTUNITY_MARKET_PROMPT_VERSION = 'opportunity-v2'
/** The pair's question with an announcement in it (shared/aiContext.ts, `news`): the event a
 * delisting raised, put to the watch's models because the user chose that on 2026-10-05. A question
 * of its own, with its own prompt and cache keys; the answer's shape is the same. */
export const AI_OPPORTUNITY_NEWS_PROMPT_VERSION = 'opportunity-news-v1'
/** The same, for the event Binance's Monitoring Tag raised: chosen by the user the same day, once the
 * tag had passed its own study. Its own prompt and cache keys; the delisting's are unchanged. */
export const AI_OPPORTUNITY_TAG_PROMPT_VERSION = 'opportunity-tag-v1'
/** The question about a market-wide move (shared/marketEvent.ts marketMoveOf): Bitcoin's pair, with
 * the pairs that moved its way in the same minute listed as breadth. Chosen by the user on
 * 7 October 2026 (the second V3 document, §17 and §43-44). Its own prompt and cache keys; the answer's
 * shape is the same, and any trade in it is in BTCUSDT. */
export const AI_OPPORTUNITY_MARKET_MOVE_PROMPT_VERSION = 'market-move-v1'

/** The questions the app puts to events as they happen -- the scanner's, and an announcement's --
 * whose answers its feed, its journal and its live board read. The market question is a
 * benchmark's, and is read by the benchmark. */
export const AI_OPPORTUNITY_LIVE_PROMPT_VERSIONS: readonly string[] = [
  AI_OPPORTUNITY_PROMPT_VERSION,
  AI_OPPORTUNITY_NEWS_PROMPT_VERSION,
  AI_OPPORTUNITY_TAG_PROMPT_VERSION,
  AI_OPPORTUNITY_MARKET_MOVE_PROMPT_VERSION
]

/** Which question an event is put as: the pair alone (opportunity-v1), the pair with the market
 * around it (opportunity-v2), or the pair with the announcement that raised it (opportunity-news-v1
 * for a delisting, opportunity-tag-v1 for the Monitoring Tag). */
export type AiOpportunityQuestionKind = 'pair' | 'market' | 'news' | 'marketMove'

export function describeQuestionKind(kind: AiOpportunityQuestionKind): string {
  return kind === 'market' ? 'with the market' : kind === 'news' ? 'with the announcement' : kind === 'marketMove' ? 'the market-wide move' : 'the pair alone'
}

/** The question a prompt version is, or null for one that is not an event's question. */
export function questionKindOfPromptVersion(version: string): AiOpportunityQuestionKind | null {
  if (version === AI_OPPORTUNITY_PROMPT_VERSION) return 'pair'
  if (version === AI_OPPORTUNITY_NEWS_PROMPT_VERSION || version === AI_OPPORTUNITY_TAG_PROMPT_VERSION) return 'news'
  if (version === AI_OPPORTUNITY_MARKET_MOVE_PROMPT_VERSION) return 'marketMove'
  return version === AI_OPPORTUNITY_MARKET_PROMPT_VERSION ? 'market' : null
}

/** How long an entry range may stay valid, in minutes. A closed set, so that expiry can be scored
 * and counted. */
export const AI_VALID_MINUTES = [5, 15, 30, 60] as const

/** A model's horizon is counted in bars of the context's coarse base interval. */
const HORIZON_BAR_SECONDS = INTERVAL_SECONDS['15m']

/** The nearer edge of an entry range may be this far from the price and no further, and the range
 * this wide and no wider, in percent. A range five percent away is not an entry at this event. */
const MAX_ENTRY_DISTANCE_PCT = 5
const MAX_ENTRY_WIDTH_PCT = 5
/** A stop or target nearer its entry than this is a rounding error, and further than this is half
 * the price away. Neither is a level. The same bounds shared/aiProposal.ts carries into a form. */
const MIN_LEVEL_PCT = 0.05
const MAX_LEVEL_PCT = 50

export type OpportunitySide = 'long' | 'short'

export type AiOpportunityVerdict = { ok: true; signal: ParsedAiSignal; detail: AiSignalDetail } | { ok: false; reason: string }

function isOneOf<T>(allowed: readonly T[], value: unknown): value is T {
  return allowed.includes(value as T)
}

function isLevel(value: unknown): value is number | null {
  return value === null || (typeof value === 'number' && Number.isFinite(value) && value > 0)
}

/** Decides whether a model's answer to an opportunity question can be used.
 *
 * `referencePrice` is the event's price: the last 1-minute close the model was shown, which is the
 * only price it could have placed its levels against. */
export function validateOpportunityAnswer(value: unknown, referencePrice: number): AiOpportunityVerdict {
  const signal = parseAiSignalResponse(value)
  if (!signal) return { ok: false, reason: 'recommendation, confidence or rationale is missing or out of range' }
  const record = value as Record<string, unknown>

  if (!isOneOf(AI_MARKET_REGIMES, record.marketRegime)) return { ok: false, reason: 'marketRegime is not an allowed value' }
  if (!isOneOf(AI_RISK_LEVELS, record.riskLevel)) return { ok: false, reason: 'riskLevel is not an allowed value' }
  if (!isOneOf<number>(AI_HORIZON_BARS, record.horizonBars)) return { ok: false, reason: 'horizonBars is not an allowed value' }
  if (!isOneOf<number>(AI_VALID_MINUTES, record.validMinutes)) return { ok: false, reason: 'validMinutes is not an allowed value' }
  if (!isLevel(record.entryMin)) return { ok: false, reason: 'entryMin is not a price or null' }
  if (!isLevel(record.entryMax)) return { ok: false, reason: 'entryMax is not a price or null' }
  if (!isLevel(record.stopLoss)) return { ok: false, reason: 'stopLoss is not a price or null' }
  if (!isLevel(record.takeProfit)) return { ok: false, reason: 'takeProfit is not a price or null' }
  if (!Array.isArray(record.reasonCodes) || !record.reasonCodes.every((code) => isOneOf(AI_REASON_CODES, code))) {
    return { ok: false, reason: 'reasonCodes holds a value outside the allowed list' }
  }

  const common = {
    marketRegime: record.marketRegime,
    riskLevel: record.riskLevel,
    horizonBars: record.horizonBars,
    reasonCodes: [...new Set(record.reasonCodes as AiReasonCode[])].slice(0, AI_MAX_REASON_CODES)
  }

  if (signal.recommendation === 'hold') {
    const named = record.entryMin !== null || record.entryMax !== null || record.stopLoss !== null || record.takeProfit !== null
    return {
      ok: true,
      signal,
      detail: {
        ...common,
        stopLoss: null,
        takeProfit: null,
        levelsNote: named ? 'Levels ignored: a call not to trade carries none.' : null,
        entry: null
      }
    }
  }

  const { entryMin, entryMax, stopLoss, takeProfit } = record
  if (entryMin === null || entryMax === null || stopLoss === null || takeProfit === null) {
    return { ok: false, reason: 'A recommendation to trade must name an entry range, a stop and a target' }
  }
  if (!(referencePrice > 0)) return { ok: false, reason: 'There is no price to check the levels against' }
  if (entryMin > entryMax) return { ok: false, reason: `The entry range is upside down (${entryMin} to ${entryMax})` }
  if (((entryMax - entryMin) / referencePrice) * 100 > MAX_ENTRY_WIDTH_PCT) {
    return { ok: false, reason: `The entry range is more than ${MAX_ENTRY_WIDTH_PCT}% wide (${entryMin} to ${entryMax})` }
  }
  const gap = referencePrice < entryMin ? entryMin - referencePrice : referencePrice > entryMax ? referencePrice - entryMax : 0
  if ((gap / referencePrice) * 100 > MAX_ENTRY_DISTANCE_PCT) {
    return { ok: false, reason: `The entry range (${entryMin} to ${entryMax}) is more than ${MAX_ENTRY_DISTANCE_PCT}% from the price (${referencePrice})` }
  }

  const long = signal.recommendation === 'buy'
  // Each level is measured from the edge of the range nearest to it: the worst entry the range
  // allows for that level.
  const stopDistancePct = long ? ((entryMin - stopLoss) / entryMin) * 100 : ((stopLoss - entryMax) / entryMax) * 100
  const targetDistancePct = long ? ((takeProfit - entryMax) / entryMax) * 100 : ((entryMin - takeProfit) / entryMin) * 100
  if (!(stopDistancePct > 0)) {
    return { ok: false, reason: long ? `The stop (${stopLoss}) is not below the entry range` : `The stop (${stopLoss}) is not above the entry range` }
  }
  if (!(targetDistancePct > 0)) {
    return { ok: false, reason: long ? `The target (${takeProfit}) is not above the entry range` : `The target (${takeProfit}) is not below the entry range` }
  }
  if (stopDistancePct < MIN_LEVEL_PCT || stopDistancePct > MAX_LEVEL_PCT) {
    return { ok: false, reason: `The stop (${stopLoss}) is not a usable distance from the entry range` }
  }
  if (targetDistancePct < MIN_LEVEL_PCT || targetDistancePct > MAX_LEVEL_PCT) {
    return { ok: false, reason: `The target (${takeProfit}) is not a usable distance from the entry range` }
  }

  return {
    ok: true,
    signal,
    detail: {
      ...common,
      stopLoss,
      takeProfit,
      levelsNote: null,
      entry: { min: entryMin, max: entryMax, validMinutes: record.validMinutes }
    }
  }
}

/** Which side a usable recommendation takes, or null when it is not one: a call not to trade, an
 * answer that was refused, a call that never reached a model, or one without an entry range. */
export function opportunitySide(decision: AiSignalDecision | null | undefined): OpportunitySide | null {
  if (!decision || decision.error !== null || decision.rejected) return null
  if (decision.recommendation === 'hold' || !decision.detail?.entry) return null
  return decision.recommendation === 'buy' ? 'long' : 'short'
}

/** Whether this app would act on a recommendation: a side, at the confidence it acts on anywhere
 * else. A benchmark's trades, and the offer of a paper trade, both follow this one rule. */
export function isActionableOpportunity(decision: AiSignalDecision | null | undefined): boolean {
  return opportunitySide(decision) !== null && (decision?.confidence ?? 0) >= GPT_MIN_CONFIDENCE
}

export interface OpportunityWindow {
  /** The event's own time: the open of the 1-minute bar the call executes on. */
  validFrom: number
  /** After this the entry is abandoned. */
  expiresAt: number
  /** How long a position is held if neither level is reached. */
  holdSeconds: number
}

/** When a recommendation is good from and until, stamped from the event's time and the minutes
 * the model named. Null for an answer with no entry range. */
export function opportunityWindow(eventTime: number, detail: AiSignalDetail | null | undefined): OpportunityWindow | null {
  if (!detail?.entry) return null
  return {
    validFrom: eventTime,
    expiresAt: eventTime + detail.entry.validMinutes * 60,
    holdSeconds: detail.horizonBars * HORIZON_BAR_SECONDS
  }
}

/** True once a recommendation's entry can no longer be taken. A recommendation that had no entry
 * range never could be, and counts as expired. */
export function isOpportunityExpired(eventTime: number, detail: AiSignalDetail | null | undefined, nowSec: number): boolean {
  const validity = opportunityWindow(eventTime, detail)
  return validity === null || nowSec >= validity.expiresAt
}

export interface OpportunityConsensus {
  /** Models that have answered, refused answers included. */
  answered: number
  refused: number
  long: number
  short: number
  noTrade: number
  /** True when at least one model says long and another says short. */
  disagreement: boolean
  /** The share of usable answers making the most common call. Null under two usable answers:
   * one model cannot agree with itself. */
  agreementPct: number | null
  /** What the answers add up to: a side only when more than half of the usable answers take it
   * and none takes the other. */
  call: OpportunitySide | 'no_trade' | null
}

/** What several models' answers to one event add up to.
 *
 * `call` IS A RULE TO BE MEASURED, NOT A FINDING. "More than half, and nobody on the other side"
 * is the obvious way to combine answers and nothing here says it earns more than any one model:
 * the benchmark scores it beside the others. It is shown so the answers on a card can be read at
 * a glance, and nothing acts on it. */
export function opportunityConsensus(decisions: (AiSignalDecision | null | undefined)[]): OpportunityConsensus {
  let answered = 0
  let refused = 0
  let long = 0
  let short = 0
  let noTrade = 0
  for (const decision of decisions) {
    if (!decision || decision.error !== null) continue
    answered++
    if (decision.rejected) {
      refused++
      continue
    }
    const side = opportunitySide(decision)
    if (side === 'long') long++
    else if (side === 'short') short++
    else noTrade++
  }
  const usable = long + short + noTrade
  const disagreement = long > 0 && short > 0
  let call: OpportunityConsensus['call'] = null
  if (usable > 0) {
    if (!disagreement && long * 2 > usable) call = 'long'
    else if (!disagreement && short * 2 > usable) call = 'short'
    else call = 'no_trade'
  }
  return {
    answered,
    refused,
    long,
    short,
    noTrade,
    disagreement,
    agreementPct: usable >= 2 ? (Math.max(long, short, noTrade) / usable) * 100 : null,
    call
  }
}

export function describeOpportunitySide(side: OpportunitySide | null, { t }: I18n = ENGLISH): string {
  if (side === 'long') return t('BUY')
  if (side === 'short') return t('SELL')
  return t('NO TRADE')
}

// ---------------------------------------------------------------------------------------------
// Asking. The candles travel with the question and the event is worked out from them in the main
// process (shared/aiContext.ts, buildEventContext): a caller names a market and a minute by the
// candles it sends, and cannot say that anything happened there.

/** Models one event can be put to at once. */
export const AI_OPPORTUNITY_MAX_MODELS = 6

export interface AiOpportunityQuestion {
  exchange: Exchange
  symbol: string
  /** COMPLETED 15-minute candles, oldest first, reaching back at least seven days before the
   * event. Bars that had not closed by the event's time are ignored. */
  candles15m: Candle[]
  /** COMPLETED 1-minute candles, oldest first, at least twelve hours of them. The last one is the
   * minute the event was read at; the call executes on the minute after it. */
  candles1m: Candle[]
  /** Present when the event is put WITH THE MARKET AROUND IT (opportunity-v2): COMPLETED candles of
   * BTCUSDT and ETHUSDT on the same exchange -- four hours and a minute of 1-minute bars ending at
   * the minute the event was read, and a day and a quarter hour of 15-minute bars that had closed
   * by then. What they did is worked out from them in the main process, as the event is. Absent,
   * the question is the pair alone (opportunity-v1), byte for byte as it always was. */
  reference?: EventReference | null
  /** Present when the event was raised by an announcement (MarketEvent.news): the article's id in
   * the main process's own record of what it read. The main process looks it up there and puts the
   * question with the announcement in it (opportunity-news-v1, or opportunity-tag-v1 for the
   * Monitoring Tag) only when that record says the article is a delisting or a tag naming this
   * pair, from around this minute; otherwise nothing is asked.
   * Never sent with `reference`. */
  newsId?: number
  /** Present when the event is a market-wide move (MarketEvent.type 'market_move'): its id. The
   * main process looks the move up in its own record of the events it raised and puts the question
   * with the move's members in it (market-move-v1), about BTCUSDT; otherwise nothing is asked.
   * Never sent with `reference` or `newsId`. */
  marketMoveId?: string
}

export interface AiOpportunityAskRequest extends AiOpportunityQuestion {
  /** The model to ask. Absent means the configured default. Never a panel: a panel's analysts
   * have no question to put to an event. */
  model?: string
  source?: AiCallSource
}

export interface AiOpportunityPeekRequest extends AiOpportunityQuestion {
  models: string[]
}

export interface AiOpportunityModelPeek {
  model: string
  /** The answer already held, or null when asking would cost. */
  decision: AiSignalDecision | null
  perCallCostUsd: number | null
  costBasis: AiSignalEstimate['costBasis']
  perCallLatencyMs: number | null
}

/** What is already held for one event and what the rest would cost. Reading it spends nothing. */
export interface AiOpportunityPeek {
  /** The event these candles end in, as the scanner names it, and its time. */
  eventId: string
  eventTime: number
  models: AiOpportunityModelPeek[]
  budgetRemainingUsd: number
}
