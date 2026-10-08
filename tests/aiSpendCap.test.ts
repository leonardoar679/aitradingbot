import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { averageCallCostUsd, budgetProblem, describeAiRunCost, estimateCallCostUsd, formatUsd } from '../shared/aiCost'
import type { AiCallRecord } from '../shared/aiLedger'
import { DEFAULT_AI_DAILY_CAP_USD, DEFAULT_AI_MODEL } from '../shared/aiSignal'

vi.mock('electron', () => ({ app: { getPath: () => process.env.AI_TEST_USER_DATA } }))
vi.mock('../electron/services/aiCredentialsService', () => ({
  getDecryptedAiCredential: async () => {
    throw new Error('no key in this test')
  }
}))

describe('budgetProblem', () => {
  it('allows a call while there is budget left', () => {
    expect(budgetProblem(1, 0)).toBeNull()
    expect(budgetProblem(1, 0.99)).toBeNull()
  })

  it('stops at the budget, and says nothing generated is lost', () => {
    expect(budgetProblem(1, 1)).toContain('used up')
    expect(budgetProblem(1, 3)).toContain('cached')
  })

  it('reads a budget of zero as switched off rather than as spent', () => {
    expect(budgetProblem(0, 0)).toContain('switched off')
  })

  it('fails closed on a budget that is not a number', () => {
    // NaN compares false against everything. Written as `spent >= cap` this would allow every
    // call, forever, which is the wrong direction for a spending limit to fail in.
    expect(budgetProblem(Number.NaN, 0)).not.toBeNull()
  })
})

describe('cost estimates', () => {
  it('prices a call from the price list when the model has never been called', () => {
    const cost = estimateCallCostUsd({ promptPricePerToken: 0.00000025, completionPricePerToken: 0.000002 }, 5000)
    // 5000 characters at 2.5 per token is 2000 prompt tokens, plus 1200 assumed for the answer.
    expect(cost).toBeCloseTo(2000 * 0.00000025 + 1200 * 0.000002, 12)
  })

  it('declines to guess when a model publishes no price', () => {
    expect(estimateCallCostUsd({ promptPricePerToken: null, completionPricePerToken: 0.000002 }, 5000)).toBeNull()
  })

  it('averages what answered calls cost and ignores the ones that failed', () => {
    const call = (status: AiCallRecord['status'], costUsd: number | null): AiCallRecord =>
      ({ status, usage: { promptTokens: 0, completionTokens: 0, costUsd, latencyMs: 0 } }) as AiCallRecord
    expect(averageCallCostUsd([call('ok', 0.002), call('rejected', 0.004), call('failed', null)])).toBeCloseTo(0.003, 12)
    expect(averageCallCostUsd([call('failed', null)])).toBeNull()
    expect(averageCallCostUsd([])).toBeNull()
  })

  it('never rounds a real cost down to nothing', () => {
    expect(formatUsd(0)).toBe('$0.00')
    expect(formatUsd(0.0021)).toBe('$0.0021')
    expect(formatUsd(0.00003)).toBe('<$0.0001')
    expect(formatUsd(1.4)).toBe('$1.40')
  })

  it('keeps the precision a per-call cost needs, without trailing zeros', () => {
    // Seen in the running app: a $0.0113 call printed as "$0.01", and a $0.0149 one would have too.
    expect(formatUsd(0.0113)).toBe('$0.0113')
    expect(formatUsd(0.0149)).toBe('$0.0149')
    expect(formatUsd(0.05)).toBe('$0.05')
    expect(formatUsd(0.012)).toBe('$0.012')
    expect(formatUsd(0.384)).toBe('$0.38')
    expect(formatUsd(0.1)).toBe('$0.10')
  })
})

