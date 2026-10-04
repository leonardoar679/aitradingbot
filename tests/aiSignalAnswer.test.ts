import { describe, expect, it } from 'vitest'
import { AI_MAX_REASON_CODES, describeUnusableAiKey, isAiModelSlug, validateAiAnswer } from '../shared/aiSignal'

// The validator, not the schema, is what stands between a model's answer and a trade. The request
// asks for a strict schema, but that schema carries types and enums only, and a provider can still
// return something else. Everything below is checked locally for that reason.

const PRICE = 100

function answer(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    recommendation: 'buy',
    confidence: 0.8,
    marketRegime: 'bull',
    riskLevel: 'medium',
    horizonBars: 16,
    stopLoss: 97,
    takeProfit: 106,
    reasonCodes: ['trend_up', 'breakout'],
    rationale: 'trend and breakout agree',
    ...overrides
  }
}

describe('validateAiAnswer', () => {
  it('accepts a well-formed answer and carries every field through', () => {
    const verdict = validateAiAnswer(answer(), PRICE)
    expect(verdict).toEqual({
      ok: true,
      signal: { recommendation: 'buy', confidence: 0.8, rationale: 'trend and breakout agree' },
      detail: {
        marketRegime: 'bull',
        riskLevel: 'medium',
        horizonBars: 16,
        stopLoss: 97,
        takeProfit: 106,
        reasonCodes: ['trend_up', 'breakout'],
        levelsNote: null
      }
    })
  })

  // A malformed field refuses the whole answer. It never degrades into a partial signal: an answer
  // with an unreadable field is one the model did not really give.
  it.each([
    ['an unknown recommendation', { recommendation: 'strong_buy' }],
    ['a confidence above 1', { confidence: 1.2 }],
    ['a confidence that is not a number', { confidence: '0.8' }],
    ['an unknown regime', { marketRegime: 'sideways' }],
    ['an unknown risk level', { riskLevel: 'extreme' }],
    ['a horizon outside the allowed set', { horizonBars: 12 }],
    ['a negative stop', { stopLoss: -1 }],
    ['a non-finite target', { takeProfit: Number.POSITIVE_INFINITY }],
    ['a reason outside the vocabulary', { reasonCodes: ['trend_up', 'vibes'] }],
    ['reasons that are not a list', { reasonCodes: 'trend_up' }],
    ['a missing field', { marketRegime: undefined }]
  ])('refuses %s', (_label, override) => {
    const verdict = validateAiAnswer(answer(override), PRICE)
    expect(verdict.ok).toBe(false)
  })

  it('refuses something that is not an object at all', () => {
    expect(validateAiAnswer('buy', PRICE).ok).toBe(false)
    expect(validateAiAnswer(null, PRICE).ok).toBe(false)
    expect(validateAiAnswer([answer()], PRICE).ok).toBe(false)
  })

  // Levels that are well formed but make no sense for the action are discarded, and the ACTION
  // stands. Nothing in the app executes on a model-proposed level, so refusing a coherent buy over
  // them would throw away the part that is used. The note is what makes the discard visible.
  describe('levels that contradict the action', () => {
    it('drops both levels when a buy places its stop at or above the price', () => {
      for (const stopLoss of [PRICE, 104]) {
        const verdict = validateAiAnswer(answer({ stopLoss }), PRICE)
        if (!verdict.ok) throw new Error('expected a usable answer')
        expect(verdict.signal.recommendation).toBe('buy')
        expect(verdict.detail.stopLoss).toBeNull()
        expect(verdict.detail.takeProfit).toBeNull()
        expect(verdict.detail.levelsNote).toContain('not below the price')
      }
    })

    it('drops both levels when a buy places its target at or below the price', () => {
      const verdict = validateAiAnswer(answer({ takeProfit: 99 }), PRICE)
      if (!verdict.ok) throw new Error('expected a usable answer')
      expect(verdict.detail.stopLoss).toBeNull()
      expect(verdict.detail.takeProfit).toBeNull()
      expect(verdict.detail.levelsNote).toContain('not above the price')
    })

    it('ignores levels on a sell or a hold, and says so only when some were given', () => {
      const sell = validateAiAnswer(answer({ recommendation: 'sell' }), PRICE)
      if (!sell.ok) throw new Error('expected a usable answer')
      expect(sell.detail.stopLoss).toBeNull()
      expect(sell.detail.levelsNote).toContain('only a buy')

      const hold = validateAiAnswer(answer({ recommendation: 'hold', stopLoss: null, takeProfit: null }), PRICE)
      if (!hold.ok) throw new Error('expected a usable answer')
      expect(hold.detail.levelsNote).toBeNull()
    })

    it('accepts a buy that names no levels', () => {
      const verdict = validateAiAnswer(answer({ stopLoss: null, takeProfit: null }), PRICE)
      if (!verdict.ok) throw new Error('expected a usable answer')
      expect(verdict.detail.levelsNote).toBeNull()
    })
  })

  it('counts each reason once and keeps at most the limit', () => {
    const codes = ['trend_up', 'trend_up', 'breakout', 'momentum_up', 'volume_confirms', 'timeframes_agree', 'low_volatility']
    const verdict = validateAiAnswer(answer({ reasonCodes: codes }), PRICE)
    if (!verdict.ok) throw new Error('expected a usable answer')
    expect(verdict.detail.reasonCodes).toHaveLength(AI_MAX_REASON_CODES)
    expect(new Set(verdict.detail.reasonCodes).size).toBe(AI_MAX_REASON_CODES)
    expect(verdict.detail.reasonCodes[0]).toBe('trend_up')
  })

  it('bounds the rationale rather than trusting the model to', () => {
    const verdict = validateAiAnswer(answer({ rationale: 'x'.repeat(5000) }), PRICE)
    if (!verdict.ok) throw new Error('expected a usable answer')
    expect(verdict.signal.rationale).toHaveLength(500)
  })
})

