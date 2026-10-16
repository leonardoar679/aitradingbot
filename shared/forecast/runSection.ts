import { FEE_RATE, positionSlippageRate } from '../fees'
import type { ExecutorConfig } from '../ipc'
import { HORIZON_BARS, type Horizon } from './features'
import type { MissingOutcomeLine, OutcomeLine, PredictionLine } from './forecastRecord'
import { liveLab, type LabMetrics, type LiveVariant, type TimingMetrics } from './lab'

// THE PRICE FORECAST IN A RUN'S REPORT (the V6 document, §45-50 and §113-114; V6 Stages 15-16, 13
// October 2026): what the engine forecast over a run's span and how it came out, read from its own
// record (forecasts/predictions-*.jsonl and outcomes-*.jsonl) -- the forecasts made and their calls, per
// horizon the calls' accuracy, the ranges' coverage and the median's error, the four variants on the same
// moments (§49), the bull and bear calls' success, the forecasts a story moved against the rest, the
// best-rated, best-called and worst-called forecasts, and the forecast trader's paper trades with their
// fees and slippage -- with the document's gates for a run: forecasts made at their closes and stamped
// right, every pair at every close, every forecast calibrated, a refresh linked to what it replaced, every
// due forecast judged, every story measured to four hours, every notice's sound on file, no trade on a
// stale forecast, and every trade's record whole. A span shorter than a horizon judges none of it, and
// says so.

export const RUN_SECTION_VERSION = 'forecast-run-v3'

/** The lines the gates are read by, pinned. */
export const RUN_LINES = {
  /** The record keeps every pair at each quarter-hour close. */
  gridSeconds: 900,
  /** A forecast is made within this long of its close. */
  madeWithinSeconds: 120,
  /** An outcome is written at the first close after it is due: wanted only past this. */
  outcomeGraceSeconds: 600,
  /** Its bars still short, the engine waits this long past due before it writes a line saying why
   * (forecastService.ts MISSING_AFTER_SEC): until then an outcome not written is waiting, not missing --
   * as V6 Stage 15's run found, one gate earlier calling it unjudged. */
  missingAfterSeconds: 3600,
  /** A trade is on a stale forecast when its forecast's close is more than two closes old. */
  staleTradeSeconds: 600,
  /** A story's reaction is measured to four hours: wanted only this long after it. */
  storySeconds: 4 * 3600 + 600,
  /** The trades a profitability conclusion needs (shared/experimentRun.ts VERDICT_LINES). */
  minTrades: 30,
  /** The best-rated forecasts listed, and the best and worst called. */
  top: 10,
  extremes: 5
} as const

export const SAMPLE_NOTE = 'Sample size is too small for a profitability conclusion.'

export interface RunHorizon {
  outcomes: number
  /** The shown forecast's (V4's) figures over the span's outcomes. */
  metrics: LabMetrics
  /** §49: the four variants on the same moments -- V1 price only, V2 with the technical figures, V3 with
   * the news, V4 with the AI's reading (what is shown). */
  variants: Record<LiveVariant, LabMetrics>
  /** BULLISH calls and how many ended up; BEARISH calls and how many ended down. */
  bull: { calls: number; right: number }
  bear: { calls: number; right: number }
  /** The forecasts a story moved, and the rest. */
  news: { moved: LabMetrics; unmoved: LabMetrics }
  /** The forecasts Bitcoin's sharp move widened, and the same by V2's own levels (V6.1); absent where none. */
  shock?: { widened: LabMetrics; unwidened: LabMetrics }
  /** The path's figures (V7.1 Stage 3): when the median was said to be reached against when it was, and
   * whether the likely high and low held; absent where no forecast carried them. */
  timing?: TimingMetrics
}

/** One forecast at its lead horizon, and how it came out where it has. */
export interface RunForecastRow {
  pair: string
  t: number
  horizon: Horizon
  call: string
  quality: number | null
  medianPct: number
  movePct: number | null
  in80: boolean | null
}

