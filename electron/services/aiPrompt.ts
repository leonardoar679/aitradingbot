import { aiContextJson, type AiMarketContext } from '../../shared/aiContext'
import { AI_VALID_MINUTES } from '../../shared/aiOpportunity'
import {
  AI_AGENT_MAX_NOTE_CHARS,
  AI_AGENT_MOMENTUM,
  AI_AGENT_VERDICTS,
  type AiAgentRole
} from '../../shared/aiPanel'
import { AI_HORIZON_BARS, AI_MARKET_REGIMES, AI_MAX_REASON_CODES, AI_REASON_CODES, AI_RISK_LEVELS } from '../../shared/aiSignal'

// What the model is told, and the shape it must answer in. Versioned by GPT_PROMPT_VERSION and
// AI_SCHEMA_VERSION in shared/aiSignal.ts, by AI_CONFIRM_PROMPT_VERSION in shared/aiConfirm.ts
// for the entry-review prompt, by the four panel versions in shared/aiPanel.ts, and by the
// opportunity versions in shared/aiOpportunity.ts: all are part
// of a cache key and are written on every ledger row, so ANY edit to a text or a schema below
// must bump the matching constant. An edit without a bump serves answers to the old question from
// the cache under the new one, and leaves a ledger in which two different prompts are
// indistinguishable. tests/aiPromptVersions.test.ts holds a hash of each text beside its version
// and fails when one moves without the other.

/** Ceiling on what one answer may cost, whatever the model does. The JSON asked for is a few
 * hundred tokens; the room is for reasoning models, which bill their thinking as output. A model
 * that hits this was cut off, and the answer is refused rather than asked for again. */
export const AI_MAX_OUTPUT_TOKENS = 3000

/** How the fields of a decision are to be filled in. Said once, to every prompt that asks for a
 * decision outright: the standalone signal, and a panel's decision. */
const SIGNAL_ANSWER_LINES = [
  'recommendation: "buy" opens a long and only means something when position is "flat"; "sell" closes a long and only means something when position is "long"; otherwise answer "hold". Prefer "hold" when the evidence is weak or the expected move does not clearly exceed roundTripCostPct.',
  'confidence: 0 to 1. How consistent the evidence is across indicators and intervals. It is not a probability of profit; never claim certainty.',
  'marketRegime: the prevailing regime on the coarsest interval shown.',
  'riskLevel: how exposed a new position would be to volatility and whipsaw right now.',
  `horizonBars: how many base-interval bars the call is meant to play out over, one of ${AI_HORIZON_BARS.join(', ')}.`,
  'stopLoss and takeProfit: absolute prices, for a "buy" only, with the stop below lastClose and the target above it. Use null for both on "sell" and "hold".',
  `reasonCodes: up to ${AI_MAX_REASON_CODES} codes from the allowed list that drove the decision, most important first.`,
  'rationale: at most 500 characters, plain text.',
  'Account for trend, momentum, volatility, volume, fees and whipsaw risk. Never provide position sizing.'
]

export const AI_SYSTEM_PROMPT = [
  'You are a conservative crypto signal classifier for a long-only spot account. Return only the requested JSON.',
  'The user message is a market snapshot built only from completed candles: recent bars and indicators on the base interval and on two coarser intervals, the current position, and the round-trip cost of a trade in percent.',
  'Bars are [unixTime, open, high, low, close, volume], oldest first.',
  ...SIGNAL_ANSWER_LINES
].join('\n')

/** The entry review: the same snapshot and the same answer shape, put to a different question.
 *
 * The answer shape is deliberately the standalone signal's. One schema means one validator, one
 * ledger and one way of scoring a call, and a review needs nothing the signal does not already
 * carry: "buy" confirms, anything else vetoes.
 *
 * It is NOT told where the confidence gate sits. A model that knows a 0.65 passes and a 0.64 does
 * not is being invited to report whichever one produces the outcome it prefers. */
