import { describe, expect, it } from 'vitest'
import {
  AI_VALID_MINUTES,
  isActionableOpportunity,
  isOpportunityExpired,
  opportunityConsensus,
  opportunitySide,
  opportunityWindow,
  validateOpportunityAnswer
} from '../shared/aiOpportunity'
import type { AiSignalDecision, AiSignalDetail } from '../shared/aiSignal'

const PRICE = 100

/** A model's answer to an opportunity question: a long around the price, unless overridden. */
function answer(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
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
    reasonCodes: ['breakout', 'volume_confirms'],
    rationale: 'Cleared the range on volume.',
    ...overrides
  }
}

const SHORT = { recommendation: 'sell', stopLoss: 101.5, takeProfit: 97 }
const NO_TRADE = { recommendation: 'hold', entryMin: null, entryMax: null, stopLoss: null, takeProfit: null }

function refusal(overrides: Record<string, unknown>): string {
  const verdict = validateOpportunityAnswer(answer(overrides), PRICE)
  if (verdict.ok) throw new Error('expected a refusal')
  return verdict.reason
}

function detail(overrides: Record<string, unknown> = {}): AiSignalDetail {
  const verdict = validateOpportunityAnswer(answer(overrides), PRICE)
  if (!verdict.ok) throw new Error(`expected a usable answer, got: ${verdict.reason}`)
  return verdict.detail
}