export interface ForecastRunGate {
  id:
    | 'forecast_made'
    | 'forecast_stamped'
    | 'forecast_history'
    | 'forecast_calibrated'
    | 'forecast_refresh'
    | 'forecast_outcomes'
    | 'news_reactions'
    | 'notice_sounds'
    | 'stale_trades'
    | 'trades_whole'
  label: string
  status: 'pass' | 'fail' | 'not measured'
  detail: string
}

export interface ForecastRunTrades {
  opened: number
  closed: number
  wins: number
  /** After fees and slippage, as the engine charged them. */
  netQuote: number
  feesQuote: number
  slippageQuote: number
  best: { pair: string; pnlQuote: number } | null
  worst: { pair: string; pnlQuote: number } | null
}

export interface ForecastRunSection {
  version: string
  fromSec: number
  toSec: number
  predictions: {
    lines: number
    pairs: number
    /** The quarter-hour closes the record holds forecasts at, of those the span holds. */
    gridCloses: number
    expectedGridCloses: number
    refreshes: number
    byReason: Record<string, number>
  }
  /** §48: the span's forecasts by their call at their lead horizon, and by their coin's class. */
  classes: { calls: Record<string, number>; pairClasses: Record<string, number> }
  horizons: Partial<Record<Horizon, RunHorizon>>
  /** §48: the best-rated forecasts at their lead horizon, and the best and worst called once judged. */
  top: RunForecastRow[]
  best: RunForecastRow[]
  worst: RunForecastRow[]
  trades: ForecastRunTrades
  /** SAMPLE_NOTE where fewer trades closed than a conclusion needs. */
  sampleNote: string | null
  gates: ForecastRunGate[]
  /** No gate failed; one not measured fails nothing. */
  passed: boolean
}

export interface ForecastRunInput {
  fromSec: number
  toSec: number
  /** The record's forecasts: those of the span are judged; any before it may be named by a trade. */
  predictions: readonly PredictionLine[]
  outcomes: readonly (OutcomeLine | MissingOutcomeLine)[]
  executors: readonly ExecutorConfig[]
  /** The notices told in the span, with the sound each made where it was recorded. */
  alerts: readonly { at: number; sound?: string }[]
  /** When the section is read: every horizon of the span's forecasts due by then, with time to write
   * it, is wanted judged. The span's end where absent -- a report filed as the run ends; a run read an
   * hour on wants its forecasts' hours too. */
  asOfSec?: number
  /** The stories read, each with the coins it names directly that trade against USDT on Binance, and
   * what the price did around each (shared/newsFeed.ts): a story measured to four hours has `h4`. Absent
   * where they could not be read: the gate is then not measured. */
  stories?: readonly { id: string; publishedAt: number; tradable: boolean }[]
  reactions?: Readonly<Record<string, { after: { h4: number | null } }>>
  /** The pairs each recorded close's pass held bars for (forecasts/passes-*.jsonl, since V6 Stage 16).
   * Absent on an older record: a pair is then wanted at every close from its first to its last. */
  passes?: readonly { t: number; held: readonly string[] }[]
}

