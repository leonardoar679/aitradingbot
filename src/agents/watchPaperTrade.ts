import type { AiConfig } from '../../shared/aiCost'
import type { AiSignalDecision } from '../../shared/aiSignal'
import {
  describeWatchPaperEntry,
  planWatchPaperTrade,
  watchPaperBlock,
  watchPaperExecutors,
  watchPaperNotice,
  type WatchPaperOutcome,
  type WatchPaperPlan
} from '../../shared/aiWatchPaper'
import type { AppSettings, Candle, Exchange, ExecutorConfig } from '../../shared/ipc'
import type { MarketEvent } from '../../shared/marketEvent'
import { describeExecutorFunding } from '../account/executorFunding'
import { settleExecutorOnStop } from '../account/settleExecutor'
import { runExecutorSimulation } from '../executors/engine'
import { settingsWrites } from '../utils/settingsWrites'

// THE ONE FILE OF THE WATCH'S THAT WRITES ANYTHING (shared/aiWatchPaper.ts has the rules).
//
// Two things happen here, and both are paper bookkeeping. A call the watch would act on becomes a
// PAPER Position executor, appended to the executors on file. And a paper position of the watch's
// that has closed -- its stop, its target or its clock ended it, or its entry expired unfilled --
// is stopped and its result settled into the paper account, the way pressing Stop on its card
// would, so that the money comes back and the count of open trades goes down.
//
// PAPER IS WRITTEN HERE AS A LITERAL. watchPaperExecutor takes no mode and has no way to be given
// one. Nothing in this file mentions the bridge a real order travels over, and
// tests/aiNoLivePath.test.ts reads this file to make sure of both.
//
// EVERY WRITE GOES THROUGH THE ONE QUEUE (src/utils/settingsWrites.ts), on executors read inside
// it: Strategies › Execution, a controller and this file all replace the same array.

type OkPlan = Extract<WatchPaperPlan, { ok: true }>

/** The executor a plan becomes. Paper, unlevered, and its position is not kept when it stops:
 * a paper trade the watch opened is closed by its own levels, not handed to Inventory. */
export function watchPaperExecutor(input: {
  id: string
  event: Pick<MarketEvent, 'exchange' | 'symbol' | 'baseAsset' | 'quoteAsset'>
  plan: OkPlan
  nowSec: number
}): ExecutorConfig {
  const { event, plan } = input
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
    watch: plan.mark,
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
  getSettings: () => Promise<Pick<AppSettings, 'executors' | 'paperAccount'>>
  setExecutors: (executors: ExecutorConfig[]) => Promise<void>
  /** The price now, or null when it cannot be had: the event's own price then stands in. */
  lastPrice: (exchange: Exchange, symbol: string) => Promise<number | null>
  /** 1-minute candles of [startSec, endSec]. */
  fetchCandles: (exchange: Exchange, symbol: string, startSec: number, endSec: number) => Promise<Candle[]>
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
  event: Pick<MarketEvent, 'id' | 'exchange' | 'symbol' | 'baseAsset' | 'quoteAsset' | 'time' | 'type' | 'price'>,
  decision: AiSignalDecision,
  deps: WatchPaperDeps
): Promise<WatchPaperResult | null> {
  const { watchPaper } = await deps.getConfig()
  if (!watchPaper.enabled || decision.model !== watchPaper.model) return null

  const before = await deps.getSettings()
  const blocked = watchPaperBlock({ config: watchPaper, event, decision, executors: before.executors })
  if (blocked !== null) return { opened: false, text: `No paper trade: ${blocked}` }

  let lastPrice: number | null = null
  try {
    lastPrice = await deps.lastPrice(event.exchange, event.symbol)
  } catch {
    lastPrice = null
  }
  const plan = planWatchPaperTrade({ config: watchPaper, event, decision, nowSec: deps.nowSec(), lastPrice })
  if (!plan.ok) return { opened: false, text: `No paper trade: ${plan.reason}` }

  // Checked again on the executors read inside the queue, with the funds: two answers arriving
  // together both passed the look above, and only one of them may be the pair's open trade.
  const refused = await deps.queue(async (): Promise<string | null> => {
    const fresh = await deps.getSettings()
    const problem =
      watchPaperBlock({ config: watchPaper, event, decision, executors: fresh.executors }) ??
      describeExecutorFunding({
        account: fresh.paperAccount ?? null,
        executors: fresh.executors,
        mode: 'paper',
        quoteAsset: event.quoteAsset,
        amountQuote: plan.params.amountQuote
      })
    if (problem !== null) return problem
    await deps.setExecutors([...fresh.executors, watchPaperExecutor({ id: deps.newId(), event, plan, nowSec: deps.nowSec() })])
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
  for (const executor of watchPaperExecutors(executors).filter((entry) => entry.status === 'active')) {
    try {
      const nowSec = deps.nowSec()
      const candles = (await deps.fetchCandles(executor.exchange, executor.symbol, executor.createdAt, nowSec)).filter((bar) => bar.time + 60 <= nowSec)
      if (candles.length === 0) continue
      const state = runExecutorSimulation(candles, executor, candles[0].close)
      if (state.kind !== 'position' || state.status !== 'closed' || state.exitReason === null) continue
      // How it ended goes on its mark: a stopped executor is not simulated again, so this is what
      // its card and the Watch card have to show, with or without a paper account.
      const result: WatchPaperOutcome = { exit: state.exitReason, pnlQuote: state.realizedPnl ?? 0, closedAt: state.closedAt ?? nowSec }
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
  fetchCandles: async (exchange, symbol, startSec, endSec) => (await window.api.market.fetchHistoricalRange(exchange, symbol, '1m', startSec, endSec)).candles,
  // Not kept in Inventory (keepPosition is false), so nothing was handed over and the whole
  // result is cash.
  settle: (executor, nowSec) => settleExecutorOnStop({ executor, handedOver: { held: null, realizedPnl: 0 }, now: nowSec }),
  notify: (title, body) => void window.api.notify(title, body).catch(() => undefined),
  nowSec: () => Math.floor(Date.now() / 1000),
  newId: () => crypto.randomUUID(),
  queue: (work) => settingsWrites(work)
}
