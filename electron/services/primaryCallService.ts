import { DELISTING_STUDY } from '../../shared/delistingStudy'
import { SOURCE_RECORD_VERSION, dayUnitOf, hourUnitOf, sourcePredictionId, type SourcePrediction } from '../../shared/evaluation/predictionRecord'
import { HORIZONS, HORIZON_BARS } from '../../shared/forecast/features'
import type { PricePrediction } from '../../shared/forecast/prediction'
import {
  DELISTING_CARD_LINES,
  PRIMARY_CALL_VERSION,
  cardStatesOf,
  delistLiveOf,
  delistingCardOf,
  delistingExitAt,
  delistingFiguresOf,
  isCard,
  isCardSideSource,
  modelCardOf,
  quantileOf,
  rankCards,
  type CardRefusal,
  type CardStateLine,
  type DelistLiveReading,
  type DelistingCandidate,
  type LateCall,
  type PrimaryCallState,
  type PrimaryCard
} from '../../shared/forecast/primaryCall'
import type { RunCalibration } from '../../shared/forecast/runCalibration'
import type { NewsItem } from '../../shared/news'
import type { NewsRecord } from '../../shared/newsRecord'
import type { LiquidityVerdict } from '../../shared/liquidityGate'
import { VENUE_STAKE_QUOTE } from '../../shared/venueCosts'
import type { SymbolInfo } from '../../shared/ipc'
import { getEffectiveConfig } from './effectiveConfigService'
import { latestForecasts } from './forecastService'
import { currentForecastCalibration } from './forecastTrainingService'
import { fetchHistoricalRange, listSymbols } from './marketService'
import { getNewsRecord } from './newsRecordService'
import { getNewsState, onNewsUpdate } from './newsService'
import { recordCardStates, recordSourcePrediction } from './predictionLedgerService'
import { EVENT_PAIRS_MAX, readEventBooksNow, setEventPairs, venueGateOf, venueMidOf } from './venueQuotesService'

// THE PRIMARY CALL, WEIGHED (V8 Stage 3; shared/forecast/primaryCall.ts). Every minute, and whenever the announcements
// reader has read: each coin a Binance delisting named, while its rule's hold lasts, is put in the event lane (its
// books read on demand) and weighed -- within the rule's five minutes, on its price and a fresh book of Binance at the
// rule's own stake, its expected net from the study's coins less this route's cost and the funding the hold crosses,
// the rule's live check on the delistings since 1 October read first; after them it is on the late list with its move
// since. A direction model in use as a range's P(up) source is weighed the same way (none is). Each card is written
// once to the prediction record, so its outcome is settled and scored like every source's, and at every whole hour
// each coin's card state is written. Public market data and the app's own records: no key, no model, no order; the
// paper short itself is the news rule's to open (src/news/newsPaperShort.ts), as before.

const WEIGH_EVERY_MS = 60_000
const SYMBOLS_EVERY_SEC = 3600

/** What the service reads the world through: a test hands in its own. */
export const primaryCallSeam = {
  now: (): number => Math.floor(Date.now() / 1000),
  news: async (): Promise<{ on: boolean; stakeQuote: number; items: NewsItem[] }> => {
    const state = await getNewsState()
    return { on: state.config.enabled, stakeQuote: state.config.delisting.paperShort.stakeQuote, items: state.recent }
  },
  symbols: (): Promise<SymbolInfo[]> => listSymbols('binance'),
  newsRecord: (): Promise<NewsRecord> => getNewsRecord(),
  readBook: (pair: string): Promise<boolean> => readEventBooksNow(pair),
  setLane: (pairs: readonly string[]): void => setEventPairs(pairs),
  mid: (pair: string, nowMs: number): number | null => venueMidOf(pair, 'binance', nowMs),
  gate: (pair: string, side: 'BUY' | 'SELL', stakeQuote: number, movePct: number, nowMs: number): LiquidityVerdict => venueGateOf(pair, 'binance', side, stakeQuote, movePct, nowMs),
  /** The open of a pair's one-minute bar at a minute, on Binance; null where it is not read. */
  openAt: async (pair: string, minuteSec: number): Promise<number | null> => {
    const { candles } = await fetchHistoricalRange('binance', pair, '1m', minuteSec, minuteSec + 60, `call:${pair}:${minuteSec}`, () => undefined)
    const bar = candles.find((candle) => candle.time === minuteSec)
    return bar !== undefined && bar.open > 0 ? bar.open : null
  },
  forecasts: (): PricePrediction[] => latestForecasts(),
  calibration: (): RunCalibration | null => currentForecastCalibration(),
  versions: async (): Promise<{ engine: string; config: string }> => {
    const config = await getEffectiveConfig()
    return { engine: config.engineVersion, config: config.configVersion }
  },
  recordPrediction: (prediction: SourcePrediction): Promise<void> => recordSourcePrediction(prediction),
  recordStates: (atSec: number, lines: readonly CardStateLine[]): Promise<number> => recordCardStates(atSec, lines)
}

