import { describe, expect, it } from 'vitest'
import type { AiCallRecord } from '../shared/aiLedger'
import type { ExecutorConfig, PositionExecutorParams } from '../shared/ipc'
import { rMultiple } from '../shared/paperRisk'
import {
  REPORT_LINES,
  refusalReason,
  sessionReportCsv,
  sessionReportOf,
  type GateId,
  type ReportGate,
  type ReportTradeReading,
  type SessionReport,
  type SessionReportInput
} from '../shared/shadowReport'

// shared/shadowReport.ts: the session report's figures and the V3 document's gates for its 1-hour and
// 12-hour test runs, each worked out from records handed to it.

const T = Date.parse('2026-10-06T12:00:00Z') / 1000
const HOUR = 3600
const MODEL = 'openai/gpt-5-mini'

const PARAMS: PositionExecutorParams = {
  side: 'buy',
  entryPrice: null,
  amountQuote: 100,
  takeProfitPct: 3,
  stopLossPct: 1.5,
  timeLimitSec: 3600,
  trailingStop: null,
  entryRange: { min: 99.8, max: 100.2 },
  entryExpiresAt: null,
  // What the watch's paper trades carry: the rate their recommendation is scored at.
  slippageRate: 0.0002
}

const BOOK = { bid: 99.99, ask: 100.01, spreadPct: 0.02, ageMs: 900, source: 'stream' as const }

