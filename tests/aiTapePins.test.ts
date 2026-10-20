import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { GPT_INTRADAY_INTERVAL, GPT_LOOKBACK_BARS, type AiSignalTapeRequest } from '../shared/aiSignal'
import type { Candle } from '../shared/ipc'

// A BOT MOVED, AND A BOT THAT WAS CLOSED (electron/services/aiSignalService.ts; V7.2-R Stage 1): a bar decided
// before the bot moved is read from the old model's answers alone and never asked again; a bar older than the
// catch-up window is read from the answers on file or held as it stood, never bought; only the bars from the
// move on, within the window, are asked of the model the bot runs on now. The network is faked.

vi.mock('electron', () => ({ app: { getPath: () => process.env.AI_TEST_USER_DATA } }))
vi.mock('../electron/services/noticeService', () => ({ tell: () => undefined, tellNotice: async () => true }))
vi.mock('../electron/services/aiCredentialsService', () => ({ getDecryptedAiCredential: async () => ({ apiKey: 'sk-or-test' }) }))

const OLD = 'openai/gpt-5-mini'
const NEW = 'anthropic/claude-opus-5.5'
const BAR = 900
const START = 1_699_999_200

function series(count: number): Candle[] {
  let seed = 11
  const next = (): number => {
    seed = (seed * 1103515245 + 12345) % 2147483648
    return seed / 2147483648
  }
  const out: Candle[] = []
  let price = 100
  for (let i = 0; i < count; i++) {
    const open = price
    price = Math.max(1, price + (next() - 0.5) * 1.2)
    out.push({ time: START + i * BAR, open, high: Math.max(open, price) + 0.3, low: Math.min(open, price) - 0.3, close: price, volume: 80 + next() * 40 })
  }
  return out
}

const CANDLES = series(GPT_LOOKBACK_BARS + 6)
/** The time of the k-th decision bar (0-based). */
const barTime = (k: number): number => CANDLES[GPT_LOOKBACK_BARS + k].time

function request(overrides: Partial<AiSignalTapeRequest> = {}): AiSignalTapeRequest {
  return { requestId: `run-${Math.random()}`, exchange: 'binance', symbol: 'BTCUSDT', interval: GPT_INTRADAY_INTERVAL, candles: CANDLES, startIndex: GPT_LOOKBACK_BARS, maxDecisions: 6, source: 'bot', ...overrides }
}

/** OpenRouter faked: every request's model recorded, every answer a hold. */
function stubOpenRouter(): { asked: string[] } {
  const asked: string[] = []
  vi.stubGlobal('fetch', async (_url: string, init: { body?: string }) => {
    asked.push((JSON.parse(init.body ?? '{}') as { model: string }).model)
    const content = JSON.stringify({ recommendation: 'hold', confidence: 0.4, marketRegime: 'neutral', riskLevel: 'medium', horizonBars: 16, stopLoss: null, takeProfit: null, reasonCodes: ['range_bound'], rationale: 'nothing decisive' })
    return { ok: true, status: 200, text: async () => JSON.stringify({ provider: 'Test', choices: [{ finish_reason: 'stop', message: { content } }], usage: { prompt_tokens: 1500, completion_tokens: 400, cost: 0.002 } }) }
  })
  return { asked }
}

async function services() {
  const tape = await import('../electron/services/aiSignalService')
  const config = await import('../electron/services/aiConfigService')
  const ledger = await import('../electron/services/aiLedgerService')
  tape.aiRetry.baseDelayMs = 0
  await config.setAiConfig({ enabledModels: [OLD, NEW], defaultModel: NEW, dailyCapUsd: 5 })
  return { ...tape, ...config, ...ledger }
}

beforeEach(() => {
  vi.resetModules()
  process.env.AI_TEST_USER_DATA = mkdtempSync(join(tmpdir(), 'ai-tape-pins-'))
})

afterEach(() => vi.unstubAllGlobals())

describe('a bot moved to another model', () => {
  it("reads the bars before the move from the old model's answers, holds one it never answered, and asks the new model only after", async () => {
    const { generateAiSignalTape, listAiCalls } = await services()
    const network = stubOpenRouter()
    // The old model answered the first two bars while the bot ran on it.
    await generateAiSignalTape(request({ model: OLD, maxDecisions: 2 }))
    expect(network.asked).toEqual([OLD, OLD])
    network.asked.length = 0
    // Moved at the fourth bar: the third was never answered by the old model.
    const tape = await generateAiSignalTape(request({ model: NEW, modelHistory: [{ model: OLD, untilSec: barTime(3) }], botId: 'gpt' }))
    expect(network.asked).toEqual([NEW, NEW, NEW])
    expect(tape.decisions.map((decision) => decision.model)).toEqual([OLD, OLD, OLD, NEW, NEW, NEW])
    expect(tape.decisions.slice(0, 2).every((decision) => decision.cached)).toBe(true)
    expect(tape.decisions[2]).toMatchObject({ recommendation: 'hold', error: null, cached: false })
    expect(tape.decisions[2].gap).toMatch(/before the bot moved to anthropic\/claude-opus-5\.5/)
    expect(tape).toMatchObject({ cachedCount: 2, gapCount: 1, callCount: 3, errorCount: 0, generatedCount: 3 })
    // The new model's calls carry the bot; the old model was never asked again.
    const rows = (await listAiCalls({ limit: 20 })).rows
    expect(rows.filter((row) => row.model === NEW).every((row) => row.botId === 'gpt')).toBe(true)
    // A paid bot decides: its rows say so, as the watch's say gate or decide.
    expect(rows.filter((row) => row.model === NEW).every((row) => row.role === 'decide')).toBe(true)
    expect(rows.filter((row) => row.model === OLD)).toHaveLength(2)
  })

  it('prices only the bars it would buy', async () => {
    const { generateAiSignalTape, estimateAiSignalTape } = await services()
    stubOpenRouter()
    await generateAiSignalTape(request({ model: OLD, maxDecisions: 2 }))
    const estimate = await estimateAiSignalTape(request({ model: NEW, modelHistory: [{ model: OLD, untilSec: barTime(3) }] }))
    // Two held under the old model, one never bought, three to ask of the new one.
    expect(estimate).toMatchObject({ total: 6, cached: 2, maximumApiCalls: 3, model: NEW })
  })
})

describe('a bot that was closed', () => {
  it('buys only the bars inside its catch-up window, and holds the older ones it has no answer for', async () => {
    const { generateAiSignalTape } = await services()
    const network = stubOpenRouter()
    const tape = await generateAiSignalTape(request({ model: NEW, askFromSec: barTime(4) }))
    expect(network.asked).toEqual([NEW, NEW])
    expect(tape).toMatchObject({ gapCount: 4, callCount: 2, errorCount: 0 })
    expect(tape.decisions.slice(0, 4).every((decision) => decision.gap?.startsWith('missed while the app was closed'))).toBe(true)
    // Asked again later with the window moved back, the bars already answered are not bought twice.
    network.asked.length = 0
    const again = await generateAiSignalTape(request({ model: NEW, askFromSec: barTime(2) }))
    expect(network.asked).toEqual([NEW, NEW])
    expect(again).toMatchObject({ gapCount: 2, cachedCount: 2, callCount: 2 })
  })

  it('asks every bar where no window is set, as a backtest does', async () => {
    const { generateAiSignalTape } = await services()
    const network = stubOpenRouter()
    const tape = await generateAiSignalTape(request({ model: NEW, source: 'backtest' }))
    expect(network.asked).toHaveLength(6)
    expect(tape.gapCount).toBeUndefined()
  })
})