describe('describeAiRunCost', () => {
  const estimate = {
    total: 672,
    cached: 480,
    maximumApiCalls: 192,
    model: 'openai/gpt-5-mini',
    perCallCostUsd: 0.002,
    estimatedCostUsd: 0.384,
    costBasis: 'history' as const,
    budgetRemainingUsd: 0.82
  }

  it('states the model, the count, the money, where the figure came from and the budget', () => {
    const text = describeAiRunCost(estimate)
    expect(text).toContain('672 candles')
    expect(text).toContain('openai/gpt-5-mini')
    expect(text).toContain('480 are confirmed cached')
    expect(text).toContain('192 model calls')
    expect(text).toContain('$0.38')
    expect(text).toContain('recent calls')
    expect(text).toContain('$0.82')
  })

  it('marks a price-list figure as the estimate it is', () => {
    expect(describeAiRunCost({ ...estimate, costBasis: 'pricing' })).toContain('an estimate')
  })

  it('says the cost is not known rather than printing a number it does not have', () => {
    const text = describeAiRunCost({ ...estimate, perCallCostUsd: null, estimatedCostUsd: null, costBasis: 'unknown' })
    expect(text).toContain('not known')
    expect(text).not.toMatch(/about \$/)
  })

  it('says so plainly when everything is cached', () => {
    expect(describeAiRunCost({ ...estimate, cached: 672, maximumApiCalls: 0, estimatedCostUsd: 0 })).toContain('nothing will be spent')
  })
})