export const AI_CONFIRM_SYSTEM_PROMPT = [
  'You review entries for a long-only spot crypto account. Return only the requested JSON.',
  'A rule-based strategy has just signalled an entry on the bar that closed at decisionTime. It opens a long at lastClose unless you veto it, and it manages the exit itself afterwards.',
  'The user message is a market snapshot built only from completed candles: recent bars and indicators on the base interval and on coarser ones, the round-trip cost of a trade in percent, and "strategy" -- its name, its rule in words, what it measured on the signal bar, and how far below the entry its own stop sits (stopDistancePct).',
  'Bars are [unixTime, open, high, low, close, volume], oldest first.',
  'recommendation: "buy" confirms the entry; "hold" vetoes it. Never answer "sell": there is no position to close.',
  'A veto removes this trade entirely: the account stays out until the strategy would have closed it, and you are not asked about it again. It is a judgement on the trade, not a request to be asked later.',
  "Veto when the snapshot contradicts the premise of the strategy's rule, or when the entry looks late or poor: a move already overextended, a breakout without volume, coarser intervals pointing the other way, or an expected move that does not clearly exceed roundTripCostPct. Do not veto only because the outcome is uncertain: the strategy has measured its own edge, and your job is to catch the entries that are worse than its usual ones.",
  'confidence: 0 to 1. How consistent the evidence is with your recommendation. It is not a probability of profit; never claim certainty.',
  'marketRegime: the prevailing regime on the coarsest interval shown.',
  'riskLevel: how exposed the new position would be to volatility and whipsaw right now.',
  `horizonBars: how many base-interval bars your view is meant to play out over, one of ${AI_HORIZON_BARS.join(', ')}.`,
  'stopLoss and takeProfit: your own levels as absolute prices, for a "buy" only, with the stop below lastClose and the target above it. Use null for both on "hold". They are recorded and scored, never executed: the strategy keeps its own stop.',
  `reasonCodes: up to ${AI_MAX_REASON_CODES} codes from the allowed list that drove the decision, most important first.`,
  'rationale: at most 500 characters, plain text.',
  'Never provide position sizing.'
].join('\n')

// ---------------------------------------------------------------------------------------------
// THE PANEL (shared/aiPanel.ts). Three analysts, each asked one narrow question about the same
// snapshot, and a decision that is shown the snapshot again with their three reports attached.
//
// AN ANALYST IS NOT ASKED WHETHER TO TRADE. Each is told so, and its schema has nowhere to say it:
// a report with a "buy" in it would be three more opinions on the one question, which is a vote,
// not a division of labour.
//
// THE DECISION IS NOT TOLD TO OBEY THE REPORTS. It is handed the snapshot as well as the reports
// and told to check one against the other, because a report is a model's reading and can be wrong
// in the ways any answer here can be.

function analystPreface(role: AiAgentRole): string[] {
  return [
    `You are the ${role} analyst on a panel advising a long-only spot crypto account. Return only the requested JSON.`,
    'The user message is a market snapshot built only from completed candles: recent bars and indicators on the base interval and on two coarser intervals, the current position, and the round-trip cost of a trade in percent.',
    'Bars are [unixTime, open, high, low, close, volume], oldest first.',
    'You do not decide whether to trade: a separate call weighs your report with two others. Answer only your own question.'
  ]
}

const ANALYST_ANSWER_LINES = [
  'confidence: 0 to 1. How consistent the evidence for your answer is. It is not a probability; never claim certainty.',
  `reasonCodes: up to ${AI_MAX_REASON_CODES} codes from the allowed list that drove your answer, most important first.`,
  `note: at most ${AI_AGENT_MAX_NOTE_CHARS} characters, plain text: what your answer rests on, and what would change it.`
]

export const AI_AGENT_SYSTEM_PROMPTS: Record<AiAgentRole, string> = {
  trend: [
    ...analystPreface('trend'),
    'Your question: what is the prevailing market regime? Judge it on the coarser intervals -- which way the trend runs and how established it is -- and use the base interval only to say whether it is holding or breaking.',
    `regime: one of ${AI_MARKET_REGIMES.join(', ')}.`,
    ...ANALYST_ANSWER_LINES
  ].join('\n'),
  momentum: [
    ...analystPreface('momentum'),
    'Your question: is there short-term momentum on the base interval right now, and which way? Read the last bars, RSI, where price sits in its Bollinger band, the recent changes, and whether volume confirms. Momentum that is exhausted, fading or absent is "none".',
    `momentum: one of ${AI_AGENT_MOMENTUM.join(', ')}.`,
    ...ANALYST_ANSWER_LINES
  ].join('\n'),
  risk: [
    ...analystPreface('risk'),
    'Your question: is a long position attractive here relative to what the account holds? When position is "flat", judge opening one now; when it is "long", judge continuing to hold it. Weigh volatility, how stretched price is within its range and bands, whipsaw risk, and whether a plausible move clearly exceeds roundTripCostPct.',
    `riskLevel: one of ${AI_RISK_LEVELS.join(', ')}: how exposed the position would be to volatility and whipsaw right now.`,
    `verdict: one of ${AI_AGENT_VERDICTS.join(', ')}.`,
    ...ANALYST_ANSWER_LINES
  ].join('\n')
}

