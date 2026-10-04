import { describe, expect, it } from 'vitest'
import {
  AI_CONFIRM_MAX_DECISIONS,
  AI_CONFIRM_PROMPT_VERSION,
  AI_CONFIRM_SETTLE_SECONDS,
  isBarSettled,
  isEntryConfirmed,
  parseStrategyBlock
} from '../shared/aiConfirm'
import { AI_CONTEXT_VERSION, aiContextJson, aiPromptVersion, buildAiContext } from '../shared/aiContext'
import { describeAiConfirmCost } from '../shared/aiCost'
import { GPT_LOOKBACK_BARS, GPT_MAX_DECISIONS, GPT_MIN_CONFIDENCE, GPT_PROMPT_VERSION, type AiSignalDecision } from '../shared/aiSignal'
import type { Candle } from '../shared/ipc'

function decision(over: Partial<AiSignalDecision>): AiSignalDecision {
  return { candleTime: 0, recommendation: 'buy', confidence: 0.9, rationale: '', model: 'm', cached: false, error: null, ...over }
}

describe('isEntryConfirmed', () => {
  it('lets an entry through only on a confident buy that was actually given', () => {
    expect(isEntryConfirmed(decision({}))).toBe(true)
    expect(isEntryConfirmed(decision({ confidence: GPT_MIN_CONFIDENCE }))).toBe(true)
  })

  // Every other answer leaves the account flat. Each of these is a way of not having been told
  // "yes", and a rule that let any of them through would be a rule that buys on a shrug.
  it.each([
    ['a buy just under the gate', decision({ confidence: GPT_MIN_CONFIDENCE - 0.001 })],
    ['a hold, however confident', decision({ recommendation: 'hold', confidence: 1 })],
    ['a sell', decision({ recommendation: 'sell', confidence: 1 })],
    ['a call that never reached a model', decision({ error: 'timeout' })],
    ['an answer the validator refused', decision({ rejected: 'not valid JSON' })]
  ])('refuses %s', (_label, value) => {
    expect(isEntryConfirmed(value)).toBe(false)
  })

  it('refuses when there is no answer at all', () => {
    expect(isEntryConfirmed(null)).toBe(false)
    expect(isEntryConfirmed(undefined)).toBe(false)
  })
})

describe('isBarSettled', () => {
  const open = 1_700_000_000

  it('waits for the bar to close, and a few seconds more', () => {
    const closes = open + 4 * 3600
    expect(isBarSettled(open, '4h', closes - 1)).toBe(false)
    expect(isBarSettled(open, '4h', closes)).toBe(false)
    expect(isBarSettled(open, '4h', closes + AI_CONFIRM_SETTLE_SECONDS - 1)).toBe(false)
    expect(isBarSettled(open, '4h', closes + AI_CONFIRM_SETTLE_SECONDS)).toBe(true)
  })

  it('measures the bar by its own interval', () => {
    expect(isBarSettled(open, '15m', open + 900 + AI_CONFIRM_SETTLE_SECONDS)).toBe(true)
    expect(isBarSettled(open, '1h', open + 900 + AI_CONFIRM_SETTLE_SECONDS)).toBe(false)
  })
})

describe('parseStrategyBlock', () => {
  const block = {
    id: 'short-term-channel',
    name: 'Short-Term Channel Breakout',
    rule: 'Buys near the top of its recent ranges.',
    stopDistancePct: 50,
    readings: [
      { label: 'mean position', value: 0.972 },
      { label: 'vote', value: '4 of 4' }
    ]
  }

  it('returns a usable block field for field', () => {
    expect(parseStrategyBlock(block)).toEqual(block)
  })

  it('accepts a block with no stop and no readings', () => {
    expect(parseStrategyBlock({ ...block, stopDistancePct: null, readings: [] })).toMatchObject({ stopDistancePct: null, readings: [] })
    expect(parseStrategyBlock({ ...block, stopDistancePct: 0 }).stopDistancePct).toBe(0)
  })

  it('serialises the same whatever order its fields arrived in', () => {
    const shuffled = { readings: block.readings, rule: block.rule, stopDistancePct: 50, name: block.name, id: block.id }
    expect(JSON.stringify(parseStrategyBlock(shuffled))).toBe(JSON.stringify(parseStrategyBlock(block)))
  })

  it.each([
    ['an array', []],
    ['a blank name', { ...block, name: '   ' }],
    ['a name that is too long', { ...block, name: 'n'.repeat(81) }],
    ['an upper-case id', { ...block, id: 'Trend' }],
    ['a negative stop distance', { ...block, stopDistancePct: -1 }],
    ['a stop distance over 100%', { ...block, stopDistancePct: 101 }],
    ['readings that are not a list', { ...block, readings: 'none' }],
    ['a reading with no label', { ...block, readings: [{ value: 1 }] }],
    ['a reading that is not finite', { ...block, readings: [{ label: 'x', value: Number.NaN }] }],
    ['a reading whose text runs on', { ...block, readings: [{ label: 'x', value: 'y'.repeat(81) }] }]
  ])('refuses %s', (_label, value) => {
    expect(() => parseStrategyBlock(value)).toThrow()
  })
})

