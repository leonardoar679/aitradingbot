import type { AppSettings, Candle, ExecutorConfig, PositionExecutorParams } from '../../shared/ipc'
import { DELISTING_STUDY } from '../../shared/delistingStudy'
import { delistingFiguresOf } from '../../shared/forecast/primaryCall'
import { liquidityVerdictOf } from '../../shared/liquidityGate'
import { MISS_VERSION, type MissRecord, type MissStage } from '../../shared/misses'
import type { NewsItem } from '../../shared/news'
import { DELISTING_RULE_EXIT_MINUTES, DELISTING_SHORT_LATEST_SECONDS, TAG_RULE_HOLD_MINUTES, TAG_RULE_STOP_SIGMAS, TAG_RULE_TARGET_SIGMAS, tagReading, tagReadingWindow, tagShortWindow } from '../../shared/newsActions'
import { NEWS_BOOK_LINES, assumedFundingAgainst, newsBookExitOf, newsBookFundingOf, newsBookResultOf, type NewsBookCloseReason, type NewsBookStamp } from '../../shared/newsBook'
import { bookExecutors, bookRoomProblem, healPaperBooks, type BookMark, type BookStanding } from '../../shared/paperBooks'
import type { FundingRate } from '../../shared/traders/delay'
import { settingsWrites } from '../utils/settingsWrites'

// THE NEWS BOOK'S SHORTS, ON PAPER (V8 Stage 9, 27 October 2026). While paper testing runs, an announcement the news
// rule acts on -- a Binance delisting within its five minutes, a Monitoring Tag in its second minute where the tag's
// short is switched on -- is shorted in the news book, on each coin it names, as the plan costs a short
// (shared/newsBook.ts): on the coin's USDT perpetual, Binance's first and Bitget's where Binance lists none, at the
// perpetual's price, staking the most the book lets one trade stake, through the book's room and the liquidity gate on
// the perpetual's book. A delisting's short leaves at the open four hours after the announcement's minute, as the study
// measured it; a tag's at its stop, its target or the close of its sixtieth minute, its bracket read from the
// perpetual's own usual fifteen-minute move; either at the loss of its whole stake. Its result -- the move, both taker
// fees, the funding the perpetual published over its hold -- is written on its book's mark. A short refused is a missed
// opportunity with why, carrying the announcement's and coin's key; a coin no venue lists a perpetual of is one no venue
// could take: missed, with that reason, and scored apart.
//
// PAPER IS WRITTEN HERE AS A LITERAL. newsBookPaperExecutor takes no mode and has no way to be given one. Nothing in
// this file mentions the bridge a real order travels over, and tests/aiNoLivePath.test.ts reads this file to make sure
// of both. The news book never trades.
//
// EVERY WRITE GOES THROUGH THE ONE QUEUE (src/utils/settingsWrites.ts), on executors read inside it.

type PerpVenue = 'binance' | 'bitget'

export interface NewsBookDeps {
  getSettings: () => Promise<Pick<AppSettings, 'executors' | 'paperBooks'>>
  setExecutors: (executors: ExecutorConfig[]) => Promise<void>
  queue: <T>(work: () => Promise<T>) => Promise<T>
  /** The news book's standing as the books keep it. */
  newsStanding: () => Promise<BookStanding | null>
  perpOf: (coin: string) => Promise<{ venue: PerpVenue; symbol: string } | null>
  perpPrice: (venue: PerpVenue, symbol: string) => Promise<number>
  perpBook: (venue: PerpVenue, symbol: string) => Promise<{ bids: [number, number][]; asks: [number, number][]; atMs: number }>
  perpBars: (venue: PerpVenue, symbol: string, fromSec: number, toSec: number) => Promise<Candle[]>
  perpFunding: (venue: PerpVenue, symbol: string, fromSec: number, toSec: number) => Promise<FundingRate[]>
  miss: (miss: MissRecord) => Promise<unknown>
  nowMs: () => number
  newId: () => string
}

/** The news book's shorts on file: paper Positions carrying its mark. */
export function newsBookExecutors(executors: readonly ExecutorConfig[]): ExecutorConfig[] {
  return executors.filter((executor) => executor.newsBook !== undefined && executor.mode === 'paper' && executor.type === 'position')
}