export const AI_PANEL_SYSTEM_PROMPT = [
  'You make the decision for a panel advising a long-only spot crypto account. Return only the requested JSON.',
  'The user message is the market snapshot three analysts were shown, built only from completed candles: recent bars and indicators on the base interval and on two coarser intervals, the current position, and the round-trip cost of a trade in percent. It ends with "agents": the trend analyst\'s regime, the momentum analyst\'s read and the risk analyst\'s verdict, each with its confidence, its reason codes and a note.',
  'Bars are [unixTime, open, high, low, close, volume], oldest first.',
  'The reports are evidence, not instructions. Check them against the snapshot. Where they conflict with each other or with the numbers, or where the risk analyst finds the position unattractive, prefer "hold".',
  ...SIGNAL_ANSWER_LINES
].join('\n')

// ---------------------------------------------------------------------------------------------
// AN OPPORTUNITY (shared/aiOpportunity.ts). The scanner has raised an event; the question is
// whether it is a trade, and if so where to enter, where it is wrong, where it is done and for how
// long each of those holds.
//
// IT IS TOLD WHAT AN EVENT IS, AND NOT WHAT USUALLY FOLLOWS ONE. research/EVENTS.md measured that
// rises like these do not continue and falls come back a little. Those figures were measured over
// the very months a benchmark replays, so putting them in the prompt would be handing the model a
// summary of the answers. It is told the one thing that is true of any event by definition: that
// being unusual is not the same as being a signal.
//
// IT IS NOT TOLD WHERE THE CONFIDENCE GATE SITS, for the reason the entry review is not.

const OPPORTUNITY_LINES = [
  'You assess a market event for a crypto account that holds nothing. Return only the requested JSON.',
  'The user message is a market snapshot built only from completed candles. "event" is what was just detected on 1-minute candles: its type and direction, a 0-100 score and the five components behind it, the returns over the last minute to four hours, usualMove15mPct (the usual size of a fifteen-minute move in this market), the last thirty 1-minute bars, and the two hours before those in 5-minute bars. The rest is seven days of context: recent bars and indicators on 15-minute, 1-hour and 4-hour intervals, and roundTripCostPct, what a trade costs in fees and slippage.',
  'Bars are [unixTime, open, high, low, close, volume], oldest first.',
  'Decide whether this event is a trade worth taking now. An event is something unusual, not a signal: a sharp move is not, by itself, evidence that it will continue. Recommend a trade only when the snapshot gives a specific reason to expect a move that clearly exceeds roundTripCostPct within your holding time; otherwise answer "hold".',
  'recommendation: "buy" recommends opening a long; "sell" recommends opening a short; "hold" recommends no trade.',
  'entryMin and entryMax: the price range to enter in, as absolute prices, with entryMin not above entryMax. Place it at or near event.price: the entry is looked for from about a minute after the event, and a range the price never trades in is never filled. Use null for both on "hold".',
  `validMinutes: how long after the event the entry range stays valid, one of ${AI_VALID_MINUTES.join(', ')}. An entry not filled by then is abandoned.`,
  'stopLoss and takeProfit: absolute prices. For "buy" the stop is below entryMin and the target above entryMax; for "sell" the stop is above entryMax and the target below entryMin. Use null for both on "hold".',
  `horizonBars: how long the position is held if neither level is reached, in 15-minute bars, one of ${AI_HORIZON_BARS.join(', ')}.`,
  'confidence: 0 to 1. How consistent the evidence is with your recommendation. It is not a probability of profit; never claim certainty.',
  'marketRegime: the prevailing regime on the coarsest interval shown.',
  'riskLevel: how exposed the position would be to volatility and whipsaw right now.',
  `reasonCodes: up to ${AI_MAX_REASON_CODES} codes from the allowed list that drove the decision, most important first.`,
  'rationale: at most 500 characters, plain text.',
  'Never provide position sizing.'
]

export const AI_OPPORTUNITY_SYSTEM_PROMPT = OPPORTUNITY_LINES.join('\n')

/** The same question with the market around the event in it (opportunity-v2,
 * shared/aiEventMarket.ts). One paragraph more, after the one that says what the user message
 * holds, and not a word of the rest changed: what an answer under it does differently is the
 * market, and not a rewording.
 *
 * IT SAYS WHAT THE BLOCK IS, AND NOT WHAT IT MEANS. Whether a pair that rose with Bitcoin goes on
 * rising, or one that rose alone does, is what the benchmark measures; the prompt does not answer
 * it, for the reason the first one does not say what usually follows an event. */
