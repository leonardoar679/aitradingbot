import { describe, expect, it } from 'vitest'
import type { AiCallRecord } from '../shared/aiLedger'
import type { ExecutorConfig } from '../shared/ipc'
import { describeTradeCosts, modelTradeCosts, tradeCosts } from '../shared/aiCostPerTrade'

// shared/aiCostPerTrade.ts: what the ledger says was spent to make each of the watch's paper trades,
// and by model what a trade, a winning trade and a dollar of net result cost.

const A = 'openai/gpt-5-mini'
const B = 'mistralai/mistral-small-2603'

function trade(id: string, model: string, eventId: string, pnlQuote: number | null): ExecutorConfig {
  return {
    id,
    name: id,
    type: 'position',
    exchange: 'binance',
    symbol: 'SOLUSDT',
    baseAsset: 'SOL',
    quoteAsset: 'USDT',
    createdAt: 1,
    status: pnlQuote === null ? 'active' : 'stopped',
    stoppedAt: null,
    keepPosition: false,
    mode: 'paper',
    watch: { eventId, eventTime: 1, model, confidence: 0.8, ...(pnlQuote === null ? {} : { result: { exit: pnlQuote > 0 ? 'take_profit' : 'stop_loss', pnlQuote, closedAt: 2 } }) },
    liveOrder: null,
    pendingLiveOrderIds: [],
    liveWatcherId: null,
    liveWatcherError: null,
    liveExitResult: null,
    liveDcaBasePrice: null,
    liveTwapRunId: null,
    liveTwapResult: null,
    params: { side: 'buy', entryPrice: null, amountQuote: 100, takeProfitPct: 3, stopLossPct: 1.5, timeLimitSec: 3600, trailingStop: null }
  } as ExecutorConfig
}

function call(over: Partial<AiCallRecord> & { costUsd: number }): AiCallRecord {
  const { costUsd, ...rest } = over
  return { id: `r-${Math.random()}`, source: 'watch', model: A, usage: { promptTokens: 1, completionTokens: 1, costUsd, latencyMs: 1 }, ...rest } as AiCallRecord
}

const E1 = 'binance:SOLUSDT:100'
const E2 = 'binance:SOLUSDT:200'

describe("what one trade's answers cost", () => {
  it("adds the watch's calls on the event, whichever model answered, and the reviewer's and the exit check's looks at the trade", () => {
    const rows = [
      call({ eventId: E1, model: A, costUsd: 0.01 }),
      call({ eventId: E1, model: B, costUsd: 0.02 }),
      call({ eventId: E2, model: A, costUsd: 0.04 }),
      call({ source: 'addition', addition: 'review', subjectId: E1, costUsd: 0.003 }),
      call({ source: 'addition', addition: 'exit', subjectId: 't1:near_stop', costUsd: 0.005 }),
      call({ source: 'addition', addition: 'exit', subjectId: 't1:news+opposite_move', costUsd: 0.005 }),
      call({ source: 'addition', addition: 'exit', subjectId: 't9:near_stop', costUsd: 0.1 }),
      call({ source: 'addition', addition: 'news', subjectId: 'story-1', costUsd: 0.2 }),
      call({ source: 'opportunity', eventId: E1, costUsd: 0.3 })
    ]
    const costs = tradeCosts([trade('t1', A, E1, 2.5), trade('t2', B, E2, null)], rows)
    expect(costs).toEqual([
      { executorId: 't1', model: A, eventId: E1, callsUsd: 0.03, additionsUsd: 0.013, totalUsd: 0.043, pnlQuote: 2.5 },
      { executorId: 't2', model: B, eventId: E2, callsUsd: 0.04, additionsUsd: 0, totalUsd: 0.04, pnlQuote: null }
    ])
  })

  it('counts a trade whose calls cost nothing, and leaves out what is not a paper position of the watch', () => {
    const live = { ...trade('l1', A, E1, 1), mode: 'live' as const }
    const plain = { ...trade('p1', A, E1, 1), watch: undefined }
    expect(tradeCosts([trade('t1', A, E1, 1), live, plain], [])).toEqual([{ executorId: 't1', model: A, eventId: E1, callsUsd: 0, additionsUsd: 0, totalUsd: 0, pnlQuote: 1 }])
  })
})

describe('by model', () => {
  const costs = [
    { executorId: 't1', model: A, eventId: E1, callsUsd: 0.03, additionsUsd: 0.01, totalUsd: 0.04, pnlQuote: 2.5 },
    { executorId: 't2', model: A, eventId: E2, callsUsd: 0.02, additionsUsd: 0, totalUsd: 0.02, pnlQuote: -1 },
    { executorId: 't3', model: A, eventId: 'binance:SOLUSDT:300', callsUsd: 0.02, additionsUsd: 0, totalUsd: 0.02, pnlQuote: null },
    { executorId: 't4', model: B, eventId: E2, callsUsd: 0.05, additionsUsd: 0, totalUsd: 0.05, pnlQuote: -2 }
  ]

  it('gives the cost a trade over every trade, a winning trade over the closed ones, and a dollar of net where the net is positive', () => {
    const entries = modelTradeCosts(costs)
    expect(entries.map((entry) => entry.model)).toEqual([B, A])
    expect(entries[1]).toEqual({ model: A, trades: 3, closed: 2, wins: 1, costUsd: 0.08, perTradeUsd: 0.08 / 3, perWinUsd: 0.06, netQuote: 1.5, perNetDollar: 0.06 / 1.5 })
    expect(entries[0]).toEqual({ model: B, trades: 1, closed: 1, wins: 0, costUsd: 0.05, perTradeUsd: 0.05, perWinUsd: null, netQuote: -2, perNetDollar: null })
    expect(modelTradeCosts([])).toEqual([])
  })

  it('says it in one sentence', () => {
    const [b, a] = modelTradeCosts(costs)
    expect(describeTradeCosts(a)).toBe('$0.03 a trade over 3, $0.06 a winning trade, 4.0 cents a dollar of net result.')
    expect(describeTradeCosts(b)).toBe('$0.05 a trade over 1, no winning trade yet, no positive net to set it against.')
  })
})
