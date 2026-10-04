import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AiEntryConfirmRequest, AiEntryPeek } from '../shared/aiConfirm'
import { GPT_LOOKBACK_BARS, type AiSignalDecision } from '../shared/aiSignal'
import type { Candle } from '../shared/ipc'

// A bot whose entries a model reviews, driven through the same function its card, its detail view,
// the Positions page and the portfolio scheduler all call. The bridge is faked; the fetch window,
// the replay and the review loop are real. What is pinned here is when such a bot is allowed to
// ask at all -- because every one of these calls is a charge on the user's own account.

const script = vi.hoisted(() => ({ entryTimes: new Set<number>(), exitTimes: new Set<number>() }))

vi.mock('../src/backtest/strategies', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/backtest/strategies')>()
  const probe = {
    id: 'probe',
    name: 'Probe',
    description: 'Enters and exits on the bars a test names.',
    preferredInterval: '15m' as const,
    warmupBarsFor: () => 0,
    generateSignals: (candles: { time: number; close: number }[]) => ({
      entries: candles.map((candle) => script.entryTimes.has(candle.time)),
      exits: candles.map((candle) => script.exitTimes.has(candle.time)),
      stopPrices: candles.map((candle) => (script.entryTimes.has(candle.time) ? candle.close * 0.5 : null)),
      warmupBars: 0
    })
  }
  return {
    ...actual,
    STRATEGIES: [...actual.STRATEGIES, probe],
    getStrategy: (id: string) => (id === 'probe' ? probe : actual.getStrategy(id))
  }
})

import { clearCandleCache } from '../src/bots/candleCache'
import { estimateConfirmBot, fetchBotDryRunResult } from '../src/bots/useDryRun'

const BAR = 900
/** Open time of the bar that is forming "now". */
const FORMING = 1_750_000_500
/** Seven minutes into it. */
const NOW = FORMING + 420
/** The bar `n` bars before the forming one. */
const bar = (n: number): number => FORMING - n * BAR
/** The bot was switched on forty bars ago. */
const ENABLED_AT = bar(40)

function answer(recommendation: 'buy' | 'hold', over: Partial<AiSignalDecision> = {}): AiSignalDecision {
  return {
    candleTime: 0,
    recommendation,
    confidence: 0.9,
    rationale: '',
    model: 'openai/gpt-5-mini',
    cached: false,
    error: null,
    rejected: null,
    detail: null,
    usage: { promptTokens: 10, completionTokens: 10, costUsd: 0.002, latencyMs: 5 },
    ...over
  }
}

interface Bridge {
  confirmed: AiEntryConfirmRequest[]
  peeked: AiEntryConfirmRequest[]
}

/** Fakes the renderer's bridge: a flat market on 15-minute bars up to the one forming now, and a
 * model that answers as `rule` says. */
function stubBridge(rule: (signalTime: number) => AiSignalDecision = () => answer('buy')): Bridge {
  const bridge: Bridge = { confirmed: [], peeked: [] }
  const signalTime = (request: AiEntryConfirmRequest): number => request.window[request.window.length - 1].time
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
        confirmEntry: async (request: AiEntryConfirmRequest) => {
          bridge.confirmed.push(request)
          return rule(signalTime(request))
        },
        peekEntryConfirmation: async (request: AiEntryConfirmRequest): Promise<AiEntryPeek> => {
          bridge.peeked.push(request)
          return { decision: null, model: 'openai/gpt-5-mini', perCallCostUsd: 0.002, costBasis: 'history', budgetRemainingUsd: 0.9 }
        }
      }
    }
  })
  return bridge
}

const BOT = { exchange: 'binance' as const, symbol: 'BTCUSDT', strategyId: 'probe', aiConfirm: true, aiModel: 'openai/gpt-5-mini' }

