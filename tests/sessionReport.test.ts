import { beforeEach, describe, expect, it } from 'vitest'
import type { AiCallRecord } from '../shared/aiLedger'
import { roundTripFee } from '../shared/fees'
import type { Candle, ExecutorConfig, PositionExecutorParams } from '../shared/ipc'
import { EVENT_DETECTOR_VERSION, type MarketEvent } from '../shared/marketEvent'
import { clearSettledFeedBars } from '../src/agents/opportunities'
import { simulatePosition } from '../src/executors/engine'
import { buildSessionReport, readTrade, spanStart, type SessionReportDeps } from '../src/performance/sessionReport'

// src/performance/sessionReport.ts: what the session report reads -- the records, and the minutes of
// each trade and recommendation in the span -- with everything it reaches faked.

const T = Date.parse('2026-10-06T12:00:00Z') / 1000
const NOW = T + 30
const OPENED = T - 1800 + 20
const ENTERED = T - 1740
const MODEL = 'openai/gpt-5-mini'

const bar = (time: number, open: number, high: number, low: number, close: number): Candle => ({ time, open, high, low, close, volume: 1 })

const PARAMS: PositionExecutorParams = {
  side: 'buy',
  entryPrice: null,
  amountQuote: 100,
  takeProfitPct: 3,
  stopLossPct: 1.5,
  timeLimitSec: 3600,
  trailingStop: null,
  entryRange: { min: 99.8, max: 100.2 },
  entryExpiresAt: OPENED + 900
}

function trade(over: Partial<ExecutorConfig> = {}, params: Partial<PositionExecutorParams> = {}): ExecutorConfig {
  return {
    id: 'sol',
    name: 'Watch: BUY SOLUSDT',
    type: 'position',
    exchange: 'binance',
    symbol: 'SOLUSDT',
    baseAsset: 'SOL',
    quoteAsset: 'USDT',
    createdAt: OPENED,
    status: 'active',
    stoppedAt: null,
    keepPosition: false,
    mode: 'paper',
    watch: { eventId: `binance:SOLUSDT:${T - 1860}`, eventTime: T - 1860, model: MODEL, confidence: 0.8, book: { bid: 99.99, ask: 100.01, spreadPct: 0.02, ageMs: 800, source: 'stream' } },
    liveOrder: null,
    pendingLiveOrderIds: [],
    liveWatcherId: null,
    liveWatcherError: null,
    liveExitResult: null,
    liveDcaBasePrice: null,
    liveTwapRunId: null,
    liveTwapResult: null,
    params: { ...PARAMS, ...params },
    ...over
  }
}

/** Entered at 100 in the minute after it was opened, up to 101.5 and down to 99.2, then the target. */
const MINUTES: Candle[] = [
  bar(T - 1860, 100, 100.1, 99.9, 100),
  bar(T - 1800, 100, 100.1, 99.9, 100),
  bar(ENTERED, 100, 100.2, 99.9, 100.1),
  bar(ENTERED + 60, 100.1, 101.5, 100, 101),
  bar(ENTERED + 120, 101, 101, 99.2, 99.5),
  bar(ENTERED + 180, 99.5, 103.4, 99.5, 103.1),
  bar(ENTERED + 240, 103.1, 103.2, 102.8, 103)
]

describe('readTrade', () => {
  it('reads where it entered and left, how far it went each way while held, and its gross and fees as the engine has them', () => {
    const reading = readTrade(trade(), MINUTES, NOW)
    const engine = simulatePosition(MINUTES.filter((candle) => candle.time >= OPENED), PARAMS)
    expect(engine).toMatchObject({ status: 'closed', exitReason: 'take_profit', enteredAt: ENTERED, exitPrice: 103 })
    expect(reading).toEqual({
      executorId: 'sol',
      entryPrice: 100,
      enteredAt: ENTERED,
      exitPrice: 103,
      bestPct: expect.closeTo(3.4, 9),
      worstPct: expect.closeTo(-0.8, 9),
      grossQuote: expect.closeTo(3, 9),
      feesQuote: roundTripFee(1, 100, 103)
    })
    // The engine's own net is that gross less those fees.
    expect((reading.grossQuote as number) - (reading.feesQuote as number)).toBeCloseTo(engine.realizedPnl as number, 9)
  })

  it('reads a short the other way round, and one still open with no exit', () => {
    const short = readTrade(trade({}, { side: 'sell', takeProfitPct: 10, stopLossPct: 10 }), MINUTES, NOW)
    expect(short).toMatchObject({ entryPrice: 100, exitPrice: null, grossQuote: null, feesQuote: null })
    expect(short.bestPct).toBeCloseTo(0.8, 9)
    expect(short.worstPct).toBeCloseTo(-3.4, 9)
  })

  it('reads nothing for a trade that never entered, or whose minutes are not there', () => {
    expect(readTrade(trade({}, { entryRange: { min: 90, max: 91 } }), MINUTES, NOW)).toMatchObject({ entryPrice: null, bestPct: null, grossQuote: null })
    expect(readTrade(trade(), [], NOW)).toMatchObject({ entryPrice: null })
    // A minute still forming is not read.
    expect(readTrade(trade(), MINUTES, ENTERED + 30).entryPrice).toBeNull()
  })
})

