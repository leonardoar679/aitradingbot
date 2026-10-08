import { REVIEW_LINES, type NewsReading } from '../../shared/aiAdditions'
import type { ReferenceCandles } from '../../shared/aiEventMarket'
import type { Candle, Exchange, ExecutorConfig, LivePosition, LiveWatcherSummary, PositionExecutorParams } from '../../shared/ipc'
import type { MarketRegime } from '../../shared/marketResearch'
import { storiesAgainst, type NewsAgainstStory } from '../../shared/paperNewsBlock'
import { ownOpenPaperTrades } from '../../shared/paperRisk'
import { thesisStatus, type ThesisVerdict } from '../../shared/thesisStatus'
import { QUARTER_HOUR, readBitcoin, readMinutes, readOpenTrade, regimeAt, type FetchCandles } from '../agents/openTradeReading'

// THE THESIS STATUS, MEASURED (shared/thesisStatus.ts has the rule). For each of the app's own open
// paper trades and each real position with a watcher, on the last closed minute, as the exit check
// measures its trades (src/agents/openTradeReading.ts): where it entered, where it is, its
// fifteen-minute move, Bitcoin's regime when it entered and now, and the stories naming its coin.
// Read once a minute while Positions is open (useThesisReadings.ts).
//
// IT READS: candles, the stories on file and the analyst's readings of them. It writes nothing, asks
// no model, and places, sizes or closes nothing. What it finds is shown beside the position, and
// nothing acts on it.

/** How far back Bitcoin's minutes are read for the regime at the entry. A position entered before
 * that has no regime at its entry, and its status reads the regime now alone. */
export const REGIME_LOOKBACK_SEC = 86_400
/** A real position's minutes are read from this far back: enough for its fifteen-minute move. Its
 * entry is its watcher's, not the engine's, so its own minutes are not needed. */
export const LIVE_MINUTES_SEC = 25 * 60

export interface ThesisDeps {
  fetchCandles: FetchCandles
  /** The stories on file that name coins (shared/newsFeed.ts). */
  stories: () => Promise<NewsAgainstStory[]>
  /** The news analyst's readings by story id, from `sinceSec` on. */
  readings: (sinceSec: number) => Promise<Record<string, NewsReading>>
  nowSec: () => number
}

/** A position whose thesis is measured: one of the app's own paper trades, or a real position with
 * a watcher. */
export interface ThesisSubject {
  /** The paper executor's id, or the real position's. */
  id: string
  exchange: Exchange
  symbol: string
  baseAsset: string
  side: 'buy' | 'sell'
  /** When it was opened: the executor's minute for a paper trade, the fill's for a real one. */
  openedAt: number
  /** Its stop and its target, as distances from the entry in percent; null for none. */
  stopPct: number | null
  targetPct: number | null
  timeLimitSec: number | null
  /** A paper trade's executor, for the engine to say where it entered; null for a real position. */
  executor: ExecutorConfig | null
  /** A real position's entry, from its watcher; null for a paper trade. */
  entryPrice: number | null
}

export interface ThesisReading {
  id: string
  /** The last closed minute's close, and its time. */
  price: number
  priceTime: number
  entryPrice: number
  enteredAt: number
  move15mPct: number | null
  regimeAtEntry: MarketRegime | null
  regimeNow: MarketRegime | null
  /** The strongest story against the side, from three hours before it was opened to now; null for
   * none. */
  storyAgainst: NewsAgainstStory | null
  /** The latest story naming the coin, whichever way it points; null for none. */
  latestStory: NewsAgainstStory | null
  verdict: ThesisVerdict
}

/** The app's own open paper trades, as subjects. */
export function paperSubjects(executors: ExecutorConfig[]): ThesisSubject[] {
  return ownOpenPaperTrades(executors).map((executor) => {
    const params = executor.params as PositionExecutorParams
    return {
      id: executor.id,
      exchange: executor.exchange,
      symbol: executor.symbol,
      baseAsset: executor.baseAsset,
      side: params.side,
      openedAt: executor.createdAt,
      stopPct: params.stopLossPct,
      targetPct: params.takeProfitPct,
      timeLimitSec: params.timeLimitSec,
      executor,
      entryPrice: null
    }
  })
}

/** The real positions that have a watcher, as subjects: the watcher's entry and barriers are the
 * position's. A real position is long (spot), so its side is a buy. */
export function liveSubjects(positions: LivePosition[], watchers: LiveWatcherSummary[]): ThesisSubject[] {
  const out: ThesisSubject[] = []
  for (const position of positions) {
    const watcher = watchers.find((entry) => entry.livePositionId === position.id)
    if (watcher === undefined || !(watcher.entryPrice > 0)) continue
    out.push({
      id: position.id,
      exchange: position.exchange,
      symbol: position.symbol,
      baseAsset: position.baseAsset,
      side: 'buy',
      openedAt: watcher.enteredAt,
      stopPct: watcher.stopLossPct,
      targetPct: watcher.takeProfitPct,
      timeLimitSec: watcher.timeLimitSec,
      executor: null,
      entryPrice: watcher.entryPrice
    })
  }
  return out
}

