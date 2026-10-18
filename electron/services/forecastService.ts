import { app } from 'electron'
import { mkdir, readFile, readdir, unlink } from 'fs/promises'
import { join } from 'path'
import { preEventAt } from '../../shared/calendar/macro'
import { parseAciTable, type AciTable } from '../../shared/forecast/aciTable'
import { staleMonth } from '../../shared/forecast/bars'
import { HORIZONS, type Horizon, type PairSeries } from '../../shared/forecast/features'
import { FORECAST_RECORD_DAYS, isMissing, parseOutcomeLine, parsePredictionLine, recordMonth, type MissingOutcomeLine, type OutcomeLine, type PredictionLine } from '../../shared/forecast/forecastRecord'
import { NEWS_EFFECT_LINES, newsSkillOf, type AnalystReadingInput, type KindReactions, type NewsStoryInput } from '../../shared/forecast/newsEffect'
import type { ClassVerdict } from '../../shared/forecast/opportunityClass'
import { consider, decisionFor, driftReadings, liveSignal, newPassState, owe, owedPairs, pass, pendingCount, recorded, settle, type PassSources, type PassState, type Refreshed, type Settled } from '../../shared/forecast/pass'
import type { PredictionNews, PricePrediction } from '../../shared/forecast/prediction'
import { predictionChangedNotice, stepCall, type CallTrack } from '../../shared/forecast/predictionChange'
import type { ForecastRanking } from '../../shared/forecast/ranking'
import type { EngineState } from '../../shared/forecast/status'
import { newTapeState, staleDay, tapeFileName, tapeLinesOf, type TapeLine } from '../../shared/forecast/tape'
import type { TradeDecision } from '../../shared/forecast/tradeDecision'
import type { LiveState } from '../../shared/liveMarket'
import { writeJsonAtomic } from './atomicWrite'
import { forecastSeries, forecastUniverse, onForecastBars, setOwedPairs } from './forecastDataService'
import { currentForecastCalibration, currentForecastModels, getForecastTrainingState, onForecastTraining } from './forecastTrainingService'
import { appendJsonLines } from './jsonlStore'
import { getResearchState } from './marketResearchService'
import { tell } from './noticeService'
import { getSettings } from './settingsService'