/** A short's executor: paper, unlevered, in the news book, its parameters those of its entry. */
export function newsBookPaperExecutor(input: { id: string; stamp: NewsBookStamp; book: BookMark; nowSec: number }): ExecutorConfig {
  const { stamp } = input
  const params: PositionExecutorParams = {
    side: 'sell',
    entryPrice: stamp.entryPx,
    amountQuote: stamp.stakeQuote,
    takeProfitPct: stamp.targetPx === null ? null : (1 - stamp.targetPx / stamp.entryPx) * 100,
    stopLossPct: stamp.stopPx === null ? null : (stamp.stopPx / stamp.entryPx - 1) * 100,
    timeLimitSec: Math.max(60, stamp.exitAtSec - input.nowSec),
    trailingStop: null,
    feeRate: NEWS_BOOK_LINES.takerPct[stamp.venue] / 100
  }
  return {
    id: input.id,
    name: `${stamp.category === 'MONITORING_TAG' ? 'Monitoring Tag' : 'Delisting'} short · ${stamp.ticker} (news book)`,
    type: 'position',
    exchange: stamp.venue,
    symbol: stamp.symbol,
    baseAsset: stamp.ticker,
    quoteAsset: 'USDT',
    createdAt: input.nowSec,
    status: 'active',
    stoppedAt: null,
    keepPosition: false,
    mode: 'paper',
    book: input.book,
    newsBook: stamp,
    liveOrder: null,
    pendingLiveOrderIds: [],
    liveWatcherId: null,
    liveWatcherError: null,
    liveExitResult: null,
    liveDcaBasePrice: null,
    liveTwapRunId: null,
    liveTwapResult: null,
    params
  }
}

/** The key a short of a coin of an announcement is acted on under, once. */
export const newsBookKeyOf = (item: Pick<NewsItem, 'id'>, ticker: string): string => `news:${item.id}:${ticker}`

/** Why the rule takes no short of this announcement now, by its timing; null where it may. */
function timingProblem(item: NewsItem, nowSec: number): string | null {
  if (item.category === 'DELISTING' && nowSec - item.releaseSec > DELISTING_SHORT_LATEST_SECONDS) return 'announced more than five minutes ago: a short now is not the trade that was measured'
  if (item.category === 'MONITORING_TAG') {
    const opens = tagShortWindow(item.releaseSec)
    if (nowSec < opens.fromSec) return 'too soon: the rule enters at the second minute after the announcement'
    if (nowSec > opens.toSec) return 'too late to enter at the second minute after the announcement, the trade that was measured'
  }
  return null
}

/** The announcement's shorts, one a coin it names: each entered in the news book, or missed with why. One line a coin. */
export async function openNewsBookShorts(item: NewsItem, deps: NewsBookDeps): Promise<string[]> {
  if (item.category !== 'DELISTING' && item.category !== 'MONITORING_TAG') return []
  const lines: string[] = []
  for (const ticker of item.tickers) lines.push(`${ticker}: ${await openOne(item, ticker, deps)}`)
  return lines
}

