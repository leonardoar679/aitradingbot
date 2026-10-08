import type { AiCallRecord } from './aiLedger'
import { GPT_MIN_CONFIDENCE } from './aiSignal'
import type { AlertSeverity } from './alerts'
import { positionSlippageRate } from './fees'
import type { ExecutorConfig, PositionExecutorParams } from './ipc'
import { MAX_SPREAD_PCT, STALE_PRICE_MS, type LiveConnection } from './liveMarket'
import type { MarketEvent } from './marketEvent'
import { rMultiple } from './paperRisk'

// THE SESSION REPORT (the V3 plan's Stage 8; the second V3 document, §37-39): what the app did over
// the last hour, the last twelve hours, or since a session was started, and whether it held to the
// gates the document sets for its 1-hour and 12-hour test runs.
//
// IT READS WHAT IS ON FILE, AND SAYS WHAT IT COULD NOT READ. The events, the call ledger and the
// executors are kept on disk and reach back as far as the span does. Three things are kept only while
// the app runs: the stream's log of connects, drops and gaps, the alerts, and the paper trades
// refused. They reach back no further than when it started, and the report says when that was.
//
// PROFIT IS REPORTED, NOT GATED. The gates are about whether the machinery behaved: no paper trade
// on a stale or bad price, from an invalid answer, twice for one event or past a limit; the calls
// answered and valid; and over twelve hours, every recommendation with an outcome, every trade traced
// to its event, its costs charged, and every story with its link.
//
// A GATE THE APP CANNOT MEET IS SHOWN FAILING. A paper trade opened before 6 October 2026 carries no
// slippage rate (the engine charges one only where the trade carries it), so the twelve-hour slippage
// gate names such a trade and fails on it, and says what slippage would have cost.

export const SESSION_REPORT_VERSION = 'session-report-v1'

export type ReportSpan = 'hour' | 'twelve' | 'day' | 'session'
export const REPORT_SPAN_SECONDS = { hour: 3600, twelve: 43_200, day: 86_400 } as const

/** The gates' lines, from the document's §39, written down before any run. */
export const REPORT_LINES = {
  /** Calls that got an answer back, of all calls made. */
  aiSuccess: 0.98,
  /** Answers the validator took, of all answers that came back. */
  validation: 0.99,
  /** A gap in the stream still open this long after it began was not dealt with. */
  gapGraceSeconds: 120,
  staleBookMs: STALE_PRICE_MS,
  maxSpreadPct: MAX_SPREAD_PCT
} as const

/** One of the app's own paper trades as its minutes were read for the report (the renderer's
 * src/performance/sessionReport.ts): where the engine says it entered and left, how far the price
 * went for it and against it while it was held, in percent of its entry, and what it made before
 * fees and what the fees were. Null where it never entered, or its minutes could not be read. */
export interface ReportTradeReading {
  executorId: string
  entryPrice: number | null
  enteredAt: number | null
  exitPrice: number | null
  bestPct: number | null
  worstPct: number | null
  grossQuote: number | null
  feesQuote: number | null
}

/** A recommendation one could act on, as its minutes scored it (src/agents/opportunities.ts). */
export interface ReportRecommendation {
  eventId: string
  model: string
  /** When its entry window and its hold are over, so that nothing about it can change. */
  endsAt: number
  status: 'waiting' | 'expired' | 'open' | 'closed' | 'unscored'
}

export interface SessionReportInput {
  span: ReportSpan
  fromSec: number
  toSec: number
  /** When the app started: the stream's log, the alerts and the refusals reach back no further. */
  appStartedSec: number
  events: Pick<MarketEvent, 'id' | 'time' | 'band'>[]
  calls: Pick<AiCallRecord, 'at' | 'source' | 'status' | 'model' | 'eventId' | 'recommendation' | 'confidence' | 'detail' | 'usage'>[]
  executors: ExecutorConfig[]
  /** The limits as they are set now. Each trade is checked against these. */
  watchPaper: { maxOpen: number; maxSameSide: number }
  maxOutQuote: number | null
  /** Null when the stream's log could not be read. */
  connection: LiveConnection | null
  alerts: { at: number; severity: AlertSeverity }[]
  refusals: { at: number; source: 'watch' | 'news'; text: string }[]
  recommendations: ReportRecommendation[]
  trades: ReportTradeReading[]
  stories: { url: string; publishedAt: number }[]
}

