import { app } from 'electron'
import { mkdir, readFile, readdir, unlink } from 'fs/promises'
import { join } from 'path'
import { staleMonth } from '../../shared/forecast/bars'
import { cellKey, emptyAciTable, levelsOf, parseAciTable, stepAciTable, type AciTable, type CellKey } from '../../shared/forecast/aciTable'
import { FEATURE_NAMES, HORIZONS, crossSectionAt, endsAt, featuresAt, quickAt, type Horizon, type PairClass, type PairQuick, type PairSeries } from '../../shared/forecast/features'
import {
  FORECAST_RECORD_DAYS,
  isMissing,
  missingOutcomeLine,
  outcomeLine,
  parseOutcomeLine,
  parsePredictionLine,
  predictionLine,
  recordMonth,
  recordedHorizons,
  type MissingOutcomeLine,
  type OutcomeLine,
  type PredictionLine
} from '../../shared/forecast/forecastRecord'
import { predictHorizon, type ForecastModelId } from '../../shared/forecast/models'
import { dueAt, outcomeOf } from '../../shared/forecast/outcome'
import { NEWS_EFFECT_LINES, newsSkillOf, type AnalystReadingInput, type KindReactions, type NewsStoryInput } from '../../shared/forecast/newsEffect'
import { makePrediction, type PredictionNews, type PricePrediction } from '../../shared/forecast/prediction'
import { refreshReasons, type RefreshReason } from '../../shared/forecast/refresh'
import type { EngineState } from '../../shared/forecast/status'
import { bookSpreadPct, isStale, type LiveState } from '../../shared/liveMarket'
import type { MarketRegime } from '../../shared/marketResearch'
import { writeJsonAtomic } from './atomicWrite'
import { forecastSeries, forecastUniverse, onForecastBars } from './forecastDataService'
import { currentForecastCalibration, currentForecastModels, getForecastTrainingState, onForecastTraining } from './forecastTrainingService'
import { appendJsonLines } from './jsonlStore'

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
// one it replaced.
//
// THE NEWS (V6 Stage 8): the stories the news feed holds naming a coin, its reaction library and the
// news analyst's readings on file (handed in by electron/main.ts, which reads the AI ledger -- this
// service reaches nothing that asks a model) move its forecast (shared/forecast/newsEffect.ts); the
// news-moved forecasts' own outcomes say, in time, whether their P(up) may be shown.
//
// ON RECORD (forecasts/): every pair's forecast at every quarter-hour and every forecast made again
// (predictions-YYYY-MM.jsonl); an outcome for each of their horizons once it is due, never before
// (outcomes-YYYY-MM.jsonl; shared/forecast/forecastRecord.ts); and the adaptive levels (aci.json),
// moved once a moment by the outcomes due at it. A restart picks up the outcomes still owed from the
// record. Month files older than 180 days are deleted at start.
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

/** What a close gave a pair, kept for forecasting it again before the next. */
interface PairInput {
  models: Partial<Record<Horizon, Record<ForecastModelId, number[]>>>
  rv24h: number
  rvRatio: number
  cls: PairClass
  regime: MarketRegime
  price: number
  barTime: number
  usualMinuteVolume: number | null
}

const blank = (): EngineState => ({ status: 'waiting', waitingFor: 'models', lastPassAt: null, lastPassMs: null, predictions: 0, recorded: 0, outcomes: 0, missing: 0, refreshes: 0, pending: 0, lastError: null })

const state: EngineState = blank()
const latest = new Map<string, PricePrediction>()
const inputs = new Map<string, PairInput>()
const lastRefreshAt = new Map<string, number>()
/** Recorded forecasts with horizons still owed an outcome, by id. */
const owed = new Map<string, { line: PredictionLine; horizons: Set<Horizon> }>()
/** Stories and events already looked at, so that each moves a pair's forecast once. */
const seenStories = new Set<string>()
const seenEvents = new Set<string>()
/** The news as last told: the feed's stories, reactions and library; the analyst's readings. */
let feed: NewsSignal | null = null
let readings: Record<string, AnalystReadingInput> = {}
/** The news-moved forecasts' outcomes, for their own skill: forecasts/news-outcomes.jsonl. */
const newsOutcomes: { h: Horizon; due: number; pUp: number; up: boolean }[] = []
let newsSkill: Partial<Record<Horizon, number | null>> = {}
let aci: AciTable | null = null
let lastRecordedAt = 0
let lastClosedAt: number | null = null
let started = false
let passing: Promise<void> | null = null
let liveState: () => LiveState | null = () => null
const listeners = new Set<() => void>()

