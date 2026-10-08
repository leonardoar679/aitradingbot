import { describe, expect, it } from 'vitest'
import type { ExecutorConfig, PositionExecutorParams } from '../shared/ipc'
import {
  ATTRIBUTION_VERSION,
  CAP_TIER_LINES,
  FRAGILE_SHARE,
  FRAGILE_TRADES,
  SCORE_BUCKETS,
  attributedTrades,
  attribution,
  attributionCsv,
  capTierOf,
  concentration,
  netSources,
  scoreBucketOf,
  scoreBuckets,
  slicesBy,
  type AttributedTrade,
  type AttributionReadings
} from '../shared/performance/attribution'

// WHERE THE RESULT CAME FROM (shared/performance/attribution.ts; the V5 document, §82-90; V5 Stage 10).

const T = Date.parse('2026-10-08T12:00:00Z') / 1000
const PARAMS: PositionExecutorParams = { side: 'buy', entryPrice: null, entryRange: { min: 99, max: 101 }, amountQuote: 100, takeProfitPct: 3, stopLossPct: 1.5, timeLimitSec: 3600, trailingStop: null, slippageRate: 0.0005 }

function made(id: string, netQuote: number, over: Partial<AttributedTrade> = {}): AttributedTrade {
  return { id, symbol: 'SOLUSDT', model: 'openai/gpt-5-mini', side: 'buy', kind: 'breakout', closedAt: T, netQuote, stakeQuote: 100, netPct: netQuote, r: netQuote / 1.8, signal: null, regime: null, capTier: null, news: null, vote: null, holdNetQuote: null, ...over }
}

function executor(id: string, over: { pnl?: number; exit?: string; regime?: 'bull'; news?: boolean; eventId?: string; side?: 'buy' | 'sell' } = {}): ExecutorConfig {
  const result = { exit: over.exit ?? 'take_profit', pnlQuote: over.pnl ?? 1, closedAt: T + 600 }
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
    stoppedAt: T + 600,
    keepPosition: false,
    mode: 'paper',
    ...(over.news
      ? { newsRule: { newsId: 1, category: 'DELISTING', ticker: 'SOL', result } as unknown as ExecutorConfig['newsRule'] }
      : { watch: { eventId: over.eventId ?? 'event-sol', eventTime: T - 60, model: 'openai/gpt-5-mini', confidence: 0.8, result, ...(over.regime ? { regime: over.regime } : {}) } as ExecutorConfig['watch'] }),
    liveOrder: null,
    pendingLiveOrderIds: [],
    liveWatcherId: null,
    liveWatcherError: null,
    liveExitResult: null,
    liveDcaBasePrice: null,
    liveTwapRunId: null,
    liveTwapResult: null,
    params: { ...PARAMS, side: over.side ?? 'buy' }
  }
}

const readings = (over: Partial<AttributionReadings> = {}): AttributionReadings => ({
  events: { 'event-sol': { id: 'event-sol', type: 'breakout', live: { detectedAt: T, quoteVolume24h: 150_000_000, spreadPct: 0.01, candidateScore: 90, rank: 1 } } },
  votes: { 'event-sol': { taking: 2, usable: 3 } },
  btc: { 'event-sol': 'rising' },
  signals: { a: 84 },
  holds: { a: 0.6 },
  news: { 'event-sol': true },
  ...over
})

