import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { eventScoring } from '../shared/aiEventBenchmark'
import {
  EXPERIMENT_MAX_EVENTS,
  experimentDrift,
  experimentIdFor,
  experimentRunTotals,
  isSameRun,
  normalizeExperimentInput,
  parseAiExperimentLines,
  sampleOwner,
  summarizeExperiment,
  type AiExperiment,
  type AiExperimentInput
} from '../shared/aiExperiment'
import type { AiCallRecord } from '../shared/aiLedger'
import { EVENT_DETECTOR_VERSION, type MarketEvent } from '../shared/marketEvent'

// A benchmark run kept as a run: what a record may hold, how it is numbered, and what the main
// process counts from the ledger when it writes one down.

vi.mock('electron', () => ({ app: { getPath: () => process.env.AI_TEST_USER_DATA } }))

const A = 'openai/gpt-5-mini'
const B = 'mistralai/mistral-small-2603'
/** 2026-10-04 12:45:00 UTC. */
const RUN = Date.parse('2026-10-04T12:45:00Z') / 1000
const DAY = 86_400

function event(symbol: string, time: number): MarketEvent {
  return {
    id: `binance:${symbol}:${time}`,
    exchange: 'binance',
    symbol,
    baseAsset: symbol.replace('USDT', ''),
    quoteAsset: 'USDT',
    time,
    type: 'breakout',
    direction: 'up',
    band: 'candidate',
    score: 78,
    components: { price: 80, volume: 70, volatility: 75, pressure: 85, breakout: 80 },
    price: 100,
    returnsPct: { m1: 0.2, m5: 0.9, m15: 2, h1: 2.4, h4: 3 },
    moveSigmas: 4,
    volumeRatio: 5,
    rangeRatio: 3,
    live: null
  }
}

const EVENTS = [event('ETHUSDT', RUN - 3 * DAY), event('BTCUSDT', RUN - 5 * DAY), event('SOLUSDT', RUN - 2 * DAY)]

function input(overrides: Partial<AiExperimentInput> = {}): AiExperimentInput {
  return {
    startedAt: RUN,
    endedAt: RUN + 500,
    startSec: RUN - 15 * DAY,
    endSec: RUN - DAY,
    pairs: ['SOLUSDT', 'BTCUSDT', 'ETHUSDT'],
    found: 7,
    events: EVENTS,
    models: [A, B],
    ...overrides
  }
}

function call(model: string, eventId: string, overrides: Partial<AiCallRecord> = {}): AiCallRecord {
  return {
    id: `${model}:${eventId}`,
    at: RUN + 60,
    source: 'benchmark',
    status: 'ok',
    model,
    provider: 'Test',
    promptVersion: 'opportunity-v1',
    contextVersion: 'context-v1',
    schemaVersion: 'opportunity-schema-v1',
    exchange: 'binance',
    symbol: eventId.split(':')[1],
    interval: '15m',
    candleTime: Number(eventId.split(':')[2]),
    position: 'flat',
    referencePrice: 100,
    usage: { promptTokens: 2400, completionTokens: 500, costUsd: 0.002, latencyMs: 9000 } as AiCallRecord['usage'],
    error: null,
    recommendation: 'buy',
    confidence: 0.7,
    rationale: '',
    detail: null,
    eventId,
    eventType: 'breakout',
    ...overrides
  }
}

function record(overrides: Partial<AiExperiment> = {}): AiExperiment {
  const normal = normalizeExperimentInput(input())
  return {
    id: 'EXP-2026-1004-001',
    ...normal,
    note: null,
    eventsOf: null,
    versions: { prompt: ['opportunity-v1'], context: ['context-v1'], schema: ['opportunity-schema-v1'], detector: EVENT_DETECTOR_VERSION },
    scoring: eventScoring(),
    calls: 6,
    failed: 0,
    costUsd: 0.012,
    ...overrides
  }
}