export const AI_OPPORTUNITY_MARKET_SYSTEM_PROMPT = [
  ...OPPORTUNITY_LINES.slice(0, 2),
  '"market" sets the event against Bitcoin and ether on the same exchange, over the same stretches and up to the same minute: btc and eth are the returns of BTCUSDT and ETHUSDT over the last 15 minutes (m15), hour (h1), four hours (h4) and day (h24), in percent, and vsBtc and vsEth are this pair\'s return over each stretch less theirs, positive where it rose more or fell less. A value is null where the candles could not measure it.',
  ...OPPORTUNITY_LINES.slice(2)
].join('\n')

/** The same question about the event an announcement raised (opportunity-news-v1,
 * shared/aiContext.ts buildNewsEventContext). One paragraph more, after the one that says what the
 * user message holds, and not a word of the rest changed.
 *
 * IT SAYS WHAT THE BLOCK IS, AND NOT WHAT IT MEANS. research/NEWS.md measured what a delisting's coin
 * did in the hours after it; putting that here would be handing the model the answer it is being
 * measured on, for the reason the first prompt does not say what usually follows an event. */
export const AI_OPPORTUNITY_NEWS_SYSTEM_PROMPT = [
  ...OPPORTUNITY_LINES.slice(0, 2),
  '"news" is why this event was raised: an announcement Binance itself published about this coin, with its title as published and releasedAt, when it was released (unix seconds). kind "delisting" means Binance has announced that it will remove this coin from its spot market. The event block is the market at the minute the announcement was read, whether or not the price had moved yet: its type is "delisting" and its direction "down" because of the announcement, not because of the candles, and its score and components are what the candles alone show.',
  ...OPPORTUNITY_LINES.slice(2)
].join('\n')

/** The system text a context is sent under: the panel's decision when it carries analysts'
 * reports, an opportunity prompt when it carries an event -- the one with the announcement or the
 * one with the market when it carries either -- the review prompt when it names a strategy, the
 * standalone one otherwise. The same tests shared/aiContext.ts's aiPromptVersion makes, so the text
 * sent and the version recorded for it are chosen by one fact. */
function systemPromptFor(context: AiMarketContext): string {
  if (context.agents !== undefined) return AI_PANEL_SYSTEM_PROMPT
  if (context.event !== undefined) {
    if (context.news !== undefined) return AI_OPPORTUNITY_NEWS_SYSTEM_PROMPT
    return context.market === undefined ? AI_OPPORTUNITY_SYSTEM_PROMPT : AI_OPPORTUNITY_MARKET_SYSTEM_PROMPT
  }
  return context.strategy === undefined ? AI_SYSTEM_PROMPT : AI_CONFIRM_SYSTEM_PROMPT
}

/** Types and enums only, on purpose.
 *
 * Providers disagree about which JSON Schema keywords a strict schema may carry: range and length
 * keywords are accepted by some and rejected outright by others. A request the provider refuses
 * costs a model its place on the shortlist for no reason, so nothing here can be refused, and
 * every range is enforced locally by validateAiAnswer instead -- which had to check them anyway. */
export const AI_RESPONSE_SCHEMA: { name: string; schema: Record<string, unknown> } = {
  name: 'intraday_signal',
  schema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      recommendation: { type: 'string', enum: ['buy', 'sell', 'hold'] },
      confidence: { type: 'number' },
      marketRegime: { type: 'string', enum: [...AI_MARKET_REGIMES] },
      riskLevel: { type: 'string', enum: [...AI_RISK_LEVELS] },
      horizonBars: { type: 'integer', enum: [...AI_HORIZON_BARS] },
      stopLoss: { type: ['number', 'null'] },
      takeProfit: { type: ['number', 'null'] },
      reasonCodes: { type: 'array', items: { type: 'string', enum: [...AI_REASON_CODES] } },
      rationale: { type: 'string' }
    },
    required: [
      'recommendation',
      'confidence',
      'marketRegime',
      'riskLevel',
      'horizonBars',
      'stopLoss',
      'takeProfit',
      'reasonCodes',
      'rationale'
    ]
  }
}

/** The signal's shape with an entry range and its validity added, and nothing taken away: types
 * and enums only, by the same rule, with every range checked by validateOpportunityAnswer. */