describe('isAiModelSlug', () => {
  it('accepts OpenRouter ids, including a variant suffix', () => {
    expect(isAiModelSlug('openai/gpt-5-mini')).toBe(true)
    expect(isAiModelSlug('anthropic/claude-sonnet-4.5')).toBe(true)
    expect(isAiModelSlug('meta-llama/llama-3.3-70b-instruct:free')).toBe(true)
  })

  it('refuses anything that could not be a model id', () => {
    expect(isAiModelSlug('')).toBe(false)
    expect(isAiModelSlug('gpt 5')).toBe(false)
    expect(isAiModelSlug('a/b?x=1')).toBe(false)
    expect(isAiModelSlug('x'.repeat(101))).toBe(false)
  })
})

describe('describeUnusableAiKey', () => {
  it('lets through what could be an OpenRouter key, with the spaces a paste brings', () => {
    expect(describeUnusableAiKey('sk-or-v1-0123456789abcdef')).toBeNull()
    expect(describeUnusableAiKey('  sk-or-v1-0123456789abcdef\n')).toBeNull()
  })

  it('refuses some other secret before it can be sent anywhere to be checked', () => {
    // A key is verified by posting it to OpenRouter. An OpenAI key or an exchange key pasted into
    // the wrong field must be stopped here, not found to be wrong by the service it was sent to.
    expect(describeUnusableAiKey('sk-proj-0123456789abcdef')).toMatch(/does not look like/)
    expect(describeUnusableAiKey('A1b2'.repeat(16))).toMatch(/does not look like/)
    expect(describeUnusableAiKey('SK-OR-v1-0123456789abcdef')).toMatch(/does not look like/)
  })

  it('refuses nothing at all, and two things pasted as one', () => {
    expect(describeUnusableAiKey('   ')).toMatch(/required/)
    expect(describeUnusableAiKey('sk-or-v1-0123 sk-or-v1-4567')).toMatch(/space or a line break/)
  })
})