describe('normalizeExperimentInput', () => {
  it('puts the events in time order and the pairs in name order', () => {
    const normal = normalizeExperimentInput(input())
    expect(normal.events.map((entry) => entry.symbol)).toEqual(['BTCUSDT', 'ETHUSDT', 'SOLUSDT'])
    expect(normal.pairs).toEqual(['BTCUSDT', 'ETHUSDT', 'SOLUSDT'])
    expect(normal.models).toEqual([A, B])
    expect(normal.note).toBeNull()
  })

  it('names a model once and keeps a note that says something', () => {
    const normal = normalizeExperimentInput(input({ models: [A, A, B], note: '  recorded afterwards  ' }))
    expect(normal.models).toEqual([A, B])
    expect(normal.note).toBe('recorded afterwards')
  })

  it.each<[string, unknown]>([
    ['nothing at all', null],
    ['a run that ended before it began', input({ endedAt: RUN - 1 })],
    ['a period that ends where it starts', input({ endSec: RUN - 15 * DAY })],
    ['no pairs', input({ pairs: [] })],
    ['no models', input({ models: [] })],
    ['more models than one event can be put to', input({ models: ['a', 'b', 'c', 'd', 'e', 'f', 'g'] })],
    ['no events', input({ events: [] })],
    ['the same event twice', input({ events: [EVENTS[0], EVENTS[0]] })],
    ['more events than were found', input({ found: 2 })],
    ['an event with no move to trade', input({ events: [{ ...EVENTS[0], returnsPct: undefined } as unknown as MarketEvent] })],
    ['something that is not an event', input({ events: [{ id: 'x' } as unknown as MarketEvent] })]
  ])('refuses %s', (_what, value) => {
    expect(() => normalizeExperimentInput(value)).toThrow(/experiment/i)
  })

  it('takes a sample as large as a benchmark draws, and no larger', () => {
    const many = Array.from({ length: EXPERIMENT_MAX_EVENTS + 1 }, (_, i) => event('BTCUSDT', RUN - 10 * DAY + i * 60))
    expect(normalizeExperimentInput(input({ events: many.slice(0, EXPERIMENT_MAX_EVENTS), found: 900 })).events).toHaveLength(EXPERIMENT_MAX_EVENTS)
    expect(() => normalizeExperimentInput(input({ events: many, found: 900 }))).toThrow(/at most/)
  })
})

describe('experimentIdFor', () => {
  it('numbers a run by the UTC day it began on', () => {
    expect(experimentIdFor(RUN, [])).toBe('EXP-2026-1004-001')
    expect(experimentIdFor(RUN, ['EXP-2026-1004-001', 'EXP-2026-1003-007'])).toBe('EXP-2026-1004-002')
    // One second before midnight UTC is still the day before.
    expect(experimentIdFor(Date.parse('2026-10-04T23:59:59Z') / 1000, [])).toBe('EXP-2026-1004-001')
    expect(experimentIdFor(Date.parse('2026-10-05T00:00:00Z') / 1000, ['EXP-2026-1004-001'])).toBe('EXP-2026-1005-001')
  })

  it('goes on from the highest number given out, not from how many there are', () => {
    expect(experimentIdFor(RUN, ['EXP-2026-1004-003'])).toBe('EXP-2026-1004-004')
    expect(experimentIdFor(RUN, ['EXP-2026-1004-999'])).toBe('EXP-2026-1004-1000')
  })
})

describe('isSameRun and sampleOwner', () => {
  it('knows a run it already holds, whatever order its parts are named in', () => {
    const held = record()
    expect(isSameRun(held, normalizeExperimentInput(input({ models: [B, A], events: [...EVENTS].reverse() })))).toBe(true)
    expect(isSameRun(held, normalizeExperimentInput(input({ startedAt: RUN + 1 })))).toBe(false)
    expect(isSameRun(held, normalizeExperimentInput(input({ models: [A] })))).toBe(false)
    expect(isSameRun(held, normalizeExperimentInput(input({ events: EVENTS.slice(0, 2) })))).toBe(false)
  })

  it('names the first run on a sample as the one whose sample it is', () => {
    const first = record()
    const later = record({ id: 'EXP-2026-1005-001', startedAt: RUN + DAY, eventsOf: first.id })
    expect(sampleOwner([], EVENTS)).toBeNull()
    expect(sampleOwner([first], EVENTS)).toBe(first.id)
    expect(sampleOwner([later, first], [...EVENTS].reverse())).toBe(first.id)
    // Written down in the wrong order -- an old run recorded after a newer one -- it is still
    // the run that began first.
    const unfiled = record({ id: 'EXP-2026-1005-001', startedAt: RUN + DAY })
    expect(sampleOwner([unfiled, first], EVENTS)).toBe(first.id)
    expect(sampleOwner([first, unfiled], EVENTS)).toBe(first.id)
    // One event fewer is another sample.
    expect(sampleOwner([first], EVENTS.slice(1))).toBeNull()
  })
})