describe('the context of a review', () => {
  const candles: Candle[] = Array.from({ length: GPT_LOOKBACK_BARS }, (_, i) => ({
    time: 1_699_992_000 + i * 900,
    open: 100 + Math.sin(i / 9),
    high: 101.5 + Math.sin(i / 9),
    low: 98.5 + Math.sin(i / 9),
    close: 100 + Math.sin((i + 1) / 9),
    volume: 50 + (i % 7)
  }))
  const meta = { exchange: 'binance' as const, symbol: 'BTCUSDT', interval: '15m' as const, position: 'flat' as const }
  const strategy = parseStrategyBlock({ id: 'probe', name: 'Probe', rule: 'A rule.', stopDistancePct: 2, readings: [] })

  it('names the strategy last, and is asked under the review prompt', () => {
    const context = buildAiContext(candles, GPT_LOOKBACK_BARS, { ...meta, strategy })!
    expect(context.strategy).toEqual(strategy)
    expect(Object.keys(context).pop()).toBe('strategy')
    expect(context.version).toBe(AI_CONTEXT_VERSION)
    expect(aiPromptVersion(context)).toBe(AI_CONFIRM_PROMPT_VERSION)
  })

  // The standalone signal's cache must survive this feature. Its context has to serialise to the
  // bytes it always did -- no `strategy: null`, no `strategy: undefined` turned into a key.
  it('leaves a standalone context exactly as it was', () => {
    const plain = buildAiContext(candles, GPT_LOOKBACK_BARS, meta)!
    expect(plain).not.toHaveProperty('strategy')
    expect(aiContextJson(plain)).not.toContain('strategy')
    expect(aiPromptVersion(plain)).toBe(GPT_PROMPT_VERSION)

    const reviewed = buildAiContext(candles, GPT_LOOKBACK_BARS, { ...meta, strategy })!
    const { strategy: _dropped, ...rest } = reviewed
    expect(JSON.stringify(rest)).toBe(aiContextJson(plain))
  })

  it('uses two different prompt versions, so the two can never share a cache entry', () => {
    expect(AI_CONFIRM_PROMPT_VERSION).not.toBe(GPT_PROMPT_VERSION)
  })
})

describe('describeAiConfirmCost', () => {
  const input = {
    strategyName: 'Trend Regime Ensemble',
    model: 'openai/gpt-5-mini',
    cached: 3,
    openQuestions: 5,
    perCallCostUsd: 0.0031,
    costBasis: 'history' as const,
    budgetRemainingUsd: 0.9
  }

  it('names the strategy, the model, the biller, the count, a figure and what is left', () => {
    const text = describeAiConfirmCost(input)
    expect(text).toContain('Trend Regime Ensemble will ask openai/gpt-5-mini through OpenRouter')
    expect(text).toContain('3 reviews are already cached')
    expect(text).toContain('About 5 model calls are expected')
    expect(text).toContain('about $0.0155')
    expect(text).toContain("this model's recent reviews here")
    expect(text).toContain('$0.90')
    expect(text.endsWith('Continue?')).toBe(true)
  })

  it('says a model is asked once per trade, and names the ceiling a run cannot pass', () => {
    const text = describeAiConfirmCost(input)
    expect(text).toContain('each trade it would take, once per trade')
    expect(text).toContain(`never reviews more than ${AI_CONFIRM_MAX_DECISIONS} entries`)
    expect(AI_CONFIRM_MAX_DECISIONS).toBe(GPT_MAX_DECISIONS)
  })

  it('says when a price is a guess from a price list, and never invents one', () => {
    expect(describeAiConfirmCost({ ...input, costBasis: 'pricing' })).toContain('going by its price list, an estimate')
    const unknown = describeAiConfirmCost({ ...input, perCallCostUsd: null, costBasis: 'unknown' })
    expect(unknown).toContain('What they will cost is not known')
    expect(unknown).not.toMatch(/That is about \$/)
  })

  it('reads properly for one of each', () => {
    const text = describeAiConfirmCost({ ...input, cached: 1, openQuestions: 1 })
    expect(text).toContain('1 review is already cached')
    expect(text).toContain('About 1 model call is expected')
  })
})