const isMissing = (line: OutcomeLine | MissingOutcomeLine): line is MissingOutcomeLine => 'missing' in line
const within = (time: number, input: { fromSec: number; toSec: number }): boolean => time >= input.fromSec && time <= input.toSec
const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`

/** A horizon's length in seconds. */
export function horizonSeconds(horizon: Horizon): number {
  return HORIZON_BARS[horizon] * 300
}

/** The horizon a forecast is read at: its best, else the hour, else the first it has. */
function leadOf(line: PredictionLine): Horizon | null {
  if (line.best !== null && line.h[line.best] !== undefined) return line.best
  if (line.h.hour1 !== undefined) return 'hour1'
  return (Object.keys(line.h) as Horizon[])[0] ?? null
}

/** A forecast's call in a word: UNCERTAIN, STRONG BULLISH, BULLISH, NEUTRAL and so on. */
function callOf(line: PredictionLine, horizon: Horizon): string {
  const at = line.h[horizon]!
  if (at.uncertain) return 'UNCERTAIN'
  return at.strong ? `STRONG ${at.dir}` : at.dir
}

/** The section over a span, from the record and the executors. */
export function forecastRunSectionOf(input: ForecastRunInput): ForecastRunSection {
  const span = { fromSec: input.fromSec, toSec: input.toSec }
  const asOfSec = Math.max(span.toSec, input.asOfSec ?? span.toSec)
  const lines = input.predictions.filter((line) => within(line.t, span))
  const ids = new Set(lines.map((line) => line.id))
  const judged = input.outcomes.filter((line) => ids.has(line.id))
  const outcomes = judged.filter((line): line is OutcomeLine => !isMissing(line))
  const lab = liveLab(lines, outcomes)

  const horizons: ForecastRunSection['horizons'] = {}
  for (const [horizon, read] of Object.entries(lab.horizons) as [Horizon, NonNullable<(typeof lab.horizons)[Horizon]>][]) {
    const own = outcomes.filter((line) => line.h === horizon)
    const bull = own.filter((line) => line.dir === 'BULLISH')
    const bear = own.filter((line) => line.dir === 'BEARISH')
    horizons[horizon] = {
      outcomes: read.outcomes,
      metrics: read.variants.v4,
      variants: read.variants,
      bull: { calls: bull.length, right: bull.filter((line) => line.move > 0).length },
      bear: { calls: bear.length, right: bear.filter((line) => line.move < 0).length },
      news: read.news,
      ...(read.shock === undefined ? {} : { shock: read.shock }),
      ...(read.timing === undefined ? {} : { timing: read.timing })
    }
  }

  // §48: the calls, the best-rated, and the best and worst called.
  const calls: Record<string, number> = {}
  const pairClasses: Record<string, number> = {}
  const outcomeOf = new Map(outcomes.map((line) => [`${line.id}|${line.h}`, line]))
  const rows: RunForecastRow[] = []
  for (const line of lines) {
    pairClasses[line.cls] = (pairClasses[line.cls] ?? 0) + 1
    const horizon = leadOf(line)
    if (horizon === null) continue
    const call = callOf(line, horizon)
    calls[call] = (calls[call] ?? 0) + 1
    const at = line.h[horizon]!
    const outcome = outcomeOf.get(`${line.id}|${horizon}`)
    rows.push({ pair: line.pair, t: line.t, horizon, call, quality: at.qual ?? null, medianPct: at.q[2], movePct: outcome?.move ?? null, in80: outcome?.in80 ?? null })
  }
  const top = rows
    .filter((row) => row.quality !== null)
    .sort((a, b) => (b.quality ?? 0) - (a.quality ?? 0) || a.t - b.t || a.pair.localeCompare(b.pair))
    .slice(0, RUN_LINES.top)
  const error = (row: RunForecastRow): number => Math.abs((row.movePct ?? 0) - row.medianPct)
  const byError = rows.filter((row) => row.movePct !== null).sort((a, b) => error(a) - error(b) || a.t - b.t || a.pair.localeCompare(b.pair))
  const best = byError.slice(0, RUN_LINES.extremes)
  const worst = byError.slice(-RUN_LINES.extremes).reverse()

  const grid = lines.filter((line) => line.why === 'grid')
  const gridCloses = new Set(grid.map((line) => line.t)).size
  const firstGrid = Math.ceil(span.fromSec / RUN_LINES.gridSeconds) * RUN_LINES.gridSeconds
  const expectedGridCloses = firstGrid > span.toSec ? 0 : Math.floor((span.toSec - firstGrid) / RUN_LINES.gridSeconds) + 1
  const refreshes = lines.filter((line) => line.why === 'refresh')
  const byReason: Record<string, number> = {}
  for (const line of refreshes) for (const reason of line.reasons ?? []) byReason[reason] = (byReason[reason] ?? 0) + 1

  // The forecast trader's paper trades opened in the span, and those of them that closed in it.
  const trades = input.executors.filter((executor) => executor.forecast !== undefined && within(executor.forecast.openedAt, span))
  const closed = trades.filter((executor) => executor.forecast?.result !== undefined && within(executor.forecast.result.closedAt, span))

  const gates = [
    madeGate(lines.length, gridCloses, expectedGridCloses),
    stampedGate(lines),
    historyGate(grid, (input.passes ?? []).filter((pass) => within(pass.t, span) && pass.t % RUN_LINES.gridSeconds === 0)),
    calibratedGate(lines),
    refreshGate(refreshes),
    outcomesGate(lines, judged, asOfSec),
    reactionsGate(input, span, asOfSec),
    soundsGate(input.alerts.filter((alert) => within(alert.at, span))),
    staleGate(trades),
    wholeGate(trades)
  ]
  return {
    version: RUN_SECTION_VERSION,
    fromSec: span.fromSec,
    toSec: span.toSec,
    predictions: { lines: lines.length, pairs: new Set(lines.map((line) => line.pair)).size, gridCloses, expectedGridCloses, refreshes: refreshes.length, byReason },
    classes: { calls, pairClasses },
    horizons,
    top,
    best,
    worst,
    trades: tradesOf(trades, closed),
    sampleNote: closed.length < RUN_LINES.minTrades ? SAMPLE_NOTE : null,
    gates,
    passed: gates.every((gate) => gate.status !== 'fail')
  }
}

/** What the trades made, and what their fills cost: a fee on each fill, the slippage the engine charges
 * each, on the trades that entered. */
function tradesOf(trades: readonly ExecutorConfig[], closed: readonly ExecutorConfig[]): ForecastRunTrades {
  let netQuote = 0
  let feesQuote = 0
  let slippageQuote = 0
  let wins = 0
  let best: ForecastRunTrades['best'] = null
  let worst: ForecastRunTrades['worst'] = null
  for (const executor of closed) {
    const result = executor.forecast!.result!
    netQuote += result.pnlQuote
    if (result.pnlQuote > 0) wins++
    if (best === null || result.pnlQuote > best.pnlQuote) best = { pair: executor.symbol, pnlQuote: result.pnlQuote }
    if (worst === null || result.pnlQuote < worst.pnlQuote) worst = { pair: executor.symbol, pnlQuote: result.pnlQuote }
    if (result.exit === 'entry_expired' || result.exit === 'btc_moved') continue
    // A record without its stake adds no cost rather than breaking the report.
    const params = (executor.params ?? {}) as { amountQuote?: number; slippageRate?: number | null }
    const stake = typeof params.amountQuote === 'number' && Number.isFinite(params.amountQuote) ? params.amountQuote : 0
    feesQuote += stake * FEE_RATE * 2
    slippageQuote += stake * 2 * positionSlippageRate(params)
  }
  return { opened: trades.length, closed: closed.length, wins, netQuote, feesQuote, slippageQuote, best, worst }
}

/** Forecasts were made, at each quarter-hour close of the span but at most one at its edges. */
function madeGate(lines: number, gridCloses: number, expected: number): ForecastRunGate {
  const label = 'Forecasts are made at their closes'
  if (expected === 0) return { id: 'forecast_made', label, status: 'not measured', detail: 'The span holds no quarter-hour close.' }
  const ok = lines > 0 && gridCloses >= expected - 1
  return {
    id: 'forecast_made',
    label,
    status: ok ? 'pass' : 'fail',
    detail: `${plural(lines, 'forecast', 'forecasts')} on record, at ${gridCloses} of the span's ${plural(expected, 'quarter-hour close', 'quarter-hour closes')}.`
  }
}