const EMPTY: PrimaryCallState = { v: PRIMARY_CALL_VERSION, at: 0, cards: [], late: [], refused: [], delistLive: null, readerOn: false, modelSources: 0 }
let state: PrimaryCallState = EMPTY
let live: { reading: DelistLiveReading; at: number } | null = null
let symbols: { at: number; byBase: Map<string, string> } | null = null
const opens = new Map<string, number | null>()
const recorded = new Set<string>()
let statesHour: number | null = null
let weighing: Promise<PrimaryCallState> | null = null
let timer: ReturnType<typeof setInterval> | null = null
let stopNews: (() => void) | null = null
const listeners = new Set<(state: PrimaryCallState) => void>()

/** Tells a listener each state as it is weighed. */
export function onPrimaryCall(listener: (state: PrimaryCallState) => void): () => void {
  listeners.add(listener)
  return () => void listeners.delete(listener)
}

/** The state as last weighed. */
export function primaryCallState(): PrimaryCallState {
  return state
}

/** The figures the record keeps beside a delisting card: its side's share right and the study's quantiles, signed. */
const STUDY = ((): { pRight: number; q: [number, number, number, number, number]; figures: ReturnType<typeof delistingFiguresOf> } => {
  const gross = DELISTING_STUDY.coins.map((coin) => coin.grossPct).sort((a, b) => a - b)
  const q = [0.9, 0.75, 0.5, 0.25, 0.1].map((p) => -quantileOf(gross, p)) as [number, number, number, number, number]
  return { pRight: gross.filter((value) => value > 0).length / gross.length, q, figures: delistingFiguresOf(DELISTING_STUDY.coins) }
})()

/** Binance's USDT pairs by base asset, read at most hourly. */
async function pairsByBase(nowSec: number): Promise<Map<string, string>> {
  if (symbols !== null && nowSec - symbols.at < SYMBOLS_EVERY_SEC) return symbols.byBase
  try {
    const byBase = new Map<string, string>()
    for (const info of await primaryCallSeam.symbols()) if (info.quoteAsset === 'USDT' && info.stockToken !== true) byBase.set(info.baseAsset, info.symbol)
    symbols = { at: nowSec, byBase }
  } catch {
    // The last list read stands; with none, no coin has a pair to weigh.
  }
  return symbols?.byBase ?? new Map()
}

/** The live check on the rule (V8-S3-DELIST-LIVE): the record of delistings since 1 October, read when a card is to be
 * weighed and at most every ten minutes; the last reading stands where it cannot be read. */
async function delistLive(nowSec: number): Promise<DelistLiveReading | null> {
  if (live !== null && nowSec - live.at < 600) return live.reading
  try {
    const record = await primaryCallSeam.newsRecord()
    const rows = record.rows.filter((row) => row.rule === 'DELISTING_HOLD' && row.status === 'scored' && row.netPct !== null).map((row) => ({ releaseSec: row.releaseSec, netPct: row.netPct as number }))
    live = { reading: delistLiveOf(rows), at: nowSec }
  } catch {
    // Unread: the last reading, or none.
  }
  return live?.reading ?? null
}

