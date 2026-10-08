import { describe, expect, it } from 'vitest'
import type { AiModelInfo } from '../shared/aiCost'
import type { EventBenchmarkRow, EventBenchmarkSlice } from '../shared/aiEventBenchmark'
import type { AiCallRecord } from '../shared/aiLedger'
import { modelRegistry, percentile } from '../shared/modelRegistry'

// The model registry (the second V3 document, §16 and §35): one view of each model the app may ask,
// from the catalogue, the ledger and the live leaderboard. It is worked out, never stored, and
// promotes nothing.

const A = 'openai/gpt-5-mini'
const T = Date.parse('2026-10-08T09:00:00Z') / 1000

const listed = (over: Partial<AiModelInfo> = {}): AiModelInfo => ({
  id: A,
  name: 'GPT-5 mini',
  contextLength: 400_000,
  promptPricePerToken: 0.25e-6,
  completionPricePerToken: 2e-6,
  structuredOutputs: true,
  reasoning: true,
  ...over
})

const call = (over: Partial<AiCallRecord> = {}): AiCallRecord =>
  ({
    id: `c-${Math.random()}`,
    at: T - 100,
    source: 'watch',
    status: 'ok',
    model: A,
    provider: 'OpenAI',
    servedModel: 'openai/gpt-5-mini-2026-08-07',
    usage: { promptTokens: 1, completionTokens: 1, costUsd: 0.002, latencyMs: 3000 },
    ...over
  }) as AiCallRecord

const slice = (by: EventBenchmarkSlice['by'], key: string, trades: number, meanNetPct: number | null): EventBenchmarkSlice => ({ by, key, trades, wins: Math.floor(trades / 2), netSumPct: 0, meanNetPct })

const row = (name: string): Pick<EventBenchmarkRow, 'name' | 'closed' | 'profitFactor' | 'meanR' | 'slices'> => ({
  name,
  closed: 34,
  profitFactor: 1.2,
  meanR: 0.1,
  slices: [slice('type', 'pump', 20, 0.3), slice('type', 'dump', 14, null), slice('btc', 'Bitcoin rising', 12, -0.1), slice('side', 'long', 34, 0.2)]
})

describe('the model registry', () => {
  it('joins the catalogue, the ledger and the leaderboard row for each model, under its own id', () => {
    const calls = [
      call({ at: T - 50, usage: { promptTokens: 1, completionTokens: 1, costUsd: 0.002, latencyMs: 4000 } }),
      call({ at: T - 60, status: 'rejected', usage: { promptTokens: 1, completionTokens: 1, costUsd: 0.001, latencyMs: 2000 } }),
      call({ at: T - 70, status: 'failed', servedModel: undefined, provider: null, usage: { promptTokens: 0, completionTokens: 0, costUsd: null, latencyMs: 60_000 } }),
      call({ at: T - 80, servedModel: 'openai/gpt-5-mini-2026-05-01', provider: 'Azure', usage: { promptTokens: 1, completionTokens: 1, costUsd: 0.003, latencyMs: 1000 } }),
      call({ at: T - 10, model: 'other/model' })
    ]
    const [entry] = modelRegistry({ models: [A], catalogue: [listed()], calls, rows: [row(A), row('follow')] })
    expect(entry.listed?.name).toBe('GPT-5 mini')
    expect(entry).toMatchObject({ calls: 4, answered: 3, refused: 1, failed: 1, costUsd: 0.006, lastAskedAt: T - 50 })
    // The failed call's sixty seconds are the time it took to fail, and say nothing about an answer.
    expect(entry.latencyP50Ms).toBe(2000)
    expect(entry.latencyP95Ms).toBe(4000)
    expect(entry.servedModels).toEqual(['openai/gpt-5-mini-2026-08-07', 'openai/gpt-5-mini-2026-05-01'])
    expect(entry.providers).toEqual(['OpenAI', 'Azure'])
    expect(entry.results).toEqual({
      closed: 34,
      profitFactor: 1.2,
      meanR: 0.1,
      byType: [
        { key: 'pump', trades: 20, wins: 10, meanNetPct: 0.3 },
        { key: 'dump', trades: 14, wins: 7, meanNetPct: null }
      ],
      byBtc: [{ key: 'Bitcoin rising', trades: 12, wins: 6, meanNetPct: -0.1 }]
    })
  })

  it("gives a model at a lower effort its model's catalogue entry under its own id, and a model the catalogue dropped none", () => {
    const [low, gone] = modelRegistry({ models: [`${A}@low`, 'gone/model'], catalogue: [listed()], calls: [], rows: [] })
    expect(low.listed).toEqual({ ...listed(), id: `${A}@low` })
    expect(low).toMatchObject({ calls: 0, answered: 0, refused: 0, failed: 0, latencyP50Ms: null, latencyP95Ms: null, costUsd: 0, lastAskedAt: null, servedModels: [], providers: [], results: null })
    expect(gone.listed).toBeNull()
  })

  it('takes the nearest rank for a percentile', () => {
    expect(percentile([], 0.5)).toBeNull()
    expect(percentile([7], 0.95)).toBe(7)
    expect(percentile([1, 2, 3, 4], 0.5)).toBe(2)
    expect(percentile([1, 2, 3, 4], 0.95)).toBe(4)
    expect(percentile(Array.from({ length: 100 }, (_, index) => index + 1), 0.95)).toBe(95)
  })
})