export type GateId =
  | 'stale_price'
  | 'invalid_output'
  | 'duplicates'
  | 'stream_gaps'
  | 'risk_bypass'
  | 'bad_prices'
  | 'malformed'
  | 'ai_success'
  | 'validation'
  | 'outcomes'
  | 'traced'
  | 'fees'
  | 'slippage'
  | 'news_links'

export interface ReportGate {
  id: GateId
  label: string
  /** Only a run of twelve hours or more is held to it. */
  twelveHour: boolean
  status: 'pass' | 'fail' | 'not measured'
  detail: string
}

export interface SessionReport {
  version: string
  span: ReportSpan
  fromSec: number
  toSec: number
  appStartedSec: number
  events: { raised: number; urgent: number; takenUp: number }
  calls: {
    total: number
    /** Calls that got an answer back, usable or not. */
    answered: number
    /** Of those, the ones the validator took. */
    valid: number
    failed: number
    successRate: number | null
    validationRate: number | null
    latencyP50Ms: number | null
    latencyP95Ms: number | null
    costUsd: number
  }
  /** The watch's answers: BUY and SELL it would act on; HOLD, the model's own word; NO TRADE, a side
   * it would not act on (no entry range, or under its confidence line). */
  answers: { buy: number; sell: number; hold: number; noTrade: number }
  paper: {
    opened: number
    openedWatch: number
    openedNews: number
    /** Ended in the span: a result was written on them. */
    ended: number
    /** Open now. */
    open: number
    refused: { reason: string; count: number }[]
    net: { asset: string; amount: number }[]
    r: number
    rTrades: number
    fees: { asset: string; amount: number }[]
    bestPct: number | null
    worstPct: number | null
    /** From the event to the paper trade being opened. */
    signalAgeSec: { median: number | null; max: number | null }
  }
  alerts: Record<AlertSeverity, number>
  /** Connects, drops and host moves are since the app started; gaps are those in the span. */
  stream: { connects: number; drops: number; gaps: number; gapSeconds: number; longestGapSeconds: number; host: string | null; hostSwitches: number; dataHostSwitches: number } | null
  gates: ReportGate[]
  /** Whether a twelve-hour gate applies: a span of twelve hours or more. */
  twelveHour: boolean
  /** No gate that applies failed. */
  passed: boolean
}

const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value)
const within = (time: number, input: Pick<SessionReportInput, 'fromSec' | 'toSec'>): boolean => time >= input.fromSec && time <= input.toSec

function percentile(values: number[], share: number): number | null {
  if (values.length === 0) return null
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(share * sorted.length) - 1))]
}

function addTo(list: { asset: string; amount: number }[], asset: string, amount: number): void {
  const held = list.find((entry) => entry.asset === asset)
  if (held === undefined) list.push({ asset, amount })
  else held.amount += amount
}

/** The app's own paper positions: the watch's and the news rules'. A live executor is never one. */
function ownTrades(executors: ExecutorConfig[]): ExecutorConfig[] {
  return executors.filter((executor) => executor.mode === 'paper' && executor.type === 'position' && (executor.watch !== undefined || executor.newsRule !== undefined))
}

function resultOf(executor: ExecutorConfig): { exit: string; pnlQuote: number; closedAt: number } | undefined {
  return executor.watch?.result ?? executor.newsRule?.result
}

function entered(result: { exit: string }): boolean {
  return result.exit !== 'entry_expired' && result.exit !== 'btc_moved'
}

/** A refusal's reason, with its figures taken out, so that like refusals count together. */
export function refusalReason(text: string): string {
  return text
    .replace(/^No paper (trade|short)[:.]\s*/i, '')
    .replace(/^[A-Z0-9]{2,12}: no paper short[.,]\s*/, '')
    .replace(/\d+(\.\d+)?/g, '#')
    .trim()
}

/** The answer the watch's paper trade followed: the first row the watch has on file for its event
 * from its model. */
function decisionRowOf(calls: SessionReportInput['calls'], mark: { eventId: string; model: string }): SessionReportInput['calls'][number] | undefined {
  return calls.filter((row) => row.source === 'watch' && row.eventId === mark.eventId && row.model === mark.model).sort((a, b) => a.at - b.at)[0]
}

function actionable(row: Pick<AiCallRecord, 'status' | 'recommendation' | 'confidence' | 'detail'>): 'buy' | 'sell' | null {
  if (row.status !== 'ok' || (row.recommendation !== 'buy' && row.recommendation !== 'sell') || row.detail?.entry == null) return null
  return (row.confidence ?? 0) >= GPT_MIN_CONFIDENCE ? row.recommendation : null
}