describe('experimentRunTotals', () => {
  const run = normalizeExperimentInput(input())

  it('counts the calls a run made, what they cost and the versions they were made under', () => {
    const rows = EVENTS.flatMap((entry) => [call(A, entry.id), call(B, entry.id, { usage: { ...call(B, entry.id).usage, costUsd: 0.001 } })])
    const totals = experimentRunTotals(rows, run)
    expect(totals.calls).toBe(6)
    expect(totals.failed).toBe(0)
    expect(totals.costUsd).toBeCloseTo(0.009, 10)
    expect(totals.versions).toEqual({ prompt: ['opportunity-v1'], context: ['context-v1'], schema: ['opportunity-schema-v1'] })
  })

  it('counts a refused answer as a call that was paid for, and an unanswered one apart', () => {
    const rows = [
      call(A, EVENTS[0].id),
      call(B, EVENTS[0].id, { status: 'rejected', error: 'The stop is not below the entry range' }),
      call(B, EVENTS[1].id, { status: 'failed', error: 'overloaded', usage: { ...call(B, EVENTS[1].id).usage, costUsd: null } as AiCallRecord['usage'] })
    ]
    expect(experimentRunTotals(rows, run)).toMatchObject({ calls: 2, failed: 1 })
    expect(experimentRunTotals(rows, run).costUsd).toBeCloseTo(0.004, 10)
  })

  it('leaves out every row that is not this run\'s', () => {
    const rows = [
      call(A, EVENTS[0].id),
      call(A, EVENTS[0].id, { source: 'watch' }),
      call(A, EVENTS[0].id, { at: RUN - 1 }),
      call(A, EVENTS[0].id, { at: RUN + 501 }),
      call('x-ai/grok-4.7', EVENTS[0].id),
      call(A, 'binance:XRPUSDT:1'),
      { ...call(A, EVENTS[0].id), eventId: undefined }
    ]
    expect(experimentRunTotals(rows, run)).toMatchObject({ calls: 1, failed: 0 })
  })

  it('says so when a run was made under two prompts', () => {
    const rows = [call(A, EVENTS[0].id), call(A, EVENTS[1].id, { promptVersion: 'opportunity-v2' })]
    expect(experimentRunTotals(rows, run).versions.prompt).toEqual(['opportunity-v1', 'opportunity-v2'])
  })
})

describe('reading the file', () => {
  it('reads each record back, and counts a line it cannot read rather than refusing the file', () => {
    const first = record()
    const second = record({ id: 'EXP-2026-1005-001', eventsOf: first.id })
    const text = [JSON.stringify(first), '{"id":"EXP-2026-1004-002","torn":', JSON.stringify({ ...first, id: 'not-an-id' }), JSON.stringify(second), ''].join('\n')
    const parsed = parseAiExperimentLines(text)
    expect(parsed.rows.map((row) => row.id)).toEqual([first.id, second.id])
    expect(parsed.skipped).toBe(2)
    expect(parsed.rows[0]).toEqual(first)
  })

  it('lists a record without its events', () => {
    const summary = summarizeExperiment(record())
    expect(summary).toMatchObject({ id: 'EXP-2026-1004-001', eventCount: 3, calls: 6 })
    expect('events' in summary).toBe(false)
  })
})

describe('experimentDrift', () => {
  const now = { detector: EVENT_DETECTOR_VERSION, scoring: eventScoring() }

  it('says nothing about a record made under the rules in force', () => {
    expect(experimentDrift(record(), now)).toEqual([])
    // Read back from a file, the same record is still the same rules.
    expect(experimentDrift(JSON.parse(JSON.stringify(record())) as AiExperiment, now)).toEqual([])
  })

  it('says which rules have moved', () => {
    const old = record({ versions: { ...record().versions, detector: 'events-v0' } })
    expect(experimentDrift(old, now)).toEqual([expect.stringContaining('events-v0')])
    const cheaper = record({ scoring: { ...eventScoring(), feeRate: 0 } })
    expect(experimentDrift(cheaper, now)).toEqual([expect.stringContaining('fees')])
  })
})