/** Each forecast is stamped with a five-minute close, and was made after it: a quarter-hour's within
 * two minutes, a refresh before the next close but one. */
function stampedGate(lines: readonly PredictionLine[]): ForecastRunGate {
  const label = 'Forecasts carry their close and their making'
  if (lines.length === 0) return { id: 'forecast_stamped', label, status: 'not measured', detail: 'No forecast is on record in the span.' }
  const wrong = lines.filter((line) => {
    const madeSec = line.at / 1000
    if (line.t % 300 !== 0 || madeSec < line.t) return true
    return line.why === 'grid' ? madeSec > line.t + RUN_LINES.madeWithinSeconds : madeSec > line.t + 600
  })
  return {
    id: 'forecast_stamped',
    label,
    status: wrong.length === 0 ? 'pass' : 'fail',
    detail: wrong.length === 0 ? `Each of the ${plural(lines.length, 'forecast', 'forecasts')} is stamped with its close and was made after it, in time.` : `${plural(wrong.length, 'forecast is', 'forecasts are')} stamped wrong or made late, the first ${wrong[0].pair} at ${wrong[0].t}.`
  }
}

/** §114, history complete: no pair skipped a quarter-hour close -- the engine forecasts a pair only with
 * its bars there. Where the passes are on record, a pair is wanted at each close whose pass held bars
 * for it, from its first forecast in the span on: one that had left the research's pairs was not held,
 * and one never yet forecast -- too young for its figures -- is not wanted. On an older record, at every
 * close from its first to its last. */