function trade(id: string, over: Partial<ExecutorConfig> = {}, mark: Partial<NonNullable<ExecutorConfig['watch']>> = {}, params: Partial<PositionExecutorParams> = {}): ExecutorConfig {
  const createdAt = over.createdAt ?? T - 1800
  return {
    id,
    name: `Watch: BUY ${id}`,
    type: 'position',
    exchange: 'binance',
    symbol: `${id.toUpperCase()}USDT`,
    baseAsset: id.toUpperCase(),
    quoteAsset: 'USDT',
    createdAt,
    status: 'active',
    stoppedAt: null,
    keepPosition: false,
    mode: 'paper',
    watch: { eventId: `event-${id}`, eventTime: createdAt - 40, model: MODEL, confidence: 0.8, book: BOOK, ...mark },
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

function ended(id: string, pnlQuote: number, closedAt = T - 600, over: Partial<ExecutorConfig> = {}): ExecutorConfig {
  const base = trade(id, { status: 'stopped', stoppedAt: closedAt + 60, ...over })
  return { ...base, watch: { ...(base.watch as NonNullable<ExecutorConfig['watch']>), result: { exit: 'take_profit', pnlQuote, closedAt } } }
}

type Call = SessionReportInput['calls'][number]

function call(over: Partial<AiCallRecord> = {}): Call {
  return {
    at: T - 1830,
    source: 'watch',
    status: 'ok',
    model: MODEL,
    eventId: 'event-sol',
    recommendation: 'buy',
    confidence: 0.8,
    detail: { marketRegime: 'bull', riskLevel: 'medium', horizonBars: 4, stopLoss: 98.5, takeProfit: 103, reasonCodes: [], levelsNote: null, entry: { min: 99.8, max: 100.2, validMinutes: 15 } },
    usage: { promptTokens: 1000, completionTokens: 100, costUsd: 0.001, latencyMs: 8000 },
    ...over
  }
}

/** A clean hour: one open trade of the watch's, one that ended, each traced and in shape. */
function input(over: Partial<SessionReportInput> = {}): SessionReportInput {
  const executors = [trade('sol'), ended('eth', 2.5)]
  return {
    span: 'hour',
    fromSec: T - HOUR,
    toSec: T,
    appStartedSec: T - 5 * HOUR,
    events: [
      { id: 'event-sol', time: T - 1840, band: 'urgent' },
      { id: 'event-eth', time: T - 1840, band: 'urgent' },
      { id: 'event-old', time: T - 2 * HOUR, band: 'urgent' },
      { id: 'event-ada', time: T - 900, band: 'notable' }
    ],
    calls: [call(), call({ eventId: 'event-eth' }), call({ source: 'addition', eventId: undefined, recommendation: null, detail: null, usage: { promptTokens: 1, completionTokens: 1, costUsd: 0.0005, latencyMs: 2000 } })],
    executors,
    watchPaper: { maxOpen: 3, maxSameSide: 2 },
    maxOutQuote: null,
    connection: { open: true, connects: 2, drops: 1, lastMessageAt: T * 1000, gaps: [{ from: T - 1200, to: T - 1100 }], host: 'data-api.binance.vision', hostSwitches: 0, dataHostSwitches: 0 },
    alerts: [
      { at: T - 100, severity: 'high' },
      { at: T - 200, severity: 'info' },
      { at: T - 2 * HOUR, severity: 'critical' }
    ],
    refusals: [],
    recommendations: [
      { eventId: 'event-sol', model: MODEL, endsAt: T - 60, status: 'closed' },
      { eventId: 'event-eth', model: MODEL, endsAt: T - 60, status: 'expired' }
    ],
    trades: [
      { executorId: 'sol', entryPrice: 100, enteredAt: T - 1740, exitPrice: null, bestPct: 1.2, worstPct: -0.4, grossQuote: null, feesQuote: null },
      { executorId: 'eth', entryPrice: 100, enteredAt: T - 1740, exitPrice: 102.7, bestPct: 3.1, worstPct: -0.2, grossQuote: 2.7, feesQuote: 0.2 }
    ],
    stories: [{ url: 'https://www.coindesk.com/a', publishedAt: T - 300 }],
    ...over
  }
}

const gateOf = (report: SessionReport, id: GateId): ReportGate => report.gates.find((entry) => entry.id === id) as ReportGate

describe('the figures', () => {
  it('counts the events, the calls and the answers in the span, and nothing before it', () => {
    const report = sessionReportOf(
      input({
        calls: [
          call(),
          call({ eventId: 'event-eth', status: 'rejected', usage: { promptTokens: 1, completionTokens: 1, costUsd: 0.002, latencyMs: 12_000 } }),
          call({ eventId: 'event-ada', status: 'failed', usage: { promptTokens: 0, completionTokens: 0, costUsd: null, latencyMs: 0 } }),
          call({ eventId: 'event-ada', recommendation: 'hold', detail: null, usage: { promptTokens: 1, completionTokens: 1, costUsd: 0.001, latencyMs: 4000 } }),
          call({ eventId: 'event-ada', recommendation: 'sell', confidence: 0.6 }),
          call({ eventId: 'event-ada', recommendation: 'sell', confidence: 0.9 }),
          call({ eventId: 'event-ada', recommendation: 'buy', detail: null }),
          call({ at: T - 2 * HOUR })
        ]
      })
    )
    expect(report.events).toEqual({ raised: 3, urgent: 2, takenUp: 3 })
    expect(report.calls).toMatchObject({ total: 7, answered: 6, valid: 5, failed: 1, successRate: 6 / 7, validationRate: 5 / 6, latencyP50Ms: 8000, latencyP95Ms: 12_000 })
    expect(report.calls.costUsd).toBeCloseTo(0.001 + 0.002 + 0.001 + 0.001 * 3, 9)
    // BUY and SELL the app would act on; HOLD, the model's word; NO TRADE, a side it would not act on.
    expect(report.answers).toEqual({ buy: 1, sell: 1, hold: 1, noTrade: 2 })
  })

  it("adds up the app's own paper trades: opened, ended, open, what they made in money and in R, and their fees", () => {
    const news: ExecutorConfig = {
      ...trade('abc', { createdAt: T - 900, name: 'Delisting short · ABCUSDT', watch: undefined, newsRule: { articleId: 7, ticker: 'ABC', releaseSec: T - 930, title: 'Binance Will Delist ABC', category: 'DELISTING' } }, {}, { side: 'sell', stopLossPct: null, takeProfitPct: null, entryRange: null }),
      status: 'stopped',
      stoppedAt: T - 100
    }
    const shortEnded: ExecutorConfig = { ...news, newsRule: { ...(news.newsRule as NonNullable<ExecutorConfig['newsRule']>), result: { exit: 'time_limit', pnlQuote: 4, closedAt: T - 160 } } }
    const neverIn: ExecutorConfig = { ...ended('xrp', 0), watch: { ...(ended('xrp', 0).watch as NonNullable<ExecutorConfig['watch']>), result: { exit: 'entry_expired', pnlQuote: 0, closedAt: T - 700 } } }
    const report = sessionReportOf(input({ executors: [trade('sol'), ended('eth', 2.5), shortEnded, neverIn, ended('old', 9, T - 2 * HOUR, { createdAt: T - 3 * HOUR })] }))
    expect(report.paper).toMatchObject({ opened: 4, openedWatch: 3, openedNews: 1, ended: 3, open: 1 })
    expect(report.paper.net).toEqual([{ asset: 'USDT', amount: 6.5 }])
    expect(report.paper.rTrades).toBe(1)
    expect(report.paper.r).toBeCloseTo(rMultiple(2.5, PARAMS) as number, 9)
    expect(report.paper.fees).toEqual([{ asset: 'USDT', amount: 0.2 }])
    expect(report.paper.bestPct).toBe(3.1)
    expect(report.paper.worstPct).toBe(-0.4)
    // From the event to the paper trade, for the watch's.
    expect(report.paper.signalAgeSec).toEqual({ median: 40, max: 40 })
  })

  it('counts the refusals, the alerts and the stream in the span, alike refusals together', () => {
    const report = sessionReportOf(
      input({
        refusals: [
          { at: T - 100, source: 'watch', text: 'No paper trade: 3 are open already, the most at once.' },
          { at: T - 200, source: 'watch', text: 'No paper trade: 2 are open already, the most at once.' },
          { at: T - 300, source: 'news', text: 'ABC: no paper short, as it has no USDT pair on Binance.' },
          { at: T - 2 * HOUR, source: 'watch', text: 'No paper trade: old.' }
        ],
        connection: { open: true, connects: 4, drops: 3, lastMessageAt: T * 1000, gaps: [{ from: T - 2 * HOUR, to: T - 2 * HOUR + 60 }, { from: T - HOUR - 30, to: T - HOUR + 90 }, { from: T - 400, to: T - 300 }], host: 'binance.com', hostSwitches: 1, dataHostSwitches: 2 }
      })
    )
    expect(report.paper.refused).toEqual([
      { reason: '# are open already, the most at once.', count: 2 },
      { reason: 'as it has no USDT pair on Binance.', count: 1 }
    ])
    expect(report.alerts).toEqual({ info: 1, watch: 0, high: 1, critical: 0 })
    // The gap that began before the span counts from where the span begins.
    expect(report.stream).toEqual({ connects: 4, drops: 3, gaps: 2, gapSeconds: 90 + 100, longestGapSeconds: 100, host: 'binance.com', hostSwitches: 1, dataHostSwitches: 2 })
  })

  it('reads latency by nearest rank: the median and the 95th percentile of the answers that came back', () => {
    const latency = (ms: number): Call => call({ eventId: 'x', usage: { promptTokens: 1, completionTokens: 1, costUsd: 0, latencyMs: ms } })
    const report = sessionReportOf(input({ calls: [latency(4000), latency(1000), latency(3000), latency(2000), call({ status: 'failed', usage: { promptTokens: 0, completionTokens: 0, costUsd: null, latencyMs: 30_000 } })] }))
    expect([report.calls.latencyP50Ms, report.calls.latencyP95Ms]).toEqual([2000, 4000])
  })

  it('reads a refusal by its reason, with its figures taken out', () => {
    expect(refusalReason('No paper trade: The live price is 12 seconds old, so the market it would enter is not known.')).toBe('The live price is # seconds old, so the market it would enter is not known.')
    expect(refusalReason('ICX: no paper short. 150.5 USDT are out together, the cap is 150.')).toBe('# USDT are out together, the cap is #.')
  })
})

describe('the gates that must be zero', () => {
  it('all pass on a clean hour, and the twelve-hour ones are not applied to it', () => {
    const report = sessionReportOf(input())
    expect(report.gates.filter((entry) => !entry.twelveHour).map((entry) => [entry.id, entry.status])).toEqual([
      ['stale_price', 'pass'],
      ['invalid_output', 'pass'],
      ['duplicates', 'pass'],
      ['stream_gaps', 'pass'],
      ['risk_bypass', 'pass'],
      ['bad_prices', 'pass'],
      ['malformed', 'pass'],
      ['ai_success', 'pass'],
      ['validation', 'pass']
    ])
    expect(report.twelveHour).toBe(false)
    expect(report.passed).toBe(true)
    // A twelve-hour gate that fails does not apply over an hour, so the hour passes: here, a trade
    // made before the paper engine charged slippage.
    const unslipped = sessionReportOf(input({ executors: [trade('sol'), ended('eth', 2.5, T - 600, { params: { ...PARAMS, slippageRate: undefined } })] }))
    expect(gateOf(unslipped, 'slippage').status).toBe('fail')
    expect(unslipped.passed).toBe(true)
    expect(gateOf(report, 'stale_price').detail).toBe('Each of the 2 trades was opened on a live price under 10 seconds old.')
  })

  it('says so plainly when no trade opened', () => {
    const report = sessionReportOf(input({ executors: [], trades: [] }))
    expect(gateOf(report, 'stale_price')).toMatchObject({ status: 'pass', detail: 'No paper trade of the watch opened in this span.' })
  })

  it('fails an entry on a price older than ten seconds, or with none recorded', () => {
    expect(REPORT_LINES.staleBookMs).toBe(10_000)
    const stale = sessionReportOf(input({ executors: [trade('sol', {}, { book: { ...BOOK, ageMs: 10_001 } })] }))
    expect(gateOf(stale, 'stale_price')).toMatchObject({ status: 'fail', detail: '1 of 1 paper trades of the watch opened: SOLUSDT at 11:30 UTC, a price 10 s old.' })
    expect(gateOf(sessionReportOf(input({ executors: [trade('sol', {}, { book: { ...BOOK, ageMs: 10_000 } })] })), 'stale_price').status).toBe('pass')
    expect(gateOf(sessionReportOf(input({ executors: [trade('sol', {}, { book: undefined })] })), 'stale_price').detail).toContain('no live price recorded')
    expect(sessionReportOf(input({ executors: [trade('sol', {}, { book: undefined })] })).passed).toBe(false)
  })

  it('fails a trade that followed an answer the validator refused', () => {
    const report = sessionReportOf(input({ calls: [call({ status: 'rejected' })] }))
    expect(gateOf(report, 'invalid_output').status).toBe('fail')
    // The answer of another model on the event is not the one it followed.
    expect(gateOf(sessionReportOf(input({ calls: [call(), call({ model: 'other', status: 'rejected' })] })), 'invalid_output').status).toBe('pass')
  })

  it('fails two trades for one event, or for one announcement and coin', () => {
    const twice = sessionReportOf(input({ executors: [trade('sol'), trade('sol2', { createdAt: T - 1700 }, { eventId: 'event-sol' })] }))
    expect(gateOf(twice, 'duplicates')).toMatchObject({ status: 'fail' })
    expect(gateOf(twice, 'duplicates').detail).toContain('2 for event event-sol')
  })

  it('fails a gap left open, or a trade opened on the stream inside one, and says when the log could not be read', () => {
    const stuck = sessionReportOf(input({ connection: { open: true, connects: 1, drops: 0, lastMessageAt: (T - 300) * 1000, gaps: [{ from: T - 121, to: null }], host: 'binance.com', hostSwitches: 0, dataHostSwitches: 0 } }))
    expect(gateOf(stuck, 'stream_gaps').status).toBe('fail')
    expect(gateOf(stuck, 'stream_gaps').detail).toContain('open since 11:57 UTC')
    expect(gateOf(sessionReportOf(input({ connection: { open: true, connects: 1, drops: 0, lastMessageAt: null, gaps: [{ from: T - 119, to: null }], host: 'binance.com', hostSwitches: 0, dataHostSwitches: 0 } })), 'stream_gaps').status).toBe('pass')
    const inside = sessionReportOf(input({ connection: { open: true, connects: 1, drops: 0, lastMessageAt: null, gaps: [{ from: T - 1900, to: T - 1700 }], host: 'binance.com', hostSwitches: 0, dataHostSwitches: 0 } }))
    expect(gateOf(inside, 'stream_gaps').detail).toContain("SOLUSDT opened on the stream's price inside a gap")
    // The same trade on a price read from the exchange instead is not.
    const rest = sessionReportOf(input({ executors: [trade('sol', {}, { book: { ...BOOK, source: 'rest' } })], connection: { open: true, connects: 1, drops: 0, lastMessageAt: null, gaps: [{ from: T - 1900, to: T - 1700 }], host: 'binance.com', hostSwitches: 0, dataHostSwitches: 0 } }))
    expect(gateOf(rest, 'stream_gaps').status).toBe('pass')
    expect(gateOf(sessionReportOf(input({ connection: null })), 'stream_gaps').status).toBe('not measured')
  })

  it('fails a trade opened past a limit as set now: one a pair, so many open, so many on a side, and the money out', () => {
    const second = trade('sol2', { createdAt: T - 1700, symbol: 'SOLUSDT' }, { eventId: 'event-sol2' })
    const onPair = sessionReportOf(input({ executors: [trade('sol'), second] }))
    expect(gateOf(onPair, 'risk_bypass').detail).toContain('another open on SOLUSDT')
    const many = sessionReportOf(input({ executors: [trade('sol'), trade('ada', { createdAt: T - 1700 })], watchPaper: { maxOpen: 1, maxSameSide: 2 } }))
    expect(gateOf(many, 'risk_bypass').detail).toContain('1 open already, the most is 1')
    const side = sessionReportOf(input({ executors: [trade('sol'), trade('ada', { createdAt: T - 1700 })], watchPaper: { maxOpen: 3, maxSameSide: 1 } }))
    expect(gateOf(side, 'risk_bypass').detail).toContain('1 open on the same side, the most is 1')
    const money = sessionReportOf(input({ executors: [trade('sol'), trade('ada', { createdAt: T - 1700 })], maxOutQuote: 150 }))
    expect(gateOf(money, 'risk_bypass').detail).toContain('200 USDT out with it, the cap is 150')
    // One stopped before the next opened was not open then.
    const after = sessionReportOf(input({ executors: [trade('sol', { status: 'stopped', stoppedAt: T - 1750 }), trade('ada', { createdAt: T - 1700 })], watchPaper: { maxOpen: 1, maxSameSide: 1 } }))
    expect(gateOf(after, 'risk_bypass').status).toBe('pass')
  })

  it('fails a price that is not one, or a spread wider than a trade is entered at', () => {
    expect(gateOf(sessionReportOf(input({ executors: [trade('sol', {}, { book: { ...BOOK, bid: 100.02 } })] })), 'bad_prices').status).toBe('fail')
    expect(gateOf(sessionReportOf(input({ executors: [trade('sol', {}, { book: { ...BOOK, spreadPct: 0.11 } })] })), 'bad_prices').status).toBe('fail')
    expect(gateOf(sessionReportOf(input({ executors: [trade('sol', {}, { book: { ...BOOK, spreadPct: 0.1 } })] })), 'bad_prices').status).toBe('pass')
    const nan: ReportTradeReading = { executorId: 'sol', entryPrice: Number.NaN, enteredAt: T - 1740, exitPrice: null, bestPct: null, worstPct: null, grossQuote: null, feesQuote: null }
    expect(gateOf(sessionReportOf(input({ trades: [nan] })), 'bad_prices').status).toBe('fail')
  })

  it('fails a trade made from a decision not in shape to be one', () => {
    expect(gateOf(sessionReportOf(input({ executors: [trade('sol', {}, {}, { stopLossPct: null })] })), 'malformed').detail).toContain('no stop or no target')
    expect(gateOf(sessionReportOf(input({ executors: [trade('sol', {}, {}, { entryRange: { min: 101, max: 100 } })] })), 'malformed').detail).toContain('no entry range')
    // An answer under the confidence the app acts on, or on the other side, is not one to trade.
    expect(gateOf(sessionReportOf(input({ calls: [call({ confidence: 0.5 })] })), 'malformed').detail).toContain('an answer the app would not act on as a BUY')
    expect(gateOf(sessionReportOf(input({ calls: [call({ recommendation: 'sell' })] })), 'malformed').status).toBe('fail')
  })
})

describe('the rates', () => {
  const calls = (failed: number, rejected: number, ok: number): Call[] => [
    ...Array.from({ length: failed }, () => call({ status: 'failed', eventId: 'x' })),
    ...Array.from({ length: rejected }, () => call({ status: 'rejected', eventId: 'x' })),
    ...Array.from({ length: ok }, () => call({ eventId: 'x' }))
  ]

  it('needs more than 98% of calls answered and more than 99% of answers valid', () => {
    expect(gateOf(sessionReportOf(input({ calls: calls(1, 0, 49) })), 'ai_success')).toMatchObject({ status: 'fail', detail: '49 of 50 got an answer back (98.0%); more than 98.0% is needed.' })
    expect(gateOf(sessionReportOf(input({ calls: calls(1, 0, 99) })), 'ai_success').status).toBe('pass')
    expect(gateOf(sessionReportOf(input({ calls: calls(0, 1, 99) })), 'validation').status).toBe('fail')
    expect(gateOf(sessionReportOf(input({ calls: calls(0, 1, 199) })), 'validation').status).toBe('pass')
    expect(gateOf(sessionReportOf(input({ calls: [] })), 'ai_success').status).toBe('not measured')
    expect(gateOf(sessionReportOf(input({ calls: calls(3, 0, 0) })), 'validation').status).toBe('not measured')
  })
})

describe('the twelve-hour gates', () => {
  const twelve = (over: Partial<SessionReportInput> = {}): SessionReport => sessionReportOf(input({ span: 'twelve', fromSec: T - 12 * HOUR, ...over }))

  it('apply to a span of twelve hours or more', () => {
    const report = twelve()
    expect(report.twelveHour).toBe(true)
    expect(report.gates.filter((entry) => entry.twelveHour).map((entry) => [entry.id, entry.status])).toEqual([
      ['outcomes', 'pass'],
      ['traced', 'pass'],
      ['fees', 'pass'],
      ['slippage', 'pass'],
      ['news_links', 'pass']
    ])
    // It reached its target: slippage on its entry, 2 bp of 100, and none on the target, a resting limit.
    expect(gateOf(report, 'slippage').detail).toBe("The trade was charged slippage on its market fills, at its pair's rate: about 0.02 USDT in all.")
    expect(gateOf(report, 'fees').detail).toBe('The trade is net of a fee on both fills, as the engine charges.')
    expect(gateOf(report, 'outcomes').detail).toBe('Each of the 2 recommendations that ended has its outcome: entered and closed, or expired unfilled.')
    expect(report.passed).toBe(true)
  })

  it('needs slippage charged on every trade that ended, and names one made before it was', () => {
    const stopped = ended('eth', -1.74)
    const out: ExecutorConfig = { ...stopped, watch: { ...(stopped.watch as NonNullable<ExecutorConfig['watch']>), result: { exit: 'stop_loss', pnlQuote: -1.74, closedAt: T - 600 } } }
    // A stop is a market fill: slippage both ways, 2 bp of 100 each.
    expect(gateOf(twelve({ executors: [out] }), 'slippage')).toMatchObject({ status: 'pass', detail: "The trade was charged slippage on its market fills, at its pair's rate: about 0.04 USDT in all." })
    // One made before the paper engine charged it carries no rate, and filled at its prices.
    const before = ended('ada', 2.5, T - 600, { params: { ...PARAMS, slippageRate: undefined } })
    const report = twelve({ executors: [ended('eth', 2.5), before] })
    expect(gateOf(report, 'slippage')).toEqual({
      id: 'slippage',
      label: 'Slippage is applied',
      twelveHour: true,
      status: 'fail',
      detail: '1 of 2 paper trades that ended: ADAUSDT at 11:30 UTC carries no slippage rate, so it filled at its prices.'
    })
    expect(report.passed).toBe(false)
    // A rate that is not one is none.
    expect(gateOf(twelve({ executors: [ended('ada', 2.5, T - 600, { params: { ...PARAMS, slippageRate: Number.NaN } })] }), 'slippage').status).toBe('fail')
  })

  it('needs an outcome for every recommendation whose life is over', () => {
    const report = twelve({
      recommendations: [
        { eventId: 'event-sol', model: MODEL, endsAt: T - 60, status: 'open' },
        { eventId: 'event-eth', model: MODEL, endsAt: T - 60, status: 'unscored' },
        // Still within its life: nothing to say yet.
        { eventId: 'event-ada', model: MODEL, endsAt: T + 600, status: 'waiting' }
      ]
    })
    expect(gateOf(report, 'outcomes').status).toBe('fail')
    expect(gateOf(report, 'outcomes').detail).toBe(`2 of 2 recommendations that ended: ${MODEL} on event-sol (still open); ${MODEL} on event-eth (its minutes could not be read).`)
    expect(gateOf(twelve({ recommendations: [] }), 'outcomes').status).toBe('not measured')
  })

  it('needs every trade traced to its event and its answer, or to its announcement', () => {
    expect(gateOf(twelve({ events: [] }), 'traced').detail).toContain('its event is not on file')
    expect(gateOf(twelve({ calls: [] }), 'traced').detail).toContain('its answer is not on file')
  })

  it('checks every closed trade is net of its fees, by the engine', () => {
    const off: ReportTradeReading = { executorId: 'eth', entryPrice: 100, enteredAt: T - 1740, exitPrice: 102.7, bestPct: 3.1, worstPct: -0.2, grossQuote: 2.7, feesQuote: 0 }
    expect(gateOf(twelve({ trades: [off] }), 'fees').status).toBe('fail')
    // A result that is its gross, with no fee, is not one the engine charged.
    expect(gateOf(twelve({ trades: [{ ...off, grossQuote: 2.5, feesQuote: 0 }] }), 'fees').status).toBe('fail')
    const gross: ReportTradeReading = { ...off, feesQuote: 0.2, grossQuote: 2.9 }
    expect(gateOf(twelve({ trades: [gross] }), 'fees').detail).toContain('made 2.5, where 2.9 less 0.2 in fees was expected')
    expect(gateOf(twelve({ trades: [] }), 'fees').detail).toContain('its minutes could not be read to check')
  })

  it('needs every story read to carry its https link', () => {
    expect(gateOf(twelve({ stories: [{ url: 'http://example.com/a', publishedAt: T - 300 }] }), 'news_links').status).toBe('fail')
    expect(gateOf(twelve({ stories: [{ url: '', publishedAt: T - 300 }] }), 'news_links').detail).toBe('1 of 1 stories: a story at 11:55 UTC has no link.')
    expect(gateOf(twelve({ stories: [] }), 'news_links').status).toBe('not measured')
  })
})

describe('the spreadsheet', () => {
  it('has a line a figure and a gate, quoted where it must be', () => {
    const csv = sessionReportCsv(sessionReportOf(input({ refusals: [{ at: T - 100, source: 'watch', text: 'No paper trade: one, two, "three".' }] })))
    const lines = csv.split('\n')
    expect(lines[0]).toBe('section,item,value,detail')
    expect(lines).toContain('events,raised,3,')
    expect(lines).toContain('paper refused,"one, two, ""three"".",1,')
    expect(lines.some((line) => line.startsWith('gate,Entries on a stale price,PASS,'))).toBe(true)
    expect(lines.some((line) => line.startsWith('gate,Slippage is applied,not applied,'))).toBe(true)
    expect(lines[lines.length - 1]).toBe('gate,all gates that apply,PASS,')
  })
})

// In a 24-hour run on 7 October 2026 the socket kept dialling a host whose name no longer resolved
// to Binance, while REST had moved to the mirror. The socket now follows, and the report says where it
// is and how often it, and the data host, moved. Moves are told, never gated: a move is the fix.
describe("the stream's host", () => {
  it('names the host the socket is on and its moves, and never fails a gate for them', () => {
    const moved = sessionReportOf(input({ connection: { open: true, connects: 13, drops: 0, lastMessageAt: T * 1000, gaps: [], host: 'binance.com', hostSwitches: 12, dataHostSwitches: 12 } }))
    expect(moved.stream).toMatchObject({ host: 'binance.com', hostSwitches: 12, dataHostSwitches: 12 })
    expect(moved.gates.find((gate) => gate.id === 'stream_gaps')?.status).toBe('pass')
    expect(moved.passed).toBe(true)
    const lines = sessionReportCsv(moved).split('\n')
    expect(lines).toContain('stream,host,binance.com,the data host the socket is on')
    expect(lines.some((line) => line.startsWith('stream,host switches,12,'))).toBe(true)
    expect(lines.some((line) => line.startsWith('stream,data host switches,12,'))).toBe(true)
    const unopened = sessionReportOf(input({ connection: { open: false, connects: 0, drops: 0, lastMessageAt: null, gaps: [], host: null, hostSwitches: 0, dataHostSwitches: 0 } }))
    expect(unopened.stream?.host).toBeNull()
  })
})
