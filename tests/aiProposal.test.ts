import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  aiProposalName,
  aiProposalOrigin,
  aiProposalPositionParams,
  aiProposalProblem,
  buildAiProposal,
  describeAiProposal,
  describeAiProposalOrigin,
  isAiCallStale
} from '../shared/aiProposal'
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
    // The mode starts as the literal 'paper', and is set in exactly two places: the checkbox a
    // person ticks, and the effect that forces it BACK to paper. A third would be a way for
    // something other than that checkbox to make an order real.
    expect(modal).toContain("useState<'paper' | 'live'>('paper')")
    expect(modal.match(/setMode\(/g)).toHaveLength(2)
    expect(modal).toContain("setMode(e.target.checked ? 'live' : 'paper')")
    expect(modal).toContain("setMode('paper')")
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
