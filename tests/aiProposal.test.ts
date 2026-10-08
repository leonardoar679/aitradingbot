import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { aiProposalEntryExpiry, aiProposalEntryRange, aiProposalName, aiProposalOrigin, aiProposalPositionParams, aiProposalProblem, buildAiProposal, buildOpportunityProposal, describeAiProposal, describeAiProposalOrigin, describeSuggestedLiveAmount, isAiCallStale, isAiProposalExpired, opportunityProposalProblem, suggestedLiveAmount } from '../shared/aiProposal'
import { validateOpportunityAnswer } from '../shared/aiOpportunity'
import type { AiSignalDecision } from '../shared/aiSignal'
import type { PositionExecutorParams } from '../shared/ipc'

// A MODEL'S CALL CAN FILL IN AN ORDER FORM. IT CANNOT PLACE THE ORDER.
//
// This is the one place where a model's answer comes near a real order, so the rules are pinned
// from both ends: what a proposal may carry (a market, the model's levels, its horizon) and what
// it may not (an amount, a mode, leverage), and -- structurally, at the bottom -- that the form it
// opens is submitted by a person and by nothing else.

const CANDLE = Date.parse('2026-10-04T01:15:00Z') / 1000
const OPEN = CANDLE + 60
const PRICE = 62_000
const PAIR = { symbol: 'BTCUSDT', baseAsset: 'BTC', quoteAsset: 'USDT' }
const ROOT = join(__dirname, '..')

function buy(overrides: Partial<AiSignalDecision> = {}): AiSignalDecision {
  return {
    candleTime: CANDLE,
    recommendation: 'buy',
    confidence: 0.8,
    rationale: 'trend and momentum agree',
    model: 'openai/gpt-5-mini',
    cached: false,
    error: null,
    rejected: null,
    detail: {
      marketRegime: 'bull',
      riskLevel: 'medium',
      horizonBars: 16,
      // 1.5% below and 2% above the price the model was shown.
      stopLoss: 61_070,
      takeProfit: 63_240,
      reasonCodes: ['trend_up'],
      levelsNote: null
    },
    ...overrides
  }
}

function proposalFor(decision: AiSignalDecision, nowSec = OPEN, referencePrice = PRICE) {
  return buildAiProposal({ decision, exchange: 'binance', pair: PAIR, interval: '15m', referencePrice, nowSec })
}

function formDefaults(overrides: Partial<PositionExecutorParams> = {}): PositionExecutorParams {
  return { side: 'buy', entryPrice: null, amountQuote: 1000, takeProfitPct: 2, stopLossPct: 1, timeLimitSec: null, trailingStop: null, ...overrides }
}

describe('which calls can be turned into an order form', () => {
  it('offers one for a buy this app would act on, while its candle is open', () => {
    expect(aiProposalProblem(buy(), '15m', OPEN)).toBeNull()
    expect(proposalFor(buy())).toEqual({
      exchange: 'binance',
      pair: PAIR,
      model: 'openai/gpt-5-mini',
      candleTime: CANDLE,
      interval: '15m',
      confidence: 0.8,
      referencePrice: PRICE,
      stopLossPct: 1.5,
      takeProfitPct: 2,
      timeLimitSec: 16 * 900
    })
  })

  it('offers none for anything the paper strategy would not enter on', () => {
    // The same gate, on purpose: a form offered for a call that a backtest would not have acted
    // on would make the hand-placed order more permissive than the record it is judged by.
    const refused: AiSignalDecision[] = [
      buy({ recommendation: 'hold' }),
      buy({ recommendation: 'sell' }),
      buy({ confidence: 0.64 }),
      buy({ error: 'OpenRouter could not be reached' }),
      buy({ rejected: 'The answer was not valid JSON.' })
    ]
    for (const decision of refused) {
      expect(aiProposalProblem(decision, '15m', OPEN), JSON.stringify(decision)).not.toBeNull()
      expect(proposalFor(decision), JSON.stringify(decision)).toBeNull()
    }
    expect(proposalFor(buy({ confidence: 0.65 }))).not.toBeNull()
  })

  it('says why a buy is not offered, in terms of the rule it missed', () => {
    expect(aiProposalProblem(buy({ confidence: 0.5 }), '15m', OPEN)).toMatch(/65% confidence or more/)
    expect(aiProposalProblem(buy(), '15m', CANDLE + 900)).toMatch(/candle this call was made for has closed/)
  })

  it('withdraws the offer the moment the candle the call was made for closes', () => {
    expect(isAiCallStale(CANDLE, '15m', CANDLE + 899)).toBe(false)
    expect(isAiCallStale(CANDLE, '15m', CANDLE + 900)).toBe(true)
    expect(proposalFor(buy(), CANDLE + 899)).not.toBeNull()
    expect(proposalFor(buy(), CANDLE + 900)).toBeNull()
  })

  it('needs the price the model was shown, and its horizon', () => {
    for (const price of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) expect(proposalFor(buy(), OPEN, price)).toBeNull()
    expect(proposalFor(buy({ detail: null }))).toBeNull()
  })
})