describe('validateOpportunityAnswer', () => {
  it('takes a long with its entry range, stop, target and clock', () => {
    expect(detail()).toEqual({
      marketRegime: 'bull',
      riskLevel: 'medium',
      horizonBars: 4,
      reasonCodes: ['breakout', 'volume_confirms'],
      stopLoss: 98.5,
      takeProfit: 103,
      levelsNote: null,
      entry: { min: 99.8, max: 100.2, validMinutes: 15 }
    })
  })

  it('takes a short, with the stop above the range and the target below it', () => {
    const short = detail(SHORT)
    expect(short.stopLoss).toBe(101.5)
    expect(short.takeProfit).toBe(97)
    expect(short.entry).toEqual({ min: 99.8, max: 100.2, validMinutes: 15 })
  })

  it('takes a call not to trade, which carries no levels', () => {
    const none = detail(NO_TRADE)
    expect(none.entry).toBeNull()
    expect(none.stopLoss).toBeNull()
    expect(none.levelsNote).toBeNull()
    // Levels sent with it are dropped, and it says so.
    const noisy = detail({ recommendation: 'hold' })
    expect(noisy.entry).toBeNull()
    expect(noisy.takeProfit).toBeNull()
    expect(noisy.levelsNote).toMatch(/ignored/)
  })

  it('refuses a recommendation to trade that is missing any of its four levels', () => {
    for (const field of ['entryMin', 'entryMax', 'stopLoss', 'takeProfit']) {
      expect(refusal({ [field]: null })).toMatch(/must name an entry range, a stop and a target/)
    }
  })

  it('refuses levels that are not prices', () => {
    expect(refusal({ entryMin: -1 })).toMatch(/entryMin is not a price/)
    expect(refusal({ entryMax: 'high' })).toMatch(/entryMax is not a price/)
    expect(refusal({ stopLoss: 0 })).toMatch(/stopLoss is not a price/)
    expect(refusal({ takeProfit: Number.POSITIVE_INFINITY })).toMatch(/takeProfit is not a price/)
  })

  it('refuses an entry range that is upside down, too wide, or nowhere near the price', () => {
    expect(refusal({ entryMin: 100.2, entryMax: 99.8 })).toMatch(/upside down/)
    expect(refusal({ entryMin: 97, entryMax: 103, stopLoss: 90, takeProfit: 110 })).toMatch(/more than 5% wide/)
    expect(refusal({ entryMin: 90, entryMax: 91, stopLoss: 88, takeProfit: 95 })).toMatch(/more than 5% from the price/)
    expect(refusal({ entryMin: 106, entryMax: 107, stopLoss: 104, takeProfit: 110 })).toMatch(/more than 5% from the price/)
    // A range the price is not inside, but near, is a pullback entry and is allowed.
    expect(detail({ entryMin: 98, entryMax: 99, stopLoss: 96.5, takeProfit: 102 }).entry).toEqual({ min: 98, max: 99, validMinutes: 15 })
  })

  it('refuses a long whose stop is not below its range or whose target is not above it', () => {
    expect(refusal({ stopLoss: 99.9 })).toMatch(/stop \(99.9\) is not below the entry range/)
    expect(refusal({ stopLoss: 100.5 })).toMatch(/not below the entry range/)
    expect(refusal({ takeProfit: 100.1 })).toMatch(/target \(100.1\) is not above the entry range/)
  })

  it('refuses a short whose stop is not above its range or whose target is not below it', () => {
    expect(refusal({ ...SHORT, stopLoss: 100 })).toMatch(/stop \(100\) is not above the entry range/)
    expect(refusal({ ...SHORT, takeProfit: 100 })).toMatch(/target \(100\) is not below the entry range/)
    // A long's levels on a short are both on the wrong side.
    expect(refusal({ recommendation: 'sell' })).toMatch(/not above the entry range/)
  })

  it('refuses a level a rounding error from the entry, or half the price away', () => {
    expect(refusal({ stopLoss: 99.79 })).toMatch(/stop .* not a usable distance/)
    expect(refusal({ stopLoss: 40 })).toMatch(/stop .* not a usable distance/)
    expect(refusal({ takeProfit: 100.21 })).toMatch(/target .* not a usable distance/)
    expect(refusal({ takeProfit: 160 })).toMatch(/target .* not a usable distance/)
  })

  it('refuses a clock, a horizon, a regime or a reason outside its closed list', () => {
    expect(refusal({ validMinutes: 10 })).toMatch(/validMinutes/)
    expect(refusal({ validMinutes: null })).toMatch(/validMinutes/)
    expect(refusal({ horizonBars: 2 })).toMatch(/horizonBars/)
    expect(refusal({ marketRegime: 'sideways' })).toMatch(/marketRegime/)
    expect(refusal({ riskLevel: 'extreme' })).toMatch(/riskLevel/)
    expect(refusal({ reasonCodes: ['vibes'] })).toMatch(/reasonCodes/)
    expect(refusal({ confidence: 1.4 })).toMatch(/recommendation, confidence or rationale/)
    expect(refusal({ recommendation: 'no_trade' })).toMatch(/recommendation, confidence or rationale/)
    // Even a call not to trade has to name a validity the schema allows: the field is required.
    expect(refusal({ ...NO_TRADE, validMinutes: 7 })).toMatch(/validMinutes/)
    for (const minutes of AI_VALID_MINUTES) expect(detail({ validMinutes: minutes }).entry?.validMinutes).toBe(minutes)
  })

  it('cannot check levels against no price', () => {
    const verdict = validateOpportunityAnswer(answer(), 0)
    expect(verdict.ok).toBe(false)
  })

  it('keeps each reason code once, and five at most', () => {
    const codes = ['breakout', 'breakout', 'trend_up', 'momentum_up', 'volume_confirms', 'timeframes_agree', 'high_volatility']
    expect(detail({ reasonCodes: codes }).reasonCodes).toEqual(['breakout', 'trend_up', 'momentum_up', 'volume_confirms', 'timeframes_agree'])
  })
})

function decision(overrides: Record<string, unknown> = {}, more: Partial<AiSignalDecision> = {}): AiSignalDecision {
  const raw = answer(overrides)
  const verdict = validateOpportunityAnswer(raw, PRICE)
  if (!verdict.ok) throw new Error(verdict.reason)
  return { candleTime: 1000, ...verdict.signal, model: 'a/model', cached: false, error: null, rejected: null, detail: verdict.detail, ...more }
}