function historyGate(grid: readonly PredictionLine[], passes: readonly { t: number; held: readonly string[] }[]): ForecastRunGate {
  const label = 'Every pair is forecast at every close'
  if (grid.length === 0) return { id: 'forecast_history', label, status: 'not measured', detail: 'No quarter-hour forecast is on record in the span.' }
  const closes = [...new Set(grid.map((line) => line.t))].sort((a, b) => a - b)
  const byPair = new Map<string, Set<number>>()
  for (const line of grid) {
    const held = byPair.get(line.pair) ?? new Set<number>()
    held.add(line.t)
    byPair.set(line.pair, held)
  }
  const holes: { pair: string; t: number }[] = []
  if (passes.length > 0) {
    const firsts = new Map([...byPair].map(([pair, held]) => [pair, Math.min(...held)]))
    for (const pass of [...passes].sort((a, b) => a.t - b.t)) {
      for (const pair of pass.held) {
        const first = firsts.get(pair)
        if (first !== undefined && first < pass.t && !byPair.get(pair)!.has(pass.t)) holes.push({ pair, t: pass.t })
      }
    }
  } else {
    for (const [pair, held] of byPair) {
      const first = Math.min(...held)
      const last = Math.max(...held)
      for (const close of closes) if (close > first && close < last && !held.has(close)) holes.push({ pair, t: close })
    }
  }
  const whole =
    passes.length > 0
      ? `Each of the ${plural(byPair.size, 'pair', 'pairs')} is on record at every quarter-hour close its pass held bars for, from its first.`
      : `Each of the ${plural(byPair.size, 'pair', 'pairs')} is on record at every quarter-hour close from its first to its last.`
  return {
    id: 'forecast_history',
    label,
    status: holes.length === 0 ? 'pass' : 'fail',
    detail: holes.length === 0 ? whole : `${plural(new Set(holes.map((hole) => hole.pair)).size, 'pair skipped', 'pairs skipped')} a close, the first ${holes[0].pair} at ${holes[0].t}.`
  }
}

/** §114, calibration recorded: each forecast names the model run it came from and the walk forward
 * that calibrated it. */