// THE FORECAST, LIVE (the V6 document, §38-43; V6 Stage 7, 13 October 2026).
//
// AT EVERY FIVE-MINUTE CLOSE, once the bars are in (forecastDataService.ts tells it), every pair of the
// research is forecast at every horizon from the bars closed by then (shared/forecast/features.ts), by
// the models in use and the newest walk forward's calibration (forecastTrainingService.ts), each level
// read where the adaptive step has moved it, the range widened for a thin book where the live stream
// holds the pair's book.
//
// BETWEEN CLOSES a pair is forecast again -- from the same bars, with what has changed -- when a story
// of impact 70 names it, the scanner raises an event on it, the live price leaves its 80% range or a
// volume shock hits it, at most once a minute (shared/forecast/refresh.ts); the new forecast names the
// one it replaced. Since V7.1 Stage 11 also when its live spread reaches three times its usual, when the
// live price crosses its expected price against its call, and, for every pair, when the market's shock
// state changes as Bitcoin's minutes read it (shared/forecast/marketShock.ts) where a state's rule is in
// use.
//
// THE MARKET'S STATE (V7.1 Stage 11) is read at every close from Bitcoin's row and the cross-section --
// its fifteen minutes and its hour in usual moves, the breadth of the last fifteen minutes, the market's
// volume against its usual -- with the shock moments of the four hours before from Bitcoin's bars, and
// between closes from its live minutes; it goes on every forecast and every record line.
//
// THE TRADE (V6 Stage 9), kept apart from the forecast: after every pass and every forecast made again,
// each pair's TradeDecision at its lead horizon (shared/forecast/tradeDecision.ts) and the ranking of
// them all, with its top ten and three (ranking.ts), from the research's volumes and the live book.
//
// PREDICTION CHANGED (V6 Stage 10, §71): every pair's call at its best horizon is followed close by
// close (shared/forecast/predictionChange.ts); one the person watches -- among the top ten, held, or
// traded by a paper executor of theirs -- that turns from BULLISH to BEARISH, or back, and holds, is
// told on its own thread, once an hour.
//
// THE NEWS (V6 Stage 8): the stories the news feed holds naming a coin, its reaction library and the
// news analyst's readings on file (handed in by electron/main.ts, which reads the AI ledger -- this
// service reaches nothing that asks a model) move its forecast (shared/forecast/newsEffect.ts); the
// news-moved forecasts' own outcomes say, in time, whether their P(up) may be shown.
//
// ON RECORD (forecasts/): every pair's forecast at every quarter-hour and every forecast made again
// (predictions-YYYY-MM.jsonl); an outcome for each of their horizons once it is due, never before
// (outcomes-YYYY-MM.jsonl; shared/forecast/forecastRecord.ts); the adaptive levels (aci.json), moved
// once a moment by the outcomes due at it; and, since V7.2 Stage 5, the tape (tape-YYYY-MM-DD.jsonl;
// shared/forecast/tape.ts): one line a minute per streamed pair's book and each of Bitcoin's minutes. A
// restart picks up the outcomes still owed from the record. Month and day files older than 180 days are
// deleted at start.
//
// SINCE V7.2 STAGE 5 (18 October 2026) every decision here is made by shared/forecast/pass.ts, pure
// functions handed the sources below and one state: this service reads the files, writes what they return,
// and tells the window and the notices. A replay hands the same functions a record's bars and a run's
// models and must get the same forecasts (shared/forecast/fidelity.ts).
//
// IT FORECASTS FROM PUBLIC MARKET DATA AND NOTHING ELSE. No key, no model of anyone else's, no order.

/** What the news feed and the scanner tell it (electron/main.ts hands their states on). */
export interface NewsSignal {
  stories: readonly {
    id: string
    title?: string
    sourceName?: string
    eventType?: string
    publishedAt?: number
    seenAt: number
    impact: number
    stale?: boolean
    repeat?: boolean
    assets: readonly { ticker: string; relationship: string }[]
  }[]
  reactions?: Readonly<Record<string, { pricedIn: boolean }>>
  impact?: readonly KindReactions[]
}
export interface ScannerSignal {
  recentEvents: readonly { id: string; symbol: string }[]
}

const blank = (): EngineState => ({ status: 'waiting', waitingFor: 'models', lastPassAt: null, lastPassMs: null, predictions: 0, recorded: 0, outcomes: 0, missing: 0, refreshes: 0, pending: 0, lastError: null, market: null, drift: {} })

const state: EngineState = blank()
/** Everything the pass keeps from one moment to the next (shared/forecast/pass.ts). */
const engine: PassState = newPassState()
const tape = newTapeState()
const calls = new Map<string, CallTrack>()
/** Stories and events already looked at, so that each moves a pair's forecast once. */
const seenStories = new Set<string>()
const seenEvents = new Set<string>()
/** The news as last told: the feed's stories, reactions and library; the analyst's readings. */
let feed: NewsSignal | null = null
let readings: Record<string, AnalystReadingInput> = {}
let lastClosedAt: number | null = null
let started = false
let passing: Promise<void> | null = null
let liveState: () => LiveState | null = () => null
/** How each opportunity class stands, as electron/main.ts hands it in (forecastLabService.ts); null
 * until it is, and then no class is judged. */
let classVerdicts: ((key: string) => ClassVerdict) | null = null
const listeners = new Set<() => void>()

const NEWS_SKILL_DAYS = NEWS_EFFECT_LINES.skillDays
/** How far back a restart reads the record for outcomes still owed: the longest horizon and two
 * hours. */
const OWED_LOOKBACK_SEC = 26 * 3600

function recordsDir(): string {
  return join(app.getPath('userData'), 'forecasts')
}