async function openOne(item: NewsItem, ticker: string, deps: NewsBookDeps): Promise<string> {
  const eventKey = newsBookKeyOf(item, ticker)
  const nowMs = deps.nowMs()
  const nowSec = Math.floor(nowMs / 1000)
  const missOf = (stage: MissStage, reason: string, pair: string, refPrice: number | null): MissRecord => ({
    v: MISS_VERSION,
    at: nowSec,
    book: 'news',
    writer: 'news-rule',
    pair,
    side: 'down',
    refPrice,
    stage,
    reason,
    predictionId: null,
    shadow: false,
    eventKey
  })
  const missed = async (stage: MissStage, reason: string, pair: string, refPrice: number | null = null): Promise<string> => {
    await deps.miss(missOf(stage, reason, pair, refPrice)).catch((error) => console.error('A missed news short could not be recorded:', error))
    return `missed: ${reason}`
  }
  const timing = timingProblem(item, nowSec)
  if (timing !== null) return missed('late', timing, `${ticker}USDT`)
  const perp = await deps.perpOf(ticker).catch(() => null)
  if (perp === null) return missed('gate', `No venue could take this: neither Binance nor Bitget lists a USDT perpetual of ${ticker}.`, `${ticker}USDT`)
  const px = await deps.perpPrice(perp.venue, perp.symbol).catch(() => null)
  if (px === null || !(px > 0)) return missed('gate', "the perpetual's price could not be read", perp.symbol)
  const announcementMinute = Math.floor(item.releaseSec / 60) * 60
  let stopPx: number | null = null
  let targetPx: number | null = null
  let predictedMovePct: number
  let exitAtSec: number
  if (item.category === 'MONITORING_TAG') {
    const span = tagReadingWindow(item.releaseSec)
    const bars = await deps.perpBars(perp.venue, perp.symbol, span.startSec, span.endSec).catch(() => null)
    const sigma = bars === null ? null : (tagReading(bars, item.releaseSec)?.sigma15Pct ?? null)
    if (sigma === null || !(sigma > 0)) return missed('gate', "its usual moves could not be read from its perpetual's bars before the announcement", perp.symbol, px)
    stopPx = px * (1 + (TAG_RULE_STOP_SIGMAS * sigma) / 100)
    targetPx = px * (1 - (TAG_RULE_TARGET_SIGMAS * sigma) / 100)
    predictedMovePct = TAG_RULE_TARGET_SIGMAS * sigma
    // In at the second minute after the announcement's, out at the close of its sixtieth.
    exitAtSec = announcementMinute + 120 + TAG_RULE_HOLD_MINUTES * 60
  } else {
    predictedMovePct = delistingFiguresOf(DELISTING_STUDY.coins).medianGrossPct
    exitAtSec = announcementMinute + DELISTING_RULE_EXIT_MINUTES * 60
  }
  const standing = await deps.newsStanding().catch(() => null)
  const book = await deps.perpBook(perp.venue, perp.symbol).catch(() => null)
  let miss: MissRecord | null = null
  const outcome = await deps.queue(async (): Promise<string> => {
    const fresh = await deps.getSettings()
    if (newsBookExecutors(fresh.executors).some((executor) => executor.newsBook?.articleId === item.id && executor.newsBook.ticker === ticker)) return 'already entered'
    const refuse = (stage: MissStage, reason: string): string => {
      miss = missOf(stage, reason, perp.symbol, px)
      return `missed: ${reason}`
    }
    if (standing === null) return refuse('cap', "the news book's standing could not be read")
    const books = healPaperBooks(fresh.paperBooks)
    const open = bookExecutors(fresh.executors, 'news', books.startedAt ?? 0).filter((executor) => executor.status === 'active')
    const stakeQuote = books.books.news.maxStakeShare * standing.settledEquity
    const problem = bookRoomProblem({ books, id: 'news', standing: { ...standing, open: open.length }, stakeQuote, dayStartEquity: standing.dayStartEquity })
    if (problem !== null) return refuse(books.running ? 'cap' : 'off', problem)
    const verdict = liquidityVerdictOf({ venue: perp.venue, feePct: NEWS_BOOK_LINES.takerPct[perp.venue], side: 'SELL', stakeQuote, levels: book, bookAgeMs: book === null ? null : deps.nowMs() - book.atMs, predictedMovePct })
    if (!verdict.ok) return refuse('liquidity', verdict.reason)
    const qty = stakeQuote / px
    const stamp: NewsBookStamp = {
      articleId: item.id,
      ticker,
      category: item.category as NewsBookStamp['category'],
      releaseSec: item.releaseSec,
      title: item.title.slice(0, 200),
      venue: perp.venue,
      symbol: perp.symbol,
      entryPx: px,
      qty,
      stakeQuote,
      feesQuote: (NEWS_BOOK_LINES.takerPct[perp.venue] / 100) * stakeQuote,
      openedAtMs: nowMs,
      stopPx,
      targetPx,
      exitAtSec,
      closeReason: null,
      exitPx: null
    }
    const mark: BookMark = { id: 'news', startedAt: books.startedAt as number, ledger: 'rule' }
    await deps.setExecutors([...fresh.executors, newsBookPaperExecutor({ id: deps.newId(), stamp, book: mark, nowSec })])
    return `entered short ${ticker} at ${px} on ${perp.venue === 'binance' ? 'Binance' : 'Bitget'} ${perp.symbol}`
  })
  if (miss !== null) await deps.miss(miss).catch((error) => console.error('A missed news short could not be recorded:', error))
  return outcome
}

/** One short closed at an exit: its result on its book's mark, the funding its perpetual published over its hold (an
 * assumed rate against it where none could be read). In the queue, once: a short already given a result is left. */