describe('reading a recommendation', () => {
  it('names the side a usable answer takes', () => {
    expect(opportunitySide(decision())).toBe('long')
    expect(opportunitySide(decision(SHORT))).toBe('short')
    expect(opportunitySide(decision(NO_TRADE))).toBeNull()
    expect(opportunitySide(decision({}, { rejected: 'refused' }))).toBeNull()
    expect(opportunitySide(decision({}, { error: 'not reached' }))).toBeNull()
    expect(opportunitySide(null)).toBeNull()
    // A signal's buy, from before answers carried an entry range, is not an opportunity.
    expect(opportunitySide(decision({}, { detail: { ...(decision().detail as AiSignalDetail), entry: undefined } }))).toBeNull()
  })

  it('acts on a side only at the confidence this app acts on anywhere', () => {
    expect(isActionableOpportunity(decision({ confidence: 0.65 }))).toBe(true)
    expect(isActionableOpportunity(decision({ confidence: 0.64 }))).toBe(false)
    expect(isActionableOpportunity(decision({ ...NO_TRADE, confidence: 0.9 }))).toBe(false)
  })

  it('stamps the clock from the event, not from the model', () => {
    const window = opportunityWindow(1_000_000, decision({ validMinutes: 30, horizonBars: 16 }).detail)
    expect(window).toEqual({ validFrom: 1_000_000, expiresAt: 1_000_000 + 30 * 60, holdSeconds: 16 * 900 })
    expect(opportunityWindow(1_000_000, decision(NO_TRADE).detail)).toBeNull()
  })

  it('expires when its minutes are up, and never was valid without an entry', () => {
    const made = decision({ validMinutes: 15 }).detail
    expect(isOpportunityExpired(1000, made, 1000 + 899)).toBe(false)
    expect(isOpportunityExpired(1000, made, 1000 + 900)).toBe(true)
    expect(isOpportunityExpired(1000, decision(NO_TRADE).detail, 1000)).toBe(true)
    expect(isOpportunityExpired(1000, null, 1000)).toBe(true)
  })
})

describe('opportunityConsensus', () => {
  it('counts each kind of answer', () => {
    const consensus = opportunityConsensus([decision(), decision(), decision(NO_TRADE), decision({}, { rejected: 'bad shape' }), decision({}, { error: 'down' }), null])
    expect(consensus).toMatchObject({ answered: 4, refused: 1, long: 2, short: 0, noTrade: 1, disagreement: false, call: 'long' })
    expect(consensus.agreementPct).toBeCloseTo((2 / 3) * 100, 6)
  })

  it('calls a side only when more than half take it', () => {
    expect(opportunityConsensus([decision(), decision(NO_TRADE)]).call).toBe('no_trade')
    expect(opportunityConsensus([decision(SHORT), decision(SHORT), decision(NO_TRADE)]).call).toBe('short')
    expect(opportunityConsensus([decision(NO_TRADE), decision(NO_TRADE)]).call).toBe('no_trade')
  })

  it('calls no trade when models take opposite sides, however many are on one of them', () => {
    const split = opportunityConsensus([decision(), decision(), decision(), decision(SHORT)])
    expect(split.disagreement).toBe(true)
    expect(split.call).toBe('no_trade')
  })

  it('has nothing to say before anyone has answered usably', () => {
    expect(opportunityConsensus([null, decision({}, { error: 'down' })])).toMatchObject({ answered: 0, call: null, agreementPct: null })
    expect(opportunityConsensus([decision({}, { rejected: 'bad shape' })])).toMatchObject({ answered: 1, refused: 1, call: null })
    // One model cannot agree with itself.
    expect(opportunityConsensus([decision()]).agreementPct).toBeNull()
    expect(opportunityConsensus([decision()]).call).toBe('long')
  })
})