const RV24 = FEATURE_NAMES.indexOf('rv_24h')
const RATIO = FEATURE_NAMES.indexOf('rv_ratio')
const NEWS_SKILL_DAYS = NEWS_EFFECT_LINES.skillDays
/** How long past due an outcome waits for its bars before it is written as missing. */
const MISSING_AFTER_SEC = 3600
/** How far back a restart reads the record for outcomes still owed: the longest horizon and two
 * hours. */
const OWED_LOOKBACK_SEC = 26 * 3600

function recordsDir(): string {
  return join(app.getPath('userData'), 'forecasts')
}

function tell(): void {
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

/** The live book of a pair the stream holds, while it is fresh: its mid and its spread. */
function liveBook(symbol: string, nowMs: number): { mid: number; spreadPct: number | null } | null {
  const book = liveState()?.books[symbol]
  if (book === undefined || isStale(book, nowMs) || !(book.bid > 0) || !(book.ask > 0)) return null
  return { mid: (book.bid + book.ask) / 2, spreadPct: bookSpreadPct(book) }
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
  return { ticker, stories, library: feed.impact ?? [], readings, skill: newsSkill }
}

function predictionFor(symbol: string, nowMs: number): PricePrediction | null {
  const input = inputs.get(symbol)
  const calibration = currentForecastCalibration()
  const current = getForecastTrainingState().current
  if (input === undefined || calibration === null || current === null) return null
  return makePrediction({
    pair: symbol,
    pairClass: input.cls,
    regime: input.regime,
    barTime: input.barTime,
    price: input.price,
    generatedAt: nowMs,
    rv24h: input.rv24h,
    rvRatio: input.rvRatio,
    spreadPct: liveBook(symbol, nowMs)?.spreadPct ?? null,
    models: input.models,
    calibration,
    levels: (horizon, variant, cell) => levelsOf(aci, cellKey(horizon, variant, cell)),
    news: newsFor(symbol),
    runId: current.runId,
    foldsRunId: calibration.runId
  })
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

function owe(line: PredictionLine): void {
  const horizons = new Set(Object.keys(line.h) as Horizon[])
  if (horizons.size > 0) owed.set(line.id, { line, horizons })
}

const pendingCount = (): number => [...owed.values()].reduce((sum, entry) => sum + entry.horizons.size, 0)

/** The outcomes due by the close `closedAt` written, each once; the adaptive levels moved by them,
 * once for the moment. */
async function settle(closedAt: number): Promise<void> {
  const lines: (OutcomeLine | MissingOutcomeLine)[] = []
  for (const [id, entry] of owed) {
    for (const horizon of [...entry.horizons]) {
      const due = dueAt(entry.line.t, horizon)
      if (due > closedAt) continue
      const recorded = entry.line.h[horizon]!
      const series = seriesOf(entry.line.pair)
      const path = series === null ? [] : series.m5.filter((bar) => bar.time >= entry.line.t && bar.time < due)
      const outcome = outcomeOf(
        { horizon, quantilesPct: recorded.q, pUp: recorded.pUp, direction: recorded.dir, width80Pct: recorded.width, usualWidth80Pct: recorded.usualWidth, newsShiftPct: recorded.news?.v4?.shift ?? 0 },
        entry.line.t,
        entry.line.price,
        path
      )
      if (outcome !== null) lines.push(outcomeLine(entry.line, horizon, outcome))
      else if (closedAt - due >= MISSING_AFTER_SEC) lines.push(missingOutcomeLine(entry.line, horizon, due, path.length === 0 ? 'no bars' : `${path.length} of its bars`))
      else continue
      entry.horizons.delete(horizon)
    }
    if (entry.horizons.size === 0) owed.delete(id)
  }
  if (lines.length === 0) return
  await writeLines('outcomes', lines)
  const measured = lines.filter((line): line is OutcomeLine => !isMissing(line))
  state.outcomes += lines.length
  state.missing += lines.length - measured.length
  const calibration = currentForecastCalibration()
  if (calibration === null || measured.length === 0) return
  if (aci === null || aci.calibrationRun !== calibration.runId) aci = emptyAciTable(calibration.runId)
  const steps: { key: CellKey; below: boolean[] }[] = []
  for (const line of measured) {
    steps.push({ key: cellKey(line.h, 'v2', line.cell), below: [...line.below].map((flag) => flag === '1') })
    if (line.v1below.length === 5) steps.push({ key: cellKey(line.h, 'v1', line.cell), below: [...line.v1below].map((flag) => flag === '1') })
    // The news-moved forecasts' levels learn only from the outcomes a story moved.
    if (line.v3below !== undefined) steps.push({ key: cellKey(line.h, 'v3', line.cell), below: [...line.v3below].map((flag) => flag === '1') })
    if (line.v4below !== undefined) steps.push({ key: cellKey(line.h, 'v4', line.cell), below: [...line.v4below].map((flag) => flag === '1') })
  }
  const touched = measured.filter((line) => line.newsPUp !== undefined).map((line) => ({ h: line.h, due: line.due, pUp: line.newsPUp!, up: line.up }))
  if (touched.length > 0) {
    newsOutcomes.push(...touched)
    await appendJsonLines(join(recordsDir(), 'news-outcomes.jsonl'), touched)
    newsSkill = newsSkillOf(newsOutcomes, closedAt)
  }
  aci = stepAciTable(aci, steps, closedAt)
  await writeJsonAtomic(join(recordsDir(), 'aci.json'), aci)
}

/** Every pair forecast at a close. */
async function pass(closedAt: number): Promise<void> {
  const startedAt = Date.now()
  lastClosedAt = closedAt
  const fitted = currentForecastModels()
  const calibration = currentForecastCalibration()
  state.waitingFor = fitted.size === 0 ? 'models' : calibration === null ? 'calibration' : null
  if (state.waitingFor !== null) {
    state.status = 'waiting'
    tell()
    return
  }
  const market = new Map<string, PairSeries>()
  for (const symbol of forecastUniverse()) {
    const series = seriesOf(symbol)
    if (series !== null) market.set(symbol, series)
  }
  const btc = market.get('BTCUSDT')
  const quick = new Map<string, PairQuick>()
  for (const [symbol, series] of market) {
    const read = quickAt(series, closedAt)
    if (read !== null) quick.set(symbol, read)
  }
  const cross = btc === undefined ? null : crossSectionAt(quick)
  if (btc === undefined || cross === null) {
    state.status = 'waiting'
    state.waitingFor = 'bars'
    tell()
    return
  }
  inputs.clear()
  for (const [symbol, series] of market) {
    // A row needs the bar that closed at the close (featuresAt); its close is the forecast's price.
    const row = featuresAt({ symbol, series, btcH1: btc.h1, cross, tSec: closedAt })
    if (row === null) continue
    const at = endsAt(series, closedAt).m5
    const bar = series.m5[at - 1]
    const models: PairInput['models'] = {}
    for (const horizon of HORIZONS) {
      const model = fitted.get(horizon)
      if (model !== undefined) models[horizon] = predictHorizon(model, row)
    }
    const hour = series.m5.slice(Math.max(0, at - 12), at)
    const usualMinuteVolume = hour.length === 12 ? hour.reduce((sum, entry) => sum + entry.volume, 0) / 60 : null
    inputs.set(symbol, { models, rv24h: row[RV24], rvRatio: row[RATIO], cls: cross.classes.get(symbol)!, regime: cross.regime, price: bar.close, barTime: closedAt, usualMinuteVolume })
  }
  await settle(closedAt)
  const nowMs = Date.now()
  latest.clear()
  lastRefreshAt.clear()
  for (const symbol of inputs.keys()) {
    const prediction = predictionFor(symbol, nowMs)
    if (prediction !== null) latest.set(symbol, prediction)
  }
  const horizons = recordedHorizons(closedAt)
  if (horizons.length > 0 && closedAt > lastRecordedAt) {
    const lines = [...latest.values()].map((prediction) => predictionLine(prediction, horizons, 'grid'))
    await writeLines('predictions', lines)
    for (const line of lines) owe(line)
    state.recorded += lines.length
    lastRecordedAt = closedAt
  }
  Object.assign(state, { status: 'running', predictions: latest.size, pending: pendingCount(), lastPassAt: closedAt, lastPassMs: Date.now() - startedAt, lastError: null })
  tell()
}

/** A pass at a close, one at a time; a close that comes while one runs is left to the next. */
function passAt(closedAt: number): Promise<void> {
  if (passing !== null) return passing
  passing = pass(closedAt)
    .catch((error) => {
      state.lastError = describe(error)
      console.error('A forecast pass failed:', error)
    })
    .finally(() => {
      passing = null
    })
  return passing
}

/** A pair forecast again between closes, for the reasons given; recorded, naming the one it replaced. */
async function refresh(symbol: string, reasons: RefreshReason[], nowMs: number): Promise<void> {
  const previous = latest.get(symbol)
  const prediction = predictionFor(symbol, nowMs)
  if (prediction === null) return
  latest.set(symbol, prediction)
  lastRefreshAt.set(symbol, nowMs)
  const line = predictionLine(prediction, HORIZONS, 'refresh', { reasons, previous: previous?.id ?? null })
  await writeLines('predictions', [line])
  owe(line)
  state.recorded++
  state.refreshes++
  state.pending = pendingCount()
  tell()
}

/** Whether a pair's forecast should be made again now, and if so made again. */
async function consider(symbol: string, signals: { newsImpact?: number | null; newEvent?: boolean; minuteVolume?: number | null }, nowMs: number): Promise<RefreshReason[]> {
  const prediction = latest.get(symbol)
  const input = inputs.get(symbol)
  if (prediction === undefined || input === undefined || passing !== null) return []
  const lead = prediction.horizons[prediction.bestHorizon ?? 'hour1'] ?? Object.values(prediction.horizons)[0]
  const reasons = refreshReasons({
    nowMs,
    lastRefreshAt: lastRefreshAt.get(symbol) ?? null,
    newsImpact: signals.newsImpact,
    newEvent: signals.newEvent,
    livePrice: liveBook(symbol, nowMs)?.mid ?? null,
    band: lead === undefined ? null : [lead.quantilePrices[0], lead.quantilePrices[4]],
    minuteVolume: signals.minuteVolume,
    usualMinuteVolume: input.usualMinuteVolume
  })
  if (reasons.length > 0) await refresh(symbol, reasons, nowMs)
  return reasons
}

/** The analyst's readings on file, by story id, each with when it was answered (electron/main.ts
 * reads them from the AI ledger). */
export function setForecastReadings(next: Record<string, AnalystReadingInput>): void {
  readings = next
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
      const prediction = latest.get(symbol)
      if (prediction === undefined || story.seenAt * 1000 < prediction.generatedAt) continue
      await consider(symbol, { newsImpact: story.impact }, nowMs)
    }
  }
}

