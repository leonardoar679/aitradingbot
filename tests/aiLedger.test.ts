import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ledgerMonthKey, matchesAiCallFilter, parseAiCallLines, type AiCallRecord } from '../shared/aiLedger'
import { summarizeUsage } from '../shared/aiCost'

vi.mock('electron', () => ({ app: { getPath: () => process.env.AI_TEST_USER_DATA } }))

const OCTOBER = Date.parse('2026-10-03T12:00:00Z') / 1000
const SEPTEMBER = Date.parse('2026-09-20T12:00:00Z') / 1000

function row(overrides: Partial<AiCallRecord> = {}): AiCallRecord {
  return {
    id: 'key-1',
    at: OCTOBER,
    source: 'agent',
    status: 'ok',
    model: 'openai/gpt-5-mini',
    provider: 'OpenAI',
    promptVersion: 'intraday-v2',
    contextVersion: 'context-v1',
    schemaVersion: 'signal-v2',
    exchange: 'binance',
    symbol: 'BTCUSDT',
    interval: '15m',
    candleTime: OCTOBER,
    position: 'flat',
    referencePrice: 100,
    usage: { promptTokens: 1500, completionTokens: 400, costUsd: 0.002, latencyMs: 2000 },
    error: null,
    recommendation: 'hold',
    confidence: 0.4,
    rationale: 'nothing decisive',
    detail: null,
    ...overrides
  }
}

describe('parseAiCallLines', () => {
  it('reads one row per line, oldest first, and ignores blank lines', () => {
    const text = `${JSON.stringify(row({ id: 'a' }))}\n\n${JSON.stringify(row({ id: 'b' }))}\n`
    const parsed = parseAiCallLines(text)
    expect(parsed.rows.map((entry) => entry.id)).toEqual(['a', 'b'])
    expect(parsed.skipped).toBe(0)
  })

  it('skips a torn final line and says that it did', () => {
    // What a crash part-way through an append leaves behind. Throwing here would hide every good
    // row above it; dropping it silently would make the totals quietly wrong.
    const text = `${JSON.stringify(row({ id: 'a' }))}\n{"id":"b","at":17`
    const parsed = parseAiCallLines(text)
    expect(parsed.rows.map((entry) => entry.id)).toEqual(['a'])
    expect(parsed.skipped).toBe(1)
  })

  it('counts a line that parses but is not a call as unreadable', () => {
    const parsed = parseAiCallLines(`{"hello":"world"}\n[1,2]\n${JSON.stringify(row())}\n`)
    expect(parsed.rows).toHaveLength(1)
    expect(parsed.skipped).toBe(2)
  })
})

describe('matchesAiCallFilter', () => {
  it('narrows by each field it is given and by nothing else', () => {
    const call = row()
    expect(matchesAiCallFilter(call, {})).toBe(true)
    expect(matchesAiCallFilter(call, { model: 'openai/gpt-5-mini', symbol: 'btcusdt', source: 'agent', status: 'ok' })).toBe(true)
    expect(matchesAiCallFilter(call, { model: 'other/model' })).toBe(false)
    expect(matchesAiCallFilter(call, { symbol: 'ETHUSDT' })).toBe(false)
    expect(matchesAiCallFilter(call, { exchange: 'upbit' })).toBe(false)
    expect(matchesAiCallFilter(call, { sinceSec: OCTOBER + 1 })).toBe(false)
    expect(matchesAiCallFilter(call, { sinceSec: OCTOBER })).toBe(true)
  })

  it('tells one prompt of a model from another', () => {
    // A model's rows are a signal's, an entry review's and a panel's four. What one of them has
    // cost is asked for by name, not picked out of whichever rows happen to be newest.
    const signal = row()
    const report = row({ id: 'key-2', promptVersion: 'panel-trend-v1', agent: 'trend', recommendation: null })
    expect(matchesAiCallFilter(signal, { promptVersion: 'intraday-v2' })).toBe(true)
    expect(matchesAiCallFilter(report, { promptVersion: 'intraday-v2' })).toBe(false)
    expect(matchesAiCallFilter(report, { model: 'openai/gpt-5-mini', promptVersion: 'panel-trend-v1' })).toBe(true)
  })
})

describe('summarizeUsage', () => {
  it('adds up each model, and averages latency over answered calls only', () => {
    const summary = summarizeUsage([
      row({ id: '1' }),
      row({ id: '2', usage: { promptTokens: 1000, completionTokens: 200, costUsd: 0.001, latencyMs: 4000 } }),
      row({ id: '3', status: 'rejected', usage: { promptTokens: 1000, completionTokens: 100, costUsd: 0.001, latencyMs: 3000 } }),
      // A failed call cost nothing and took no meaningful time; counting its zero latency would
      // make a model that is down look fast.
      row({ id: '4', status: 'failed', usage: { promptTokens: 0, completionTokens: 0, costUsd: null, latencyMs: 0 } }),
      row({ id: '5', model: 'anthropic/claude', usage: { promptTokens: 10, completionTokens: 10, costUsd: 0.5, latencyMs: 1000 } })
    ])
    // Most expensive first.
    expect(summary.map((entry) => entry.model)).toEqual(['anthropic/claude', 'openai/gpt-5-mini'])
    const mini = summary[1]
    expect(mini).toMatchObject({ calls: 4, failed: 1, rejected: 1, promptTokens: 3500, completionTokens: 700 })
    expect(mini.costUsd).toBeCloseTo(0.004, 10)
    expect(mini.averageLatencyMs).toBeCloseTo(3000, 10)
  })
})

