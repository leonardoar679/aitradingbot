import { describe, expect, it } from 'vitest'
import type { AiCallRecord } from '../shared/aiLedger'
import {
  EXPERIMENT_KIND_MINUTES,
  EXPERIMENT_MAX_MINUTES,
  EXPERIMENT_MIN_MINUTES,
  VERDICT_LINES,
  describeExperimentKind,
  describeExperimentVerdict,
  experimentFigures,
  experimentGates,
  experimentIdOf,
  experimentMinutesOf,
  experimentModeOf,
  experimentReportOf,
  experimentSlippageQuote,
  experimentSpan,
  experimentStatusAt,
  experimentVerdictOf,
  foldExperimentRuns,
  healExperimentRun,
  parseExperimentRunLines,
  type ExperimentRun
} from '../shared/experimentRun'
import type { ExecutorConfig, PositionExecutorParams } from '../shared/ipc'
import type { LiveConnection } from '../shared/liveMarket'
import { sessionReportOf, type SessionReportInput } from '../shared/shadowReport'

// EXPERIMENTS IN THE APP (shared/experimentRun.ts; the V5 document, §56-62 and §124-126; V5 Stage 9).

const T = Date.parse('2026-10-08T12:00:00Z') / 1000
const HOUR = 3600

const RUN: ExperimentRun = {
  id: 'run-2026-10-08-1200',
  kind: 'shadow-1h',
  minutes: 60,
  startedAt: T,
  endsAt: T + HOUR,
  mode: 'PAPER',
  versions: { prompt: 'opportunity-v3', context: 'context-v2', schema: 'opportunity-schema-v2', detector: 'events-v2', config: 'abc', engine: 'def' },
  models: ['openai/gpt-5-mini'],
  universe: 60,
  status: 'running'
}

describe('a run on file', () => {
  it('is read as one, and not a line that is not', () => {
    expect(healExperimentRun(RUN)).toEqual(RUN)
    expect(healExperimentRun({ ...RUN, kind: 'weekly' })).toBeNull()
    expect(healExperimentRun({ ...RUN, mode: 'LIVE' })).toBeNull()
    expect(healExperimentRun({ ...RUN, versions: undefined })).toBeNull()
    expect(healExperimentRun('run')).toBeNull()
    expect(healExperimentRun({ ...RUN, models: ['a', 3], stoppedAt: T + 60 })).toMatchObject({ models: ['a'], stoppedAt: T + 60 })
  })

  it('folds the lines so that the newest line for an id is the run, newest run first', () => {
    const older = { ...RUN, id: 'run-older', startedAt: T - HOUR, endsAt: T }
    const text = [JSON.stringify(older), JSON.stringify(RUN), 'not json', JSON.stringify({ ...RUN, status: 'ended' }), JSON.stringify({ nope: true })].join('\n')
    const parsed = parseExperimentRunLines(text)
    expect(parsed.skipped).toBe(2)
    expect(parsed.rows.map((run) => [run.id, run.status])).toEqual([
      ['run-2026-10-08-1200', 'ended'],
      ['run-older', 'running']
    ])
    expect(foldExperimentRuns([RUN, { ...RUN, status: 'stopped', stoppedAt: T + 10 }])[0].status).toBe('stopped')
  })

  it('stands as running until its end passes, then ended until reported; stopped when stopped', () => {
    expect(experimentStatusAt(RUN, T + HOUR - 1)).toBe('running')
    expect(experimentStatusAt(RUN, T + HOUR)).toBe('ended')
    expect(experimentStatusAt({ ...RUN, status: 'stopped', stoppedAt: T + 10 }, T + 20)).toBe('stopped')
    expect(experimentStatusAt({ ...RUN, report: {} as ExperimentRun['report'] }, T + 20)).toBe('reported')
    expect(experimentSpan(RUN)).toEqual({ fromSec: T, toSec: T + HOUR })
    expect(experimentSpan({ ...RUN, stoppedAt: T + 10 })).toEqual({ fromSec: T, toSec: T + 10 })
  })

  it('takes its minutes from its kind, or from what a custom run asked for within the bounds', () => {
    expect(EXPERIMENT_KIND_MINUTES).toEqual({ 'shadow-1h': 60, 'paper-12h': 720 })
    expect(experimentMinutesOf('shadow-1h', 5)).toBe(60)
    expect(experimentMinutesOf('custom', 90)).toBe(90)
    expect(experimentMinutesOf('custom', 1)).toBe(EXPERIMENT_MIN_MINUTES)
    expect(experimentMinutesOf('custom', 1e9)).toBe(EXPERIMENT_MAX_MINUTES)
    expect(experimentMinutesOf('custom', null)).toBe(EXPERIMENT_MIN_MINUTES)
    expect(describeExperimentKind('shadow-1h', 60)).toBe('One hour')
    expect(describeExperimentKind('custom', 180)).toBe('3 hours')
    expect(describeExperimentKind('custom', 45)).toBe('45 minutes')
  })

  it('reads the mode the chip read: SHADOW with the watch off or asking only, PAPER with paper trades, CONFIRM with the switch', () => {
    expect(experimentModeOf({ watch: { enabled: false, confirmLive: false }, watchPaper: { enabled: true } })).toBe('SHADOW')
    expect(experimentModeOf({ watch: { enabled: true, confirmLive: false }, watchPaper: { enabled: false } })).toBe('SHADOW')
    expect(experimentModeOf({ watch: { enabled: true, confirmLive: false }, watchPaper: { enabled: true } })).toBe('PAPER')
    expect(experimentModeOf({ watch: { enabled: true, confirmLive: true }, watchPaper: { enabled: true } })).toBe('CONFIRM')
  })

  it('is named by its start, and not twice', () => {
    expect(experimentIdOf(T, [])).toBe('run-2026-10-08-1200')
    expect(experimentIdOf(T, ['run-2026-10-08-1200'])).toBe('run-2026-10-08-1200-2')
  })
})