/** The scanner: an event raised on a coin forecast moves its forecast, once. */
export async function forecastScannerSignal(scanner: ScannerSignal, nowMs: number = Date.now()): Promise<void> {
  for (const event of scanner.recentEvents) {
    if (seenEvents.has(event.id)) continue
    seenEvents.add(event.id)
    if (latest.has(event.symbol)) await consider(event.symbol, { newEvent: true }, nowMs)
  }
}

/** The live stream: a pair whose price left its forecast's 80% range, or whose minute forming has
 * traded three times its usual minute, has its forecast made again. */
export async function forecastLiveSignal(live: LiveState, nowMs: number = Date.now()): Promise<void> {
  for (const symbol of Object.keys(live.books)) {
    if (!latest.has(symbol)) continue
    const minutes = live.minutes[symbol] ?? []
    const forming = minutes[minutes.length - 1]
    await consider(symbol, { minuteVolume: forming !== undefined && !forming.closed ? forming.volume : null }, nowMs)
  }
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
    if (line !== null) done.add(`${line.id}/${line.h}`)
  }
  for (const raw of await read('predictions')) {
    const line = parsePredictionLine(raw)
    if (line === null || line.t < nowSec - OWED_LOOKBACK_SEC) continue
    lastRecordedAt = Math.max(lastRecordedAt, line.why === 'grid' ? line.t : 0)
    const horizons = (Object.keys(line.h) as Horizon[]).filter((horizon) => !done.has(`${line.id}/${horizon}`))
    if (horizons.length > 0) owed.set(line.id, { line, horizons: new Set(horizons) })
  }
  state.pending = pendingCount()
}