/** The latest story on file that names the coin and is not stale, whichever way it points. */
export function latestStoryNaming(stories: readonly NewsAgainstStory[], baseAsset: string, nowSec: number): NewsAgainstStory | null {
  let latest: NewsAgainstStory | null = null
  for (const story of stories) {
    if (story.stale || story.publishedAt > nowSec || !story.assets.some((asset) => asset.ticker === baseAsset)) continue
    if (latest === null || story.publishedAt > latest.publishedAt) latest = story
  }
  return latest
}

/** How far the price is from the stop and from the target, in percent of the price, positive while
 * each is still ahead of it; null for a level the trade has none of. */
export function distancesOf(input: { side: 'buy' | 'sell'; entryPrice: number; price: number; stopPct: number | null; targetPct: number | null }): { toStopPct: number | null; toTargetPct: number | null } {
  const { side, entryPrice, price } = input
  if (!(entryPrice > 0) || !(price > 0)) return { toStopPct: null, toTargetPct: null }
  const sign = side === 'buy' ? 1 : -1
  const stop = input.stopPct === null || input.stopPct <= 0 ? null : entryPrice * (1 - (sign * input.stopPct) / 100)
  const target = input.targetPct === null || input.targetPct <= 0 ? null : entryPrice * (1 + (sign * input.targetPct) / 100)
  return {
    toStopPct: stop === null ? null : (sign * (price - stop) * 100) / price,
    toTargetPct: target === null ? null : (sign * (target - price) * 100) / price
  }
}

interface Stand {
  subject: ThesisSubject
  entryPrice: number
  enteredAt: number
  last: Candle
  move15mPct: number | null
}

/** One measurement of every subject, keyed by its id. A subject that has not entered, has closed,
 * or whose minutes could not be read is left out, and the others are measured. Never throws. */
export async function measureTheses(subjects: ThesisSubject[], deps: ThesisDeps): Promise<Record<string, ThesisReading>> {
  const out: Record<string, ThesisReading> = {}
  if (subjects.length === 0) return out
  const nowSec = deps.nowSec()
  const stands: Stand[] = []
  for (const subject of subjects) {
    try {
      if (subject.executor !== null) {
        const minutes = await deps.fetchCandles(subject.exchange, subject.symbol, '1m', subject.openedAt - QUARTER_HOUR - 60, nowSec)
        const reading = readOpenTrade(subject.executor, minutes, nowSec)
        if (reading !== null) stands.push({ subject, ...reading })
      } else if (subject.entryPrice !== null) {
        const minutes = await deps.fetchCandles(subject.exchange, subject.symbol, '1m', nowSec - LIVE_MINUTES_SEC, nowSec)
        const reading = readMinutes(minutes, nowSec)
        if (reading !== null) stands.push({ subject, entryPrice: subject.entryPrice, enteredAt: subject.openedAt, ...reading })
      }
    } catch (failure) {
      console.error(`The thesis of ${subject.symbol} could not be measured:`, failure)
    }
  }
  if (stands.length === 0) return out

  // Bitcoin's minutes once an exchange, from the earliest entry within the lookback; the stories and
  // the analyst's readings once.
  const bitcoin = new Map<Exchange, { from: number; candles: ReferenceCandles | null }>()
  for (const exchange of new Set(stands.map((stand) => stand.subject.exchange))) {
    const from = Math.max(nowSec - REGIME_LOOKBACK_SEC, Math.min(...stands.filter((stand) => stand.subject.exchange === exchange).map((stand) => stand.enteredAt)))
    bitcoin.set(exchange, { from, candles: await readBitcoin(deps.fetchCandles, exchange, from, nowSec) })
  }
  const earliest = Math.min(...stands.map((stand) => stand.subject.openedAt))
  const [stories, readings] = await Promise.all([
    deps.stories().catch((): NewsAgainstStory[] => []),
    deps.readings(earliest - REVIEW_LINES.majorNewsSeconds).catch((): Record<string, NewsReading> => ({}))
  ])

  for (const stand of stands) {
    const { subject } = stand
    const btc = bitcoin.get(subject.exchange) ?? null
    const regimeAtEntry = btc === null || btc.candles === null || stand.enteredAt < btc.from ? null : regimeAt(btc.candles, stand.enteredAt)
    const regimeNow = btc === null || btc.candles === null ? null : regimeAt(btc.candles, stand.last.time + 60)
    const storyAgainst = storiesAgainst({ event: { baseAsset: subject.baseAsset, time: subject.openedAt }, side: subject.side, stories, readings, nowSec })[0] ?? null
    const latestStory = latestStoryNaming(stories, subject.baseAsset, nowSec)
    const verdict = thesisStatus({
      side: subject.side,
      entryPrice: stand.entryPrice,
      stopPct: subject.stopPct,
      price: stand.last.close,
      move15mPct: stand.move15mPct,
      regimeAtEntry,
      regimeNow,
      storyAgainst
    })
    out[subject.id] = {
      id: subject.id,
      price: stand.last.close,
      priceTime: stand.last.time,
      entryPrice: stand.entryPrice,
      enteredAt: stand.enteredAt,
      move15mPct: stand.move15mPct,
      regimeAtEntry,
      regimeNow,
      storyAgainst,
      latestStory,
      verdict
    }
  }
  return out
}