function tellNotice(notice: Parameters<typeof tell>[0]): void {
  try {
    tell(notice)
  } catch (error) {
    console.error('A forecast notice could not be told:', error)
  }
}

function told(): void {
  for (const listener of listeners) {
    try {
      listener()
    } catch (error) {
      console.error('A forecast listener failed:', error)
    }
  }
}

const describe = (error: unknown): string => (error instanceof Error ? error.message : String(error))

function seriesOf(symbol: string): PairSeries | null {
  const held = forecastSeries(symbol)
  return held === null ? null : { m5: held.m5 as PairSeries['m5'], h1: held.h1 as PairSeries['h1'] }
}

/** A coin's news as the forecast reads it: the stories naming it, as their subject or not (which of
 * them count is shared/forecast/newsEffect.ts's to say), with their reactions' priced-in. Undefined
 * where there are none. */
function newsFor(symbol: string): PredictionNews | undefined {
  if (feed === null || !symbol.endsWith('USDT')) return undefined
  const ticker = symbol.slice(0, -4)
  const stories: NewsStoryInput[] = []
  for (const story of feed.stories) {
    const asset = story.assets.find((entry) => entry.ticker === ticker)
    if (asset === undefined) continue
    stories.push({
      id: story.id,
      title: story.title ?? '',
      source: story.sourceName ?? '',
      kind: story.eventType ?? 'OTHER',
      impact: story.impact,
      publishedAt: story.publishedAt ?? story.seenAt,
      seenAt: story.seenAt,
      stale: story.stale === true,
      repeat: story.repeat === true,
      relationship: asset.relationship === 'DIRECT' ? 'DIRECT' : 'INDIRECT',
      pricedIn: feed.reactions?.[story.id]?.pricedIn === true
    })
  }
  if (stories.length === 0) return undefined
  return { ticker, stories, library: feed.impact ?? [], readings, skill: engine.newsSkill }
}

/** What the pass reads, from the services around it. */
const sources: PassSources = {
  universe: forecastUniverse,
  seriesOf,
  models: currentForecastModels,
  calibration: currentForecastCalibration,
  runId: () => getForecastTrainingState().current?.runId ?? null,
  book: (symbol) => liveState()?.books[symbol],
  depth: (symbol) => liveState()?.depth[symbol],
  volumes: () => new Map(getResearchState().pairs.map((pair) => [pair.symbol, pair.quoteVolume24h])),
  news: newsFor,
  preEvent: preEventAt,
  classVerdict: () => classVerdicts
}

export function setForecastClassVerdicts(judge: ((key: string) => ClassVerdict) | null): void {
  classVerdicts = judge
}

async function writeLines(kind: 'predictions' | 'outcomes', lines: readonly (PredictionLine | OutcomeLine | MissingOutcomeLine)[]): Promise<void> {
  if (lines.length === 0) return
  const byMonth = new Map<string, (PredictionLine | OutcomeLine | MissingOutcomeLine)[]>()
  for (const line of lines) {
    const month = recordMonth(line.t)
    const mine = byMonth.get(month)
    if (mine === undefined) byMonth.set(month, [line])
    else mine.push(line)
  }
  await mkdir(recordsDir(), { recursive: true })
  for (const [month, mine] of byMonth) await appendJsonLines(join(recordsDir(), `${kind}-${month}.jsonl`), mine)
}

/** The pairs outcomes are still owed for: the data keeps their bars coming until they are judged. */
export function owedForecastPairs(): string[] {
  return owedPairs(engine)
}

/** What a close's settling left, written: the outcomes, the news-moved ones to their own file, the levels. */
async function applySettled(settled: Settled): Promise<void> {
  if (settled.lines.length === 0) return
  await writeLines('outcomes', settled.lines)
  state.outcomes += settled.lines.length
  state.missing += settled.lines.length - settled.measured
  if (settled.drift !== null) state.drift = settled.drift
  if (settled.newsTouched.length > 0) await appendJsonLines(join(recordsDir(), 'news-outcomes.jsonl'), settled.newsTouched)
  if (settled.aciMoved && engine.aci !== null) await writeJsonAtomic(join(recordsDir(), 'aci.json'), engine.aci)
}

