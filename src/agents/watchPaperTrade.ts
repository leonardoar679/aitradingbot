import { reviewRefusal, type TradeReview } from '../../shared/aiAdditions'
import type { AiConfig } from '../../shared/aiCost'
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
import { bookSpreadPct, livePaperBlock, priceAgeMs, type LiveBook } from '../../shared/liveMarket'
import type { MarketEvent } from '../../shared/marketEvent'
import { correlatedExposureBlock, readBtcCorrelation } from '../../shared/paperExposure'
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
// where something about the trade stood out (shared/aiAdditions.ts), or the live price -- none
// fresh, or a spread over 0.1% (shared/liveMarket.ts) -- refuse it. And
// a paper position of the watch's that has closed -- its stop, its target or its clock ended it,
// or its entry expired unfilled -- is stopped and its result settled into the paper account, the
// way pressing Stop on its card would, so that the money comes back and the count of open trades
// goes down. So is one still waiting for its entry when Bitcoin has moved against it by more than
// its safeguard allows.
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
 * it was read for it, are written on its mark. */
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
    params: plan.params
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

  // The market it would enter, live (shared/liveMarket.ts): with no fresh price, or a spread wider
  // than a trade is entered at, none is opened.
  let book: LiveBook | null = null
  try {
    book = await deps.liveBook(event.exchange, event.symbol)
  } catch {
    book = null
  }
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
  const refused = await deps.queue(async (): Promise<string | null> => {
    const fresh = await deps.getSettings()
    const problem =
      watchPaperBlock({ config: watchPaper, event, decision, executors: fresh.executors, nowSec: deps.nowSec() }) ??
      paperPauseBlock({ setting: healPaperPause(fresh.paperPause), executors: fresh.executors, source: 'watch' }) ??
      livePaperBlock(book, deps.nowSec() * 1000) ??
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
    await deps.setExecutors([...fresh.executors, watchPaperExecutor({ id: deps.newId(), event, plan, nowSec: deps.nowSec(), book, btcCorrelation })])
    return null
  })
  if (refused !== null) return { opened: false, text: `No paper trade: ${refused}` }

  const notice = watchPaperNotice(event, plan)
  try {
    deps.notify(notice.title, notice.body)
  } catch {
    // A desktop that cannot show it is not a reason to report a trade that was opened as not.
  }
  return { opened: true, text: `A paper ${plan.side === 'buy' ? 'BUY' : 'SELL'} of ${plan.params.amountQuote} ${event.quoteAsset} was opened, ${describeWatchPaperEntry(plan.params)}.` }
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
        // its card and the Watch card have to show, with or without a paper account.
        found = { exit: state.exitReason, pnlQuote: state.realizedPnl ?? 0, closedAt: state.closedAt ?? nowSec }
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
  // Not kept in Inventory (keepPosition is false), so nothing was handed over and the whole
  // result is cash.
  settle: (executor, nowSec) => settleExecutorOnStop({ executor, handedOver: { held: null, realizedPnl: 0 }, now: nowSec }),
  notify: (title, body) => void window.api.notify(title, body).catch(() => undefined),
  nowSec: () => Math.floor(Date.now() / 1000),
  newId: () => crypto.randomUUID(),
  queue: (work) => settingsWrites(work)
}