function gate(id: GateId, label: string, twelveHour: boolean, failures: string[], checked: number, noun: string, passed: string): ReportGate {
  if (failures.length > 0) {
    const shown = failures.slice(0, 5).join('; ')
    return { id, label, twelveHour, status: 'fail', detail: `${failures.length} of ${checked} ${noun}: ${shown}${failures.length > 5 ? '; …' : ''}.` }
  }
  return { id, label, twelveHour, status: 'pass', detail: passed }
}

/** "The trade" for one, "Each of the 3 trades" for more. */
function eachOf(n: number, one: string, many: string): string {
  return n === 1 ? `The ${one}` : `Each of the ${n} ${many}`
}

function counted(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`
}

const pct = (value: number): string => `${(value * 100).toFixed(1)}%`

/** The report. Pure: everything it reads is handed to it. */
export function sessionReportOf(input: SessionReportInput): SessionReport {
  const { fromSec, toSec } = input
  const twelveHour = toSec - fromSec >= REPORT_SPAN_SECONDS.twelve

  // Events, and the ones the watch took up.
  const events = input.events.filter((event) => within(event.time, input))
  const callsIn = input.calls.filter((row) => within(row.at, input))
  const watchCalls = callsIn.filter((row) => row.source === 'watch')
  const takenUp = new Set(watchCalls.map((row) => row.eventId).filter((id): id is string => id !== undefined))

  // The calls.
  const answered = callsIn.filter((row) => row.status !== 'failed')
  const valid = answered.filter((row) => row.status === 'ok')
  const latencies = answered.map((row) => row.usage.latencyMs).filter((ms) => finite(ms) && ms > 0)
  const calls: SessionReport['calls'] = {
    total: callsIn.length,
    answered: answered.length,
    valid: valid.length,
    failed: callsIn.length - answered.length,
    successRate: callsIn.length === 0 ? null : answered.length / callsIn.length,
    validationRate: answered.length === 0 ? null : valid.length / answered.length,
    latencyP50Ms: percentile(latencies, 0.5),
    latencyP95Ms: percentile(latencies, 0.95),
    costUsd: callsIn.reduce((sum, row) => sum + (finite(row.usage.costUsd) ? row.usage.costUsd : 0), 0)
  }

  // The watch's answers, by what the app would make of them.
  const answers = { buy: 0, sell: 0, hold: 0, noTrade: 0 }
  for (const row of watchCalls) {
    if (row.status !== 'ok') continue
    if (row.recommendation === 'hold') answers.hold++
    else {
      const side = actionable(row)
      if (side === 'buy') answers.buy++
      else if (side === 'sell') answers.sell++
      else answers.noTrade++
    }
  }

  // The paper trades.
  const own = ownTrades(input.executors)
  const opened = own.filter((executor) => within(executor.createdAt, input))
  const openedWatch = opened.filter((executor) => executor.watch !== undefined)
  const ended = own.filter((executor) => {
    const result = resultOf(executor)
    return result !== undefined && executor.status === 'stopped' && within(result.closedAt, input)
  })
  const enteredEnded = ended.filter((executor) => entered(resultOf(executor) as { exit: string }))
  const readings = new Map(input.trades.map((reading) => [reading.executorId, reading]))
  const net: { asset: string; amount: number }[] = []
  const fees: { asset: string; amount: number }[] = []
  let r = 0
  let rTrades = 0
  for (const executor of enteredEnded) {
    const result = resultOf(executor) as { pnlQuote: number }
    addTo(net, executor.quoteAsset, result.pnlQuote)
    const reading = readings.get(executor.id)
    if (reading !== undefined && finite(reading.feesQuote)) addTo(fees, executor.quoteAsset, reading.feesQuote)
    const inR = rMultiple(result.pnlQuote, executor.params as PositionExecutorParams)
    if (inR !== null) {
      r += inR
      rTrades++
    }
  }
  const touched = own.filter((executor) => within(executor.createdAt, input) || executor.status === 'active' || ended.includes(executor))
  const moves = touched.map((executor) => readings.get(executor.id)).filter((reading): reading is ReportTradeReading => reading !== undefined)
  const bests = moves.map((reading) => reading.bestPct).filter(finite)
  const worsts = moves.map((reading) => reading.worstPct).filter(finite)
  const ages = openedWatch.map((executor) => executor.createdAt - (executor.watch as { eventTime: number }).eventTime).filter((age) => finite(age) && age >= 0)
  const refusalsIn = input.refusals.filter((refusal) => within(refusal.at, input))
  const byReason = new Map<string, number>()
  for (const refusal of refusalsIn) {
    const reason = refusalReason(refusal.text)
    byReason.set(reason, (byReason.get(reason) ?? 0) + 1)
  }
  const paper: SessionReport['paper'] = {
    opened: opened.length,
    openedWatch: openedWatch.length,
    openedNews: opened.length - openedWatch.length,
    ended: ended.length,
    open: own.filter((executor) => executor.status === 'active').length,
    refused: [...byReason.entries()].map(([reason, count]) => ({ reason, count })).sort((a, b) => b.count - a.count || a.reason.localeCompare(b.reason)),
    net,
    r,
    rTrades,
    fees,
    bestPct: bests.length === 0 ? null : Math.max(...bests),
    worstPct: worsts.length === 0 ? null : Math.min(...worsts),
    signalAgeSec: { median: percentile(ages, 0.5), max: ages.length === 0 ? null : Math.max(...ages) }
  }

  const alerts: Record<AlertSeverity, number> = { info: 0, watch: 0, high: 0, critical: 0 }
  for (const alert of input.alerts) if (within(alert.at, input)) alerts[alert.severity]++

  // The stream: its gaps in the span, each clipped to it.
  const gapsIn = (input.connection?.gaps ?? []).filter((gap) => gap.from <= toSec && (gap.to ?? toSec) >= fromSec)
  const gapLengths = gapsIn.map((gap) => Math.max(0, Math.min(gap.to ?? toSec, toSec) - Math.max(gap.from, fromSec)))
  const stream: SessionReport['stream'] =
    input.connection === null
      ? null
      : {
          connects: input.connection.connects,
          drops: input.connection.drops,
          gaps: gapsIn.length,
          gapSeconds: gapLengths.reduce((sum, length) => sum + length, 0),
          longestGapSeconds: gapLengths.length === 0 ? 0 : Math.max(...gapLengths),
          host: input.connection.host,
          hostSwitches: input.connection.hostSwitches,
          dataHostSwitches: input.connection.dataHostSwitches
        }

  const gates: ReportGate[] = []
  const watchNoun = 'paper trades of the watch opened'
  const noneOpened = 'No paper trade of the watch opened in this span.'

  // Must be zero: a trade on a price older than ten seconds, or with none recorded.
  gates.push(
    gate(
      'stale_price',
      'Entries on a stale price',
      false,
      openedWatch
        .filter((executor) => executor.watch?.book === undefined || !(executor.watch.book.ageMs <= REPORT_LINES.staleBookMs))
        .map((executor) => `${executor.symbol} at ${clock(executor.createdAt)}, ${executor.watch?.book === undefined ? 'no live price recorded' : `a price ${Math.round(executor.watch.book.ageMs / 1000)} s old`}`),
      openedWatch.length,
      watchNoun,
      openedWatch.length === 0 ? noneOpened : `${eachOf(openedWatch.length, 'trade', 'trades')} was opened on a live price under ${REPORT_LINES.staleBookMs / 1000} seconds old.`
    )
  )

  // Must be zero: a trade from an answer the validator refused.
  gates.push(
    gate(
      'invalid_output',
      'Trades from invalid AI output',
      false,
      openedWatch
        .filter((executor) => {
          const row = decisionRowOf(input.calls, executor.watch as { eventId: string; model: string })
          return row !== undefined && row.status !== 'ok'
        })
        .map((executor) => `${executor.symbol} at ${clock(executor.createdAt)}`),
      openedWatch.length,
      watchNoun,
      openedWatch.length === 0 ? noneOpened : 'Every one followed an answer the validator took.'
    )
  )

  // Must be zero: two of the app's own trades for one event, or one announcement and coin.
  const keyOf = (executor: ExecutorConfig): string =>
    executor.watch !== undefined ? `event ${executor.watch.eventId}` : `${executor.newsRule?.ticker ?? '?'} on announcement ${executor.newsRule?.articleId ?? '?'}`
  const byKey = new Map<string, ExecutorConfig[]>()
  for (const executor of own) byKey.set(keyOf(executor), [...(byKey.get(keyOf(executor)) ?? []), executor])
  gates.push(
    gate(
      'duplicates',
      'Duplicate trades for one event',
      false,
      [...byKey.entries()].filter(([, group]) => group.length > 1 && group.some((executor) => within(executor.createdAt, input))).map(([key, group]) => `${group.length} for ${key}`),
      opened.length,
      'paper trades opened',
      opened.length === 0 ? 'No paper trade of the app opened in this span.' : `${eachOf(opened.length, 'trade', 'trades')} was the only one for its event.`
    )
  )

  // Must be zero: a gap in the stream left open, or a trade opened on the stream's price inside one.
  if (input.connection === null) {
    gates.push({ id: 'stream_gaps', label: 'Unhandled stream gaps', twelveHour: false, status: 'not measured', detail: "The stream's log could not be read." })
  } else {
    const stuck = gapsIn.filter((gap) => gap.to === null && toSec - gap.from > REPORT_LINES.gapGraceSeconds).map((gap) => `open since ${clock(gap.from)}`)
    const insideGap = openedWatch
      .filter((executor) => executor.watch?.book?.source === 'stream' && gapsIn.some((gap) => executor.createdAt >= gap.from && executor.createdAt <= (gap.to ?? toSec)))
      .map((executor) => `${executor.symbol} opened on the stream's price inside a gap, at ${clock(executor.createdAt)}`)
    gates.push(
      gate(
        'stream_gaps',
        'Unhandled stream gaps',
        false,
        [...stuck, ...insideGap],
        gapsIn.length + openedWatch.length,
        'gaps and trades',
        gapsIn.length === 0 ? 'No gap in the stream in this span.' : `${counted(gapsIn.length, 'gap', 'gaps')}, each closed within ${REPORT_LINES.gapGraceSeconds / 60} minutes, and no trade opened on the stream's price inside one.`
      )
    )
  }

  // Must be zero: a trade of the watch's opened past a limit, as the limits are set now.
  const sideOf = (executor: ExecutorConfig): string => (executor.params as PositionExecutorParams).side
  const openAt = (time: number, self: ExecutorConfig, from: ExecutorConfig[]): ExecutorConfig[] =>
    from.filter((other) => other.id !== self.id && other.createdAt < time && (other.stoppedAt === null || other.stoppedAt > time))
  const watchTrades = own.filter((executor) => executor.watch !== undefined)
  const bypasses: string[] = []
  for (const executor of openedWatch) {
    const others = openAt(executor.createdAt, executor, watchTrades)
    const why: string[] = []
    if (others.some((other) => other.symbol === executor.symbol)) why.push(`another open on ${executor.symbol}`)
    if (others.length >= input.watchPaper.maxOpen) why.push(`${others.length} open already, the most is ${input.watchPaper.maxOpen}`)
    const sameSide = others.filter((other) => sideOf(other) === sideOf(executor)).length
    if (sameSide >= input.watchPaper.maxSameSide) why.push(`${sameSide} open on the same side, the most is ${input.watchPaper.maxSameSide}`)
    if (input.maxOutQuote !== null) {
      const out = openAt(executor.createdAt, executor, own)
        .filter((other) => other.quoteAsset === executor.quoteAsset)
        .reduce((sum, other) => sum + (other.params as PositionExecutorParams).amountQuote, 0)
      const stake = (executor.params as PositionExecutorParams).amountQuote
      if (out + stake > input.maxOutQuote + 1e-9) why.push(`${out + stake} ${executor.quoteAsset} out with it, the cap is ${input.maxOutQuote}`)
    }
    if (why.length > 0) bypasses.push(`${executor.symbol} at ${clock(executor.createdAt)} (${why.join(', ')})`)
  }
  gates.push(
    gate(
      'risk_bypass',
      'Risk bypasses',
      false,
      bypasses,
      openedWatch.length,
      watchNoun,
      openedWatch.length === 0 ? noneOpened : 'Each was within the limits as they are set now: one a pair, so many open, so many on one side, and the money out.'
    )
  )

  // Must be zero: a trade opened on a price that is not one, or whose figures are not numbers.
  const badPrices: string[] = []
  for (const executor of opened) {
    const book = executor.watch?.book
    if (book !== undefined && !(finite(book.bid) && finite(book.ask) && book.bid > 0 && book.ask >= book.bid && finite(book.spreadPct) && book.spreadPct <= REPORT_LINES.maxSpreadPct + 1e-9)) {
      badPrices.push(`${executor.symbol} at ${clock(executor.createdAt)}: bid ${book.bid}, ask ${book.ask}`)
    }
    const reading = readings.get(executor.id)
    if (reading !== undefined && reading.enteredAt !== null && !(finite(reading.entryPrice) && reading.entryPrice > 0)) badPrices.push(`${executor.symbol}: entered at ${String(reading.entryPrice)}`)
    const result = resultOf(executor)
    if (result !== undefined && !finite(result.pnlQuote)) badPrices.push(`${executor.symbol}: a result of ${String(result.pnlQuote)}`)
  }
  gates.push(
    gate(
      'bad_prices',
      'Bad prices',
      false,
      badPrices,
      opened.length,
      'paper trades opened',
      opened.length === 0 ? 'No paper trade of the app opened in this span.' : `Every price was a number above zero, and every spread at most ${REPORT_LINES.maxSpreadPct}%.`
    )
  )

  // Must be zero: a trade of the watch's made from a decision not in shape to be one.
  const malformed: string[] = []
  for (const executor of openedWatch) {
    const params = executor.params as PositionExecutorParams
    const why: string[] = []
    if (!(finite(params.amountQuote) && params.amountQuote > 0)) why.push('no stake')
    if (!(finite(params.stopLossPct) && params.stopLossPct > 0) || !(finite(params.takeProfitPct) && params.takeProfitPct > 0)) why.push('no stop or no target')
    if (!(finite(params.timeLimitSec) && params.timeLimitSec > 0)) why.push('no time limit')
    const range = params.entryRange
    if (range == null || !(finite(range.min) && finite(range.max) && range.min > 0 && range.min <= range.max)) why.push('no entry range')
    const row = decisionRowOf(input.calls, executor.watch as { eventId: string; model: string })
    if (row !== undefined && row.status === 'ok' && actionable(row) !== params.side) why.push(`an answer the app would not act on as a ${params.side.toUpperCase()}`)
    if (why.length > 0) malformed.push(`${executor.symbol} at ${clock(executor.createdAt)} (${why.join(', ')})`)
  }
  gates.push(gate('malformed', 'Malformed decisions traded', false, malformed, openedWatch.length, watchNoun, openedWatch.length === 0 ? noneOpened : 'Each had its entry range, stop, target, time limit and stake, and followed a call to act on.'))

  // Rates.
  gates.push(
    calls.successRate === null
      ? { id: 'ai_success', label: 'AI calls answered', twelveHour: false, status: 'not measured', detail: 'No model was asked in this span.' }
      : {
          id: 'ai_success',
          label: 'AI calls answered',
          twelveHour: false,
          status: calls.successRate > REPORT_LINES.aiSuccess ? 'pass' : 'fail',
          detail: `${calls.answered} of ${calls.total} got an answer back (${pct(calls.successRate)}); more than ${pct(REPORT_LINES.aiSuccess)} is needed.`
        }
  )
  gates.push(
    calls.validationRate === null
      ? { id: 'validation', label: 'Answers valid', twelveHour: false, status: 'not measured', detail: 'No answer came back in this span.' }
      : {
          id: 'validation',
          label: 'Answers valid',
          twelveHour: false,
          status: calls.validationRate > REPORT_LINES.validation ? 'pass' : 'fail',
          detail: `${calls.valid} of ${calls.answered} answers passed the validator (${pct(calls.validationRate)}); more than ${pct(REPORT_LINES.validation)} is needed.`
        }
  )

  // Twelve hours: every recommendation whose life is over has an outcome.
  const over = input.recommendations.filter((recommendation) => recommendation.endsAt <= toSec && within(eventTimeOf(input, recommendation.eventId) ?? recommendation.endsAt, input))
  const noOutcome = over.filter((recommendation) => recommendation.status !== 'closed' && recommendation.status !== 'expired')
  gates.push(
    over.length === 0
      ? { id: 'outcomes', label: 'Every recommendation has an outcome', twelveHour: true, status: 'not measured', detail: 'No recommendation to act on ended in this span.' }
      : gate(
          'outcomes',
          'Every recommendation has an outcome',
          true,
          noOutcome.map((recommendation) => `${recommendation.model} on ${recommendation.eventId} (${recommendation.status === 'unscored' ? 'its minutes could not be read' : `still ${recommendation.status}`})`),
          over.length,
          'recommendations that ended',
          `${eachOf(over.length, 'recommendation that ended', 'recommendations that ended')} has its outcome: entered and closed, or expired unfilled.`
        )
  )

  // Twelve hours: every trade traces to the event and the answer, or the announcement, it was opened on.
  const eventIds = new Set(input.events.map((event) => event.id))
  const untraced: string[] = []
  for (const executor of opened) {
    if (executor.watch !== undefined) {
      const missing: string[] = []
      if (!eventIds.has(executor.watch.eventId)) missing.push('its event is not on file')
      if (decisionRowOf(input.calls, executor.watch) === undefined) missing.push('its answer is not on file')
      if (missing.length > 0) untraced.push(`${executor.symbol} at ${clock(executor.createdAt)} (${missing.join(', ')})`)
    } else if (!(finite(executor.newsRule?.articleId) && (executor.newsRule?.articleId ?? 0) > 0 && (executor.newsRule?.ticker ?? '') !== '')) {
      untraced.push(`${executor.symbol} at ${clock(executor.createdAt)} (no announcement on it)`)
    }
  }
  gates.push(
    opened.length === 0
      ? { id: 'traced', label: 'Every trade traces to its event', twelveHour: true, status: 'not measured', detail: 'No paper trade of the app opened in this span.' }
      : gate('traced', 'Every trade traces to its event', true, untraced, opened.length, 'paper trades opened', 'Each traces to its event and the answer it followed, or to its announcement.')
  )

  // Twelve hours: costs. Fees are checked against the engine's own figures, and slippage by the rate
  // each trade carries.
  const feeFailures: string[] = []
  for (const executor of enteredEnded) {
    const reading = readings.get(executor.id)
    const result = resultOf(executor) as { pnlQuote: number }
    if (reading === undefined || !finite(reading.grossQuote) || !finite(reading.feesQuote)) feeFailures.push(`${executor.symbol}: its minutes could not be read to check`)
    else if (!(reading.feesQuote > 0) || Math.abs(result.pnlQuote - (reading.grossQuote - reading.feesQuote)) > 1e-6 * Math.max(1, Math.abs(reading.grossQuote))) {
      feeFailures.push(`${executor.symbol}: made ${result.pnlQuote}, where ${reading.grossQuote} less ${reading.feesQuote} in fees was expected`)
    }
  }
  gates.push(
    enteredEnded.length === 0
      ? { id: 'fees', label: 'Fees are applied', twelveHour: true, status: 'not measured', detail: 'No paper trade that entered ended in this span.' }
      : gate('fees', 'Fees are applied', true, feeFailures, enteredEnded.length, 'paper trades that ended', `${eachOf(enteredEnded.length, 'trade', 'trades')} is net of a fee on both fills, as the engine charges.`)
  )
  // A trade made since the paper engine charges slippage carries its rate, and the engine charges it
  // on every market fill; one made before carries none, and filled at its prices.
  const slippage: { asset: string; amount: number }[] = []
  const unslipped: string[] = []
  for (const executor of enteredEnded) {
    const params = executor.params as PositionExecutorParams
    const rate = positionSlippageRate(params)
    if (!(rate > 0)) {
      unslipped.push(`${executor.symbol} at ${clock(executor.createdAt)} carries no slippage rate, so it filled at its prices`)
      continue
    }
    // Its entry, and its exit unless a target ended it: a target is a resting limit, paid exactly.
    addTo(slippage, executor.quoteAsset, params.amountQuote * rate * ((resultOf(executor) as { exit: string }).exit === 'take_profit' ? 1 : 2))
  }
  gates.push(
    enteredEnded.length === 0
      ? { id: 'slippage', label: 'Slippage is applied', twelveHour: true, status: 'not measured', detail: 'No paper trade that entered ended in this span.' }
      : gate(
          'slippage',
          'Slippage is applied',
          true,
          unslipped,
          enteredEnded.length,
          'paper trades that ended',
          `${eachOf(enteredEnded.length, 'trade', 'trades')} was charged slippage on its market fills, at its pair's rate: about ${slippage.map((entry) => `${Number(entry.amount.toPrecision(3))} ${entry.asset}`).join(' and ')} in all.`
        )
  )

  // Twelve hours: every story read has its link.
  const stories = input.stories.filter((story) => within(story.publishedAt, input))
  gates.push(
    stories.length === 0
      ? { id: 'news_links', label: 'News links are present', twelveHour: true, status: 'not measured', detail: 'No story was published in this span.' }
      : gate(
          'news_links',
          'News links are present',
          true,
          stories.filter((story) => !/^https:\/\/\S+$/.test(story.url)).map((story) => `a story at ${clock(story.publishedAt)} has ${story.url === '' ? 'no link' : `"${story.url}"`}`),
          stories.length,
          'stories',
          `${eachOf(stories.length, 'story', 'stories')} has its https link.`
        )
  )

  return {
    version: SESSION_REPORT_VERSION,
    span: input.span,
    fromSec,
    toSec,
    appStartedSec: input.appStartedSec,
    events: { raised: events.length, urgent: events.filter((event) => event.band === 'urgent').length, takenUp: takenUp.size },
    calls,
    answers,
    paper,
    alerts,
    stream,
    gates,
    twelveHour,
    passed: gates.every((entry) => entry.status !== 'fail' || (entry.twelveHour && !twelveHour))
  }
}