/** Every pair forecast at a close: what the pure pass made, written and told. */
async function runPass(closedAt: number): Promise<void> {
  const startedAt = Date.now()
  lastClosedAt = closedAt
  const made = pass(engine, sources, closedAt, Date.now())
  if (made.status === 'waiting') {
    state.status = 'waiting'
    state.waitingFor = made.waitingFor
    told()
    return
  }
  state.waitingFor = null
  await applySettled(made.settled)
  state.market = made.market
  if (made.pass !== null) {
    await writeLines('predictions', made.predictions)
    await appendJsonLines(join(recordsDir(), `passes-${recordMonth(closedAt)}.jsonl`), [made.pass])
    recorded(engine, closedAt, made.predictions)
    state.recorded += made.predictions.length
  }
  await followCalls()
  Object.assign(state, { status: 'running', predictions: engine.latest.size, pending: pendingCount(engine), lastPassAt: closedAt, lastPassMs: Date.now() - startedAt, lastError: null })
  told()
}

/** The pairs the person watches: the top ten, those held, and those a paper executor of theirs trades. */
async function watchedPairs(): Promise<Set<string>> {
  const watched = new Set(engine.ranking.top10)
  try {
    const settings = await getSettings()
    for (const held of settings.heldPositions ?? []) watched.add(held.symbol)
    for (const executor of settings.executors ?? []) if (executor.status === 'active') watched.add(executor.symbol)
  } catch {
    // Settings unreadable: the top ten alone.
  }
  return watched
}

/** Every pair's call followed for a close; a watched one that turned, told. */
async function followCalls(): Promise<void> {
  const watched = await watchedPairs()
  for (const prediction of engine.latest.values()) {
    const { track, change } = stepCall(calls.get(prediction.pair), prediction)
    calls.set(prediction.pair, track)
    if (change !== null && watched.has(prediction.pair)) tellNotice((i18n) => predictionChangedNotice(change, i18n))
  }
}

/** A pass at a close, one at a time; a close that comes while one runs is left to the next. */
function passAt(closedAt: number): Promise<void> {
  if (passing !== null) return passing
  passing = runPass(closedAt)
    .catch((error) => {
      state.lastError = describe(error)
      console.error('A forecast pass failed:', error)
    })
    .finally(() => {
      passing = null
    })
  return passing
}

/** The forecasts made again between closes, recorded in order, each owed its outcomes. */
async function recordRefreshed(refreshed: readonly Refreshed[]): Promise<void> {
  for (const made of refreshed) {
    await writeLines('predictions', [made.line])
    owe(engine, made.line)
    state.recorded++
    state.refreshes++
    state.pending = pendingCount(engine)
    told()
  }
}

/** The tape's lines for the moment, appended to the day's file (V7.2 Stage 5). */
async function writeTape(live: LiveState, nowMs: number): Promise<void> {
  const lines = tapeLinesOf(tape, live, nowMs)
  if (lines.length === 0) return
  const byFile = new Map<string, TapeLine[]>()
  for (const line of lines) {
    const name = tapeFileName(line.t)
    const mine = byFile.get(name)
    if (mine === undefined) byFile.set(name, [line])
    else mine.push(line)
  }
  await mkdir(recordsDir(), { recursive: true })
  for (const [name, mine] of byFile) await appendJsonLines(join(recordsDir(), name), mine)
}

/** The analyst's readings on file, by story id, each with when it was answered (electron/main.ts
 * reads them from the AI ledger). */
export function setForecastReadings(next: Record<string, AnalystReadingInput>): void {
  readings = next
}

/** The analyst's readings on file, by story, as last handed in: what the Lab's replay shows beside a story. */
export function forecastNewsReadings(): Readonly<Record<string, AnalystReadingInput>> {
  return readings
}