/** The prediction line a card is recorded under (shared/evaluation/predictionRecord.ts). */
export function predictionLineOf(card: PrimaryCard, versions: { engine: string; config: string }): SourcePrediction {
  const delisting = card.detail.kind === 'delisting'
  const from = card.eventAt ?? card.madeAt
  return {
    v: SOURCE_RECORD_VERSION,
    id: card.predictionId,
    source: card.source,
    sourceVersion: card.sourceVersion,
    kind: 'direction',
    pair: card.pair,
    venue: card.venue,
    madeAt: card.madeAt,
    bar: null,
    horizonSec: Math.max(60, card.exitAt - card.madeAt),
    refPrice: card.refPrice,
    side: card.side,
    movePct: card.movePct,
    targetPrice: card.targetPrice,
    window: card.arrival === null ? null : { fromSec: Math.max(0, from + card.arrival.fromSec - card.madeAt), toSec: Math.max(0, from + card.arrival.toSec - card.madeAt) },
    dist: { pRight: delisting ? STUDY.pRight : null, q: delisting ? STUDY.q : null, pMove: null },
    scenarios: { upPct: card.scenarios.forPct, downPct: card.scenarios.againstPct, worstPct: card.scenarios.worstPct },
    cost: { roundTripPct: card.cost.totalPct, basis: card.cost.basis, stakeQuote: card.cost.stakeQuote },
    expectedNet: { pct: card.expectedNet.pct, low: card.expectedNet.low, high: card.expectedNet.high },
    reason:
      card.detail.kind === 'delisting'
        ? `Binance announced it will delist ${card.detail.ticker}: of the study's ${card.detail.coins} delisted coins (${card.detail.hours} announcement hours), ${card.ahead.count} were lower four hours on after costs`
        : `${card.detail.model} calls this way, a direction model that cleared the direction bar on two walk forwards in a row`,
    evidence: card.evidence,
    unit: card.eventAt !== null ? hourUnitOf(card.eventAt) : dayUnitOf(card.madeAt),
    versions
  }
}

