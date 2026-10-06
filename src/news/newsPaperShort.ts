import { aiExitOutcome, aiExitPlanEnd, aiExitPlanParams, aiExitPlanResult, aiExitWrite, type AiExitOrder } from '../../shared/aiExit'
import type { NewsItem, NewsKindActions } from '../../shared/news'
import {
  delistingShortParams,
  newsShortBlock,
  newsShortExecutors,
  newsShortNotice,
  tagReading,
  tagReadingWindow,
  tagShortParams,
  type NewsShortMark
} from '../../shared/newsActions'
import type { AppSettings, Candle, Exchange, ExecutorConfig, PositionExecutorParams, SymbolInfo } from '../../shared/ipc'
import { correlatedExposureBlock, readBtcCorrelation } from '../../shared/paperExposure'
import { healPaperPause, paperPauseBlock } from '../../shared/paperPause'
import { healPaperRisk, paperOutBlock, sizePaperTrade } from '../../shared/paperRisk'
import { describeExecutorFunding } from '../account/executorFunding'
import { settleExecutorOnStop } from '../account/settleExecutor'
import { runExecutorSimulation } from '../executors/engine'
import { settingsWrites } from '../utils/settingsWrites'

// THE ONE FILE THAT WRITES WHAT THE NEWS DOES (shared/newsActions.ts has the rules).
//
// Two things happen here, and both are paper bookkeeping, as in src/agents/watchPaperTrade.ts. An
// announcement of one of the two kinds that passed becomes a PAPER Position short on each coin it
// names, by the kind's rule research/NEWS.md measured: a delisting's is out four hours after the
// announcement with no stop and no target; a Monitoring Tag's has a stop and a target from the
// coin's usual moves and is out within the hour. Each stakes its kind's stake; a tag's, which has a
// stop, is sized by what it would lose there where the app's own paper trades are sized by risk,
// and none is opened past what they may have out together (shared/paperRisk.ts) or on one side on
// coins that move with Bitcoin (shared/paperExposure.ts), or while a losing run of the rules' own
// has them paused (shared/paperPause.ts). And a short of a
// rule's that has closed is stopped and its result settled into the paper account, the way
// pressing Stop on its card would.
//
// And since 6 October 2026, the exit check's EXIT (shared/aiExit.ts), as on the watch's: an open
// short of a rule's has its time limit brought forward, so that it closes at the next minute by the
// engine's own rule and is stopped and settled here like any other. Nothing else about it changes.
// Once the plan's own time has passed, what the plan would have made is written beside how it did
// end.
//
// PAPER IS WRITTEN HERE AS A LITERAL. newsShortExecutor takes no mode and has no way to be given
// one. Nothing in this file mentions the bridge a real order travels over, and
// tests/aiNoLivePath.test.ts reads this file to make sure of both. This app places no short.
//
// EVERY WRITE GOES THROUGH THE ONE QUEUE (src/utils/settingsWrites.ts), on executors read inside it.

/** The executor a rule's short is. Paper, unlevered, and its position is not kept when it stops.
 * Its pair's correlation with Bitcoin, where it was read for it, is written on its mark. */
export function newsShortExecutor(input: {
  id: string
  item: NewsItem
  ticker: string
  pair: SymbolInfo
  nowSec: number
  params: PositionExecutorParams
  btcCorrelation?: number | null
}): ExecutorConfig {
  const { item, ticker, pair } = input
  const tagged = item.category === 'MONITORING_TAG'
  const marked: NewsShortMark = { articleId: item.id, ticker, releaseSec: item.releaseSec, title: item.title, category: tagged ? 'MONITORING_TAG' : 'DELISTING' }
  const mark: NewsShortMark = input.btcCorrelation === undefined ? marked : { ...marked, btcCorrelation: input.btcCorrelation }
  return {
    id: input.id,
    name: `${tagged ? 'Monitoring Tag' : 'Delisting'} short · ${pair.symbol}`,
    type: 'position',
    exchange: 'binance',
    symbol: pair.symbol,
    baseAsset: pair.baseAsset,
    quoteAsset: pair.quoteAsset,
    createdAt: input.nowSec,
    status: 'active',
    stoppedAt: null,
    keepPosition: false,
    mode: 'paper',
    newsRule: mark,
    liveOrder: null,
    pendingLiveOrderIds: [],
    liveWatcherId: null,
    liveWatcherError: null,
    liveExitResult: null,
    liveDcaBasePrice: null,
    liveTwapRunId: null,
    liveTwapResult: null,
    params: input.params
  }
}