describe('the budget in the main process', () => {
  let dir: string

  async function config() {
    return import('../electron/services/aiConfigService')
  }

  beforeEach(() => {
    vi.resetModules()
    dir = mkdtempSync(join(tmpdir(), 'ai-config-'))
    process.env.AI_TEST_USER_DATA = dir
  })

  afterEach(() => vi.useRealTimers())

  it('starts from the defaults when nothing has been saved', async () => {
    const { getAiConfig } = await config()
    expect(await getAiConfig()).toEqual({
      defaultModel: DEFAULT_AI_MODEL,
      enabledModels: [DEFAULT_AI_MODEL],
      // One model decides alone until a route is set, and setting one is always somebody's choice.
      route: null,
      dailyCapUsd: DEFAULT_AI_DAILY_CAP_USD,
      spentTodayUsd: 0,
      // Nothing asks a model without a click until the watch is switched on.
      watch: { enabled: false, models: [], maxEventsPerDay: 10, minBand: 'urgent', firstModelGates: false, confirmLive: false },
      // And nothing opens a position without one, paper or otherwise, until that is switched on too.
      watchPaper: { enabled: false, model: null, stakeQuote: 100, maxOpen: 3, maxSameSide: 2, pauseAfterLosses: 3, dropOnBtcMovePct: 1 },
      callsPerMinute: 30,
      // The AI additions are on, as the user chose on 6 October 2026; the ones that ask by themselves
      // still wait for the watch, which is off.
      additions: { news: true, why: true, exit: true, review: true, daily: true }
    })
  })

  it('heals a saved file holding values that could not gate anything', async () => {
    writeFileSync(join(dir, 'aiConfig.json'), JSON.stringify({ defaultModel: 'not a model', enabledModels: 'x', dailyCapUsd: 'lots' }))
    const { getAiConfig, assertAiBudget } = await config()
    expect(await getAiConfig()).toMatchObject({ defaultModel: DEFAULT_AI_MODEL, dailyCapUsd: DEFAULT_AI_DAILY_CAP_USD })
    await expect(assertAiBudget()).resolves.toBeUndefined()
  })

  it('refuses a call once today has spent the budget', async () => {
    const { assertAiBudget, recordAiSpend, setAiConfig, budgetRemainingUsd, AiBudgetError } = await config()
    await setAiConfig({ dailyCapUsd: 0.5 })
    await recordAiSpend(0.3)
    await expect(assertAiBudget()).resolves.toBeUndefined()
    expect(await budgetRemainingUsd()).toBeCloseTo(0.2, 10)
    await recordAiSpend(0.3)
    await expect(assertAiBudget()).rejects.toBeInstanceOf(AiBudgetError)
    expect(await budgetRemainingUsd()).toBe(0)
  })

  it('survives a restart: what was spent is on disk, not in memory', async () => {
    const first = await config()
    await first.setAiConfig({ dailyCapUsd: 0.5 })
    await first.recordAiSpend(0.6)
    vi.resetModules()
    const second = await config()
    expect((await second.getAiConfig()).spentTodayUsd).toBeCloseTo(0.6, 10)
    await expect(second.assertAiBudget()).rejects.toThrow(/used up/)
  })

  it('starts again at the next UTC day', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-10-03T23:50:00Z'))
    const { assertAiBudget, recordAiSpend, getAiConfig } = await config()
    await recordAiSpend(5)
    await expect(assertAiBudget()).rejects.toThrow(/used up/)

    vi.setSystemTime(new Date('2026-10-04T00:05:00Z'))
    await expect(assertAiBudget()).resolves.toBeUndefined()
    expect((await getAiConfig()).spentTodayUsd).toBe(0)
  })

  it('refuses a budget that is not a usable number, and keeps the old one', async () => {
    const { setAiConfig, getAiConfig } = await config()
    await expect(setAiConfig({ dailyCapUsd: -1 })).rejects.toThrow(/0 or more/)
    await expect(setAiConfig({ dailyCapUsd: Number.NaN })).rejects.toThrow(/0 or more/)
    expect((await getAiConfig()).dailyCapUsd).toBe(DEFAULT_AI_DAILY_CAP_USD)
  })

  it('keeps the default model enabled whatever else is switched off', async () => {
    const { setAiConfig } = await config()
    const next = await setAiConfig({ enabledModels: ['anthropic/claude-sonnet-4.5'], defaultModel: 'anthropic/claude-sonnet-4.5' })
    expect(next.defaultModel).toBe('anthropic/claude-sonnet-4.5')
    // Trying to disable the default leaves it enabled: a run that names no model must have one.
    expect((await setAiConfig({ enabledModels: [] })).enabledModels).toEqual(['anthropic/claude-sonnet-4.5'])
  })

  it('refuses a model id that is not one', async () => {
    const { setAiConfig } = await config()
    await expect(setAiConfig({ defaultModel: 'not a model' })).rejects.toThrow(/not a valid model id/)
    await expect(setAiConfig({ enabledModels: [DEFAULT_AI_MODEL, 'a/b?c'] })).rejects.toThrow(/not a valid model id/)
  })

  it('checks a newly enabled model against the catalogue once one is held', async () => {
    writeFileSync(
      join(dir, 'aiModels.json'),
      JSON.stringify({
        fetchedAt: Math.floor(Date.now() / 1000),
        models: [
          { id: DEFAULT_AI_MODEL, name: 'Mini', contextLength: 1, promptPricePerToken: 1, completionPricePerToken: 1, structuredOutputs: true },
          { id: 'acme/prose-only', name: 'Prose', contextLength: 1, promptPricePerToken: 1, completionPricePerToken: 1, structuredOutputs: false }
        ]
      })
    )
    const { setAiConfig, listAiModels, findAiModel } = await config()
    await expect(setAiConfig({ enabledModels: [DEFAULT_AI_MODEL, 'acme/prose-only'] })).rejects.toThrow(/strict JSON schema/)
    await expect(setAiConfig({ enabledModels: [DEFAULT_AI_MODEL, 'acme/unknown'] })).rejects.toThrow(/not in the model catalogue/)
    // A fresh catalogue is served from disk: no key is needed, and none is asked for.
    expect((await listAiModels(false)).models).toHaveLength(2)
    expect((await findAiModel('acme/prose-only'))?.structuredOutputs).toBe(false)
  })

  it('only lets an enabled model be asked', async () => {
    const { resolveAiModel, setAiConfig } = await config()
    expect(await resolveAiModel(undefined)).toBe(DEFAULT_AI_MODEL)
    await expect(resolveAiModel('anthropic/claude-sonnet-4.5')).rejects.toThrow(/not enabled/)
    await setAiConfig({ enabledModels: [DEFAULT_AI_MODEL, 'anthropic/claude-sonnet-4.5'] })
    expect(await resolveAiModel('anthropic/claude-sonnet-4.5')).toBe('anthropic/claude-sonnet-4.5')
  })
})

describe('describeAiRunCost for a run asked less often than every candle', () => {
  const estimate = {
    total: 672,
    cached: 0,
    maximumApiCalls: 672,
    model: 'openai/gpt-5-mini',
    perCallCostUsd: 0.002,
    estimatedCostUsd: 1.344,
    costBasis: 'history' as const,
    budgetRemainingUsd: 5
  }

  it('says how the candles are spaced, because the count alone does not say how long the run is', () => {
    expect(describeAiRunCost({ ...estimate, decideEveryBars: 16 })).toContain('672 candles, one every 4 hours, with openai/gpt-5-mini')
    expect(describeAiRunCost({ ...estimate, decideEveryBars: 4 })).toContain('672 candles, one every hour, with openai/gpt-5-mini')
  })

  it('says nothing about spacing when every candle is asked about', () => {
    expect(describeAiRunCost(estimate)).toContain('672 candles with openai/gpt-5-mini')
    expect(describeAiRunCost({ ...estimate, decideEveryBars: 1 })).toContain('672 candles with openai/gpt-5-mini')
  })
})