function eventTimeOf(input: SessionReportInput, eventId: string): number | undefined {
  return input.events.find((event) => event.id === eventId)?.time
}

function clock(sec: number): string {
  return `${new Date(sec * 1000).toISOString().slice(11, 16)} UTC`
}

function csvCell(value: string | number | null): string {
  const text = value === null ? '' : String(value)
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text
}

/** The report as a spreadsheet: one line a figure or gate, as section, item, value and detail. */
export function sessionReportCsv(report: SessionReport): string {
  const lines: (string | number | null)[][] = [['section', 'item', 'value', 'detail']]
  const add = (section: string, item: string, value: string | number | null, detail = ''): void => void lines.push([section, item, value, detail])
  add('span', 'from', new Date(report.fromSec * 1000).toISOString())
  add('span', 'to', new Date(report.toSec * 1000).toISOString())
  add('span', 'app started', new Date(report.appStartedSec * 1000).toISOString(), 'the stream, the alerts and the refusals reach back no further')
  add('events', 'raised', report.events.raised)
  add('events', 'urgent', report.events.urgent)
  add('events', 'taken up by the watch', report.events.takenUp)
  add('calls', 'made', report.calls.total)
  add('calls', 'answered', report.calls.answered)
  add('calls', 'valid', report.calls.valid)
  add('calls', 'failed', report.calls.failed)
  add('calls', 'latency p50 ms', report.calls.latencyP50Ms)
  add('calls', 'latency p95 ms', report.calls.latencyP95Ms)
  add('calls', 'cost usd', Number(report.calls.costUsd.toFixed(6)))
  add('answers', 'BUY', report.answers.buy)
  add('answers', 'SELL', report.answers.sell)
  add('answers', 'HOLD', report.answers.hold)
  add('answers', 'NO TRADE', report.answers.noTrade)
  add('paper', 'opened', report.paper.opened, `${report.paper.openedWatch} by the watch, ${report.paper.openedNews} by the news rules`)
  add('paper', 'ended', report.paper.ended)
  add('paper', 'open now', report.paper.open)
  for (const refusal of report.paper.refused) add('paper refused', refusal.reason, refusal.count)
  for (const entry of report.paper.net) add('paper net', entry.asset, Number(entry.amount.toPrecision(8)), 'after fees')
  add('paper', 'R', Number(report.paper.r.toFixed(4)), `over ${report.paper.rTrades} with a stop`)
  for (const entry of report.paper.fees) add('paper fees', entry.asset, Number(entry.amount.toPrecision(8)))
  add('paper', 'best move %', report.paper.bestPct === null ? null : Number(report.paper.bestPct.toFixed(4)))
  add('paper', 'worst move %', report.paper.worstPct === null ? null : Number(report.paper.worstPct.toFixed(4)))
  add('paper', 'signal age median s', report.paper.signalAgeSec.median)
  add('paper', 'signal age max s', report.paper.signalAgeSec.max)
  for (const severity of ['info', 'watch', 'high', 'critical'] as const) add('alerts', severity.toUpperCase(), report.alerts[severity])
  if (report.stream !== null) {
    add('stream', 'connects', report.stream.connects, 'since the app started')
    add('stream', 'drops', report.stream.drops, 'since the app started')
    add('stream', 'gaps', report.stream.gaps)
    add('stream', 'gap seconds', report.stream.gapSeconds)
    add('stream', 'host', report.stream.host, 'the data host the socket is on')
    add('stream', 'host switches', report.stream.hostSwitches, 'since the app started: the socket moved to a host that answers')
    add('stream', 'data host switches', report.stream.dataHostSwitches, 'since the app started: REST moved to its partner')
  }
  for (const entry of report.gates) {
    const applies = !entry.twelveHour || report.twelveHour
    add('gate', entry.label, applies ? entry.status.toUpperCase() : 'not applied', `${entry.twelveHour ? '(12-hour) ' : ''}${entry.detail}`)
  }
  add('gate', 'all gates that apply', report.passed ? 'PASS' : 'FAIL')
  return lines.map((line) => line.map(csvCell).join(',')).join('\n')
}
