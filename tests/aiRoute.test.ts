import { describe, expect, it } from 'vitest'
import { describeAiRunCost } from '../shared/aiCost'
import {
  AI_ESCALATE_WHEN,
  describeAiRoute,
  describeEscalation,
  describeRouteKind,
  escalates,
  firstOpinionOf,
  parseAiRoute,
  routedDecision,
  sameAiRoute
} from '../shared/aiRoute'
import { GPT_FLAT, GPT_MIN_CONFIDENCE, type AiSignalDecision, type AiSignalEstimate, type GptPosition } from '../shared/aiSignal'

// A route decides how many paid calls one decision makes, and whose answer the account acts on.
// These pin the rule itself: which answers are passed on to the second model, that a failure never
// is, and that what someone is told before a routed run is the ceiling it can reach.

const LONG: GptPosition = { long: true, stop: 90 }
const SURE = GPT_MIN_CONFIDENCE
const UNSURE = GPT_MIN_CONFIDENCE - 0.01

function said(recommendation: 'buy' | 'sell' | 'hold', confidence: number, over: Partial<AiSignalDecision> = {}): AiSignalDecision {
  return {
    candleTime: 1_700_000_000,
    recommendation,
    confidence,
    rationale: 'because',
    model: 'cheap/model',
    cached: false,
    error: null,
    rejected: null,
    detail: null,
    usage: { promptTokens: 1000, completionTokens: 200, costUsd: 0.002, latencyMs: 900 },
    ...over
  }
}

const REFUSED = said('hold', 0, { rejected: 'marketRegime is not an allowed value' })
const UNREACHED = said('hold', 0, { error: 'OpenRouter returned 503' })

describe('passing a decision on when the first model wants to trade', () => {
  it('passes on an entry while flat and an exit while long, at the confidence a bot acts on', () => {
    expect(escalates(said('buy', SURE), GPT_FLAT, 'acting')).toBe(true)
    expect(escalates(said('sell', SURE), LONG, 'acting')).toBe(true)
  })

  it('keeps everything that would not change the account', () => {
    // Below the gate the bot does not act, so there is nothing to get a second opinion on.
    expect(escalates(said('buy', UNSURE), GPT_FLAT, 'acting')).toBe(false)
    expect(escalates(said('sell', UNSURE), LONG, 'acting')).toBe(false)
    expect(escalates(said('hold', 0.99), GPT_FLAT, 'acting')).toBe(false)
    expect(escalates(said('hold', 0.99), LONG, 'acting')).toBe(false)
    // A buy on top of an open position and a sell with nothing to sell are not trades.
    expect(escalates(said('buy', 0.99), LONG, 'acting')).toBe(false)
    expect(escalates(said('sell', 0.99), GPT_FLAT, 'acting')).toBe(false)
    expect(escalates(REFUSED, GPT_FLAT, 'acting')).toBe(false)
  })
})

describe('passing a decision on when the first model is unsure', () => {
  it('passes on anything answered below the gate, whatever it recommended', () => {
    for (const recommendation of ['buy', 'sell', 'hold'] as const) {
      expect(escalates(said(recommendation, UNSURE), GPT_FLAT, 'unsure')).toBe(true)
      expect(escalates(said(recommendation, UNSURE), LONG, 'unsure')).toBe(true)
    }
  })

  it('lets a confident answer stand, a confident entry included', () => {
    for (const recommendation of ['buy', 'sell', 'hold'] as const) {
      expect(escalates(said(recommendation, SURE), GPT_FLAT, 'unsure')).toBe(false)
      expect(escalates(said(recommendation, 0.95), LONG, 'unsure')).toBe(false)
    }
  })

  it('passes on an answer the validator refused: the first model said nothing usable', () => {
    expect(escalates(REFUSED, GPT_FLAT, 'unsure')).toBe(true)
    // Even one whose stored shape carries a confidence: refused is refused.
    expect(escalates(said('buy', 0.9, { rejected: 'riskLevel is not an allowed value' }), GPT_FLAT, 'unsure')).toBe(true)
  })
})

describe('a call that never reached the first model', () => {
  it('is not passed on under either rule', () => {
    // It parses as a zero-confidence hold, which is exactly what "unsure" would pass on. It is a
    // failure, not an answer: it is asked again, not replaced by another model's.
    for (const when of AI_ESCALATE_WHEN) {
      expect(escalates(UNREACHED, GPT_FLAT, when)).toBe(false)
      expect(escalates(UNREACHED, LONG, when)).toBe(false)
      expect(escalates(said('buy', 0.9, { error: 'timeout' }), GPT_FLAT, when)).toBe(false)
    }
  })
})

