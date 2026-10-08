import { AI_ADDITION_PROMPT_VERSIONS, REVIEW_LINES, newsReadingsOf, reviewRefusal, type NewsReading, type TradeReview } from '../../shared/aiAdditions'
import type { AiConfig } from '../../shared/aiCost'
import { aiExitOutcome, aiExitPlanEnd, aiExitPlanParams, aiExitPlanResult, aiExitWrite, type AiExitOrder } from '../../shared/aiExit'
import type { AiSignalDecision } from '../../shared/aiSignal'
import { MARKET_REFERENCE_SYMBOLS } from '../../shared/aiEventMarket'
import {
  btcMoveAgainst,
  describeWatchPaperEntry,
  planWatchPaperTrade,
  watchPaperBlock,
  watchPaperDropNotice,
  watchPaperExecutors,
  watchPaperNotice,
  type WatchPaperOutcome,
  type WatchPaperPlan
} from '../../shared/aiWatchPaper'
import type { AppSettings, Candle, Exchange, ExecutorConfig, PositionExecutorParams } from '../../shared/ipc'
import { bookSpreadPct, livePaperBlock, priceAgeMs, streamedEntry, thinBookBlock, type LiveBook } from '../../shared/liveMarket'
import type { MarketEvent } from '../../shared/marketEvent'
import { correlatedExposureBlock, readBtcCorrelation } from '../../shared/paperExposure'
import { newsAgainstBlock, type NewsAgainstStory } from '../../shared/paperNewsBlock'
import { healPaperPause, paperPauseBlock } from '../../shared/paperPause'
import { healPaperRisk, paperOutBlock } from '../../shared/paperRisk'
import { describeExecutorFunding } from '../account/executorFunding'
import { settleExecutorOnStop } from '../account/settleExecutor'
import { runExecutorSimulation } from '../executors/engine'
import { settingsWrites } from '../utils/settingsWrites'

// THE ONE FILE OF THE WATCH'S THAT WRITES ANYTHING (shared/aiWatchPaper.ts has the rules).
//
// Two things happen here, and both are paper bookkeeping. A call the watch would act on becomes a
// PAPER Position executor, appended to the executors on file, unless its limits, the paper money
// the app's own trades have out, what they have out on one side on coins that move with Bitcoin
// (shared/paperExposure.ts), a losing run of its own (shared/paperPause.ts), the reviewer's REJECT
// where something about the trade stood out (shared/aiAdditions.ts), the live price -- none
// fresh, or a spread over 0.1% (shared/liveMarket.ts) -- or, since 8 October 2026, a best level on
// the side a fill would take that cannot hold the stake (the same file), or major news on the coin
// pointing against the side (shared/paperNewsBlock.ts), refuse it. And
// a paper position of the watch's that has closed -- its stop, its target or its clock ended it,
// or its entry expired unfilled -- is stopped and its result settled into the paper account, the
// way pressing Stop on its card would, so that the money comes back and the count of open trades
// goes down. So is one still waiting for its entry when Bitcoin has moved against it by more than
// its safeguard allows.
//
// And since 6 October 2026, the exit check's EXIT (shared/aiExit.ts): an open paper trade of the
// watch's has its time limit brought forward, so that it closes at the next minute by the engine's
// own rule and is stopped and settled above like any other. Nothing else about it changes. Once the
// plan's own time has passed, what the plan would have made is written beside how it did end.
//
// PAPER IS WRITTEN HERE AS A LITERAL. watchPaperExecutor takes no mode and has no way to be given
// one. Nothing in this file mentions the bridge a real order travels over, and
// tests/aiNoLivePath.test.ts reads this file to make sure of both.
//
// EVERY WRITE GOES THROUGH THE ONE QUEUE (src/utils/settingsWrites.ts), on executors read inside
// it: Strategies › Execution, a controller and this file all replace the same array.

type OkPlan = Extract<WatchPaperPlan, { ok: true }>

