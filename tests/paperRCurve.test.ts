import { describe, expect, it } from 'vitest'
import type { ExecutorConfig, PositionExecutorParams } from '../shared/ipc'
import { paperRCurves } from '../shared/paperRCurve'

// shared/paperRCurve.ts: the app's own paper trades as a running total in R, one line for the watch
// and one for the news rules, drawn on Performance (src/performance/PaperRCurveCard.tsx).

const T = Date.parse('2026-10-05T00:00:00Z') / 1000
const H = 3600

type Exit = NonNullable<NonNullable<ExecutorConfig['watch']>['result']>['exit']

const params = (amountQuote: number, stopLossPct: number | null): PositionExecutorParams => ({
  side: 'buy',
  entryPrice: null,
  amountQuote,
  takeProfitPct: null,
  stopLossPct,
  timeLimitSec: 3600,
  trailingStop: null
})

function position(id: string, overrides: Partial<ExecutorConfig>): ExecutorConfig {
  return {
    id,
    name: id,
    type: 'position',
    exchange: 'binance',
    symbol: 'SOLUSDT',
    baseAsset: 'SOL',
    quoteAsset: 'USDT',
    createdAt: T,
    status: 'stopped',
    stoppedAt: null,
    keepPosition: false,
    mode: 'paper',
    liveOrder: null,
    pendingLiveOrderIds: [],
    liveWatcherId: null,
    liveWatcherError: null,
    liveExitResult: null,
    liveDcaBasePrice: null,
    liveTwapRunId: null,
    liveTwapResult: null,
    // 100 staked 1.5% from its stop, with a round trip's fees of 0.2%: 1.70 risked.
    params: params(100, 1.5),
    ...overrides
  }
}

const watched = (id: string, openedAt: number, exit: Exit, pnlQuote: number, closedAt: number, overrides: Partial<ExecutorConfig> = {}): ExecutorConfig =>
  position(id, { createdAt: openedAt, watch: { eventId: id, eventTime: openedAt, model: 'openai/gpt-5-mini', confidence: 0.8, result: { exit, pnlQuote, closedAt } }, ...overrides })

const shorted = (id: string, stopLossPct: number | null, pnlQuote: number, closedAt: number): ExecutorConfig =>
  position(id, {
    createdAt: closedAt - H,
    params: params(100, stopLossPct),
    newsRule: { articleId: 1, ticker: 'SOL', releaseSec: closedAt - H, title: 't', category: stopLossPct === null ? 'DELISTING' : 'MONITORING_TAG', result: { exit: 'time_limit', pnlQuote, closedAt } }
  })

describe('the running total in R', () => {
  it('adds up each line from zero, in the order the trades closed', () => {
    const curves = paperRCurves([
      watched('second', T + 2 * H, 'stop_loss', -1.7, T + 3 * H),
      watched('first', T + H, 'take_profit', 3.4, T + 2 * H),
      watched('third', T + 4 * H, 'time_limit', 0.85, T + 5 * H)
    ])
    expect(curves.watch.points).toEqual([
      { time: T + H, r: 0 },
      { time: T + 2 * H, r: expect.closeTo(2, 9) },
      { time: T + 3 * H, r: expect.closeTo(1, 9) },
      { time: T + 5 * H, r: expect.closeTo(1.5, 9) }
    ])
    expect(curves.watch).toMatchObject({ trades: 3, ahead: 2, unmeasured: 0 })
    expect(curves.news).toEqual({ points: [], trades: 0, ahead: 0, unmeasured: 0 })
  })

  it('keeps the news rules apart, and counts a delisting short beside its line, not on it', () => {
    const curves = paperRCurves([shorted('tag', 2, -1.1, T + 3 * H), shorted('delisting', null, 12.4, T + 4 * H), watched('w', T, 'take_profit', 1.7, T + H)])
    // 100 staked 2% from its stop: 2.20 risked, so -1.10 is -0.5 R.
    expect(curves.news.points).toEqual([
      { time: T + 2 * H, r: 0 },
      { time: T + 3 * H, r: expect.closeTo(-0.5, 9) }
    ])
    expect(curves.news).toMatchObject({ trades: 1, ahead: 0, unmeasured: 1 })
    expect(curves.watch.trades).toBe(1)
    // With only trades that cannot be measured, there is no line, and they are still counted.
    expect(paperRCurves([shorted('delisting', null, 12.4, T + 4 * H)]).news).toEqual({ points: [], trades: 0, ahead: 0, unmeasured: 1 })
  })

  it('makes one point of trades that closed in the same second, so the times strictly rise', () => {
    const curves = paperRCurves([watched('a', T, 'take_profit', 1.7, T + H), watched('b', T, 'stop_loss', -1.7, T + H), watched('c', T, 'take_profit', 1.7, T + 2 * H)])
    expect(curves.watch.points.map((point) => point.time)).toEqual([T, T + H, T + 2 * H])
    expect(curves.watch.points[1].r).toBeCloseTo(0, 9)
    // A trade opened and closed in its first second still has a zero before it.
    expect(paperRCurves([watched('quick', T, 'take_profit', 1.7, T)]).watch.points).toEqual([
      { time: T - 1, r: 0 },
      { time: T, r: expect.closeTo(1, 9) }
    ])
  })

  it('draws only entered paper positions of the app\'s own, with how they ended on file', () => {
    const curves = paperRCurves([
      watched('expired', T, 'entry_expired', 0, T + H),
      watched('dropped', T, 'btc_moved', 0, T + H),
      watched('open', T, 'take_profit', 1.7, T + H, { status: 'active' }),
      watched('real', T, 'take_profit', 1.7, T + H, { mode: 'live' }),
      watched('grid', T, 'take_profit', 1.7, T + H, { type: 'grid' }),
      // Stopped by hand: nothing written on it.
      position('by hand', { watch: { eventId: 'x', eventTime: T, model: 'openai/gpt-5-mini', confidence: 0.8 } }),
      // A paper position made by hand carries no mark.
      position('mine', {})
    ])
    expect(curves.watch).toEqual({ points: [], trades: 0, ahead: 0, unmeasured: 0 })
    expect(curves.news).toEqual({ points: [], trades: 0, ahead: 0, unmeasured: 0 })
  })
})