describe('the decision a route reaches', () => {
  const first = said('buy', 0.9, { cached: true })
  const second = said('hold', 0.7, { model: 'frontier/model', cached: true, rationale: 'late entry' })

  it("is the second model's answer, carrying what the first had said", () => {
    const routed = routedDecision(first, second)
    expect(routed).toMatchObject({ recommendation: 'hold', confidence: 0.7, model: 'frontier/model', rationale: 'late entry' })
    expect(routed.first).toEqual({ model: 'cheap/model', recommendation: 'buy', confidence: 0.9, rejected: null })
    expect(firstOpinionOf(REFUSED).rejected).toContain('marketRegime')
  })

  it('counts as free only when neither answer was paid for by this run', () => {
    expect(routedDecision(first, second).cached).toBe(true)
    expect(routedDecision({ ...first, cached: false }, second).cached).toBe(false)
    expect(routedDecision(first, { ...second, cached: false }).cached).toBe(false)
  })

  it('keeps the failure when the second model could not be reached', () => {
    const routed = routedDecision(first, { ...UNREACHED, model: 'frontier/model' })
    expect(routed.error).toContain('503')
    expect(routed.first?.recommendation).toBe('buy')
  })
})

describe('reading a route', () => {
  it('rebuilds a well-formed one and drops anything that came with it', () => {
    expect(parseAiRoute({ model: 'acme/frontier', when: 'acting', extra: true })).toEqual({ model: 'acme/frontier', when: 'acting' })
    expect(parseAiRoute({ model: 'acme/frontier:beta', when: 'unsure' })).toEqual({ model: 'acme/frontier:beta', when: 'unsure' })
  })

  it('reads nothing as no route', () => {
    expect(parseAiRoute(undefined)).toBeNull()
    expect(parseAiRoute(null)).toBeNull()
  })

  it('refuses a malformed one rather than guessing', () => {
    expect(() => parseAiRoute('acme/frontier')).toThrow(/second model and when/)
    expect(() => parseAiRoute([{ model: 'acme/frontier', when: 'acting' }])).toThrow(/second model and when/)
    expect(() => parseAiRoute({ when: 'acting' })).toThrow(/not a valid model id/)
    expect(() => parseAiRoute({ model: 'has spaces', when: 'acting' })).toThrow(/not a valid model id/)
    // A rule that cannot be read must not run as "always ask both".
    expect(() => parseAiRoute({ model: 'acme/frontier' })).toThrow(/wants to trade, or when it is unsure/)
    expect(() => parseAiRoute({ model: 'acme/frontier', when: 'always' })).toThrow(/wants to trade, or when it is unsure/)
  })

  it('tells two routes apart by model and by rule', () => {
    const route = { model: 'acme/frontier', when: 'acting' as const }
    expect(sameAiRoute(route, { ...route })).toBe(true)
    expect(sameAiRoute(route, { ...route, when: 'unsure' })).toBe(false)
    expect(sameAiRoute(route, { ...route, model: 'acme/other' })).toBe(false)
    expect(sameAiRoute(null, undefined)).toBe(true)
    expect(sameAiRoute(route, null)).toBe(false)
  })

  it('says in words when the second model is asked', () => {
    expect(describeEscalation('acting')).toBe('wants to open or close a position')
    expect(describeEscalation('unsure')).toBe(`answers with less than ${GPT_MIN_CONFIDENCE * 100}% confidence`)
    expect(describeAiRoute('cheap/model', { model: 'acme/frontier', when: 'acting' })).toBe(
      'cheap/model, then acme/frontier when it wants to open or close a position'
    )
  })
})