describe('the trades, read', () => {
  it('takes each closed paper trade of the app\'s own with what is known of it, oldest first, and leaves out the ones that never entered', () => {
    const list = attributedTrades([executor('a', { pnl: 2 }), executor('b', { exit: 'entry_expired', pnl: 0 }), executor('c', { exit: 'btc_moved', pnl: 0 }), executor('d', { news: true, pnl: -1 })], readings())
    expect(list.map((trade) => trade.id)).toEqual(['a', 'd'])
    expect(list[0]).toMatchObject({ symbol: 'SOLUSDT', model: 'openai/gpt-5-mini', side: 'buy', kind: 'breakout', netQuote: 2, stakeQuote: 100, netPct: 2, signal: 84, regime: 'rising', capTier: 'large', news: 'with news', vote: 'majority', holdNetQuote: 0.6 })
    expect(list[0].r).toBeCloseTo(2 / 1.8, 10)
    // A news rule's trade: no model, no event record, nothing read for it.
    expect(list[1]).toMatchObject({ model: null, kind: null, signal: null, regime: null, capTier: null, news: null, vote: null, holdNetQuote: null, netQuote: -1 })
  })

  it("prefers the regime the trade recorded to Bitcoin's direction, reads the vote as one model under two, and the tier from the pair's day", () => {
    const list = attributedTrades([executor('a', { regime: 'bull' })], readings({ votes: { 'event-sol': { taking: 1, usable: 1 } } }))
    expect(list[0]).toMatchObject({ regime: 'bull', vote: 'one model' })
    expect(capTierOf(CAP_TIER_LINES.large)).toBe('large')
    expect(capTierOf(CAP_TIER_LINES.large - 1)).toBe('mid')
    expect(capTierOf(CAP_TIER_LINES.mid)).toBe('mid')
    expect(capTierOf(CAP_TIER_LINES.mid - 1)).toBe('small')
    expect(capTierOf(null)).toBeNull()
    // Oldest first, whatever order the executors came in.
    const late = { ...executor('late'), watch: { ...(executor('late').watch as NonNullable<ExecutorConfig['watch']>), result: { exit: 'take_profit', pnlQuote: 1, closedAt: T + 900 } } } as ExecutorConfig
    expect(attributedTrades([late, executor('early')], readings()).map((trade) => trade.id)).toEqual(['early', 'late'])
    expect([scoreBucketOf(90), scoreBucketOf(89.9), scoreBucketOf(80), scoreBucketOf(70), scoreBucketOf(69), scoreBucketOf(null)]).toEqual(['90+', '80-90', '80-90', '70-80', 'under 70', 'not scored'])
    expect(SCORE_BUCKETS).toHaveLength(5)
  })
})

describe('concentration', () => {
  it('says what share of the net the best few trades made, from thirty trades and a positive net, and calls five making nine tenths fragile', () => {
    // Thirty trades: one of 50, four of 10, twenty-five of 0.4 -- net 100; the best five make 90.
    // The best 1% is one trade, the best 5% two (a share rounded up), the best 10% three.
    const trades = [made('big', 50), ...Array.from({ length: 4 }, (_, k) => made(`mid${k}`, 10)), ...Array.from({ length: 25 }, (_, k) => made(`small${k}`, 0.4))]
    const c = concentration(trades)
    expect(c).toMatchObject({ trades: 30, enough: true, fragile: true })
    expect(c.netQuote).toBeCloseTo(100, 10)
    expect(c.top1Pct).toBeCloseTo(50, 10)
    expect(c.top5Pct).toBeCloseTo(60, 10)
    expect(c.top10Pct).toBeCloseTo(70, 10)
    expect(c.bestFiveSharePct).toBeCloseTo(90, 10)
    expect(FRAGILE_SHARE).toBe(0.9)
    expect(FRAGILE_TRADES).toBe(5)
    // Spread evenly, the best five make a sixth: not fragile.
    const even = concentration(Array.from({ length: 30 }, (_, k) => made(`e${k}`, 1)))
    expect(even.bestFiveSharePct).toBeCloseTo(100 / 6, 6)
    expect(even.fragile).toBe(false)
    // Under thirty, or with no positive net -- a loss, or nothing at all -- no share is said.
    expect(concentration(trades.slice(0, 29))).toMatchObject({ enough: false, top5Pct: null, fragile: false })
    expect(concentration(Array.from({ length: 30 }, (_, k) => made(`l${k}`, -1)))).toMatchObject({ enough: true, top5Pct: null, fragile: false })
    expect(concentration(Array.from({ length: 30 }, (_, k) => made(`z${k}`, k < 15 ? 1 : -1)))).toMatchObject({ enough: true, netQuote: 0, top1Pct: null, top5Pct: null, bestFiveSharePct: null, fragile: false })
  })
})