/** The executor a plan becomes. Paper, unlevered, and its position is not kept when it stops:
 * a paper trade the watch opened is closed by its own levels, not handed to Inventory. The live
 * book it was opened against, where there was one, and its pair's correlation with Bitcoin, where
 * it was read for it, are written on its mark. Since 8 October 2026, where that book's fill price
 * is inside the entry range, the trade enters there and then (PositionExecutorParams.entryFill,
 * shared/liveMarket.ts streamedEntry) instead of waiting for a minute bar inside the range; the
 * recommendation's score stays on minute bars, and the two are shown side by side. */
export function watchPaperExecutor(input: {
  id: string
  event: Pick<MarketEvent, 'exchange' | 'symbol' | 'baseAsset' | 'quoteAsset'>
  plan: OkPlan
  nowSec: number
  book?: LiveBook | null
  btcCorrelation?: number | null
}): ExecutorConfig {
  const { event, plan, book } = input
  const spread = book === undefined || book === null ? null : bookSpreadPct(book)
  const withBook =
    book === undefined || book === null || spread === null
      ? plan.mark
      : { ...plan.mark, book: { bid: book.bid, ask: book.ask, spreadPct: spread, ageMs: priceAgeMs(book, input.nowSec * 1000), source: book.source } }
  const mark = input.btcCorrelation === undefined ? withBook : { ...withBook, btcCorrelation: input.btcCorrelation }
  const fill = book === undefined || book === null ? null : streamedEntry(book, plan.params, input.nowSec * 1000)
  return {
    id: input.id,
    name: plan.name,
    type: 'position',
    exchange: event.exchange,
    symbol: event.symbol,
    baseAsset: event.baseAsset,
    quoteAsset: event.quoteAsset,
    createdAt: input.nowSec,
    status: 'active',
    stoppedAt: null,
    keepPosition: false,
    mode: 'paper',
    watch: mark,
    liveOrder: null,
    pendingLiveOrderIds: [],
    liveWatcherId: null,
    liveWatcherError: null,
    liveExitResult: null,
    liveDcaBasePrice: null,
    liveTwapRunId: null,
    liveTwapResult: null,
    params: fill === null ? plan.params : { ...plan.params, entryFill: fill }
  }
}

export interface WatchPaperDeps {
  getConfig: () => Promise<Pick<AiConfig, 'watchPaper'>>
  getSettings: () => Promise<Pick<AppSettings, 'executors' | 'paperAccount' | 'paperRisk' | 'paperPause'>>
  setExecutors: (executors: ExecutorConfig[]) => Promise<void>
  /** The price now, or null when it cannot be had: the event's own price then stands in. */
  lastPrice: (exchange: Exchange, symbol: string) => Promise<number | null>
  /** The live book now (shared/liveMarket.ts): the stream's, or one read just now. Null when none
   * can be had, and then no paper trade is opened. */
  liveBook: (exchange: Exchange, symbol: string) => Promise<LiveBook | null>
  /** 1-minute candles of [startSec, endSec]. */
  fetchCandles: (exchange: Exchange, symbol: string, startSec: number, endSec: number) => Promise<Candle[]>
  /** The pair's hourly moves over the last week against Bitcoin's (shared/paperExposure.ts), or
   * null when they cannot be read: it then counts as a pair that tracks Bitcoin. */
  btcCorrelation: (exchange: Exchange, symbol: string) => Promise<number | null>
  /** The reviewer's second look (shared/aiAdditions.ts), asked in the main process only when
   * something about the trade stands out. Its REJECT refuses the trade; anything else leaves it. */
  review: (event: MarketEvent, decision: AiSignalDecision) => Promise<TradeReview>
  /** The stories on file that name coins (shared/newsFeed.ts), for the news against a trade. */
  stories: () => Promise<NewsAgainstStory[]>
  /** The news analyst's readings by story id, from `sinceSec` on. */
  readings: (sinceSec: number) => Promise<Record<string, NewsReading>>
  /** Books a stopped paper executor's result into the paper account. */
  settle: (executor: ExecutorConfig, nowSec: number) => Promise<unknown>
  notify: (title: string, body: string) => void
  nowSec: () => number
  newId: () => string
  /** Runs a read-modify-write of settings with no other one inside it. */
  queue: <T>(work: () => Promise<T>) => Promise<T>
}