/** The news-moved forecasts' outcomes of the last days, for their own skill. */
async function readNewsOutcomes(nowSec: number): Promise<void> {
  const text = await readFile(join(recordsDir(), 'news-outcomes.jsonl'), 'utf-8').catch(() => '')
  const since = nowSec - NEWS_SKILL_DAYS * 86_400
  newsOutcomes.length = 0
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue
    try {
      const row = JSON.parse(line) as { h?: unknown; due?: unknown; pUp?: unknown; up?: unknown }
      if (HORIZONS.includes(row.h as Horizon) && typeof row.due === 'number' && row.due >= since && typeof row.pUp === 'number' && typeof row.up === 'boolean') newsOutcomes.push({ h: row.h as Horizon, due: row.due, pUp: row.pUp, up: row.up })
    } catch {
      // A torn line: skipped.
    }
  }
  newsSkill = newsSkillOf(newsOutcomes, nowSec)
}

async function sweepOldRecords(nowSec: number): Promise<void> {
  const names = await readdir(recordsDir()).catch(() => [] as string[])
  for (const name of names) {
    const month = /^(?:predictions|outcomes)-(\d{4}-\d{2})\.jsonl$/.exec(name)?.[1]
    if (month !== undefined && staleMonth(month, nowSec, FORECAST_RECORD_DAYS)) await unlink(join(recordsDir(), name)).catch(() => undefined)
  }
}