describe("the model's levels, as the form takes them", () => {
  it('turns its prices into distances from the price it was shown, to two places', () => {
    const detail = { ...buy().detail!, stopLoss: 61_123.45, takeProfit: 64_000 }
    const proposal = proposalFor(buy({ detail }))
    expect(proposal?.stopLossPct).toBe(1.41)
    expect(proposal?.takeProfitPct).toBe(3.23)
  })

  it('does not carry a level that is no use as a default', () => {
    // A stop a rounding error from the price, a target several times the price away, and a level
    // on the wrong side of the price. The validator discards the last kind before it gets here;
    // this is the second lock on the same door.
    const levels = (stopLoss: number | null, takeProfit: number | null) => proposalFor(buy({ detail: { ...buy().detail!, stopLoss, takeProfit } }))
    expect(levels(61_999, 63_240)).toMatchObject({ stopLossPct: null, takeProfitPct: 2 })
    expect(levels(61_070, 200_000)).toMatchObject({ stopLossPct: 1.5, takeProfitPct: null })
    expect(levels(63_000, 61_000)).toMatchObject({ stopLossPct: null, takeProfitPct: null })
    expect(levels(null, null)).toMatchObject({ stopLossPct: null, takeProfitPct: null })
  })

  it('takes the time limit from the horizon the model named', () => {
    expect(proposalFor(buy({ detail: { ...buy().detail!, horizonBars: 4 } }))?.timeLimitSec).toBe(3600)
    expect(proposalFor(buy({ detail: { ...buy().detail!, horizonBars: 96 } }))?.timeLimitSec).toBe(86_400)
  })
})