export interface WatchPaperResult {
  opened: boolean
  /** One sentence for the Watch card. */
  text: string
}

/** Opens a paper trade on an answer the watch got, if that is switched on and its limits allow.
 * Null when there is nothing to say: paper trades are off, or the answer is another model's.
 * Never throws for a trade it decides not to make; that is a result. */
export async function openWatchPaperTrade(
  event: MarketEvent,
  decision: AiSignalDecision,
  deps: WatchPaperDeps
): Promise<WatchPaperResult | null> {
  const { watchPaper } = await deps.getConfig()
  if (!watchPaper.enabled || decision.model !== watchPaper.model) return null

  const before = await deps.getSettings()
  // Its own limits, then the losing run that pauses the app's own paper trades (shared/paperPause.ts).
  const blocked =
    watchPaperBlock({ config: watchPaper, event, decision, executors: before.executors, nowSec: deps.nowSec() }) ??
    paperPauseBlock({ setting: healPaperPause(before.paperPause), executors: before.executors, source: 'watch' })
  if (blocked !== null) return { opened: false, text: `No paper trade: ${blocked}` }

  let lastPrice: number | null = null
  try {
    lastPrice = await deps.lastPrice(event.exchange, event.symbol)
  } catch {
    lastPrice = null
  }
  const plan = planWatchPaperTrade({ config: watchPaper, risk: healPaperRisk(before.paperRisk), event, decision, nowSec: deps.nowSec(), lastPrice })
  if (!plan.ok) return { opened: false, text: `No paper trade: ${plan.reason}` }

  // The market it would enter, live (shared/liveMarket.ts): with no fresh price, a spread wider than
  // a trade is entered at, or a best level that cannot hold the stake, none is opened; nor against
  // major news on the coin (shared/paperNewsBlock.ts). Looked at before a second look is asked for,
  // so that the reviewer is not asked about a trade that could not be opened.
  const readBook = async (): Promise<LiveBook | null> => {
    try {
      return await deps.liveBook(event.exchange, event.symbol)
    } catch {
      return null
    }
  }
  const first = await readBook()
  const unfit = livePaperBlock(first, deps.nowSec() * 1000) ?? thinBookBlock(first, plan.side, plan.params.amountQuote) ?? (await newsAgainst(event, plan.side, deps))
  if (unfit !== null) return { opened: false, text: `No paper trade: ${unfit}` }

  // A second look, where something about this trade stands out: its REJECT means no trade. A review
  // that was not asked, refused or could not be had leaves the trade as it was: it only opens less.
  let review: TradeReview | null = null
  try {
    review = await deps.review(event, decision)
  } catch {
    review = null
  }
  const rejected = reviewRefusal(review)
  if (rejected !== null) return { opened: false, text: `No paper trade: ${rejected}` }

  // Read again, as a review can take seconds: the trade is judged on the market as it is now.
  const book = await readBook()
  // Whether the pair moves with Bitcoin, for what the app's trades have out on one side of it.
  let btcCorrelation: number | null = null
  try {
    btcCorrelation = await deps.btcCorrelation(event.exchange, event.symbol)
  } catch {
    btcCorrelation = null
  }

  // Checked again on the executors read inside the queue, with the funds and with what the app's
  // own paper trades have out together, and on one side on coins that move with Bitcoin: two
  // answers arriving together both passed the look above, and only one of them may be the pair's
  // open trade. A trade that closed in between may have ended a losing run, and that is read again
  // too; and the live price is judged as of now.
  const made: { executor: ExecutorConfig | null } = { executor: null }
  const refused = await deps.queue(async (): Promise<string | null> => {
    const fresh = await deps.getSettings()
    const problem =
      watchPaperBlock({ config: watchPaper, event, decision, executors: fresh.executors, nowSec: deps.nowSec() }) ??
      paperPauseBlock({ setting: healPaperPause(fresh.paperPause), executors: fresh.executors, source: 'watch' }) ??
      livePaperBlock(book, deps.nowSec() * 1000) ??
      thinBookBlock(book, plan.side, plan.params.amountQuote) ??
      describeExecutorFunding({
        account: fresh.paperAccount ?? null,
        executors: fresh.executors,
        mode: 'paper',
        quoteAsset: event.quoteAsset,
        amountQuote: plan.params.amountQuote
      }) ??
      paperOutBlock({ risk: healPaperRisk(fresh.paperRisk), executors: fresh.executors, quoteAsset: event.quoteAsset, amountQuote: plan.params.amountQuote }) ??
      correlatedExposureBlock({
        account: fresh.paperAccount ?? null,
        risk: healPaperRisk(fresh.paperRisk),
        executors: fresh.executors,
        quoteAsset: event.quoteAsset,
        side: plan.side,
        amountQuote: plan.params.amountQuote,
        correlation: btcCorrelation
      })
    if (problem !== null) return problem
    const executor = watchPaperExecutor({ id: deps.newId(), event, plan, nowSec: deps.nowSec(), book, btcCorrelation })
    await deps.setExecutors([...fresh.executors, executor])
    made.executor = executor
    return null
  })
  if (refused !== null) return { opened: false, text: `No paper trade: ${refused}` }

  const notice = watchPaperNotice(event, plan)
  try {
    deps.notify(notice.title, notice.body)
  } catch {
    // A desktop that cannot show it is not a reason to report a trade that was opened as not.
  }
  return {
    opened: true,
    text: `A paper ${plan.side === 'buy' ? 'BUY' : 'SELL'} of ${plan.params.amountQuote} ${event.quoteAsset} was opened, ${describeWatchPaperEntry((made.executor?.params as PositionExecutorParams | undefined) ?? plan.params)}.`
  }
}