/** The news: a story of high impact naming a coin forecast moves its forecast, once. */
export async function forecastNewsSignal(next: NewsSignal, nowMs: number = Date.now()): Promise<void> {
  feed = next
  for (const story of next.stories) {
    if (seenStories.has(story.id)) continue
    seenStories.add(story.id)
    for (const asset of story.assets) {
      if (asset.relationship !== 'DIRECT') continue
      const symbol = `${asset.ticker}USDT`
      const prediction = engine.latest.get(symbol)
      if (prediction === undefined || story.seenAt * 1000 < prediction.generatedAt) continue
      const made = consider(engine, sources, symbol, { newsImpact: story.impact }, nowMs, passing !== null)
      if (made.line !== null) await recordRefreshed([{ symbol, reasons: made.reasons, line: made.line }])
    }
  }
}

/** The scanner: an event raised on a coin forecast moves its forecast, once. */
export async function forecastScannerSignal(scanner: ScannerSignal, nowMs: number = Date.now()): Promise<void> {
  for (const event of scanner.recentEvents) {
    if (seenEvents.has(event.id)) continue
    seenEvents.add(event.id)
    if (!engine.latest.has(event.symbol)) continue
    const made = consider(engine, sources, event.symbol, { newEvent: true }, nowMs, passing !== null)
    if (made.line !== null) await recordRefreshed([{ symbol: event.symbol, reasons: made.reasons, line: made.line }])
  }
}

/** The live stream: Bitcoin's sharp move or a change of the market's state makes every pair's forecast
 * again where a rule is in use; a pair whose price left its forecast's 80% range, or whose minute forming
 * has traded three times its usual minute, has its forecast made again; and the tape takes its lines. */
export async function forecastLiveSignal(live: LiveState, nowMs: number = Date.now()): Promise<void> {
  const made = liveSignal(engine, sources, live, nowMs, passing !== null)
  if (made.market !== undefined) state.market = made.market
  await recordRefreshed(made.refreshed)
  await writeTape(live, nowMs)
}

/** The outcomes still owed, read back from the last day and a bit of the record: those recorded and
 * not yet written. */
async function readOwed(nowSec: number): Promise<void> {
  const months = [...new Set([recordMonth(nowSec - OWED_LOOKBACK_SEC), recordMonth(nowSec)])]
  const read = async (kind: string): Promise<unknown[]> => {
    const out: unknown[] = []
    for (const month of months) {
      const text = await readFile(join(recordsDir(), `${kind}-${month}.jsonl`), 'utf-8').catch(() => '')
      for (const line of text.split('\n')) {
        if (line.trim() === '') continue
        try {
          out.push(JSON.parse(line))
        } catch {
          // A torn line: skipped.
        }
      }
    }
    return out
  }
  const done = new Set<string>()
  for (const raw of await read('outcomes')) {
    const line = parseOutcomeLine(raw)
    if (line === null) continue
    done.add(`${line.id}/${line.h}`)
    // The outcomes for the drift gate (V7.1 Stage 13), pruned to the last day below: the gate stands across a restart.
    if (!isMissing(line)) engine.driftOutcomes.set(line.h, [...(engine.driftOutcomes.get(line.h) ?? []), { due: line.due, in80: line.in80 }])
  }
  state.drift = driftReadings(engine, nowSec)
  for (const raw of await read('predictions')) {
    const line = parsePredictionLine(raw)
    if (line === null || line.t < nowSec - OWED_LOOKBACK_SEC) continue
    engine.lastRecordedAt = Math.max(engine.lastRecordedAt, line.why === 'grid' ? line.t : 0)
    const horizons = (Object.keys(line.h) as Horizon[]).filter((horizon) => !done.has(`${line.id}/${horizon}`))
    if (horizons.length > 0) engine.owed.set(line.id, { line, horizons: new Set(horizons) })
  }
  state.pending = pendingCount(engine)
}