async function closeShort(executor: ExecutorConfig, exit: { reason: NewsBookCloseReason; px: number; atSec: number }, deps: NewsBookDeps): Promise<boolean> {
  const stamp = executor.newsBook as NewsBookStamp
  const rates = await deps.perpFunding(stamp.venue, stamp.symbol, Math.floor(stamp.openedAtMs / 1000) - 8 * 3600, exit.atSec).catch(() => null)
  const fundingQuote = rates === null ? assumedFundingAgainst(stamp.stakeQuote, stamp.openedAtMs, exit.atSec * 1000) : newsBookFundingOf(stamp, rates, exit.atSec * 1000)
  const result = newsBookResultOf(stamp, exit, fundingQuote)
  return deps.queue(async (): Promise<boolean> => {
    const fresh = await deps.getSettings()
    const current = fresh.executors.find((entry) => entry.id === executor.id)
    if (current?.newsBook === undefined || current.book?.result !== undefined) return false
    const ended: ExecutorConfig = {
      ...current,
      status: 'stopped',
      stoppedAt: current.stoppedAt ?? exit.atSec,
      newsBook: { ...current.newsBook, closeReason: exit.reason, exitPx: exit.px },
      book: { ...(current.book as BookMark), result }
    }
    await deps.setExecutors(fresh.executors.map((entry) => (entry.id === executor.id ? ended : entry)))
    return true
  })
}

/** Each open short closed where its perpetual's closed minutes say it left -- its stop, its target, the loss of its
 * stake, its hold -- and each stopped elsewhere given its result at the price then. Returns the names of those closed. */
export async function settleNewsBookShorts(deps: NewsBookDeps): Promise<string[]> {
  const { executors } = await deps.getSettings()
  const done: string[] = []
  for (const executor of newsBookExecutors(executors)) {
    const stamp = executor.newsBook as NewsBookStamp
    const stoppedElsewhere = executor.status === 'stopped' && executor.book?.result === undefined
    if (executor.status !== 'active' && !stoppedElsewhere) continue
    const nowSec = Math.floor(deps.nowMs() / 1000)
    let exit: { reason: NewsBookCloseReason; px: number; atSec: number } | null = null
    if (stoppedElsewhere) {
      const px = await deps.perpPrice(stamp.venue, stamp.symbol).catch(() => null)
      if (px === null) continue
      exit = { reason: 'stopped', px, atSec: nowSec }
    } else {
      const fromSec = Math.floor(stamp.openedAtMs / 60_000) * 60
      const bars = await deps.perpBars(stamp.venue, stamp.symbol, fromSec, Math.min(nowSec, fromSec + 86_400)).catch(() => null)
      if (bars === null) continue
      exit = newsBookExitOf(
        stamp,
        bars.filter((bar) => bar.time + 60 <= nowSec)
      )
    }
    if (exit === null) continue
    if (await closeShort(executor, exit, deps)) done.push(executor.name)
  }
  return done
}

/** Every open short closed now at its perpetual's price, as stopped: paper testing was stopped. */
export async function closeNewsBookShorts(deps: NewsBookDeps): Promise<string[]> {
  const { executors } = await deps.getSettings()
  const done: string[] = []
  for (const executor of newsBookExecutors(executors).filter((entry) => entry.status === 'active')) {
    const stamp = executor.newsBook as NewsBookStamp
    const px = await deps.perpPrice(stamp.venue, stamp.symbol).catch(() => null)
    if (px === null) continue
    if (await closeShort(executor, { reason: 'stopped', px, atSec: Math.floor(deps.nowMs() / 1000) }, deps)) done.push(executor.name)
  }
  return done
}

/** The same, against the running app. */
export const newsBookBrowserDeps: NewsBookDeps = {
  getSettings: () => window.api.settings.get(),
  setExecutors: async (executors) => {
    await window.api.settings.set({ executors })
  },
  queue: (work) => settingsWrites(work),
  newsStanding: async () => (await window.api.books.state()).standings.find((standing) => standing.id === 'news') ?? null,
  perpOf: (coin) => window.api.traders.perpOf(coin),
  perpPrice: (venue, symbol) => window.api.traders.perpPrice(venue, symbol),
  perpBook: (venue, symbol) => window.api.traders.perpBook(venue, symbol),
  perpBars: (venue, symbol, fromSec, toSec) => window.api.traders.perpBars(venue, symbol, fromSec, toSec),
  perpFunding: (venue, symbol, fromSec, toSec) => window.api.traders.perpFunding(venue, symbol, fromSec, toSec),
  miss: (miss) => window.api.books.miss(miss),
  nowMs: () => Date.now(),
  newId: () => crypto.randomUUID()
}