/** News against the trade (shared/paperNewsBlock.ts): a story of major impact naming the coin, from
 * the reviewer's three hours before the event to now, pointing the other way. Stories or readings
 * that cannot be read refuse nothing: as with the reviewer, what could not be had leaves the trade
 * as it was. */
async function newsAgainst(event: MarketEvent, side: 'buy' | 'sell', deps: WatchPaperDeps): Promise<string | null> {
  try {
    const [stories, readings] = await Promise.all([deps.stories(), deps.readings(event.time - REVIEW_LINES.majorNewsSeconds)])
    return newsAgainstBlock({ event, side, stories, readings, nowSec: deps.nowSec() })
  } catch {
    return null
  }
}

/** Stops and settles each paper trade of the watch's whose position has closed. Returns the names
 * of the ones it settled.
 *
 * A POSITION IS JUDGED ON MINUTES THAT HAVE CLOSED. A forming candle has a low and a high that are
 * not yet facts, and a stop "hit" by one may not be hit when the minute ends.
 *
 * A TRADE IS SETTLED ONCE. It is stopped inside the queue, on the executors read there, and only
 * the pass that found it still active goes on to settle it: so two passes that overlap, and an
 * executor someone stopped or deleted by hand while its candles were being read, each end with
 * its result booked exactly once, by whoever stopped it.
 *
 * HOW IT ENDED IS WRITTEN ON IT in the same write that stops it: the exit and what it made or
 * lost. The paper account, where there is one, is told the same figure by the settlement. */