describe('what someone is told before a routed run', () => {
  const estimate: AiSignalEstimate = {
    total: 141,
    cached: 23,
    maximumApiCalls: 235,
    model: 'cheap/model',
    route: { model: 'acme/frontier', when: 'acting', maximumApiCalls: 118, perCallCostUsd: 0.013, costBasis: 'pricing' },
    perCallCostUsd: 0.002,
    estimatedCostUsd: 117 * 0.002 + 118 * 0.013,
    costBasis: 'history',
    budgetRemainingUsd: 0.96,
    decideEveryBars: 16
  }

  it('names both models, the rule, and each model\'s share of the ceiling', () => {
    const text = describeAiRunCost(estimate)
    expect(text).toContain('141 candles, one every 4 hours, with cheap/model through OpenRouter.')
    expect(text).toContain('When it wants to open or close a position, acme/frontier is asked the same question and its answer is the one that counts.')
    expect(text).toContain('23 are confirmed cached.')
    expect(text).toContain('At most 235 model calls may be made:')
    expect(text).toContain('  cheap/model: up to 117 calls, about $0.23 going by its recent calls here')
    expect(text).toContain('  acme/frontier: up to 118 calls, about $1.53 going by its price list, an estimate')
    expect(text).toContain('About $1.77 in all if every decision were passed on. That is the ceiling: acme/frontier is asked only when cheap/model wants to open or close a position.')
    expect(text).toContain("$0.96 of today's AI budget is left.")
  })

  it('says so when a model has no price, instead of printing a total that leaves it out', () => {
    const text = describeAiRunCost({
      ...estimate,
      estimatedCostUsd: null,
      route: { model: 'acme/frontier', when: 'unsure', maximumApiCalls: 118, perCallCostUsd: null, costBasis: 'unknown' }
    })
    expect(text).toContain('  acme/frontier: up to 118 calls, cost not known (no call history here and no published price)')
    expect(text).toContain('What that comes to in all is not known; acme/frontier is asked only when cheap/model answers with less than 65% confidence.')
    expect(text).not.toContain('in all if every decision')
  })

  it('prices only the second model when the first has already answered the one open decision', () => {
    const text = describeAiRunCost({
      ...estimate,
      total: 1,
      cached: 0,
      maximumApiCalls: 1,
      estimatedCostUsd: 0.013,
      route: { model: 'acme/frontier', when: 'acting', maximumApiCalls: 1, perCallCostUsd: 0.013, costBasis: 'history' },
      decideEveryBars: undefined
    })
    expect(text).toContain('At most 1 model call may be made:')
    expect(text).toContain('  cheap/model: nothing to ask, its answers are cached')
    expect(text).toContain('  acme/frontier: up to 1 call, about $0.013 going by its recent calls here')
  })

  it('is the ordinary free message when both models have already answered everything', () => {
    const text = describeAiRunCost({ ...estimate, cached: 141, maximumApiCalls: 0, estimatedCostUsd: 0, route: { ...estimate.route!, maximumApiCalls: 0 } })
    expect(text).toContain('Every decision is already cached, so nothing will be spent.')
    expect(text).not.toContain('At most')
  })

  it('says nothing about a second model when there is none', () => {
    const text = describeAiRunCost({ ...estimate, route: undefined, maximumApiCalls: 118, estimatedCostUsd: 0.236 })
    expect(text).not.toContain('same question')
    expect(text).toContain("At most 118 model calls may be made, about $0.24 going by this model's recent calls here.")
  })
})

// The second step of a route can be a panel of agents on a model (shared/aiPanel.ts). The rule
// that passes a decision on does not change; what is said about it does, because a panel is four
// calls for each decision it is handed and a confirmation has to say so.
describe('a route whose second step is a panel', () => {
  const route = { model: 'panel:cheap/model', when: 'acting' as const }
  const estimate: AiSignalEstimate = {
    total: 141,
    cached: 23,
    maximumApiCalls: 118 + 472,
    model: 'cheap/model',
    route: { ...route, maximumApiCalls: 472, perCallCostUsd: 0.002, costBasis: 'history', callsPerDecision: 4 },
    perCallCostUsd: 0.002,
    estimatedCostUsd: 590 * 0.002,
    costBasis: 'history',
    budgetRemainingUsd: 3.2
  }

  it('is named as what it is, not as a model id', () => {
    expect(describeAiRoute('cheap/model', route)).toBe('cheap/model, then the agent panel on cheap/model when it wants to open or close a position')
    expect(describeRouteKind(route)).toBe('model and panel')
    expect(describeRouteKind({ model: 'acme/frontier', when: 'unsure' })).toBe('two models')
  })

  it('is priced at four calls for each decision passed on, and the confirmation says so', () => {
    const text = describeAiRunCost(estimate)
    expect(text).toContain('with cheap/model through OpenRouter. When it wants to open or close a position, the agent panel on cheap/model is asked the same question and its answer is the one that counts.')
    expect(text).toContain('At most 590 model calls may be made:')
    expect(text).toContain('  cheap/model: up to 118 calls, about $0.24 going by its recent calls here')
    expect(text).toContain('  the agent panel on cheap/model: up to 472 calls, 4 for each decision passed on, about $0.94 going by its recent calls here')
    expect(text).toContain('About $1.18 in all if every decision were passed on. That is the ceiling: the agent panel on cheap/model is asked only when cheap/model wants to open or close a position.')
  })

  it('says nothing about calls per decision for a second step that is one model', () => {
    const text = describeAiRunCost({ ...estimate, route: { model: 'acme/frontier', when: 'acting', maximumApiCalls: 118, perCallCostUsd: 0.013, costBasis: 'pricing' }, maximumApiCalls: 236 })
    expect(text).not.toContain('for each decision passed on')
  })
})