function calibratedGate(lines: readonly PredictionLine[]): ForecastRunGate {
  const label = 'Every forecast names its calibration'
  if (lines.length === 0) return { id: 'forecast_calibrated', label, status: 'not measured', detail: 'No forecast is on record in the span.' }
  const named = (value: unknown): boolean => typeof value === 'string' && value !== '' && value !== 'none'
  const unnamed = lines.filter((line) => !named(line.run) || !named(line.foldsRun)).length
  return {
    id: 'forecast_calibrated',
    label,
    status: unnamed === 0 ? 'pass' : 'fail',
    detail: unnamed === 0 ? `Each of the ${plural(lines.length, 'forecast', 'forecasts')} names its model run and the walk forward that calibrated it.` : `${plural(unnamed, 'forecast names', 'forecasts name')} no model run or no calibration.`
  }
}

/** Each forecast made again between closes says why, and which it replaced. */
function refreshGate(refreshes: readonly PredictionLine[]): ForecastRunGate {
  const label = 'A refresh names its reason and what it replaced'
  if (refreshes.length === 0) return { id: 'forecast_refresh', label, status: 'not measured', detail: 'Nothing triggered a refresh in the span.' }
  const unlinked = refreshes.filter((line) => (line.reasons ?? []).length === 0 || typeof line.previous !== 'string' || line.previous === '')
  return {
    id: 'forecast_refresh',
    label,
    status: unlinked.length === 0 ? 'pass' : 'fail',
    detail: unlinked.length === 0 ? `Each of the ${plural(refreshes.length, 'refresh', 'refreshes')} names its reason and the forecast it replaced.` : `${plural(unlinked.length, 'refresh names', 'refreshes name')} no reason or no forecast replaced.`
  }
}

/** Every horizon of every forecast that fell due by the time the section is read, with time to write
 * it, was judged: an outcome, or a line saying why it could not be. */
function outcomesGate(lines: readonly PredictionLine[], judged: readonly (OutcomeLine | MissingOutcomeLine)[], asOfSec: number): ForecastRunGate {
  const label = 'Every due forecast is judged'
  const written = new Set(judged.map((line) => `${line.id}|${line.h}`))
  const due: { key: string; dueAt: number }[] = []
  for (const line of lines) {
    for (const horizon of Object.keys(line.h) as Horizon[]) {
      const dueAt = line.t + horizonSeconds(horizon)
      if (dueAt + RUN_LINES.outcomeGraceSeconds <= asOfSec) due.push({ key: `${line.id}|${horizon}`, dueAt })
    }
  }
  if (due.length === 0) return { id: 'forecast_outcomes', label, status: 'not measured', detail: 'No forecast of the span has fallen due with time to judge it.' }
  const unjudged = due.filter((entry) => !written.has(entry.key))
  // Not written within the engine's hour for its bars, with time to write the line after: missing.
  const late = unjudged.filter((entry) => entry.dueAt + RUN_LINES.missingAfterSeconds + RUN_LINES.outcomeGraceSeconds <= asOfSec)
  const waiting = unjudged.length - late.length
  const missing = judged.filter((line) => isMissing(line)).length
  return {
    id: 'forecast_outcomes',
    label,
    status: late.length === 0 ? 'pass' : 'fail',
    detail:
      late.length === 0
        ? `Each of the ${plural(due.length - waiting, 'due horizon', 'due horizons')} has its outcome${missing > 0 ? `, ${missing} of them a line saying why it could not be judged` : ''}${waiting > 0 ? `; ${plural(waiting, 'more waits', 'more wait')} for bars, as the engine waits an hour` : ''}.`
        : `${plural(late.length, 'due horizon has', 'due horizons have')} no outcome an hour after it was due, the first ${late[0].key.replace('|', ' at ')}.`
  }
}

/** §114, news correlation complete: every story of the span naming a coin traded on Binance, once four
 * hours have passed, has what the price did around it measured to four hours. */