const PARAMS: PositionExecutorParams = { side: 'buy', entryPrice: null, entryRange: { min: 99, max: 101 }, amountQuote: 100, takeProfitPct: 3, stopLossPct: 1.5, timeLimitSec: 3600, trailingStop: null, slippageRate: 0.0005 }

function trade(id: string, over: { createdAt?: number; callId?: string | null; result?: { exit: string; pnlQuote: number; closedAt: number } | null; params?: Partial<PositionExecutorParams>; news?: boolean } = {}): ExecutorConfig {
  const createdAt = over.createdAt ?? T + 600
  // With the live book it was opened against, so that the session's own stale-price gate passes.
  const mark = {
    eventId: `event-${id}`,
    eventTime: createdAt - 60,
    model: 'openai/gpt-5-mini',
    confidence: 0.8,
    book: { bid: 99.9, ask: 100.1, spreadPct: 0.02, ageMs: 500, source: 'stream' as const },
    ...(over.callId === null ? {} : { callId: over.callId ?? `call-${id}` }),
    ...(over.result === null || over.result === undefined ? {} : { result: over.result })
  }
  return {
    id,
    name: `Watch: BUY ${id}`,
    type: 'position',
    exchange: 'binance',
    symbol: `${id.toUpperCase()}USDT`,
    baseAsset: id.toUpperCase(),
    quoteAsset: 'USDT',
    createdAt,
    status: over.result ? 'stopped' : 'active',
    stoppedAt: over.result ? over.result.closedAt : null,
    keepPosition: false,
    mode: 'paper',
    ...(over.news ? { newsRule: { newsId: 1, category: 'DELISTING', ticker: id.toUpperCase(), ...(over.result ? { result: over.result } : {}) } as unknown as ExecutorConfig['newsRule'] } : { watch: mark as ExecutorConfig['watch'] }),
    liveOrder: null,
    pendingLiveOrderIds: [],
    liveWatcherId: null,
    liveWatcherError: null,
    liveExitResult: null,
    liveDcaBasePrice: null,
    liveTwapRunId: null,
    liveTwapResult: null,
    params: { ...PARAMS, ...over.params }
  }
}