export interface NewsShortDeps {
  getSettings: () => Promise<Pick<AppSettings, 'executors' | 'paperAccount' | 'paperRisk' | 'paperPause'>>
  setExecutors: (executors: ExecutorConfig[]) => Promise<void>
  /** Binance's spot pairs: a coin with no USDT pair has nothing to short. */
  listPairs: () => Promise<SymbolInfo[]>
  /** 1-minute candles of [startSec, endSec]. */
  fetchCandles: (exchange: Exchange, symbol: string, startSec: number, endSec: number) => Promise<Candle[]>
  /** The pair's hourly moves over the last week against Bitcoin's (shared/paperExposure.ts), or
   * null when they cannot be read: it then counts as a pair that tracks Bitcoin. */
  btcCorrelation: (exchange: Exchange, symbol: string) => Promise<number | null>
  /** Books a stopped paper executor's result into the paper account. */
  settle: (executor: ExecutorConfig, nowSec: number) => Promise<unknown>
  notify: (title: string, body: string) => void
  nowSec: () => number
  newId: () => string
  /** Runs a read-modify-write of settings with no other one inside it. */
  queue: <T>(work: () => Promise<T>) => Promise<T>
}

/** Opens the rule's paper short on each coin an announcement names, where it is switched on for
 * its kind and the rule allows. One line per coin, saying what came of it. Never throws for a short
 * it decides not to open; that is a result. */