describe('the ledger on disk', () => {
  let dir: string

  async function ledger() {
    return import('../electron/services/aiLedgerService')
  }

  beforeEach(() => {
    vi.resetModules()
    dir = mkdtempSync(join(tmpdir(), 'ai-ledger-'))
    process.env.AI_TEST_USER_DATA = dir
  })

  it('returns what was appended, newest first', async () => {
    const { appendAiCall, listAiCalls } = await ledger()
    await appendAiCall(row({ id: 'first', at: OCTOBER }))
    await appendAiCall(row({ id: 'second', at: OCTOBER + 60 }))
    const page = await listAiCalls({})
    expect(page.rows.map((entry) => entry.id)).toEqual(['second', 'first'])
    expect(page.skippedLines).toBe(0)
  })

  it('is empty, not an error, before anything has been written', async () => {
    const { listAiCalls, getAiUsageSummary } = await ledger()
    expect(await listAiCalls({})).toEqual({ rows: [], skippedLines: 0 })
    expect(await getAiUsageSummary()).toEqual({ today: [], last30Days: [], skippedLines: 0 })
  })

  it('files each row under its own month and reads across them in order', async () => {
    const { appendAiCall, listAiCalls } = await ledger()
    await appendAiCall(row({ id: 'sep', at: SEPTEMBER }))
    await appendAiCall(row({ id: 'oct', at: OCTOBER }))
    expect(readFileSync(join(dir, 'aiLedger', `calls-${ledgerMonthKey(SEPTEMBER)}.jsonl`), 'utf-8')).toContain('"sep"')
    expect(readFileSync(join(dir, 'aiLedger', `calls-${ledgerMonthKey(OCTOBER)}.jsonl`), 'utf-8')).toContain('"oct"')
    expect((await listAiCalls({})).rows.map((entry) => entry.id)).toEqual(['oct', 'sep'])
    // A query bounded in time does not open months before its start.
    expect((await listAiCalls({ sinceSec: OCTOBER - 60 })).rows.map((entry) => entry.id)).toEqual(['oct'])
  })

  it('keeps every row, in the order appended, when many arrive at once', async () => {
    // "Newest first" is read off the file backwards, so it is only true if file order is append
    // order. Left to the thread pool, sixty concurrent appends land shuffled.
    const { appendAiCall, listAiCalls } = await ledger()
    await Promise.all(Array.from({ length: 60 }, (_, i) => appendAiCall(row({ id: `row-${i}`, at: OCTOBER + i }))))
    const page = await listAiCalls({ limit: 100 })
    expect(page.skippedLines).toBe(0)
    expect(page.rows.map((entry) => entry.id)).toEqual(Array.from({ length: 60 }, (_, i) => `row-${59 - i}`))
  })

  it('applies the filter before the limit, so a filtered page is still full', async () => {
    const { appendAiCall, listAiCalls } = await ledger()
    for (let i = 0; i < 6; i++) {
      await appendAiCall(row({ id: `row-${i}`, at: OCTOBER + i, model: i % 2 === 0 ? 'a/model' : 'b/model' }))
    }
    const page = await listAiCalls({ model: 'a/model', limit: 2 })
    expect(page.rows.map((entry) => entry.id)).toEqual(['row-4', 'row-2'])
  })

  it('does not lose the next row to a line a crash left torn', async () => {
    // The fragment has no newline. Appended straight after it, the next row would join onto it
    // and both would be unreadable: one crash would cost two rows, then keep costing.
    mkdirSync(join(dir, 'aiLedger'), { recursive: true })
    const file = join(dir, 'aiLedger', `calls-${ledgerMonthKey(OCTOBER)}.jsonl`)
    writeFileSync(file, `${JSON.stringify(row({ id: 'before' }))}\n`)
    appendFileSync(file, '{"id":"torn","at":17')

    const { appendAiCall, listAiCalls } = await ledger()
    await appendAiCall(row({ id: 'after', at: OCTOBER + 60 }))
    const page = await listAiCalls({})
    expect(page.rows.map((entry) => entry.id)).toEqual(['after', 'before'])
    expect(page.skippedLines).toBe(1)
  })

  it('separates today from the last thirty days', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-10-03T18:00:00Z'))
    try {
      const { appendAiCall, getAiUsageSummary } = await ledger()
      await appendAiCall(row({ id: 'today', at: OCTOBER }))
      await appendAiCall(row({ id: 'recent', at: SEPTEMBER }))
      await appendAiCall(row({ id: 'old', at: Date.parse('2026-08-01T00:00:00Z') / 1000 }))
      const summary = await getAiUsageSummary()
      expect(summary.today[0].calls).toBe(1)
      expect(summary.last30Days[0].calls).toBe(2)
    } finally {
      vi.useRealTimers()
    }
  })
})