function call(over: Partial<AiCallRecord> = {}): AiCallRecord {
  return {
    id: 'c1',
    at: T + 500,
    source: 'watch',
    status: 'ok',
    model: 'openai/gpt-5-mini',
    provider: 'x',
    promptVersion: 'opportunity-v3',
    contextVersion: 'context-v2',
    schemaVersion: 'opportunity-schema-v2',
    exchange: 'binance',
    symbol: 'SOLUSDT',
    interval: '1m',
    candleTime: T + 480,
    position: 'flat',
    referencePrice: 100,
    usage: { promptTokens: 1, completionTokens: 1, costUsd: 0.01, latencyMs: 1000 },
    error: null,
    recommendation: 'buy',
    confidence: 0.8,
    rationale: 'x',
    detail: null,
    eventId: 'event-sol',
    ...over
  }
}

const connection = (gaps: { from: number; to: number }[]): LiveConnection => ({ open: true, connects: 1, drops: 0, lastMessageAt: T * 1000, gaps, host: 'h', hostSwitches: 0, dataHostSwitches: 0, connectedAt: null, planned: 0, subscribeErrors: 0 })

const base = (over: Partial<SessionReportInput> = {}): SessionReportInput => ({
  span: 'session',
  fromSec: T,
  toSec: T + HOUR,
  appStartedSec: T - HOUR,
  events: [],
  calls: [],
  executors: [],
  watchPaper: { maxOpen: 3, maxSameSide: 2 },
  maxOutQuote: null,
  connection: connection([]),
  alerts: [],
  refusals: [],
  recommendations: [],
  trades: [],
  stories: [],
  ...over
})

describe("the document's five further gates", () => {
  const ids = (gates: ReturnType<typeof experimentGates>): string[] => gates.map((gate) => `${gate.id}:${gate.status}`)

  it('pass on an empty span, and name their counts', () => {
    const gates = experimentGates(base())
    expect(ids(gates)).toEqual(['duplicate_orders:pass', 'calls_without_event:pass', 'trades_without_call:pass', 'silent_failures:pass', 'long_gaps:pass'])
    expect(gates[0].detail).toBe('Each of the 0 watch trades follows a call of its own.')
    expect(gates[4].detail).toBe('0 gaps in the span, none over three minutes.')
  })

  it('fail on two trades from one call, a watch call with no event, a watch trade with no call, a row with no status, and a gap over three minutes', () => {
    const input = base({
      executors: [trade('a', { callId: 'same' }), trade('b', { callId: 'same' }), trade('c', { callId: null }), trade('d', { news: true })],
      calls: [call(), call({ id: 'c2', eventId: undefined }), call({ id: 'c3', status: 'done' as AiCallRecord['status'] })],
      connection: connection([{ from: T + 100, to: T + 281 }, { from: T + 1000, to: T + 1100 }])
    })
    const gates = experimentGates(input)
    expect(ids(gates)).toEqual(['duplicate_orders:fail', 'calls_without_event:fail', 'trades_without_call:fail', 'silent_failures:fail', 'long_gaps:fail'])
    expect(gates[0].detail).toBe('1 call opened more than one paper trade.')
    expect(gates[1].detail).toBe('1 watch call names no event.')
    expect(gates[2].detail).toBe('1 watch trade names no call.')
    expect(gates[3].detail).toBe('1 row of the ledger carry no status.')
    expect(gates[4].detail).toBe('1 gap over three minutes.')
  })

  it('count the span only, read a gap by the part inside it, and count no gap with no log', () => {
    const outside = base({
      executors: [trade('a', { callId: 'same', createdAt: T - 100 }), trade('b', { callId: 'same', createdAt: T - 90 })],
      calls: [call({ id: 'c2', eventId: undefined, at: T - 10 })],
      connection: connection([{ from: T - 600, to: T + 100 }, { from: T + HOUR - 100, to: T + HOUR + 600 }])
    })
    expect(ids(experimentGates(outside))).toEqual(['duplicate_orders:pass', 'calls_without_event:pass', 'trades_without_call:pass', 'silent_failures:pass', 'long_gaps:pass'])
    expect(experimentGates(outside)[4].detail).toBe('2 gaps in the span, none over three minutes.')
    expect(experimentGates(base({ connection: null }))[4].detail).toBe("The stream's log could not be read, so no gap is counted.")
  })
})