/** One trade from before the bot was switched on, two signals after it. */
function scriptThreeEntries(): void {
  script.entryTimes = new Set([bar(100), bar(30), bar(10)])
  script.exitTimes = new Set([bar(90), bar(25)])
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date(NOW * 1000))
  clearCandleCache()
  script.entryTimes = new Set()
  script.exitTimes = new Set()
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('a running bot with AI-confirmed entries', () => {
  it('asks only about entries signalled since it was switched on, with the model it was pinned to', async () => {
    scriptThreeEntries()
    const bridge = stubBridge((time) => (time === bar(10) ? answer('hold') : answer('buy')))

    const fetched = await fetchBotDryRunResult({ ...BOT, enabledAt: ENABLED_AT })
    expect(bridge.confirmed.map((request) => request.window[request.window.length - 1].time)).toEqual([bar(30), bar(10)])
    for (const request of bridge.confirmed) {
      expect(request.window).toHaveLength(GPT_LOOKBACK_BARS)
      expect(request).toMatchObject({ exchange: 'binance', symbol: 'BTCUSDT', interval: '15m', model: 'openai/gpt-5-mini', source: 'bot' })
      expect(request.strategy.id).toBe('probe')
    }
    expect(bridge.peeked).toEqual([])

    // The trade from before the bot existed is the strategy's own and is replayed untouched; the
    // first signal after it was confirmed and taken; the second was vetoed and is not there.
    expect(fetched?.result.trades.map((trade) => trade.entryTime)).toEqual([bar(100), bar(30)])
    expect(fetched?.result.openPositionAtEnd).toBeNull()
    expect(fetched?.aiCalls).toEqual({ total: 2, cached: 0, generated: 2, errors: 0, vetoed: 1 })
  })

  it('holds a confirmed entry as an open position, not as a trade that closed on the newest bar', async () => {
    script.entryTimes = new Set([bar(10)])
    stubBridge()
    const fetched = await fetchBotDryRunResult({ ...BOT, enabledAt: ENABLED_AT })
    // Force-closing it would report a synthetic exit the strategy never made, on every poll.
    expect(fetched?.result.trades).toEqual([])
    expect(fetched?.result.openPositionAtEnd?.entryTime).toBe(bar(10))
    expect(fetched?.aiCalls).toEqual({ total: 1, cached: 0, generated: 1, errors: 0, vetoed: 0 })
  })

  it('does not ask about, or take, an entry signalled on the bar that is still forming', async () => {
    script.entryTimes = new Set([FORMING])
    const bridge = stubBridge()
    const fetched = await fetchBotDryRunResult({ ...BOT, enabledAt: ENABLED_AT })
    expect(bridge.confirmed).toEqual([])
    expect(fetched?.result.openPositionAtEnd).toBeNull()
    // Not a failure: the entry is simply not due until its bar closes.
    expect(fetched?.aiCalls).toEqual({ total: 0, cached: 0, generated: 0, errors: 0, vetoed: 0 })
  })

  it('stays flat, and says so, when the model cannot be reached', async () => {
    script.entryTimes = new Set([bar(10)])
    const bridge = stubBridge(() => answer('hold', { confidence: 0, error: 'OpenRouter 503: no provider' }))
    const fetched = await fetchBotDryRunResult({ ...BOT, enabledAt: ENABLED_AT })
    expect(bridge.confirmed).toHaveLength(1)
    expect(fetched?.result.openPositionAtEnd).toBeNull()
    expect(fetched?.aiCalls).toMatchObject({ total: 0, errors: 1 })
  })

  it('lets a refusal that will not change surface as the error it is', async () => {
    script.entryTimes = new Set([bar(10)])
    stubBridge(() => {
      throw new Error("Today's AI budget is used up")
    })
    await expect(fetchBotDryRunResult({ ...BOT, enabledAt: ENABLED_AT })).rejects.toThrow(/budget is used up/)
  })
})

describe('a bot that must not spend', () => {
  it('asks nothing while it is stopped, and shows the strategy as it is', async () => {
    scriptThreeEntries()
    const bridge = stubBridge()
    const fetched = await fetchBotDryRunResult({ ...BOT, enabledAt: null })
    expect(bridge.confirmed).toEqual([])
    expect(bridge.peeked).toEqual([])
    expect(fetched?.result.trades.map((trade) => trade.entryTime)).toEqual([bar(100), bar(30)])
    expect(fetched?.result.openPositionAtEnd?.entryTime).toBe(bar(10))
    expect(fetched?.aiCalls).toBeNull()
  })

  it('asks nothing when its entries are not reviewed at all', async () => {
    scriptThreeEntries()
    const bridge = stubBridge()
    const fetched = await fetchBotDryRunResult({ ...BOT, aiConfirm: false, enabledAt: ENABLED_AT })
    expect(bridge.confirmed).toEqual([])
    expect(fetched?.aiCalls).toBeNull()
  })
})

describe('estimateConfirmBot', () => {
  it('prices a review without buying one, from the newest bar that has closed', async () => {
    scriptThreeEntries()
    const bridge = stubBridge()
    const estimate = await estimateConfirmBot({ exchange: 'binance', symbol: 'BTCUSDT', strategyId: 'probe', aiConfirm: true })

    expect(bridge.confirmed).toEqual([])
    expect(bridge.peeked).toHaveLength(1)
    const [request] = bridge.peeked
    expect(request.window).toHaveLength(GPT_LOOKBACK_BARS)
    // Not the forming bar: a review can only ever be of a bar that has finished.
    expect(request.window[request.window.length - 1].time).toBe(bar(1))
    // Unpinned: switching on re-pins to whatever the default is now.
    expect(request.model).toBeUndefined()
    expect(request.source).toBe('bot')

    expect(estimate?.quote).toMatchObject({ model: 'openai/gpt-5-mini', perCallCostUsd: 0.002, budgetRemainingUsd: 0.9 })
    // What the strategy alone opened over the stretch its chart replays.
    expect(estimate?.recentEntries).toBe(3)
    expect(estimate?.recentDays).toBeGreaterThanOrEqual(1)
  })
})