describe('the slices', () => {
  it('cut the trades by a key, in the order given, with the figures from ten trades', () => {
    const trades = [
      ...Array.from({ length: 10 }, (_, k) => made(`w${k}`, k < 6 ? 2 : -1, { signal: 92 })),
      ...Array.from({ length: 9 }, (_, k) => made(`v${k}`, 1, { signal: 85 })),
      ...Array.from({ length: 3 }, (_, k) => made(`x${k}`, 1, { signal: 75 })),
      made('y', 1, { signal: null })
    ]
    const rows = scoreBuckets(trades)
    // Ten is a slice; nine is not.
    expect(rows.map((row) => [row.key, row.trades, row.enough])).toEqual([
      ['90+', 10, true],
      ['80-90', 9, false],
      ['70-80', 3, false],
      ['not scored', 1, false]
    ])
    expect(rows[1].winRatePct).toBeNull()
    expect(rows[0]).toMatchObject({ wins: 6, winRatePct: 60, netQuote: 8 })
    expect(rows[0].expectancyPct).toBeCloseTo(0.8, 10)
    expect(rows[0].meanR).toBeCloseTo(0.8 / 1.8, 10)
    expect(rows[2]).toMatchObject({ wins: 3, winRatePct: null, expectancyPct: null, meanR: null, netQuote: 3 })
    // A key that is not known is left out; keys outside the order come after it, sorted.
    expect(slicesBy([made('a', 1, { capTier: 'small' }), made('b', 1, { capTier: null }), made('c', 1, { capTier: 'large' })], (trade) => trade.capTier, ['large', 'mid', 'small']).map((row) => row.key)).toEqual(['large', 'small'])
    expect(slicesBy([made('a', 1, { kind: 'pump' }), made('b', 1, { kind: 'breakout' })], (trade) => trade.kind).map((row) => row.key)).toEqual(['breakout', 'pump'])
  })

  it("sets the net against what holding the window made, by a key, over the trades it was read for", () => {
    const trades = [made('a', 2, { holdNetQuote: 3 }), made('b', -1, { holdNetQuote: -2 }), made('c', 5, { holdNetQuote: null })]
    const rows = netSources(trades, () => 'all')
    expect(rows).toEqual([{ key: 'all', trades: 2, netQuote: 1, holdNetQuote: 1, restQuote: 0, enough: false }])
    expect(netSources(trades, (trade) => (trade.id === 'a' ? 'news' : null))).toEqual([{ key: 'news', trades: 1, netQuote: 2, holdNetQuote: 3, restQuote: -1, enough: false }])
  })

  it('builds every table at once, and writes them as one spreadsheet', () => {
    const trades = Array.from({ length: 12 }, (_, k) => made(`t${k}`, k % 3 === 0 ? -1 : 1.5, { signal: 85, regime: 'bull', capTier: 'large', news: 'with news', vote: 'all', holdNetQuote: 1 }))
    const report = attribution(trades)
    expect(report.version).toBe(ATTRIBUTION_VERSION)
    expect(report.trades).toBe(12)
    expect(report.scores[0]).toMatchObject({ key: '80-90', trades: 12, wins: 8 })
    expect(report.byRegime[0].key).toBe('bull')
    expect(report.byVote[0]).toMatchObject({ key: 'all', trades: 12, enough: true })
    expect(report.sources.all[0]).toMatchObject({ trades: 12, holdNetQuote: 12, enough: true })
    expect(report.sources.all[0].restQuote).toBeCloseTo(8 * 1.5 - 4 - 12, 10)
    const csv = attributionCsv(report)
    expect(csv.split('\n')[0]).toBe('table,key,trades,wins or net,win rate % or hold,expectancy % or rest,net or note')
    expect(csv).toContain('score,80-90,12,8,66.67,')
    expect(csv).toContain('source,all,12,')
    expect(csv).toContain('concentration,trades,12,')
  })
})