export async function settleWatchPaperTrades(deps: WatchPaperDeps): Promise<string[]> {
  const settled: string[] = []
  const { executors } = await deps.getSettings()
  await measureWatchExitPlans(executors, deps)
  const active = watchPaperExecutors(executors).filter((entry) => entry.status === 'active')
  if (active.length === 0) return settled
  // The safeguard as it is set now, and Bitcoin's minutes read once a pass for every trade that
  // needs them, from the earliest of their events.
  const { watchPaper } = await deps.getConfig()
  const btcMinutes = new Map<Exchange, Promise<Candle[]>>()
  const bitcoin = (exchange: Exchange, nowSec: number): Promise<Candle[]> => {
    let read = btcMinutes.get(exchange)
    if (read === undefined) {
      const fromSec = Math.min(...active.map((entry) => entry.watch?.eventTime ?? nowSec)) - 60
      read = deps.fetchCandles(exchange, MARKET_REFERENCE_SYMBOLS.btc, fromSec, nowSec).then((bars) => bars.filter((bar) => bar.time + 60 <= nowSec))
      btcMinutes.set(exchange, read)
    }
    return read
  }
  for (const executor of active) {
    try {
      const nowSec = deps.nowSec()
      const candles = (await deps.fetchCandles(executor.exchange, executor.symbol, executor.createdAt, nowSec)).filter((bar) => bar.time + 60 <= nowSec)
      if (candles.length === 0) continue
      const state = runExecutorSimulation(candles, executor, candles[0].close)
      if (state.kind !== 'position') continue
      let found: WatchPaperOutcome | null = null
      if (state.status === 'closed' && state.exitReason !== null) {
        // How it ended goes on its mark: a stopped executor is not simulated again, so this is what
        // its card and the Watch card have to show, with or without a paper account. One the exit
        // check's time limit ended is the check's exit.
        found = { exit: aiExitOutcome(state.exitReason, executor.watch?.aiExit), pnlQuote: state.realizedPnl ?? 0, closedAt: state.closedAt ?? nowSec }
      } else if (state.status === 'pending' && executor.watch !== undefined && watchPaper.dropOnBtcMovePct > 0) {
        // Still waiting for its entry: dropped when Bitcoin has moved against it since the event.
        const movePct = btcMoveAgainst({
          side: (executor.params as PositionExecutorParams).side,
          eventTime: executor.watch.eventTime,
          btc: await bitcoin(executor.exchange, nowSec),
          limitPct: watchPaper.dropOnBtcMovePct
        })
        if (movePct !== null) found = { exit: 'btc_moved', pnlQuote: 0, closedAt: nowSec, btcMovePct: movePct }
      }
      if (found === null) continue
      const result: WatchPaperOutcome = found
      const stopped = await deps.queue(async (): Promise<boolean> => {
        const fresh = await deps.getSettings()
        const current = fresh.executors.find((entry) => entry.id === executor.id)
        if (current?.status !== 'active' || current.watch === undefined) return false
        const ended: ExecutorConfig = { ...current, status: 'stopped', stoppedAt: nowSec, watch: { ...current.watch, result } }
        await deps.setExecutors(fresh.executors.map((entry) => (entry.id === executor.id ? ended : entry)))
        return true
      })
      if (!stopped) continue
      await deps.settle(executor, nowSec)
      settled.push(executor.name)
      if (result.exit === 'btc_moved' && executor.watch !== undefined) {
        const notice = watchPaperDropNotice(executor, executor.watch.eventTime, result.btcMovePct ?? 0)
        try {
          deps.notify(notice.title, notice.body)
        } catch {
          // A desktop that cannot show it is not a reason to report a trade that was dropped as not.
        }
      }
    } catch (failure) {
      // One trade whose candles could not be read is tried again next minute; the others go on.
      console.error(`The watch could not settle its paper trade "${executor.name}":`, failure)
    }
  }
  return settled
}

/** What the plan of each trade the exit check closed would have made, once the plan's own time limit
 * has passed: the same minutes from when the trade was opened, simulated with the time limit it had,
 * and written on its mark beside how it did end. Judged on minutes that have closed, and written
 * once, inside the queue, on the executors read there. */
async function measureWatchExitPlans(executors: ExecutorConfig[], deps: WatchPaperDeps): Promise<void> {
  for (const executor of watchPaperExecutors(executors)) {
    const mark = executor.watch?.aiExit
    if (executor.status !== 'stopped' || mark === undefined || mark.plan !== undefined || executor.watch?.result === undefined) continue
    try {
      const nowSec = deps.nowSec()
      const end = aiExitPlanEnd(mark)
      if (nowSec < end + 60) continue
      const candles = (await deps.fetchCandles(executor.exchange, executor.symbol, executor.createdAt, end + 60)).filter((bar) => bar.time + 60 <= nowSec)
      const plan = { ...executor, params: aiExitPlanParams(executor.params as PositionExecutorParams, mark) }
      const state = candles.length === 0 ? null : runExecutorSimulation(candles, plan, candles[0].close)
      const result = aiExitPlanResult(state?.kind === 'position' ? state : null, mark, nowSec)
      if (result === undefined) continue
      await deps.queue(async (): Promise<void> => {
        const fresh = await deps.getSettings()
        const current = watchPaperExecutors(fresh.executors).find((entry) => entry.id === executor.id)
        if (current?.watch?.aiExit === undefined || current.watch.aiExit.plan !== undefined) return
        const measured: ExecutorConfig = { ...current, watch: { ...current.watch, aiExit: { ...current.watch.aiExit, plan: result } } }
        await deps.setExecutors(fresh.executors.map((entry) => (entry.id === executor.id ? measured : entry)))
      })
    } catch (failure) {
      // Its minutes are read again next minute.
      console.error(`The watch could not measure the plan of "${executor.name}":`, failure)
    }
  }
}