export const AI_OPPORTUNITY_SCHEMA: { name: string; schema: Record<string, unknown> } = {
  name: 'market_opportunity',
  schema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      recommendation: { type: 'string', enum: ['buy', 'sell', 'hold'] },
      confidence: { type: 'number' },
      entryMin: { type: ['number', 'null'] },
      entryMax: { type: ['number', 'null'] },
      validMinutes: { type: 'integer', enum: [...AI_VALID_MINUTES] },
      stopLoss: { type: ['number', 'null'] },
      takeProfit: { type: ['number', 'null'] },
      horizonBars: { type: 'integer', enum: [...AI_HORIZON_BARS] },
      marketRegime: { type: 'string', enum: [...AI_MARKET_REGIMES] },
      riskLevel: { type: 'string', enum: [...AI_RISK_LEVELS] },
      reasonCodes: { type: 'array', items: { type: 'string', enum: [...AI_REASON_CODES] } },
      rationale: { type: 'string' }
    },
    required: [
      'recommendation',
      'confidence',
      'entryMin',
      'entryMax',
      'validMinutes',
      'stopLoss',
      'takeProfit',
      'horizonBars',
      'marketRegime',
      'riskLevel',
      'reasonCodes',
      'rationale'
    ]
  }
}

/** The answer shape a context is asked for in: an opportunity's when it carries an event, the
 * signal's otherwise. Chosen by the same fact aiSchemaVersion reads. */
export function responseSchemaFor(context: AiMarketContext): { name: string; schema: Record<string, unknown> } {
  return context.event === undefined ? AI_RESPONSE_SCHEMA : AI_OPPORTUNITY_SCHEMA
}

function analystSchema(name: string, own: Record<string, unknown>): { name: string; schema: Record<string, unknown> } {
  return {
    name,
    schema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        ...own,
        confidence: { type: 'number' },
        reasonCodes: { type: 'array', items: { type: 'string', enum: [...AI_REASON_CODES] } },
        note: { type: 'string' }
      },
      required: [...Object.keys(own), 'confidence', 'reasonCodes', 'note']
    }
  }
}

/** An analyst's report, by the same rule as the schema above: types and enums only, with every
 * range checked locally by validateAgentReport. */
export const AI_AGENT_SCHEMAS: Record<AiAgentRole, { name: string; schema: Record<string, unknown> }> = {
  trend: analystSchema('trend_report', { regime: { type: 'string', enum: [...AI_MARKET_REGIMES] } }),
  momentum: analystSchema('momentum_report', { momentum: { type: 'string', enum: [...AI_AGENT_MOMENTUM] } }),
  risk: analystSchema('risk_report', {
    riskLevel: { type: 'string', enum: [...AI_RISK_LEVELS] },
    verdict: { type: 'string', enum: [...AI_AGENT_VERDICTS] }
  })
}

export function buildAiMessages(context: AiMarketContext): { role: 'system' | 'user'; content: string }[] {
  return [
    { role: 'system', content: systemPromptFor(context) },
    { role: 'user', content: aiContextJson(context) }
  ]
}

/** An analyst's question: its own instruction, over the SAME bytes the standalone signal is sent.
 * Refuses a context that is not a plain snapshot, because an analyst handed a strategy block or
 * another panel's reports would be answering a question that has no version and no cache key. */
export function buildAgentMessages(role: AiAgentRole, context: AiMarketContext): { role: 'system' | 'user'; content: string }[] {
  if (context.strategy !== undefined || context.agents !== undefined || context.event !== undefined) {
    throw new Error('An analyst is shown the market snapshot and nothing else')
  }
  return [
    { role: 'system', content: AI_AGENT_SYSTEM_PROMPTS[role] },
    { role: 'user', content: aiContextJson(context) }
  ]
}

/** Characters in one request, for estimating what a call will cost before any has been made. */
export function aiPromptChars(context: AiMarketContext): number {
  return systemPromptFor(context).length + aiContextJson(context).length + JSON.stringify(responseSchemaFor(context)).length
}

export function aiAgentPromptChars(role: AiAgentRole, context: AiMarketContext): number {
  return AI_AGENT_SYSTEM_PROMPTS[role].length + aiContextJson(context).length + JSON.stringify(AI_AGENT_SCHEMAS[role]).length
}

/** Room allowed for three reports that have not been written yet, each with a full-length note. */
const PANEL_REPORTS_CHARS = 3 * (AI_AGENT_MAX_NOTE_CHARS + 180)

/** Characters in a panel's decision request, estimated from the snapshot before any analyst has
 * reported: the same snapshot, the panel's instruction, and room for three reports. */
export function aiPanelDecisionPromptChars(context: AiMarketContext): number {
  return AI_PANEL_SYSTEM_PROMPT.length + aiContextJson(context).length + PANEL_REPORTS_CHARS + JSON.stringify(AI_RESPONSE_SCHEMA).length
}