/** Starts the live forecast: the record's owed outcomes and adaptive levels read back, a pass after
 * every data pass, and the signals that make a pair's forecast again. Called once, from
 * electron/main.ts, with the live stream's state. */
export function startForecast(live: () => LiveState | null): void {
  if (started) return
  started = true
  liveState = live
  const nowSec = Math.floor(Date.now() / 1000)
  void (async (): Promise<void> => {
    await sweepOldRecords(nowSec)
    const text = await readFile(join(recordsDir(), 'aci.json'), 'utf-8').catch(() => null)
    if (text !== null) {
      try {
        aci = parseAciTable(JSON.parse(text))
      } catch {
        aci = null
      }
    }
    await readOwed(nowSec)
    await readNewsOutcomes(nowSec)
  })().catch((error) => console.error('The forecast record could not be read back:', error))
  onForecastBars((closedAt) => void passAt(closedAt))
  // New models or a new calibration put in use: the close already in is forecast with them.
  onForecastTraining(() => {
    if (lastClosedAt !== null && state.waitingFor !== null && currentForecastCalibration() !== null && currentForecastModels().size > 0) void passAt(lastClosedAt)
    else tell()
  })
}

export function getForecastEngineState(): EngineState {
  return { ...state }
}

/** The latest forecast of every pair, by pair. */
export function latestForecasts(): PricePrediction[] {
  return [...latest.values()].sort((a, b) => a.pair.localeCompare(b.pair))
}

export function forecastOf(symbol: unknown): PricePrediction | null {
  return typeof symbol === 'string' ? (latest.get(symbol) ?? null) : null
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
  settle,
  readOwed,
  owed,
  setAci(table: AciTable | null): void {
    aci = table
  },
  aci: (): AciTable | null => aci,
  reset(): void {
    Object.assign(state, blank())
    latest.clear()
    inputs.clear()
    lastRefreshAt.clear()
    owed.clear()
    seenStories.clear()
    seenEvents.clear()
    feed = null
    readings = {}
    newsOutcomes.length = 0
    newsSkill = {}
    aci = null
    lastRecordedAt = 0
    lastClosedAt = null
    started = false
    passing = null
    liveState = (): LiveState | null => null
    listeners.clear()
  }
}
