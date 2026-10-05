import { describe, expect, it } from 'vitest'
import { averageCallLatencyMs, describeAiBenchmarkCost, describeAiRunCost, describeDuration } from '../shared/aiCost'
import type { AiCallRecord } from '../shared/aiLedger'
import type { AiSignalEstimate } from '../shared/aiSignal'

// HOW LONG A PAID RUN TAKES, SAID BEFORE IT STARTS.
//
// The first real call took thirteen seconds. A tape asks one question at a time, so a full
// backtest of 672 decisions is two and a half hours -- and its confirmation stated two dollars and
// nothing else. Against a faked transport every call had taken twenty milliseconds, so nothing
// had ever shown it.

function call(status: AiCallRecord['status'], latencyMs: number): AiCallRecord {
  return { status, usage: { promptTokens: 0, completionTokens: 0, costUsd: 0.003, latencyMs } } as AiCallRecord
}

function estimate(overrides: Partial<AiSignalEstimate> = {}): AiSignalEstimate {
  return {
    total: 672,
    cached: 0,
    maximumApiCalls: 672,
    model: 'openai/gpt-5-mini',
    perCallCostUsd: 0.003,
    estimatedCostUsd: 2.016,
    costBasis: 'history',
    perCallLatencyMs: 13_000,
    budgetRemainingUsd: 1,
    ...overrides
  }
}

describe('the pace a model has answered at', () => {
  it('is the average of its answered calls, refused answers included', () => {
    expect(averageCallLatencyMs([call('ok', 12_000), call('rejected', 14_000)])).toBe(13_000)
  })

  it('leaves out a call that failed, and one that reports no time', () => {
    // A failure's time is how long it took to fail. Counted, a model that is down looks fast.
    expect(averageCallLatencyMs([call('ok', 10_000), call('failed', 60_000), call('ok', 0)])).toBe(10_000)
    expect(averageCallLatencyMs([call('failed', 500)])).toBeNull()
    expect(averageCallLatencyMs([])).toBeNull()
  })
})

describe('describeDuration', () => {
  it('says seconds, minutes, then hours and minutes, no finer than the figure deserves', () => {
    expect(describeDuration(400)).toBe('about 1 second')
    expect(describeDuration(13_000)).toBe('about 13 seconds')
    expect(describeDuration(89_000)).toBe('about 89 seconds')
    expect(describeDuration(90_000)).toBe('about 2 minutes')
    expect(describeDuration(12 * 60_000)).toBe('about 12 minutes')
    expect(describeDuration(89 * 60_000)).toBe('about 89 minutes')
    expect(describeDuration(90 * 60_000)).toBe('about 1 hour 30 minutes')
    expect(describeDuration(672 * 13_000)).toBe('about 2 hours 25 minutes')
    // 119.9 minutes rounds to two hours, not to "1 hour 60 minutes".
    expect(describeDuration(119.9 * 60_000)).toBe('about 2 hours')
  })
})

describe('what a run is agreed to', () => {
  it('states the time beside the price: one call after another', () => {
    const text = describeAiRunCost(estimate())
    expect(text).toContain('about $2.02')
    expect(text).toContain('One call after another, that is about 2 hours 25 minutes: it has been taking 13 seconds a call here.')
    expect(text).toContain('It can be cancelled, and what has been answered stays cached.')
  })

  it('says the time is not known for a model that has never been called here', () => {
    // There is a price list to estimate a cost from. There is no such thing for time.
    for (const perCallLatencyMs of [null, undefined]) {
      const text = describeAiRunCost(estimate({ perCallLatencyMs, costBasis: 'pricing' }))
      expect(text).toContain('How long that takes is not known: this model has not been called here yet.')
      expect(text).not.toContain('a call here')
    }
  })

  it('says a pace in whole seconds, and does not print a fast one as zero', () => {
    expect(describeAiRunCost(estimate({ perCallLatencyMs: 1_200 }))).toContain('it has been taking 1 second a call here')
    expect(describeAiRunCost(estimate({ perCallLatencyMs: 300 }))).toContain('it has been taking under a second a call here')
  })

  it('says nothing about time when every decision is cached', () => {
    const text = describeAiRunCost(estimate({ cached: 672, maximumApiCalls: 0, estimatedCostUsd: 0 }))
    expect(text).not.toMatch(/One call after another|How long/)
  })

  it('adds up both models of a route, as the ceiling it is', () => {
    const routed = estimate({
      total: 100,
      maximumApiCalls: 200,
      estimatedCostUsd: 1.3,
      route: { model: 'acme/frontier', when: 'acting', maximumApiCalls: 100, perCallCostUsd: 0.01, costBasis: 'history', perCallLatencyMs: 20_000 }
    })
    // 100 calls at 13 s and 100 at 20 s: 55 minutes.
    expect(describeAiRunCost(routed)).toContain('One call after another, that is up to about 55 minutes at the pace the two have answered here.')

    const untimed = { ...routed, route: { ...routed.route!, perCallLatencyMs: null } }
    expect(describeAiRunCost(untimed)).toContain('How long that takes is not known: one of the two has not been called here yet.')
  })
})