function reactionsGate(input: ForecastRunInput, span: { fromSec: number; toSec: number }, asOfSec: number): ForecastRunGate {
  const label = 'Every story is measured to four hours'
  if (input.stories === undefined || input.reactions === undefined) return { id: 'news_reactions', label, status: 'not measured', detail: "The stories' reactions could not be read." }
  const due = input.stories.filter((story) => story.tradable && within(story.publishedAt, span) && story.publishedAt + RUN_LINES.storySeconds <= asOfSec)
  if (due.length === 0) return { id: 'news_reactions', label, status: 'not measured', detail: 'No story of the span naming a traded coin has had four hours yet.' }
  const unmeasured = due.filter((story) => (input.reactions![story.id]?.after.h4 ?? null) === null)
  return {
    id: 'news_reactions',
    label,
    status: unmeasured.length === 0 ? 'pass' : 'fail',
    detail: unmeasured.length === 0 ? `Each of the ${plural(due.length, 'story', 'stories')} naming a traded coin has its four hours measured.` : `${plural(unmeasured.length, 'story has', 'stories have')} no four-hour reaction.`
  }
}

/** Every notice told in the span recorded the sound it made (V6 Stage 13). */
function soundsGate(alerts: readonly { sound?: string }[]): ForecastRunGate {
  const label = "Every notice's sound is on file"
  if (alerts.length === 0) return { id: 'notice_sounds', label, status: 'not measured', detail: 'No notice was told in the span.' }
  const silent = alerts.filter((alert) => typeof alert.sound !== 'string').length
  return {
    id: 'notice_sounds',
    label,
    status: silent === 0 ? 'pass' : 'fail',
    detail: silent === 0 ? `Each of the ${plural(alerts.length, 'notice', 'notices')} records its sound.` : `${plural(silent, 'notice records', 'notices record')} no sound.`
  }
}

/** No forecast trade was opened on a forecast more than two closes old, or past its plan's time. */
function staleGate(trades: readonly ExecutorConfig[]): ForecastRunGate {
  const label = 'No trade on a stale forecast'
  if (trades.length === 0) return { id: 'stale_trades', label, status: 'not measured', detail: 'The forecast trader opened nothing in the span.' }
  const stale = trades.filter((executor) => {
    const mark = executor.forecast!
    return mark.openedAt - mark.barTime > RUN_LINES.staleTradeSeconds || mark.openedAt > mark.plan.validUntil
  })
  return {
    id: 'stale_trades',
    label,
    status: stale.length === 0 ? 'pass' : 'fail',
    detail: stale.length === 0 ? `Each of the ${plural(trades.length, 'paper trade', 'paper trades')} the forecast trader opened followed a forecast of its own close and plan.` : `${plural(stale.length, 'paper trade followed', 'paper trades followed')} a stale forecast.`
  }
}

/** §114, no missing lifecycle record: each forecast trade names its forecast and carries its five levels
 * and its plan, and one stopped carries how it ended. */
function wholeGate(trades: readonly ExecutorConfig[]): ForecastRunGate {
  const label = "Every forecast trade's record is whole"
  if (trades.length === 0) return { id: 'trades_whole', label, status: 'not measured', detail: 'The forecast trader opened nothing in the span.' }
  const broken = trades.filter((executor) => {
    const mark = executor.forecast!
    if (typeof mark.predictionId !== 'string' || mark.predictionId === '' || mark.quantilesPct.length !== 5 || mark.plan === undefined) return true
    return executor.status === 'stopped' && mark.result === undefined
  })
  return {
    id: 'trades_whole',
    label,
    status: broken.length === 0 ? 'pass' : 'fail',
    detail: broken.length === 0 ? `Each of the ${plural(trades.length, 'paper trade', 'paper trades')} names its forecast, carries its levels and plan, and once stopped how it ended.` : `${plural(broken.length, "paper trade's record is", "paper trades' records are")} missing a part.`
  }
}
