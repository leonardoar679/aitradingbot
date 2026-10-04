import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  GPT_INTRADAY_STRATEGY_ID,
  GPT_LOOKBACK_BARS,
  GPT_MAX_DECISIONS,
  decisionRange,
  type AiSignalEstimate,
  type AiSignalTape,
  type AiSignalTapeRequest
} from '../shared/aiSignal'
import type { Candle } from '../shared/ipc'
import { clearCandleCache } from '../src/bots/candleCache'
import { estimatePaidBot, fetchBotDryRunResult } from '../src/bots/useDryRun'

// A GPT Intraday bot asked every hour or every four hours, driven through the function its card,
// its detail view, the Positions page and the portfolio scheduler all call. The bridge is faked;
// the fetch window and the request are real. What is pinned is that the cadence a bot was created
// with is the one it asks at -- every one of these requests is a charge on the user's account, and
// "every candle" is sixteen times the bill of "every four hours".

const BAR = 900
const DAY = 86_400
/** Open time of the candle forming "now": on a four-hour boundary. */
const FORMING = 1_750_003_200
const NOW = FORMING + 420

const EMPTY_TAPE: AiSignalTape = {
  promptVersion: 'intraday-v2',
  exchange: 'binance',
  symbol: 'BTCUSDT',
  interval: '15m',
  model: 'openai/gpt-5-mini',
  decisions: [],
  cachedCount: 0,
  generatedCount: 0,
  callCount: 0,
  errorCount: 0,
  rejectedCount: 0,
  costUsd: 0
}

const ESTIMATE: AiSignalEstimate = {
  total: 0,
  cached: 0,
  maximumApiCalls: 0,
  model: 'openai/gpt-5-mini',
  perCallCostUsd: 0.002,
  estimatedCostUsd: 0,
  costBasis: 'history',
  budgetRemainingUsd: 0.9
}

interface Bridge {
  tapes: AiSignalTapeRequest[]
  estimates: AiSignalTapeRequest[]
}

/** Fakes the renderer's bridge: a flat market on 15-minute bars, and a model that is never asked
 * anything -- the request is what is under test, not the answer. */
function stubBridge(tape: AiSignalTape = EMPTY_TAPE): Bridge {
  const bridge: Bridge = { tapes: [], estimates: [] }
  vi.stubGlobal('window', {
    api: {
      market: {
        fetchHistoricalRange: async (_exchange: string, _symbol: string, _interval: string, from: number, to: number) => {
          const candles: Candle[] = []
          for (let time = Math.ceil(from / BAR) * BAR; time <= to; time += BAR) {
            candles.push({ time, open: 100, high: 100.5, low: 99.5, close: 100, volume: 10 })
          }
          return { candles, cancelled: false }
        }
      },
      ai: {
        generateSignalTape: async (request: AiSignalTapeRequest) => {
          bridge.tapes.push(request)
          return tape
        },
        estimateSignalTape: async (request: AiSignalTapeRequest) => {
          bridge.estimates.push(request)
          return ESTIMATE
        }
      }
    }
  })
  return bridge
}