export async function openNewsShorts(item: NewsItem, actions: Pick<NewsKindActions, 'paperShort'>, deps: NewsShortDeps): Promise<string[]> {
  if (!actions.paperShort.enabled || (item.category !== 'DELISTING' && item.category !== 'MONITORING_TAG')) return []
  const stake = actions.paperShort.stakeQuote
  const pairs = await deps.listPairs()
  const lines: string[] = []
  for (const ticker of item.tickers) {
    const pair = pairs.find((entry) => entry.baseAsset === ticker && entry.quoteAsset === 'USDT')
    if (pair === undefined) {
      lines.push(`${ticker}: no paper short, as it has no USDT pair on Binance.`)
      continue
    }
    // A tag's stop and target are the coin's own usual move, read before the announcement.
    let sigma15Pct: number | null = null
    if (item.category === 'MONITORING_TAG') {
      const span = tagReadingWindow(item.releaseSec)
      try {
        sigma15Pct = tagReading(await deps.fetchCandles('binance', pair.symbol, span.startSec, span.endSec), item.releaseSec)?.sigma15Pct ?? null
      } catch {
        sigma15Pct = null
      }
      if (sigma15Pct === null) {
        lines.push(`${ticker}: no paper short, as its usual moves could not be read from its candles before the announcement.`)
        continue
      }
    }
    // Whether the pair moves with Bitcoin, for what the app's trades have out on one side of it.
    let btcCorrelation: number | null = null
    try {
      btcCorrelation = await deps.btcCorrelation('binance', pair.symbol)
    } catch {
      btcCorrelation = null
    }
    const outcome = await deps.queue(async (): Promise<{ opened: number } | { refused: string }> => {
      const fresh = await deps.getSettings()
      const nowSec = deps.nowSec()
      // The rule's own limits, then the losing run that pauses the app's own paper trades
      // (shared/paperPause.ts): the news rules' shorts are judged on their own record.
      const blocked =
        newsShortBlock({ item, ticker, nowSec, executors: fresh.executors }) ??
        paperPauseBlock({ setting: healPaperPause(fresh.paperPause), executors: fresh.executors, source: 'news' })
      if (blocked !== null) return { refused: blocked }
      const drafted =
        sigma15Pct === null
          ? delistingShortParams({ releaseSec: item.releaseSec, createdAt: nowSec, stakeQuote: stake })
          : tagShortParams({ sigma15Pct, stakeQuote: stake })
      // A tag's short has a stop, and is sized by what it would lose there where that is how the
      // app's own paper trades are sized; a delisting's has none, and stakes its stake.
      const risk = healPaperRisk(fresh.paperRisk)
      const size = sizePaperTrade({ risk, stakeQuote: stake, stopPct: drafted.stopLossPct, quoteAsset: pair.quoteAsset })
      if (!size.ok) return { refused: size.reason }
      const params: PositionExecutorParams = { ...drafted, amountQuote: size.amountQuote }
      const problem =
        describeExecutorFunding({
          account: fresh.paperAccount ?? null,
          executors: fresh.executors,
          mode: 'paper',
          quoteAsset: pair.quoteAsset,
          amountQuote: params.amountQuote
        }) ??
        paperOutBlock({ risk, executors: fresh.executors, quoteAsset: pair.quoteAsset, amountQuote: params.amountQuote }) ??
        correlatedExposureBlock({
          account: fresh.paperAccount ?? null,
          risk,
          executors: fresh.executors,
          quoteAsset: pair.quoteAsset,
          side: params.side,
          amountQuote: params.amountQuote,
          correlation: btcCorrelation
        })
      if (problem !== null) return { refused: problem }
      const executor = newsShortExecutor({ id: deps.newId(), item, ticker, pair, nowSec, params, btcCorrelation })
      await deps.setExecutors([...fresh.executors, executor])
      const notice = newsShortNotice(item, ticker, params, pair.quoteAsset)
      try {
        deps.notify(notice.title, notice.body)
      } catch {
        // A desktop that cannot show it is not a reason to report a short that was opened as not.
      }
      return { opened: params.amountQuote }
    })
    lines.push('opened' in outcome ? `${ticker}: a paper short of ${outcome.opened} ${pair.quoteAsset} was opened.` : `${ticker}: no paper short. ${outcome.refused}`)
  }
  return lines
}

/** Stops and settles each of the rules' paper shorts whose position has closed -- by its clock,
 * or a tag's by its stop or target. Judged on minutes that have closed; settled once, by the pass
 * that finds it still active inside the queue; how it ended is written on its mark in the same
 * write. Returns the names of the ones it settled. */
export async function settleNewsShorts(deps: NewsShortDeps): Promise<string[]> {
  const settled: string[] = []
  const { executors } = await deps.getSettings()
  await measureNewsExitPlans(executors, deps)
  for (const executor of newsShortExecutors(executors).filter((entry) => entry.status === 'active')) {
    try {
      const nowSec = deps.nowSec()
      const candles = (await deps.fetchCandles(executor.exchange, executor.symbol, executor.createdAt, nowSec)).filter((bar) => bar.time + 60 <= nowSec)
      if (candles.length === 0) continue
      const state = runExecutorSimulation(candles, executor, candles[0].close)
      if (state.kind !== 'position' || state.status !== 'closed' || state.exitReason === null) continue
      // One the exit check's time limit ended is the check's exit.
      const result = { exit: aiExitOutcome(state.exitReason, executor.newsRule?.aiExit), pnlQuote: state.realizedPnl ?? 0, closedAt: state.closedAt ?? nowSec }
      const stopped = await deps.queue(async (): Promise<boolean> => {
        const fresh = await deps.getSettings()
        const current = fresh.executors.find((entry) => entry.id === executor.id)
        if (current?.status !== 'active' || current.newsRule === undefined) return false
        const ended: ExecutorConfig = { ...current, status: 'stopped', stoppedAt: nowSec, newsRule: { ...current.newsRule, result } }
        await deps.setExecutors(fresh.executors.map((entry) => (entry.id === executor.id ? ended : entry)))
        return true
      })
      if (!stopped) continue
      await deps.settle(executor, nowSec)
      settled.push(executor.name)
    } catch (failure) {
      // One short whose candles could not be read is tried again next minute; the others go on.
      console.error(`The news reader could not settle its paper short "${executor.name}":`, failure)
    }
  }
  return settled
}