describe('the figures and the verdict', () => {
  const closed = (id: string, pnlQuote: number, at: number): ExecutorConfig => trade(id, { createdAt: at - 600, result: { exit: pnlQuote >= 0 ? 'take_profit' : 'stop_loss', pnlQuote, closedAt: at } })

  it('reads the closed trades in the span: net, the answers\' cost, gains over losses, the deepest fall in R', () => {
    // Risked at the 1.5% stop on a 100 stake with 0.2% of fees and 0.1% of slippage: 1.8 a trade.
    const figures = experimentFigures(base({ executors: [closed('a', 3.6, T + 100), closed('b', -1.8, T + 200), closed('c', -1.8, T + 300), closed('d', 1.8, T + 400), closed('e', 9, T - 10)], calls: [call(), call({ id: 'c2', at: T + HOUR + 1 })] }))
    expect(figures.closed).toBe(4)
    expect(figures.netQuote).toBeCloseTo(1.8, 10)
    expect(figures.aiCostUsd).toBeCloseTo(0.01, 10)
    expect(figures.netAfterAiUsd).toBeCloseTo(1.79, 10)
    expect(figures.profitFactor).toBeCloseTo(5.4 / 3.6, 10)
    // +2 R, then -1 R twice: a fall of 2 R from the peak, then back up 1 R.
    expect(figures.maxDrawdownR).toBeCloseTo(2, 6)
    expect(experimentFigures(base()).profitFactor).toBeNull()
  })

  it('is NOT ENOUGH TRADES under thirty, YES on a profitable thirty within the fall, NOT YET otherwise', () => {
    expect(VERDICT_LINES).toEqual({ minTrades: 30, maxDrawdownR: 10, minProfitFactor: 1 })
    const figures = { closed: 30, netQuote: 10, aiCostUsd: 1, netAfterAiUsd: 9, profitFactor: 1.5, maxDrawdownR: 4 }
    expect(experimentVerdictOf(figures)).toBe('YES')
    expect(experimentVerdictOf({ ...figures, closed: 29 })).toBe('NOT ENOUGH TRADES')
    expect(experimentVerdictOf({ ...figures, netAfterAiUsd: 0 })).toBe('NOT YET')
    expect(experimentVerdictOf({ ...figures, profitFactor: 1 })).toBe('NOT YET')
    expect(experimentVerdictOf({ ...figures, maxDrawdownR: 10 })).toBe('NOT YET')
    expect(experimentVerdictOf({ ...figures, profitFactor: null })).toBe('YES')
    expect(describeExperimentVerdict('NOT ENOUGH TRADES', { ...figures, closed: 4 })).toBe('AI ADDING VALUE: NOT ENOUGH TRADES. 4 of the 30 closed paper trades the verdict needs.')
    expect(describeExperimentVerdict('YES', figures)).toBe("AI ADDING VALUE: YES. 30 closed trades: net 10.00 after fees, 9.00 after the answers' $1.00; gains over losses 1.50; deepest fall 4.0 R.")
  })

  it('charges slippage on the trades that entered, as the engine did, and builds the report whole', () => {
    const input = base({ executors: [closed('a', 1, T + 100), trade('x', { createdAt: T + 50, result: { exit: 'entry_expired', pnlQuote: 0, closedAt: T + 900 } })], calls: [call()] })
    // 100 both ways at 0.05%: 0.1.
    expect(experimentSlippageQuote(input)).toBeCloseTo(0.1, 10)
    const session = sessionReportOf(input)
    const report = experimentReportOf({ session, sessionInput: input, help: [] })
    expect(report.version).toBe('experiment-run-v1')
    expect(report.gates).toHaveLength(5)
    expect(report.costs.aiUsd).toBeCloseTo(0.01, 10)
    expect(report.costs.slippageQuote).toBeCloseTo(0.1, 10)
    expect(report.verdict).toBe('NOT ENOUGH TRADES')
    expect(report.passed).toBe(session.passed)
    expect(report.help).toEqual([])
    // Its own gates are in `passed` too: two trades from one call fail the run, whatever the session says.
    const twice = base({ executors: [trade('a', { callId: 'same' }), trade('b', { callId: 'same' })] })
    const twiceSession = sessionReportOf(twice)
    expect(twiceSession.passed).toBe(true)
    const failed = experimentReportOf({ session: twiceSession, sessionInput: twice, help: [] })
    expect(failed.gates[0].status).toBe('fail')
    expect(failed.passed).toBe(false)
  })
})