/** Closes one of the watch's open paper trades at the next minute, on the exit check's EXIT: its time
 * limit is brought forward (shared/aiExit.ts), so that the engine ends it by its own rule and the
 * settle loop above stops and books it, and the plan as it was and what was said are written on its
 * mark. Its stop and its target are not touched, and its time is never made longer. Only one of the
 * watch's own paper trades still open, read inside the queue. Returns whether it was brought
 * forward. */
export async function exitWatchPaperTrade(order: AiExitOrder, deps: Pick<WatchPaperDeps, 'getSettings' | 'setExecutors' | 'nowSec' | 'queue'>): Promise<boolean> {
  return deps.queue(async (): Promise<boolean> => {
    const fresh = await deps.getSettings()
    const current = watchPaperExecutors(fresh.executors).find((entry) => entry.id === order.executorId)
    if (current?.status !== 'active' || current.watch === undefined || current.watch.aiExit !== undefined) return false
    const written = aiExitWrite({
      params: current.params as PositionExecutorParams,
      enteredAt: order.enteredAt,
      nowSec: deps.nowSec(),
      model: order.model,
      triggers: order.triggers,
      confidence: order.confidence,
      reason: order.reason
    })
    if (written === null) return false
    const closing: ExecutorConfig = { ...current, params: written.params, watch: { ...current.watch, aiExit: written.mark } }
    await deps.setExecutors(fresh.executors.map((entry) => (entry.id === current.id ? closing : entry)))
    return true
  })
}

/** The same, against the running app. */
export const watchPaperBrowserDeps: WatchPaperDeps = {
  getConfig: () => window.api.ai.getConfig(),
  getSettings: () => window.api.settings.get(),
  setExecutors: async (executors) => {
    await window.api.settings.set({ executors })
  },
  lastPrice: async (exchange, symbol) => (await window.api.market.fetchTicker24h(exchange, symbol)).lastPrice,
  // The live stream is Binance's: an event on another exchange has no live book here.
  liveBook: (exchange, symbol) => (exchange === 'binance' ? window.api.market.liveBook(symbol) : Promise.resolve(null)),
  fetchCandles: async (exchange, symbol, startSec, endSec) => (await window.api.market.fetchHistoricalRange(exchange, symbol, '1m', startSec, endSec)).candles,
  btcCorrelation: (exchange, symbol) =>
    readBtcCorrelation(
      async (from, pair, startSec, endSec) => (await window.api.market.fetchHistoricalRange(from, pair, '1h', startSec, endSec)).candles,
      exchange,
      symbol,
      Math.floor(Date.now() / 1000)
    ),
  review: (event, decision) => window.api.ai.reviewTrade({ event, decision }),
  // The stories on file, and the analyst's readings of them from the ledger: both free to read.
  stories: async () => (await window.api.feed.getState()).stories,
  readings: async (sinceSec) =>
    newsReadingsOf((await window.api.ai.listCalls({ source: 'addition', promptVersion: AI_ADDITION_PROMPT_VERSIONS.news, sinceSec, limit: 1000 })).rows),
  // Not kept in Inventory (keepPosition is false), so nothing was handed over and the whole
  // result is cash.
  settle: (executor, nowSec) => settleExecutorOnStop({ executor, handedOver: { held: null, realizedPnl: 0 }, now: nowSec }),
  notify: (title, body) => void window.api.notify(title, body).catch(() => undefined),
  nowSec: () => Math.floor(Date.now() / 1000),
  newId: () => crypto.randomUUID(),
  queue: (work) => settingsWrites(work)
}