/** What the plan of each short the exit check closed would have made, once the plan's own time limit
 * has passed, written on its mark beside how it did end: as on the watch's
 * (src/agents/watchPaperTrade.ts). */
async function measureNewsExitPlans(executors: ExecutorConfig[], deps: NewsShortDeps): Promise<void> {
  for (const executor of newsShortExecutors(executors)) {
    const mark = executor.newsRule?.aiExit
    if (executor.status !== 'stopped' || mark === undefined || mark.plan !== undefined || executor.newsRule?.result === undefined) continue
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
        const current = newsShortExecutors(fresh.executors).find((entry) => entry.id === executor.id)
        if (current?.newsRule?.aiExit === undefined || current.newsRule.aiExit.plan !== undefined) return
        const measured: ExecutorConfig = { ...current, newsRule: { ...current.newsRule, aiExit: { ...current.newsRule.aiExit, plan: result } } }
        await deps.setExecutors(fresh.executors.map((entry) => (entry.id === executor.id ? measured : entry)))
      })
    } catch (failure) {
      // Its minutes are read again next minute.
      console.error(`The news reader could not measure the plan of "${executor.name}":`, failure)
    }
  }
}

/** Closes one of the rules' open paper shorts at the next minute, on the exit check's EXIT, as on the
 * watch's (src/agents/watchPaperTrade.ts): its time limit is brought forward (shared/aiExit.ts) and
 * nothing else is touched, and its time is never made longer. Only one of the rules' own paper
 * shorts still open, read inside the queue. Returns whether it was brought forward. */
export async function exitNewsShort(order: AiExitOrder, deps: Pick<NewsShortDeps, 'getSettings' | 'setExecutors' | 'nowSec' | 'queue'>): Promise<boolean> {
  return deps.queue(async (): Promise<boolean> => {
    const fresh = await deps.getSettings()
    const current = newsShortExecutors(fresh.executors).find((entry) => entry.id === order.executorId)
    if (current?.status !== 'active' || current.newsRule === undefined || current.newsRule.aiExit !== undefined) return false
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
    const closing: ExecutorConfig = { ...current, params: written.params, newsRule: { ...current.newsRule, aiExit: written.mark } }
    await deps.setExecutors(fresh.executors.map((entry) => (entry.id === current.id ? closing : entry)))
    return true
  })
}

/** The same, against the running app. */
export const newsShortBrowserDeps: NewsShortDeps = {
  getSettings: () => window.api.settings.get(),
  setExecutors: async (executors) => {
    await window.api.settings.set({ executors })
  },
  listPairs: () => window.api.market.listSymbols('binance'),
  fetchCandles: async (exchange, symbol, startSec, endSec) => (await window.api.market.fetchHistoricalRange(exchange, symbol, '1m', startSec, endSec)).candles,
  btcCorrelation: (exchange, symbol) =>
    readBtcCorrelation(
      async (from, pair, startSec, endSec) => (await window.api.market.fetchHistoricalRange(from, pair, '1h', startSec, endSec)).candles,
      exchange,
      symbol,
      Math.floor(Date.now() / 1000)
    ),
  // Not kept in Inventory (keepPosition is false), so nothing was handed over and the whole
  // result is cash.
  settle: (executor, nowSec) => settleExecutorOnStop({ executor, handedOver: { held: null, realizedPnl: 0 }, now: nowSec }),
  notify: (title, body) => void window.api.notify(title, body).catch(() => undefined),
  nowSec: () => Math.floor(Date.now() / 1000),
  newId: () => crypto.randomUUID(),
  queue: (work) => settingsWrites(work)
}