/** The news-moved forecasts' outcomes of the last days, for their own skill. */
async function readNewsOutcomes(nowSec: number): Promise<void> {
  const text = await readFile(join(recordsDir(), 'news-outcomes.jsonl'), 'utf-8').catch(() => '')
  const since = nowSec - NEWS_SKILL_DAYS * 86_400
  engine.newsOutcomes = []
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue
    try {
      const row = JSON.parse(line) as { h?: unknown; due?: unknown; pUp?: unknown; up?: unknown }
      if (HORIZONS.includes(row.h as Horizon) && typeof row.due === 'number' && row.due >= since && typeof row.pUp === 'number' && typeof row.up === 'boolean') engine.newsOutcomes.push({ h: row.h as Horizon, due: row.due, pUp: row.pUp, up: row.up })
    } catch {
      // A torn line: skipped.
    }
  }
  engine.newsSkill = newsSkillOf(engine.newsOutcomes, nowSec)
}

/** The record's month files, and the tape's day files, older than the record keeps: deleted. */
async function sweepOldRecords(nowSec: number): Promise<void> {
  const names = await readdir(recordsDir()).catch(() => [] as string[])
  for (const name of names) {
    const month = /^(?:predictions|outcomes|passes)-(\d{4}-\d{2})\.jsonl$/.exec(name)?.[1]
    if (month !== undefined && staleMonth(month, nowSec, FORECAST_RECORD_DAYS)) await unlink(join(recordsDir(), name)).catch(() => undefined)
    const day = /^tape-(\d{4}-\d{2}-\d{2})\.jsonl$/.exec(name)?.[1]
    if (day !== undefined && staleDay(day, nowSec, FORECAST_RECORD_DAYS)) await unlink(join(recordsDir(), name)).catch(() => undefined)
  }
}

/** Starts the live forecast: the record's owed outcomes and adaptive levels read back, a pass after
 * every data pass, and the signals that make a pair's forecast again. Called once, from
 * electron/main.ts, with the live stream's state. */
export function startForecast(live: () => LiveState | null): void {
  if (started) return
  started = true
  liveState = live
  setOwedPairs(owedForecastPairs)
  const nowSec = Math.floor(Date.now() / 1000)
  void (async (): Promise<void> => {
    await sweepOldRecords(nowSec)
    const text = await readFile(join(recordsDir(), 'aci.json'), 'utf-8').catch(() => null)
    if (text !== null) {
      try {
        engine.aci = parseAciTable(JSON.parse(text))
      } catch {
        engine.aci = null
      }
    }
    await readOwed(nowSec)
    await readNewsOutcomes(nowSec)
  })().catch((error) => console.error('The forecast record could not be read back:', error))
  onForecastBars((closedAt) => void passAt(closedAt))
  // New models or a new calibration put in use: the close already in is forecast with them.
  onForecastTraining(() => {
    if (lastClosedAt !== null && state.waitingFor !== null && currentForecastCalibration() !== null && currentForecastModels().size > 0) void passAt(lastClosedAt)
    else told()
  })
}

export function getForecastEngineState(): EngineState {
  return { ...state }
}

/** The latest forecast of every pair, by pair. */
export function latestForecasts(): PricePrediction[] {
  return [...engine.latest.values()].sort((a, b) => a.pair.localeCompare(b.pair))
}

export function forecastOf(symbol: unknown): PricePrediction | null {
  return typeof symbol === 'string' ? (engine.latest.get(symbol) ?? null) : null
}

/** Every pair's place, best first, with its decision; the top ten and three. */
export function forecastRanking(): ForecastRanking {
  return engine.ranking
}

/** A pair's trade decision at its lead horizon; null before it is forecast. */
export function forecastDecision(symbol: unknown): TradeDecision | null {
  return typeof symbol === 'string' ? (engine.decisions.get(symbol) ?? null) : null
}