describe('what a benchmark is agreed to', () => {
  const model = (overrides: Record<string, unknown> = {}) => ({
    model: 'openai/gpt-5-mini',
    cached: 0,
    toAsk: 180,
    perCallCostUsd: 0.0033,
    costBasis: 'history' as const,
    perCallLatencyMs: 14_000,
    ...overrides
  })
  // Null leaves it out. Not `undefined`: that would just select the default.
  const input = (models: ReturnType<typeof model>[], concurrency: number | null = 4) => ({
    symbol: 'BTCUSDT',
    decisions: 180,
    models,
    budgetRemainingUsd: 1,
    ...(concurrency !== null ? { concurrency } : {})
  })

  it('divides the calls by how many are in the air at once', () => {
    // 180 calls of 14 seconds, four at a time: ten and a half minutes.
    expect(describeAiBenchmarkCost(input([model()]))).toContain('Asking 4 at a time, that is about 11 minutes at the pace it has answered here.')
  })

  it('counts a panel as the four calls each answer takes, and adds the models up', () => {
    const text = describeAiBenchmarkCost(input([model(), model({ model: 'panel:openai/gpt-5-mini', callsPerAnswer: 4, perCallLatencyMs: 10_000 })]))
    // 180 x 14 s plus 720 x 10 s, over four: 40.5 minutes.
    expect(text).toContain('Asking 4 at a time, that is about 41 minutes at the pace they have answered here.')
  })

  it('does not guess for a model that has never been called here', () => {
    const text = describeAiBenchmarkCost(input([model(), model({ model: 'acme/new', perCallLatencyMs: null })]))
    expect(text).toContain('How long that takes is not known: a model that has not been called here has no pace to go by.')
    expect(text).not.toContain('Asking 4 at a time')
  })

  it('leaves time out when nothing is to be asked, and when it is not told how many are asked at once', () => {
    expect(describeAiBenchmarkCost(input([model({ cached: 180, toAsk: 0 })]))).not.toMatch(/at a time|How long/)
    expect(describeAiBenchmarkCost(input([model()], null))).not.toMatch(/at a time|How long/)
  })

  it('only needs a pace from the models it would actually ask', () => {
    const text = describeAiBenchmarkCost(input([model(), model({ model: 'acme/cached', cached: 180, toAsk: 0, perCallLatencyMs: null })]))
    expect(text).toContain('Asking 4 at a time, that is about 11 minutes at the pace it has answered here.')
  })

  it('never says a run takes less than the most calls a minute to one model allows', () => {
    // A fast model: 180 calls of 2 seconds, four at a time, is a minute and a half -- but at
    // thirty a minute the last of them cannot start until five minutes in.
    const fast = model({ perCallLatencyMs: 2000 })
    expect(describeAiBenchmarkCost(input([fast]))).toContain('Asking 4 at a time, that is about 2 minutes')
    expect(describeAiBenchmarkCost({ ...input([fast]), callsPerMinute: 30 })).toContain(
      'Asking 4 at a time and no model more than 30 times a minute, that is about 5 minutes at the pace it has answered here.'
    )
    // Where the calls themselves take longer than the pace, the pace changes nothing but the words.
    expect(describeAiBenchmarkCost({ ...input([model()]), callsPerMinute: 60 })).toContain('no model more than 60 times a minute, that is about 11 minutes')
    // And a model never called here still has the pace's floor stated.
    expect(describeAiBenchmarkCost({ ...input([model({ perCallLatencyMs: null })]), callsPerMinute: 30 })).toContain(
      'At no more than 30 calls a minute to one model it takes about 5 minutes at the least.'
    )
  })

  it('counts the pace per model: two models are asked at the same time', () => {
    // 100 calls each to two fast models at thirty a minute: each takes three minutes, side by side.
    const two = [model({ toAsk: 100, perCallLatencyMs: 1000 }), model({ model: 'acme/other', toAsk: 100, perCallLatencyMs: 1000 })]
    expect(describeAiBenchmarkCost({ ...input(two), callsPerMinute: 30 })).toContain('that is about 3 minutes')
  })
})