describe('buildSessionReport', () => {
  beforeEach(() => clearSettledFeedBars())

  const EVENT: MarketEvent = {
    id: `binance:SOLUSDT:${T - 1860}`,
    exchange: 'binance',
    symbol: 'SOLUSDT',
    baseAsset: 'SOL',
    quoteAsset: 'USDT',
    time: T - 1860,
    type: 'breakout',
    direction: 'up',
    band: 'urgent',
    score: 90,
    components: { price: 90, volume: 90, volatility: 80, pressure: 90, breakout: 90 },
    price: 100,
    returnsPct: { m1: 0.4, m5: 1.5, m15: 3, h1: 3.2, h4: 2.5 },
    moveSigmas: 6,
    volumeRatio: 4,
    rangeRatio: 3,
    live: { detectedAt: T - 1852, quoteVolume24h: 8e7, spreadPct: 0.01, candidateScore: 93, rank: 1 }
  }
  const ANSWER: AiCallRecord = {
    id: 'a',
    at: T - 1840,
    source: 'watch',
    status: 'ok',
    model: MODEL,
    provider: 'Test',
    promptVersion: 'opportunity-v1',
    contextVersion: 'context-v1',
    schemaVersion: 'opportunity-schema-v1',
    exchange: 'binance',
    symbol: 'SOLUSDT',
    interval: '15m',
    candleTime: T - 1860,
    position: 'flat',
    referencePrice: 100,
    usage: { promptTokens: 2000, completionTokens: 300, costUsd: 0.002, latencyMs: 9000 },
    error: null,
    recommendation: 'buy',
    confidence: 0.8,
    rationale: 'Cleared the range.',
    detail: { marketRegime: 'bull', riskLevel: 'medium', horizonBars: 1, stopLoss: 98.5, takeProfit: 103, reasonCodes: [], levelsNote: null, entry: { min: 99.8, max: 100.2, validMinutes: 15 } },
    eventId: `binance:SOLUSDT:${T - 1860}`,
    eventType: 'breakout'
  }

  function deps(over: Partial<SessionReportDeps> = {}): SessionReportDeps & { reads: string[] } {
    const reads: string[] = []
    return {
      reads,
      listEvents: async () => [EVENT],
      listCalls: async () => [ANSWER],
      getSettings: async () => ({ executors: [trade()], paperRisk: undefined }),
      getConfig: async () => ({ watchPaper: { enabled: true, model: MODEL, stakeQuote: 100, maxOpen: 3, maxSameSide: 2, pauseAfterLosses: 3, dropOnBtcMovePct: 1 } }),
      liveConnection: async () => ({ open: true, connects: 1, drops: 0, lastMessageAt: NOW * 1000, gaps: [], host: 'data-api.binance.vision', hostSwitches: 0, dataHostSwitches: 0, connectedAt: null, planned: 0, subscribeErrors: 0 }),
      stories: async () => [{ url: 'https://www.coindesk.com/a', publishedAt: T - 600 }],
      fetchCandles: async (_exchange, symbol, interval, startSec, endSec) => {
        reads.push(`${symbol}:${interval}:${startSec}`)
        return MINUTES.filter((candle) => candle.time >= startSec && candle.time <= endSec)
      },
      alerts: async () => [{ at: T - 60, severity: 'high' }],
      refusals: async () => [{ id: 'r1', at: T - 120, source: 'watch', symbol: 'ADAUSDT', text: 'No paper trade: 3 are open already, the most at once.' }],
      effectiveConfig: async () => ({ configVersion: 'cfg0000000001', engineVersion: 'eng0000000001' }),
      appStartedSec: T - 7200,
      nowSec: () => NOW,
      ...over
    }
  }

  describe('the versions the report ran under', () => {
    it('names the configuration, the engine, the detector and the prompt and schema versions of the span\'s calls', async () => {
      const report = await buildSessionReport('hour', T - 3600, deps())
      expect(report.versions).toEqual({ config: 'cfg0000000001', engine: 'eng0000000001', detector: EVENT_DETECTOR_VERSION, prompts: [ANSWER.promptVersion], schemas: [ANSWER.schemaVersion] })
    })

    it('reads the alerts and the refusals for the span, and says nothing of versions it could not read', async () => {
      const asked: number[] = []
      const report = await buildSessionReport(
        'hour',
        T - 3600,
        deps({
          alerts: async (sinceSec) => {
            asked.push(sinceSec)
            return []
          },
          refusals: async (sinceSec) => {
            asked.push(sinceSec)
            return []
          },
          effectiveConfig: async () => {
            throw new Error('no bridge')
          }
        })
      )
      expect(asked).toEqual([T - 3600, T - 3600])
      expect(report.versions).toBeNull()
    })
  })

  it('reads the records, the minutes of each trade and recommendation in the span, and reports them', async () => {
    const fake = deps()
    const report = await buildSessionReport('hour', T - 3600, fake)
    expect(report).toMatchObject({ span: 'hour', fromSec: T - 3600, toSec: NOW, appStartedSec: T - 7200 })
    expect(report.events).toEqual({ raised: 1, urgent: 1, takenUp: 1 })
    expect(report.answers).toEqual({ buy: 1, sell: 0, hold: 0, noTrade: 0 })
    expect(report.paper).toMatchObject({ opened: 1, openedWatch: 1, open: 1, bestPct: expect.closeTo(3.4, 9), refused: [{ reason: '# are open already, the most at once.', count: 1 }] })
    expect(report.alerts.high).toBe(1)
    // One read for the trade, from when it was opened, and one for the event's recommendation.
    expect(fake.reads.sort()).toEqual([`SOLUSDT:1m:${OPENED}`, `SOLUSDT:1m:${T - 1860}`].sort())
    // Its recommendation entered and reached its target: it has its outcome.
    expect(report.gates.find((gate) => gate.id === 'outcomes')).toMatchObject({ status: 'pass' })
    expect(report.gates.filter((gate) => !gate.twelveHour).every((gate) => gate.status === 'pass')).toBe(true)
  })

  it('reads a recommendation whose minutes cannot be read as without an outcome, and a trade as not measured', async () => {
    const report = await buildSessionReport(
      'twelve',
      T - 43_200,
      deps({
        fetchCandles: async () => {
          throw new Error('down')
        }
      })
    )
    expect(report.gates.find((gate) => gate.id === 'outcomes')).toMatchObject({ status: 'fail' })
    expect(report.paper.bestPct).toBeNull()
  })

  it('reports without the stream or the stories when they cannot be read', async () => {
    const report = await buildSessionReport(
      'hour',
      T - 3600,
      deps({
        liveConnection: async () => {
          throw new Error('down')
        },
        stories: async () => {
          throw new Error('down')
        }
      })
    )
    expect(report.stream).toBeNull()
    expect(report.gates.find((gate) => gate.id === 'stream_gaps')?.status).toBe('not measured')
    expect(report.gates.find((gate) => gate.id === 'news_links')?.status).toBe('not measured')
  })

  it('reads a span from its choice', () => {
    expect(spanStart('hour', NOW, null)).toBe(NOW - 3600)
    expect(spanStart('twelve', NOW, null)).toBe(NOW - 43_200)
    expect(spanStart('day', NOW, null)).toBe(NOW - 86_400)
    expect(spanStart('session', NOW, T - 600)).toBe(T - 600)
  })
})

describe('readTrade, on a trade filled from the live book', () => {
  it('reads the fill as its entry, from the minute it was made in', () => {
    const fill = { price: 100.05, at: OPENED + 20 }
    const reading = readTrade(trade({}, { entryFill: fill }), MINUTES, NOW)
    expect(reading.enteredAt).toBe(Math.floor((OPENED + 20) / 60) * 60)
    expect(reading.entryPrice).toBeCloseTo(100.05 * (1 + (PARAMS.slippageRate ?? 0)), 10)
  })
})