/** A pair's record since `fromSec`: its forecasts and their outcomes. */
export async function forecastHistory(symbol: unknown, fromSec: unknown): Promise<{ predictions: PredictionLine[]; outcomes: (OutcomeLine | MissingOutcomeLine)[] }> {
  if (typeof symbol !== 'string' || typeof fromSec !== 'number' || !Number.isFinite(fromSec)) return { predictions: [], outcomes: [] }
  const nowSec = Math.floor(Date.now() / 1000)
  const months: string[] = []
  for (let t = Math.max(fromSec, nowSec - FORECAST_RECORD_DAYS * 86_400); recordMonth(t) <= recordMonth(nowSec); t += 28 * 86_400) if (!months.includes(recordMonth(t))) months.push(recordMonth(t))
  if (!months.includes(recordMonth(nowSec))) months.push(recordMonth(nowSec))
  const predictions: PredictionLine[] = []
  const outcomes: (OutcomeLine | MissingOutcomeLine)[] = []
  for (const month of months) {
    for (const [kind, sink] of [
      ['predictions', predictions],
      ['outcomes', outcomes]
    ] as const) {
      const text = await readFile(join(recordsDir(), `${kind}-${month}.jsonl`), 'utf-8').catch(() => '')
      for (const line of text.split('\n')) {
        if (!line.includes(`"pair":"${symbol}"`)) continue
        try {
          const raw = JSON.parse(line)
          const read = kind === 'predictions' ? parsePredictionLine(raw) : parseOutcomeLine(raw)
          if (read !== null && read.t >= fromSec) (sink as unknown[]).push(read)
        } catch {
          // A torn line: skipped.
        }
      }
    }
  }
  return { predictions, outcomes }
}

export function onForecastUpdate(listener: () => void): () => void {
  listeners.add(listener)
  return () => void listeners.delete(listener)
}

/** Test seams. */
export const forecastForTest = {
  pass: passAt,
  /** The outcomes due by a close, written. */
  settle: async (closedAt: number): Promise<void> => applySettled(settle(engine, sources, closedAt)),
  readOwed,
  owed: engine.owed,
  setAci(table: AciTable | null): void {
    engine.aci = table
  },
  aci: (): AciTable | null => engine.aci,
  /** A forecast's decision now, as a pass makes it. */
  decide: (prediction: PricePrediction, nowMs: number): TradeDecision => decisionFor(engine, sources, prediction, nowMs),
  /** The pass's state and sources, as the service holds them. */
  engine,
  sources,
  /** A held forecast's call at a horizon set, for the refresh on a crossing of its median to be exercised
   * where no market of the tests calls a way. */
  setCall(symbol: string, horizon: Horizon, direction: 'BULLISH' | 'BEARISH' | 'NEUTRAL'): void {
    const held = engine.latest.get(symbol)
    const range = held?.horizons[horizon]
    if (held === undefined || range === undefined) return
    engine.latest.set(symbol, { ...held, bestHorizon: horizon, horizons: { ...held.horizons, [horizon]: { ...range, direction } } })
  },
  /** A close's calls followed on these forecasts, with this top ten. */
  async follow(predictions: readonly PricePrediction[], top10: readonly string[]): Promise<void> {
    engine.latest.clear()
    for (const prediction of predictions) engine.latest.set(prediction.pair, prediction)
    engine.ranking = { ...engine.ranking, top10: [...top10] }
    await followCalls()
  },
  reset(): void {
    Object.assign(state, blank())
    const fresh = newPassState()
    for (const key of Object.keys(fresh) as (keyof PassState)[]) {
      const held = engine[key]
      if (held instanceof Map) held.clear()
      else (engine as unknown as Record<string, unknown>)[key] = fresh[key]
    }
    tape.minutes.clear()
    tape.btcMinute = 0
    calls.clear()
    seenStories.clear()
    seenEvents.clear()
    feed = null
    readings = {}
    lastClosedAt = null
    started = false
    passing = null
    liveState = (): LiveState | null => null
    listeners.clear()
  }
}
