import { describe, expect, it } from 'vitest'
import type { ExecutorConfig } from '../shared/ipc'
import { RESEARCH_MIN_TRADES } from '../shared/research/common'
import { agreementBucketOf, agreementValue } from '../shared/research/agreementValue'

// AGREEMENT VALUE (shared/research/agreementValue.ts; the V5 document, §90; V5 Stage 5): the
// watch's own closed paper trades by how many of the models asked took their side.

const T = 1_790_000_000

function trade(id: string, eventId: string, side: 'buy' | 'sell', pnlQuote: number, stake = 100): ExecutorConfig {
  return {
    id,
    name: 'Watch',
    type: 'position',
    exchange: 'binance',
    symbol: 'SOLUSDT',
    baseAsset: 'SOL',
    quoteAsset: 'USDT',
    createdAt: T,
    status: 'stopped',
    stoppedAt: T + 600,
    keepPosition: false,
    mode: 'paper',
    watch: { eventId, eventTime: T, model: 'a', confidence: 0.8, result: { exit: 'take_profit', pnlQuote, closedAt: T + 600 } },
    liveOrder: null,
    pendingLiveOrderIds: [],
    liveWatcherId: null,
    liveWatcherError: null,
    liveExitResult: null,
    liveDcaBasePrice: null,
    liveTwapRunId: null,
    liveTwapResult: null,
    params: { side, entryPrice: null, amountQuote: stake, takeProfitPct: 2, stopLossPct: 1.5, timeLimitSec: 3600, trailingStop: null, slippageRate: 0.0002 }
  } as unknown as ExecutorConfig
}

const call = (eventId: string, model: string, recommendation: 'buy' | 'sell' | 'hold', over: Partial<{ status: 'ok' | 'rejected' | 'failed'; source: 'watch' | 'benchmark' }> = {}) => ({
  eventId,
  model,
  recommendation,
  status: 'ok' as const,
  source: 'watch' as const,
  ...over
})

describe('the buckets', () => {
  it('are all, more than half, and half or fewer, of two or more usable answers', () => {
    expect(agreementBucketOf(3, 3)).toBe('all')
    expect(agreementBucketOf(2, 3)).toBe('majority')
    expect(agreementBucketOf(1, 3)).toBe('half_or_fewer')
    expect(agreementBucketOf(1, 2)).toBe('half_or_fewer')
    expect(agreementBucketOf(2, 2)).toBe('all')
    expect(agreementBucketOf(1, 1)).toBeNull()
    expect(agreementBucketOf(0, 0)).toBeNull()
  })
})

describe('the table', () => {
  it('puts each closed trade in its bucket by the answers on its event, and shows figures from thirty', () => {
    const executors: ExecutorConfig[] = []
    const calls: ReturnType<typeof call>[] = []
    for (let index = 0; index < RESEARCH_MIN_TRADES; index++) {
      const eventId = `all-${index}`
      executors.push(trade(`t-${eventId}`, eventId, 'buy', index % 3 === 0 ? -1 : 2))
      calls.push(call(eventId, 'a', 'buy'), call(eventId, 'b', 'buy'), call(eventId, 'c', 'buy'))
    }
    // Two of three: a minority on the other side counts against the agreement, not the trade. A
    // refused answer and a benchmark's answer on the same event are not the watch's usable ones:
    // counted, they would make it two of five, half or fewer.
    executors.push(trade('t-maj', 'maj', 'buy', 3))
    calls.push(call('maj', 'a', 'buy'), call('maj', 'b', 'buy'), call('maj', 'c', 'sell'), call('maj', 'd', 'sell', { status: 'rejected' }), call('maj', 'e', 'sell', { source: 'benchmark' }))
    // One of three.
    executors.push(trade('t-few', 'few', 'sell', -2))
    calls.push(call('few', 'a', 'sell'), call('few', 'b', 'buy'), call('few', 'c', 'hold'))
    const table = agreementValue(executors, calls)
    expect(table.modelsAsked).toBe(3)
    const by = Object.fromEntries(table.rows.map((row) => [row.bucket, row]))
    expect(by.all).toMatchObject({ name: 'All agreed', label: 'LIVE PAPER', closed: 30, wins: 20 })
    expect(by.all.winRatePct).toBeCloseTo((20 / 30) * 100, 6)
    expect(by.all.profitFactor).toBeCloseTo((20 * 2) / 10, 6)
    expect(by.all.meanNetPct).toBeCloseTo((20 * 2 - 10) / 30, 6)
    expect(by.majority).toMatchObject({ closed: 1, wins: 1, winRatePct: null, profitFactor: null, meanNetPct: null })
    expect(by.half_or_fewer).toMatchObject({ closed: 1, wins: 0 })
  })

  it('counts nothing while one model is asked, nor a trade whose event has no answers on file, nor one dropped before it entered', () => {
    const one = agreementValue([trade('t', 'e1', 'buy', 2)], [call('e1', 'a', 'buy')])
    expect(one.modelsAsked).toBe(1)
    expect(one.rows.map((row) => row.closed)).toEqual([0, 0, 0])
    const none = agreementValue([trade('t', 'e1', 'buy', 2)], [])
    expect(none.modelsAsked).toBe(0)
    // The count is of the models asked, over every event answered -- not only the events traded.
    expect(agreementValue([], [call('e2', 'a', 'buy'), call('e2', 'b', 'hold')]).modelsAsked).toBe(2)
    const dropped = { ...trade('t', 'e1', 'buy', 0), watch: { eventId: 'e1', eventTime: T, model: 'a', confidence: 0.8, result: { exit: 'btc_moved', pnlQuote: 0, closedAt: T + 60 } } } as unknown as ExecutorConfig
    expect(agreementValue([dropped], [call('e1', 'a', 'buy'), call('e1', 'b', 'buy')]).rows.map((row) => row.closed)).toEqual([0, 0, 0])
  })
})