const BOT = { exchange: 'binance' as const, symbol: 'BTCUSDT', strategyId: GPT_INTRADAY_STRATEGY_ID, aiModel: 'openai/gpt-5-mini' }

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date(NOW * 1000))
  clearCandleCache()
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('a running GPT Intraday bot', () => {
  it('asks at the cadence it was created with, of the model it was pinned to', async () => {
    const bridge = stubBridge()
    await fetchBotDryRunResult({ ...BOT, aiEveryBars: 16, enabledAt: NOW - 3 * DAY })
    expect(bridge.tapes).toHaveLength(1)
    expect(bridge.tapes[0]).toMatchObject({
      interval: '15m',
      decideEveryBars: 16,
      maxDecisions: GPT_MAX_DECISIONS,
      model: 'openai/gpt-5-mini',
      source: 'bot'
    })
  })

  it('is asked on every candle when it was saved before there was a cadence', async () => {
    const bridge = stubBridge()
    await fetchBotDryRunResult({ ...BOT, enabledAt: NOW - 3 * DAY })
    expect(bridge.tapes[0].decideEveryBars).toBe(1)
  })

  it('starts asking at the candle it was switched on at, with a full lookback behind it', async () => {
    const bridge = stubBridge()
    const enabledAt = NOW - 3 * DAY
    await fetchBotDryRunResult({ ...BOT, aiEveryBars: 4, enabledAt })
    const request = bridge.tapes[0]
    expect(request.startIndex).toBe(GPT_LOOKBACK_BARS)
    const first = request.candles[request.startIndex].time
    expect(first).toBeGreaterThanOrEqual(enabledAt)
    expect(first - enabledAt).toBeLessThan(BAR)
  })

  it("keeps a slow bot's whole run in view, where an every-candle bot's first week has scrolled out", async () => {
    const enabledAt = NOW - 10 * DAY
    const fast = stubBridge()
    await fetchBotDryRunResult({ ...BOT, enabledAt })
    const fastFirst = fast.tapes[0].candles[fast.tapes[0].startIndex].time
    // 672 decisions are seven days on every candle, so the replay has moved on to its second week.
    expect(fastFirst).toBeGreaterThanOrEqual(enabledAt + 7 * DAY)

    clearCandleCache()
    const slow = stubBridge()
    await fetchBotDryRunResult({ ...BOT, aiEveryBars: 16, enabledAt })
    const slowFirst = slow.tapes[0].candles[slow.tapes[0].startIndex].time
    // The same ceiling is 112 days at this cadence: ten days in, nothing has scrolled out.
    expect(slowFirst - enabledAt).toBeLessThan(BAR)
    expect(slowFirst).toBeGreaterThanOrEqual(enabledAt)
  })

  it('never asks for more decisions in one replay than the ceiling, however long it has run', async () => {
    const bridge = stubBridge()
    await fetchBotDryRunResult({ ...BOT, aiEveryBars: 16, enabledAt: NOW - 200 * DAY })
    const request = bridge.tapes[0]
    expect(request.candles.length - request.startIndex).toBeLessThanOrEqual(GPT_MAX_DECISIONS * 16)
    // The real plan for that request, as the main process would make it.
    expect(decisionRange(request).total).toBeLessThanOrEqual(GPT_MAX_DECISIONS)
    expect(decisionRange(request).total).toBeGreaterThan(0)
  })

  it('reports what the tape counted, whatever the cadence', async () => {
    stubBridge()
    const fetched = await fetchBotDryRunResult({ ...BOT, aiEveryBars: 4, enabledAt: NOW - 3 * DAY })
    expect(fetched?.aiCalls).toEqual({ total: 0, cached: 0, generated: 0, errors: 0 })
    expect(fetched?.result.trades).toEqual([])
  })
})

describe('pricing a GPT Intraday bot before it is switched on', () => {
  it('is priced at the cadence it will ask at', async () => {
    const bridge = stubBridge()
    const estimate = await estimatePaidBot({ exchange: 'binance', symbol: 'BTCUSDT', strategyId: GPT_INTRADAY_STRATEGY_ID, aiEveryBars: 4 })
    expect(estimate).toEqual(ESTIMATE)
    expect(bridge.estimates[0].decideEveryBars).toBe(4)
    // Nothing was asked of a model to find that out.
    expect(bridge.tapes).toHaveLength(0)
  })

  it('is priced as every candle for a bot with no cadence', async () => {
    const bridge = stubBridge()
    await estimatePaidBot({ exchange: 'binance', symbol: 'BTCUSDT', strategyId: GPT_INTRADAY_STRATEGY_ID })
    expect(bridge.estimates[0].decideEveryBars).toBe(1)
  })
})

// The route a bot was switched on with. Every request a running bot makes names its own route or
// says there is none: it never leaves the question open, because the answer to an open question
// is a setting somebody may have changed since the bot's confirmation was shown.
describe('a GPT Intraday bot and its second model', () => {
  const route = { model: 'acme/frontier', when: 'acting' as const }

  it('names the route it was switched on with in every request', async () => {
    const bridge = stubBridge()
    await fetchBotDryRunResult({ ...BOT, aiRoute: route, enabledAt: NOW - 3 * DAY })
    expect(bridge.tapes[0]).toMatchObject({ model: 'openai/gpt-5-mini', route, source: 'bot' })
  })

  it('says outright that it has none when it was switched on without one', async () => {
    const bridge = stubBridge()
    await fetchBotDryRunResult({ ...BOT, enabledAt: NOW - 3 * DAY })
    expect(bridge.tapes[0].route).toBeNull()
  })

  it('counts calls rather than decisions, and says how many went to the second model', async () => {
    stubBridge({ ...EMPTY_TAPE, generatedCount: 3, callCount: 5, route: { ...route, escalated: 2 } })
    const fetched = await fetchBotDryRunResult({ ...BOT, aiRoute: route, enabledAt: NOW - 3 * DAY })
    expect(fetched?.aiCalls).toEqual({ total: 0, cached: 0, generated: 5, errors: 0, escalated: 2 })
  })

  it('is priced with the route it would be switched on with, and with none when there is none', async () => {
    const bridge = stubBridge()
    await estimatePaidBot({ exchange: 'binance', symbol: 'BTCUSDT', strategyId: GPT_INTRADAY_STRATEGY_ID, aiRoute: route })
    await estimatePaidBot({ exchange: 'binance', symbol: 'BTCUSDT', strategyId: GPT_INTRADAY_STRATEGY_ID })
    expect(bridge.estimates[0].route).toEqual(route)
    expect(bridge.estimates[1].route).toBeNull()
    expect(bridge.tapes).toHaveLength(0)
  })
})