describe('the form a proposal opens', () => {
  it('lays the call over the form, and leaves the amount exactly as the form had it', () => {
    const proposal = proposalFor(buy())!
    expect(aiProposalPositionParams(proposal, formDefaults({ amountQuote: 1000 }))).toEqual({
      side: 'buy',
      entryPrice: null,
      amountQuote: 1000,
      takeProfitPct: 2,
      stopLossPct: 1.5,
      timeLimitSec: 14_400,
      trailingStop: null
    })
    expect(aiProposalPositionParams(proposal, formDefaults({ amountQuote: 37 })).amountQuote).toBe(37)
  })

  it('carries no amount, no mode and no leverage, whatever the form held', () => {
    // What an order risks is the amount, whether it is real, and how it is geared. None of the
    // three is something a call can set.
    const proposal = proposalFor(buy())!
    for (const key of ['amountQuote', 'amount', 'mode', 'leverage', 'side']) expect(Object.keys(proposal)).not.toContain(key)
    const params = aiProposalPositionParams(proposal, formDefaults({ leverage: 10, side: 'sell', entryPrice: 50_000 }))
    expect(Object.keys(params)).not.toContain('leverage')
    expect(params.side).toBe('buy')
    expect(params.entryPrice).toBeNull()
  })

  it("keeps the form's own stop and target where the model named none, and says so", () => {
    const proposal = proposalFor(buy({ detail: { ...buy().detail!, stopLoss: null, takeProfit: null } }))!
    const params = aiProposalPositionParams(proposal, formDefaults({ stopLossPct: 1, takeProfitPct: 2 }))
    // A real position with no stop is a worse default than a stop the model did not choose.
    expect(params).toMatchObject({ stopLossPct: 1, takeProfitPct: 2, timeLimitSec: 14_400 })
    expect(describeAiProposal(proposal).join(' ')).toMatch(/named no usable stop or target, so the form's usual ones are shown/)
  })

  it('says where each value came from, and what is still the user’s to do', () => {
    const text = describeAiProposal(proposalFor(buy())!).join(' ')
    expect(text).toContain('openai/gpt-5-mini said BUY BTCUSDT at 80% confidence, for the 15m candle that opened 01:15 UTC')
    expect(text).toContain('set against a price of 62,000: 1.5% below and 2% above')
    expect(text).toContain('The time limit is the 4 hours it said the call plays out over')
    expect(text).toContain('The amount is yours to set')
    expect(text).toContain('Nothing is placed until you submit this form')
    expect(describeAiProposal(proposalFor(buy({ model: 'panel:openai/gpt-5-mini' }))!)[0]).toContain('the agent panel on openai/gpt-5-mini said BUY')
  })

  it('names the executor after the call, and keeps only where the idea came from', () => {
    const proposal = proposalFor(buy())!
    expect(aiProposalName(proposal)).toBe('AI call BTCUSDT')
    expect(aiProposalOrigin(proposal)).toEqual({ model: 'openai/gpt-5-mini', candleTime: CANDLE, confidence: 0.8 })
    expect(describeAiProposalOrigin(aiProposalOrigin(proposal))).toBe(
      'Filled in from a call by openai/gpt-5-mini (80% confidence, 01:15 UTC candle). Placed by you.'
    )
  })
})

describe('a proposal opens a form, and a person submits it', () => {
  const modal = readFileSync(join(ROOT, 'src', 'executors', 'NewExecutorModal.tsx'), 'utf-8')
  const page = readFileSync(join(ROOT, 'src', 'executors', 'ExecutorsPage.tsx'), 'utf-8')

  it('the form opens on paper however it was opened', () => {
    // The mode starts as the literal 'paper', and is set in exactly three places: the checkbox a
    // person ticks, the effect that forces it BACK to paper, and -- since 8 October 2026, CONFIRM --
    // the effect that ticks it for a call confirmed from Opportunities, which runs once and only
    // where the checkbox itself could be ticked (canGoLive: a verified key, the session armed by a
    // person, no kill switch). The phrase is still typed and the button still pressed by a person.
    expect(modal).toContain("useState<'paper' | 'live'>('paper')")
    expect(modal.match(/setMode\(/g)).toHaveLength(3)
    expect(modal).toContain("setMode(e.target.checked ? 'live' : 'paper')")
    expect(modal).toContain("setMode('paper')")
    expect(modal).toMatch(/if \(!proposalLive \|\| liveAsked\.current \|\| !canGoLive\) return\r?\n\s+liveAsked\.current = true\r?\n\s+setMode\('live'\)/)
  })

  it('a live order still needs its phrase typed, with or without a proposal', () => {
    expect(modal).toContain("const liveConfirmOk = liveConfirmText.trim() === LIVE_CONFIRM_PHRASE")
    expect(modal).toContain("const [liveConfirmText, setLiveConfirmText] = useState('')")
    // Nothing fills the phrase in: its setter is called from the field itself and to clear it.
    for (const call of modal.match(/setLiveConfirmText\([^)]*\)/g) ?? []) {
      expect(["setLiveConfirmText('')", 'setLiveConfirmText(e.target.value)']).toContain(call)
    }
  })

  it('an executor is created by the form’s own button and by nothing else', () => {
    // handleCreate is where a real order is placed. It appears as its definition and as the
    // modal's onCreate, and the effect that receives a proposal does not mention it.
    const uses = page.split('\n').filter((line) => line.includes('handleCreate') && !line.trim().startsWith('*') && !line.trim().startsWith('/'))
    expect(uses.map((line) => line.trim())).toEqual(['async function handleCreate(input: {', 'onCreate={handleCreate}'])
    const effect = page.slice(page.indexOf('if (proposal === null) return'), page.indexOf('function closeNew'))
    expect(effect).toContain('setShowNew(true)')
    expect(effect).not.toMatch(/placeLive|handleCreate|setExecutors/)
  })
})

// ---------------------------------------------------------------------------------------------
// A RECOMMENDATION ON AN EVENT (shared/aiOpportunity.ts) can fill in the same form. It adds three
// things a signal's call never had -- a side that may be a short, a price to wait for, and an
// expiry -- and each of them is pinned here.

const EVENT_TIME = Date.parse('2026-10-04T05:12:00Z') / 1000
const EVENT = {
  exchange: 'binance' as const,
  symbol: 'SOLUSDT',
  baseAsset: 'SOL',
  quoteAsset: 'USDT',
  time: EVENT_TIME,
  type: 'breakout' as const,
  price: 100
}

/** A long around 100 unless overridden: in at 99.8 to 100.2 for fifteen minutes, an hour to hold. */
function recommendation(overrides: Record<string, unknown> = {}, more: Partial<AiSignalDecision> = {}): AiSignalDecision {
  const verdict = validateOpportunityAnswer(
    {
      recommendation: 'buy',
      confidence: 0.8,
      entryMin: 99.8,
      entryMax: 100.2,
      validMinutes: 15,
      stopLoss: 98.5,
      takeProfit: 103,
      horizonBars: 4,
      marketRegime: 'bull',
      riskLevel: 'medium',
      reasonCodes: ['breakout'],
      rationale: 'Cleared the range on volume.',
      ...overrides
    },
    EVENT.price
  )
  if (!verdict.ok) throw new Error(verdict.reason)
  return { candleTime: EVENT_TIME, ...verdict.signal, model: 'openai/gpt-5-mini', cached: false, error: null, rejected: null, detail: verdict.detail, ...more }
}

const SHORT = { recommendation: 'sell', stopLoss: 101.5, takeProfit: 97 }
const SOON = EVENT_TIME + 120

function offer(decision: AiSignalDecision, lastPrice: number | null = 100, nowSec = SOON) {
  return buildOpportunityProposal({ event: EVENT, decision, nowSec, lastPrice })
}

describe('a recommendation on an event, as an order form', () => {
  it('enters at market while the price is inside the range the model named', () => {
    const proposal = offer(recommendation(), 100.1)!
    expect(proposal).toEqual({
      exchange: 'binance',
      pair: { symbol: 'SOLUSDT', baseAsset: 'SOL', quoteAsset: 'USDT' },
      model: 'openai/gpt-5-mini',
      candleTime: EVENT_TIME,
      interval: '1m',
      confidence: 0.8,
      referencePrice: 100.1,
      // The model's own prices, as distances from the entry: 98.5 and 103 against 100.1.
      stopLossPct: 1.6,
      takeProfitPct: 2.9,
      timeLimitSec: 3600,
      side: 'buy',
      entryPrice: null,
      // The range itself goes with it, for a paper position to enter by.
      entryRange: { min: 99.8, max: 100.2 },
      expiresAt: EVENT_TIME + 900,
      eventType: 'breakout'
    })
    expect(aiProposalPositionParams(proposal, formDefaults({ amountQuote: 250 }))).toEqual({
      side: 'buy',
      entryPrice: null,
      amountQuote: 250,
      takeProfitPct: 2.9,
      stopLossPct: 1.6,
      timeLimitSec: 3600,
      trailingStop: null
    })
  })

  it('waits for the nearer edge of the range when the price is outside it', () => {
    // Above the range: wait for a pullback to its top.
    const above = offer(recommendation(), 100.9)!
    expect(above.entryPrice).toBe(100.2)
    expect(above.referencePrice).toBe(100.2)
    expect(above.stopLossPct).toBeCloseTo(1.7, 10)
    // Below it: wait for the price to come back up to its bottom.
    expect(offer(recommendation(), 99.5)!.entryPrice).toBe(99.8)
    expect(aiProposalPositionParams(above, formDefaults()).entryPrice).toBe(100.2)
  })

  it('uses the price the model saw when there is no price now', () => {
    const proposal = buildOpportunityProposal({ event: EVENT, decision: recommendation(), nowSec: SOON })!
    expect(proposal.entryPrice).toBeNull()
    expect(proposal.referencePrice).toBe(100)
  })

  it('opens a short as a sell, with its stop above and its target below', () => {
    const proposal = offer(recommendation(SHORT), 100)!
    expect(proposal).toMatchObject({ side: 'sell', entryPrice: null, stopLossPct: 1.5, takeProfitPct: 3, timeLimitSec: 3600 })
    expect(aiProposalPositionParams(proposal, formDefaults()).side).toBe('sell')
    // Outside the range, a short waits for the nearer edge too.
    expect(offer(recommendation(SHORT), 99.4)!.entryPrice).toBe(99.8)
    expect(offer(recommendation(SHORT), 100.6)!.entryPrice).toBe(100.2)
  })

  it('carries no amount, no mode and no leverage, long or short', () => {
    for (const proposal of [offer(recommendation())!, offer(recommendation(SHORT))!]) {
      for (const key of ['amountQuote', 'amount', 'mode', 'leverage']) expect(Object.keys(proposal)).not.toContain(key)
      const params = aiProposalPositionParams(proposal, formDefaults({ leverage: 10 }))
      expect(Object.keys(params)).not.toContain('leverage')
    }
  })

  it('offers no form for a call this app would not act on', () => {
    const none = recommendation({ recommendation: 'hold', entryMin: null, entryMax: null, stopLoss: null, takeProfit: null })
    expect(offer(none)).toBeNull()
    expect(opportunityProposalProblem(EVENT_TIME, none, SOON)).toBe('A call not to trade opens nothing.')
    expect(offer(recommendation({ confidence: 0.6 }))).toBeNull()
    expect(opportunityProposalProblem(EVENT_TIME, recommendation({ confidence: 0.6 }), SOON)).toMatch(/65% confidence or more/)
    expect(offer(recommendation({}, { rejected: 'bad shape' }))).toBeNull()
    expect(opportunityProposalProblem(EVENT_TIME, recommendation({}, { rejected: 'bad shape' }), SOON)).toMatch(/refused/)
    expect(opportunityProposalProblem(EVENT_TIME, recommendation({}, { error: 'down' }), SOON)).toMatch(/not reached/)
  })

  it('withdraws the offer when the entry expires', () => {
    const last = EVENT_TIME + 899
    expect(offer(recommendation(), 100, last)).not.toBeNull()
    expect(offer(recommendation(), 100, last + 1)).toBeNull()
    expect(opportunityProposalProblem(EVENT_TIME, recommendation(), last + 1)).toBe(
      'Its entry expired at 05:27 UTC, so no order form is offered for it. Ask again for a current one.'
    )
    // A longer validity is a longer offer.
    expect(offer(recommendation({ validMinutes: 60 }), 100, EVENT_TIME + 3000)).not.toBeNull()
  })

  it('offers none once the price has gone through the stop or reached the target', () => {
    expect(offer(recommendation(), 98.4)).toBeNull()
    expect(opportunityProposalProblem(EVENT_TIME, recommendation(), SOON, 98.4)).toMatch(/gone through its stop/)
    expect(offer(recommendation(), 103.1)).toBeNull()
    expect(opportunityProposalProblem(EVENT_TIME, recommendation(), SOON, 103.1)).toMatch(/reached its target/)
    // Mirrored for a short.
    expect(opportunityProposalProblem(EVENT_TIME, recommendation(SHORT), SOON, 101.6)).toMatch(/gone through its stop/)
    expect(opportunityProposalProblem(EVENT_TIME, recommendation(SHORT), SOON, 96.9)).toMatch(/reached its target/)
    expect(opportunityProposalProblem(EVENT_TIME, recommendation(SHORT), SOON, 100)).toBeNull()
  })

  it('says where each value came from, when it expires, and that a short is paper only', () => {
    const long = describeAiProposal(offer(recommendation(), 100.9)!).join(' ')
    expect(long).toContain('openai/gpt-5-mini said BUY SOLUSDT at 80% confidence, on the breakout raised at 05:12 UTC')
    expect(long).toContain('It waits for a price of 100.2, the nearer edge of the range the model named, 99.8 to 100.2.')
    expect(long).toContain('On paper, with the entry left as it is, the position enters in the first minute the price trades inside that range, from whichever side: a price that has left it is not chased, and is not bought at once from its far side.')
    expect(long).toContain("The model's stop is 1.7% below that entry and its target 2.79% above it.")
    expect(long).toContain('The time limit is the 1 hour it said to hold for.')
    expect(long).toContain('Its entry is good until 05:27 UTC. After that this form will not submit it as it stands, and a paper position still waiting to enter then is abandoned.')
    expect(long).toContain('real money still needs Live Trading ticked below and its phrase typed')

    const short = describeAiProposal(offer(recommendation(SHORT), 100)!).join(' ')
    expect(short).toContain('said SELL SOLUSDT')
    expect(short).toContain('It enters at market: the price is inside the range the model named, 99.8 to 100.2.')
    expect(short).toContain("The model's stop is 1.5% above that entry and its target 3% below it.")
    expect(short).toContain('A short is paper only: this app places no short or leveraged order, so Live Trading cannot be ticked for it.')
    expect(short).not.toContain('real money still needs')
  })

  it('knows when a form made from one can no longer be submitted, and never says so of a signal', () => {
    const proposal = offer(recommendation())!
    expect(isAiProposalExpired(proposal, EVENT_TIME + 899)).toBe(false)
    expect(isAiProposalExpired(proposal, EVENT_TIME + 900)).toBe(true)
    // A signal's proposal has no expiry: an old one is warned about, not refused.
    expect(isAiProposalExpired(proposalFor(buy())!, CANDLE + 10 * 86_400)).toBe(false)
  })

  it('gives a paper position made from one the same expiry, and a live one none', () => {
    const proposal = offer(recommendation())!
    expect(aiProposalEntryExpiry(proposal, 'paper')).toBe(EVENT_TIME + 900)
    // Nothing in this app cancels a resting real order on a clock.
    expect(aiProposalEntryExpiry(proposal, 'live')).toBeNull()
    // A signal's proposal has no entry window to run out.
    expect(aiProposalEntryExpiry(proposalFor(buy())!, 'paper')).toBeNull()
  })

  it('gives a paper position made from one the model\'s range to enter by, while its entry is still the recommendation\'s', () => {
    const inside = offer(recommendation(), 100.1)!
    expect(aiProposalEntryRange(inside, 'paper', null)).toEqual({ min: 99.8, max: 100.2 })
    const above = offer(recommendation(), 100.9)!
    expect(aiProposalEntryRange(above, 'paper', 100.2)).toEqual({ min: 99.8, max: 100.2 })
    // A price typed over the entry, or the entry cleared to market, is the user's own order.
    expect(aiProposalEntryRange(inside, 'paper', 100.05)).toBeNull()
    expect(aiProposalEntryRange(above, 'paper', null)).toBeNull()
    expect(aiProposalEntryRange(above, 'paper', 100.3)).toBeNull()
    // An exchange has no order that means "when the price trades in this range".
    expect(aiProposalEntryRange(inside, 'live', null)).toBeNull()
    expect(aiProposalEntryRange(above, 'live', 100.2)).toBeNull()
    // A signal's proposal names no range.
    expect(proposalFor(buy())!.entryRange).toBeUndefined()
    expect(aiProposalEntryRange(proposalFor(buy())!, 'paper', null)).toBeNull()
  })

  it('stamps the expiry and the range where the form is submitted, and only on a position that still follows the recommendation', () => {
    const modal = readFileSync(join(__dirname, '..', 'src', 'executors', 'NewExecutorModal.tsx'), 'utf-8')
    expect(modal).toContain("const entryExpiresAt = type === 'position' && proposal !== null && followsProposal ? aiProposalEntryExpiry(proposal, mode) : null")
    expect(modal).toContain("const entryRange = type === 'position' && proposal !== null && followsProposal ? aiProposalEntryRange(proposal, mode, positionParams.entryPrice) : null")
    expect(modal).toContain('params: entryExpiresAt !== null || entryRange !== null ? { ...positionParams, ...fromRecommendation } : params,')
  })
})

describe('a short can be paper traded and cannot be placed', () => {
  const modal = readFileSync(join(ROOT, 'src', 'executors', 'NewExecutorModal.tsx'), 'utf-8').replace(/\r\n/g, '\n')

  it('the form refuses Live for any position that is not a buy entered at market', () => {
    // The gate a short proposal meets. It is the form's own, older than proposals, and it does
    // not look at where the form's values came from.
    expect(modal).toMatch(/const canGoLivePosition =\n\s+type === 'position' &&\n\s+positionParams\.side === 'buy' &&\n\s+positionParams\.entryPrice === null &&/)
    for (const gate of ["const canGoLiveDca = type === 'dca' && dcaParams.side === 'buy'", "const canGoLiveTwap = type === 'twap' && twapParams.side === 'buy'", "const canGoLiveGrid = type === 'grid' && gridParams.side === 'buy'"]) {
      expect(modal).toContain(gate)
    }
    // The checkbox that makes an order real cannot be ticked while that gate is shut, and the
    // mode is forced back to paper the moment it shuts.
    expect(modal).toContain('disabled={!canGoLive}')
    expect(modal).toMatch(/if \(!canGoLive && mode === 'live'\) \{\n\s+setMode\('paper'\)/)
  })

  it('a proposal sets the side of the form and nothing about whether it is real', () => {
    // The only things read off a proposal are what the form opens on, what it is recorded as,
    // whether it has expired, and -- since 8 October 2026 -- its stop, read to size the amount by
    // the PERSON'S risk setting (suggestedLiveAmount): the model still names no amount.
    const reads = [...modal.matchAll(/proposal\??\.(\w+)/g)].map((match) => match[1])
    expect(new Set(reads)).toEqual(new Set(['exchange', 'pair', 'side', 'expiresAt', 'candleTime', 'interval', 'stopLossPct']))
    expect(modal).toContain('stopLossPct: proposal.stopLossPct')
  })

  it('Confirm is on offer for a BUY alone, and hands the form the call and nothing more (8 October 2026)', () => {
    // CONFIRM: the row's button fills in a real order from a BUY; a short stays paper, and the
    // flag that opens the form as real is computed from the setting and the side, nothing else.
    const tab = readFileSync(join(ROOT, 'src', 'agents', 'OpportunitiesTab.tsx'), 'utf-8')
    expect(tab).toContain("onPrepareOrder(result.proposal, config?.watch.confirmLive === true && opportunitySide(answer.decision) === 'long')")
    expect(readFileSync(join(ROOT, 'src', 'agents', 'OpportunityTableCard.tsx'), 'utf-8')).toContain("const confirming = confirm === true && answer !== null && answer.decision.recommendation === 'buy'")
    expect(readFileSync(join(ROOT, 'src', 'agents', 'OpportunityCard.tsx'), 'utf-8')).toContain("{confirm === true && side === 'long' ? 'Confirm' : 'Paper trade'}")
    // The page keeps the flag with the proposal and lets go of both together.
    const page = readFileSync(join(ROOT, 'src', 'executors', 'ExecutorsPage.tsx'), 'utf-8')
    expect(page).toContain('setFormLive(proposalLive)')
    expect(page).toContain('proposalLive={formLive}')
  })

  it('the form will not submit an expired recommendation as it stands', () => {
    expect(modal).toContain('const blockedByExpiry = followsProposal && proposalExpired')
    expect(modal).toMatch(/disabled=\{[^}]*\|\| blockedByExpiry\}/)
    // And the clock is asked again at the click, before anything is created.
    const create = modal.slice(modal.indexOf('function handleCreate(): void {'), modal.indexOf('return (\n    <div\n      onClick={onClose}'))
    expect(create.indexOf('isAiProposalExpired(proposal, Math.floor(Date.now() / 1000))')).toBeGreaterThan(0)
    expect(create.indexOf('isAiProposalExpired(proposal, Math.floor(Date.now() / 1000))')).toBeLessThan(create.indexOf('onCreate({'))
  })
})

describe('the amount a real order from a call is suggested to stake (8 October 2026)', () => {
  const limits = { riskPct: 0.25, allocationQuote: 5000, dailyCapQuote: 50, maxOrderQuote: 25 }

  it("is the risk setting's share of the allocation lost at the stop after fees, under the max order size", () => {
    // 0.25% of 5,000 is 12.5; at a 1.5% stop and 0.2% of fees that stakes 735.29, held to 25.
    expect(suggestedLiveAmount({ ...limits, stopLossPct: 1.5 })).toEqual({ amountQuote: 25, riskQuote: 12.5, basis: 'allocation', capped: true })
    expect(suggestedLiveAmount({ ...limits, maxOrderQuote: 1000, stopLossPct: 1.5 })).toEqual({ amountQuote: 735.29, riskQuote: 12.5, basis: 'allocation', capped: false })
  })

  it("takes the share of the day's cap without an allocation, and none of an allocation of nothing", () => {
    // 0.25% of 50 is 0.125; at a 1.5% stop that stakes 7.35.
    expect(suggestedLiveAmount({ ...limits, allocationQuote: null, stopLossPct: 1.5 })).toEqual({ amountQuote: 7.35, riskQuote: 0.13, basis: 'daily cap', capped: false })
    expect(suggestedLiveAmount({ ...limits, allocationQuote: 0, stopLossPct: 1.5 })).toBeNull()
  })

  it('suggests nothing without a usable stop, a share, a cap, or a size worth placing', () => {
    expect(suggestedLiveAmount({ ...limits, stopLossPct: null })).toBeNull()
    expect(suggestedLiveAmount({ ...limits, stopLossPct: 0 })).toBeNull()
    expect(suggestedLiveAmount({ ...limits, riskPct: 0, stopLossPct: 1.5 })).toBeNull()
    expect(suggestedLiveAmount({ ...limits, maxOrderQuote: 0, stopLossPct: 1.5 })).toBeNull()
    // 0.1% of 50 at a 5% stop: 0.05 / 5.2% is 0.96, under the 5 the smallest order is worth.
    expect(suggestedLiveAmount({ riskPct: 0.1, allocationQuote: null, dailyCapQuote: 50, maxOrderQuote: 25, stopLossPct: 5 })).toBeNull()
  })

  it('says what it is, whose setting sized it, and that the model did not', () => {
    const suggested = suggestedLiveAmount({ ...limits, stopLossPct: 1.5 })
    expect(suggested).not.toBeNull()
    expect(describeSuggestedLiveAmount(suggested!, { riskPct: 0.25, stopLossPct: 1.5, quoteAsset: 'USDT' })).toBe(
      'Amount 25 USDT: 0.25% of your allocation (12.5 USDT) lost at the 1.5% stop, after fees. Held to the max order size. Sized by your risk setting on Risk & Safety, not by the model; change it as you like.'
    )
  })
})