/** One weighing of every candidate: the cards, the late list and the refusals, told and recorded. */
async function weighOnce(): Promise<PrimaryCallState> {
  const nowSec = primaryCallSeam.now()
  const nowMs = nowSec * 1000
  const news = await primaryCallSeam.news().catch(() => ({ on: false, stakeQuote: 100, items: [] as NewsItem[] }))
  const byBase = await pairsByBase(nowSec)
  const holdSec = DELISTING_CARD_LINES.exitBars * 60
  const refused: CardRefusal[] = []
  const candidates: DelistingCandidate[] = []
  for (const item of news.items) {
    if (item.category !== 'DELISTING' || item.releaseSec > nowSec || nowSec - item.releaseSec > holdSec) continue
    for (const ticker of item.tickers) {
      const pair = byBase.get(ticker)
      if (pair === undefined) refused.push({ refused: 'no-pair', source: 'delisting-rule', pair: `${ticker}USDT`, eventAt: item.releaseSec, expectedNet: null })
      else candidates.push({ articleId: item.id, title: item.title, releaseSec: item.releaseSec, ticker, pair })
    }
  }
  candidates.sort((a, b) => b.releaseSec - a.releaseSec)
  primaryCallSeam.setLane(candidates.map((candidate) => candidate.pair).slice(0, EVENT_PAIRS_MAX))
  const inWindow = (candidate: DelistingCandidate): boolean => nowSec - candidate.releaseSec <= DELISTING_CARD_LINES.windowSec
  const reading = candidates.some(inWindow) ? await delistLive(nowSec) : (live?.reading ?? null)
  const cards: PrimaryCard[] = []
  const late: LateCall[] = []
  for (const candidate of candidates.slice(0, EVENT_PAIRS_MAX)) {
    if (inWindow(candidate)) {
      await primaryCallSeam.readBook(candidate.pair).catch(() => false)
      const made = delistingCardOf({
        candidate,
        nowSec,
        livePrice: primaryCallSeam.mid(candidate.pair, nowMs),
        gate: primaryCallSeam.gate(candidate.pair, 'SELL', news.stakeQuote, STUDY.figures.medianGrossPct, nowMs),
        stakeQuote: news.stakeQuote,
        study: DELISTING_STUDY,
        live: reading ?? { hours: 0, coins: 0, meanPct: null, low: null, high: null, state: 'ok' },
        predictionId: sourcePredictionId('delisting-rule', candidate.pair, candidate.releaseSec)
      })
      if (isCard(made)) cards.push(made)
      else refused.push(made)
      continue
    }
    const minute = Math.floor(candidate.releaseSec / 60) * 60
    const key = `${candidate.pair}:${minute}`
    if (!opens.has(key)) opens.set(key, await primaryCallSeam.openAt(candidate.pair, minute).catch(() => null))
    const open = opens.get(key) ?? null
    const price = primaryCallSeam.mid(candidate.pair, nowMs)
    late.push({ pair: candidate.pair, ticker: candidate.ticker, eventAt: candidate.releaseSec, exitAt: delistingExitAt(candidate.releaseSec), movedSincePct: open !== null && price !== null ? (price / open - 1) * 100 : null })
    refused.push({ refused: 'late', source: 'delisting-rule', pair: candidate.pair, eventAt: candidate.releaseSec, expectedNet: null })
  }

  // A direction model's calls: only where a range reads its P(up) from one, which none does until a model clears the
  // direction bar on two walk forwards in a row.
  let modelSources = 0
  const calibration = primaryCallSeam.calibration()
  for (const prediction of primaryCallSeam.forecasts()) {
    for (const horizon of HORIZONS) {
      const range = prediction.horizons[horizon]
      if (range === undefined || !isCardSideSource(range.pUpSource)) continue
      modelSources++
      const made = calibration?.horizons[horizon]?.direction?.models[range.pUpSource]
      const score = (made?.honest.byClass[prediction.pairClass] ?? made?.honest.pooled) ?? null
      const edge = score?.edge
      const horizonSec = HORIZON_BARS[horizon] * 300
      const quantiles = range.quantilesPct
      const card = modelCardOf({
        pair: prediction.pair,
        nowSec,
        horizonSec,
        pUpSource: range.pUpSource,
        direction: range.direction,
        livePrice: primaryCallSeam.mid(prediction.pair, nowMs) ?? prediction.currentPrice,
        record: edge === undefined || score === null ? null : { calls: edge.calls, meanPct: edge.meanPct, ci: edge.ci, hours: score.blocks ?? 0 },
        quantilesPct: [quantiles[0], quantiles[1], quantiles[2], quantiles[3], quantiles[4]],
        gate: primaryCallSeam.gate(prediction.pair, range.direction === 'BEARISH' ? 'SELL' : 'BUY', VENUE_STAKE_QUOTE, Math.abs(quantiles[2]), nowMs),
        stakeQuote: VENUE_STAKE_QUOTE,
        predictionId: sourcePredictionId('direction-model', prediction.pair, prediction.barTime, HORIZONS.indexOf(horizon))
      })
      if (card === null) continue
      if (isCard(card)) cards.push(card)
      else refused.push(card)
    }
  }

  state = { v: PRIMARY_CALL_VERSION, at: nowSec, cards: rankCards(cards), late, refused, delistLive: reading, readerOn: news.on, modelSources }

  // Each card once on the record, so its outcome is settled and scored like every source's.
  const fresh = state.cards.filter((card) => !recorded.has(card.predictionId))
  if (fresh.length > 0) {
    const versions = await primaryCallSeam.versions().catch(() => ({ engine: 'unknown', config: 'unknown' }))
    for (const card of fresh) {
      recorded.add(card.predictionId)
      await primaryCallSeam.recordPrediction(predictionLineOf(card, versions)).catch((error) => {
        // Already on file (a start within its window) is no failure.
        if (!/on file already/.test(error instanceof Error ? error.message : String(error))) console.error('A card could not be recorded:', error)
      })
    }
  }
  // Each coin's card state, once at each whole hour -- from the first weighing of the hour that has coins to write: one
  // at a start, before the forecast's first pass, has none, and the hour is not spent on it.
  const hour = Math.floor(nowSec / 3600) * 3600
  const pairs = statesHour === hour ? [] : [...new Set([...primaryCallSeam.forecasts().map((prediction) => prediction.pair), ...candidates.map((candidate) => candidate.pair)])]
  if (pairs.length > 0) {
    statesHour = hour
    await primaryCallSeam.recordStates(hour, cardStatesOf(hour, state, pairs)).catch((error) => console.error("The hour's card states could not be recorded:", error))
  }
  for (const listener of listeners) {
    try {
      listener(state)
    } catch (error) {
      console.error('A primary-call listener failed:', error)
    }
  }
  return state
}

/** Weighs now, or waits for the weighing under way. */
export function weighPrimaryCall(): Promise<PrimaryCallState> {
  if (weighing === null) {
    weighing = weighOnce().finally(() => {
      weighing = null
    })
  }
  return weighing
}

/** Weighs every minute and whenever the announcements reader has read. Called once, from electron/main.ts. */
export function startPrimaryCall(): void {
  if (timer !== null) return
  timer = setInterval(() => void weighPrimaryCall().catch((error) => console.error('Weighing the primary call failed:', error)), WEIGH_EVERY_MS)
  stopNews = onNewsUpdate(() => void weighPrimaryCall().catch((error) => console.error('Weighing the primary call failed:', error)))
  void weighPrimaryCall().catch((error) => console.error('Weighing the primary call failed:', error))
}

/** Test seam: as a new session finds it. */
export function resetPrimaryCall(): void {
  state = EMPTY
  live = null
  symbols = null
  opens.clear()
  recorded.clear()
  statesHour = null
  weighing = null
  listeners.clear()
  if (timer !== null) clearInterval(timer)
  timer = null
  stopNews?.()
  stopNews = null
}