describe('recording a run', () => {
  async function services() {
    const experiments = await import('../electron/services/aiExperimentService')
    const ledger = await import('../electron/services/aiLedgerService')
    return { ...experiments, ...ledger }
  }

  beforeEach(() => {
    vi.resetModules()
    process.env.AI_TEST_USER_DATA = mkdtempSync(join(tmpdir(), 'ai-experiment-'))
  })

  it('writes down what the ledger says the run made, and gives it the day\'s first number', async () => {
    const { appendAiCall, recordAiExperiment, listAiExperiments, getAiExperiment } = await services()
    for (const entry of EVENTS) {
      await appendAiCall(call(A, entry.id))
      await appendAiCall(call(B, entry.id, { status: entry === EVENTS[0] ? 'failed' : 'ok' }))
    }
    // A watch call about the same event, and a benchmark call from another day: neither is this run's.
    await appendAiCall(call(A, EVENTS[0].id, { id: 'watch', source: 'watch' }))
    await appendAiCall(call(A, EVENTS[0].id, { id: 'later', at: RUN + DAY }))

    const made = await recordAiExperiment(input())
    expect(made).toMatchObject({
      id: 'EXP-2026-1004-001',
      startedAt: RUN,
      eventsOf: null,
      models: [A, B],
      calls: 5,
      failed: 1,
      found: 7,
      versions: { prompt: ['opportunity-v1'], context: ['context-v1'], schema: ['opportunity-schema-v1'], detector: EVENT_DETECTOR_VERSION },
      scoring: eventScoring()
    })
    expect(made.costUsd).toBeCloseTo(0.01, 10)
    expect(made.events.map((entry) => entry.symbol)).toEqual(['BTCUSDT', 'ETHUSDT', 'SOLUSDT'])

    const listed = await listAiExperiments()
    expect(listed.rows).toEqual([expect.objectContaining({ id: made.id, eventCount: 3 })])
    expect(listed.skippedLines).toBe(0)
    expect(await getAiExperiment(made.id)).toEqual(made)
    expect(await getAiExperiment('EXP-2026-1004-009')).toBeNull()
  })

  it('records a run once however often it is handed in', async () => {
    const { appendAiCall, recordAiExperiment, listAiExperiments } = await services()
    await appendAiCall(call(A, EVENTS[0].id))
    const [first, again] = await Promise.all([recordAiExperiment(input()), recordAiExperiment(input({ models: [B, A] }))])
    expect(again.id).toBe(first.id)
    expect((await listAiExperiments()).rows).toHaveLength(1)
    const file = readFileSync(join(process.env.AI_TEST_USER_DATA ?? '', 'aiExperiments', 'experiments.jsonl'), 'utf-8')
    expect(file.trim().split('\n')).toHaveLength(1)
  })

  it('files a later run on the same events under the run that drew them, newest first', async () => {
    const { appendAiCall, recordAiExperiment, listAiExperiments } = await services()
    const C = 'anthropic/claude-sonnet-5.5'
    await appendAiCall(call(A, EVENTS[0].id))
    await appendAiCall(call(C, EVENTS[1].id, { at: RUN + 900 }))
    await appendAiCall(call(C, EVENTS[2].id, { at: RUN + DAY + 30 }))
    const first = await recordAiExperiment(input())
    const second = await recordAiExperiment(input({ startedAt: RUN + 800, endedAt: RUN + 1000, models: [C] }))
    const third = await recordAiExperiment(input({ startedAt: RUN + DAY, endedAt: RUN + DAY + 60, models: [C] }))
    expect(second).toMatchObject({ id: 'EXP-2026-1004-002', eventsOf: first.id, calls: 1 })
    expect(third).toMatchObject({ id: 'EXP-2026-1005-001', eventsOf: first.id, calls: 1 })
    expect((await listAiExperiments()).rows.map((row) => row.id)).toEqual([third.id, second.id, first.id])
  })

  it('records nothing for a run that left no call in the ledger', async () => {
    const { recordAiExperiment, listAiExperiments } = await services()
    await expect(recordAiExperiment(input())).rejects.toThrow(/No call in the ledger/)
    await expect(recordAiExperiment({ startedAt: RUN })).rejects.toThrow(/experiment/i)
    expect((await listAiExperiments()).rows).toEqual([])
  })

  it('reads past a torn line left by a crash, and writes the next record on a line of its own', async () => {
    const { appendAiCall, recordAiExperiment, listAiExperiments } = await services()
    const dir = join(process.env.AI_TEST_USER_DATA ?? '', 'aiExperiments')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'experiments.jsonl'), '{"id":"EXP-2026-1003-001","startedAt":', 'utf-8')
    await appendAiCall(call(A, EVENTS[0].id))
    const made = await recordAiExperiment(input())
    const listed = await listAiExperiments()
    expect(listed.rows.map((row) => row.id)).toEqual([made.id])
    expect(listed.skippedLines).toBe(1)
  })
})
