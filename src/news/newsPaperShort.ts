import type { NewsConfig, NewsItem } from '../../shared/news'
import { delistingShortBlock, delistingShortNotice, delistingShortParams, newsShortExecutors, type NewsShortMark } from '../../shared/newsActions'
import type { AppSettings, Candle, Exchange, ExecutorConfig, SymbolInfo } from '../../shared/ipc'
import { describeExecutorFunding } from '../account/executorFunding'
import { settleExecutorOnStop } from '../account/settleExecutor'
import { runExecutorSimulation } from '../executors/engine'
import { settingsWrites } from '../utils/settingsWrites'

// THE ONE FILE THAT WRITES WHAT THE NEWS DOES (shared/newsActions.ts has the rules).
//
// Two things happen here, and both are paper bookkeeping, as in src/agents/watchPaperTrade.ts. A
// delisting Binance has just announced becomes a PAPER Position short on each coin it names, by the
// rule research/NEWS.md measured -- out four hours after the announcement, no stop, no target. And
// a short of the rule's that has closed is stopped and its result settled into the paper account,
// the way pressing Stop on its card would.
//
// PAPER IS WRITTEN HERE AS A LITERAL. newsShortExecutor takes no mode and has no way to be given
// one. Nothing in this file mentions the bridge a real order travels over, and
// tests/aiNoLivePath.test.ts reads this file to make sure of both. This app places no short.
//
// EVERY WRITE GOES THROUGH THE ONE QUEUE (src/utils/settingsWrites.ts), on executors read inside it.

/** The executor the rule's short is. Paper, unlevered, and its position is not kept when it stops. */
export function newsShortExecutor(input: { id: string; item: NewsItem; ticker: string; pair: SymbolInfo; stakeQuote: number; nowSec: number }): ExecutorConfig {
  const { item, ticker, pair } = input
  const mark: NewsShortMark = { articleId: item.id, ticker, releaseSec: item.releaseSec, title: item.title }
  return {
    id: input.id,
    name: `Delisting short · ${pair.symbol}`,
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
    params: delistingShortParams({ releaseSec: item.releaseSec, createdAt: input.nowSec, stakeQuote: input.stakeQuote })
  }
}

export interface NewsShortDeps {
  getSettings: () => Promise<Pick<AppSettings, 'executors' | 'paperAccount'>>
  setExecutors: (executors: ExecutorConfig[]) => Promise<void>
  /** Binance's spot pairs: a coin with no USDT pair has nothing to short. */
  listPairs: () => Promise<SymbolInfo[]>
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

/** Opens the rule's paper short on each coin a delisting names, where it is switched on and the
 * rule allows. One line per coin, saying what came of it. Never throws for a short it decides not
 * to open; that is a result. */
export async function openDelistingShorts(item: NewsItem, config: Pick<NewsConfig, 'paperShort'>, deps: NewsShortDeps): Promise<string[]> {
  if (!config.paperShort.enabled || item.category !== 'DELISTING') return []
  const pairs = await deps.listPairs()
  const lines: string[] = []
  for (const ticker of item.tickers) {
    const pair = pairs.find((entry) => entry.baseAsset === ticker && entry.quoteAsset === 'USDT')
    if (pair === undefined) {
      lines.push(`${ticker}: no paper short, as it has no USDT pair on Binance.`)
      continue
    }
    const refused = await deps.queue(async (): Promise<string | null> => {
      const fresh = await deps.getSettings()
      const nowSec = deps.nowSec()
      const problem =
        delistingShortBlock({ item, ticker, nowSec, executors: fresh.executors }) ??
        describeExecutorFunding({
          account: fresh.paperAccount ?? null,
          executors: fresh.executors,
          mode: 'paper',
          quoteAsset: pair.quoteAsset,
          amountQuote: config.paperShort.stakeQuote
        })
      if (problem !== null) return problem
      const executor = newsShortExecutor({ id: deps.newId(), item, ticker, pair, stakeQuote: config.paperShort.stakeQuote, nowSec })
      await deps.setExecutors([...fresh.executors, executor])
      const notice = delistingShortNotice(item, ticker, executor.params as ReturnType<typeof delistingShortParams>, pair.quoteAsset)
      try {
        deps.notify(notice.title, notice.body)
      } catch {
        // A desktop that cannot show it is not a reason to report a short that was opened as not.
      }
      return null
    })
    lines.push(refused === null ? `${ticker}: a paper short of ${config.paperShort.stakeQuote} USDT was opened.` : `${ticker}: no paper short. ${refused}`)
  }
  return lines
}

/** Stops and settles each of the rule's paper shorts whose position has closed -- its clock ends
 * it four hours after the announcement. Judged on minutes that have closed; settled once, by the
 * pass that finds it still active inside the queue; how it ended is written on its mark in the
 * same write. Returns the names of the ones it settled. */
export async function settleNewsShorts(deps: NewsShortDeps): Promise<string[]> {
  const settled: string[] = []
  const { executors } = await deps.getSettings()
  for (const executor of newsShortExecutors(executors).filter((entry) => entry.status === 'active')) {
    try {
      const nowSec = deps.nowSec()
      const candles = (await deps.fetchCandles(executor.exchange, executor.symbol, executor.createdAt, nowSec)).filter((bar) => bar.time + 60 <= nowSec)
      if (candles.length === 0) continue
      const state = runExecutorSimulation(candles, executor, candles[0].close)
      if (state.kind !== 'position' || state.status !== 'closed' || state.exitReason === null) continue
      const result = { exit: state.exitReason, pnlQuote: state.realizedPnl ?? 0, closedAt: state.closedAt ?? nowSec }
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

/** The same, against the running app. */
export const newsShortBrowserDeps: NewsShortDeps = {
  getSettings: () => window.api.settings.get(),
  setExecutors: async (executors) => {
    await window.api.settings.set({ executors })
  },
  listPairs: () => window.api.market.listSymbols('binance'),
  fetchCandles: async (exchange, symbol, startSec, endSec) => (await window.api.market.fetchHistoricalRange(exchange, symbol, '1m', startSec, endSec)).candles,
  // Not kept in Inventory (keepPosition is false), so nothing was handed over and the whole
  // result is cash.
  settle: (executor, nowSec) => settleExecutorOnStop({ executor, handedOver: { held: null, realizedPnl: 0 }, now: nowSec }),
  notify: (title, body) => void window.api.notify(title, body).catch(() => undefined),
  nowSec: () => Math.floor(Date.now() / 1000),
  newId: () => crypto.randomUUID(),
  queue: (work) => settingsWrites(work)
}
