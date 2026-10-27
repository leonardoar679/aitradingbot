import type { AppSettings, Candle, ExecutorConfig, PositionExecutorParams } from '../../shared/ipc'
import { BASELINE_BAR_SEC, BASELINE_LINES, baselineExitOf, baselineFreshAt, baselineResultOf, type BaselineCloseReason, type BaselineStamp } from '../../shared/baseline'
import { liquidityVerdictOf } from '../../shared/liquidityGate'
import { MISS_VERSION, type MissRecord, type MissStage } from '../../shared/misses'
import { bookExecutors, bookRoomProblem, healPaperBooks, type BookMark, type BookStanding } from '../../shared/paperBooks'
import { trendRegimeEnsemble } from '../backtest/strategies/trendRegimeEnsemble'
import { settingsWrites } from '../utils/settingsWrites'

// THE BASELINE BOOK'S TRADES, ON PAPER (V8 Stage 9, 27 October 2026). While paper testing runs, Trend Regime Ensemble
// is read on its eight symbols at each of its 4-hour closes, thirty seconds on (shared/baseline.ts), and traded as it
// was backtested (src/backtest/engine.ts): long on Binance's spot at a close where all four of its lookbacks agree,
// its disaster stop fixed there; out at a bar whose low reaches the stop, or at the close of a bar where at most one
// lookback still does. Each close's exits are read before its entries. It takes only the run's own entries: at a bar
// that closed after the Start, and never on a regime standing at the Start until that regime has broken. One trade a
// symbol at a time, staking the most the book lets one trade stake, through the book's room and the liquidity gate on
// Binance's book. An entry read later than five minutes after its close is not the entry backtested (one at the close)
// and is missed as late; the strategy's position is then joined at the next close it still holds at. A refused entry
// is a missed opportunity with why, once, under its symbol's and bar's key. A trade's result -- its move, the taker fee
// each way; spot pays no funding -- is written on its book's mark.
//
// PAPER IS WRITTEN HERE AS A LITERAL. baselinePaperExecutor takes no mode and has no way to be given one. Nothing in
// this file mentions the bridge a real order travels over, and tests/aiNoLivePath.test.ts reads this file to make sure
// of both. The baseline never trades.
//
// EVERY WRITE GOES THROUGH THE ONE QUEUE (src/utils/settingsWrites.ts), on executors read inside it.

/** An entry read later than this after its bar's close is not the one backtested, an entry at the close: missed as
 * late. */
export const BASELINE_ENTRY_WINDOW_SEC = 300

/** Bars read before the strategy's warm-up, so that the bar a run started in has its signals. */
const SERIES_MARGIN_BARS = 40

type SpotBook = { bids: [number, number][]; asks: [number, number][]; atMs: number }

export interface BaselineDeps {
  getSettings: () => Promise<Pick<AppSettings, 'executors' | 'paperBooks'>>
  setExecutors: (executors: ExecutorConfig[]) => Promise<void>
  queue: <T>(work: () => Promise<T>) => Promise<T>
  /** The baseline book's standing as the books keep it. */
  baselineStanding: () => Promise<BookStanding | null>
  /** A symbol's 4-hour bars from `fromSec` to `toSec`, the one forming among them. */
  bars: (symbol: string, fromSec: number, toSec: number) => Promise<Candle[]>
  /** A symbol's last spot price. */
  price: (symbol: string) => Promise<number>
  /** Binance's spot book of a symbol now. */
  book: (symbol: string) => Promise<SpotBook>
  misses: (sinceSec: number) => Promise<MissRecord[]>
  miss: (miss: MissRecord) => Promise<unknown>
  nowMs: () => number
  newId: () => string
}

/** The baseline book's trades on file: paper Positions carrying its mark. */
export function baselineExecutors(executors: readonly ExecutorConfig[]): ExecutorConfig[] {
  return executors.filter((executor) => executor.baseline !== undefined && executor.mode === 'paper' && executor.type === 'position')
}

/** A trade's executor: paper, long on spot, in the baseline book, its parameters those of its entry. */
export function baselinePaperExecutor(input: { id: string; stamp: BaselineStamp; book: BookMark; nowSec: number }): ExecutorConfig {
  const { stamp } = input
  const params: PositionExecutorParams = {
    side: 'buy',
    entryPrice: stamp.entryPx,
    amountQuote: stamp.stakeQuote,
    takeProfitPct: null,
    stopLossPct: (1 - stamp.stopPx / stamp.entryPx) * 100,
    timeLimitSec: null,
    trailingStop: null,
    feeRate: BASELINE_LINES.takerPct / 100
  }
  return {
    id: input.id,
    name: `Trend Regime Ensemble · ${stamp.symbol} (baseline book)`,
    type: 'position',
    exchange: 'binance',
    symbol: stamp.symbol,
    baseAsset: stamp.symbol.replace(/USDT$/, ''),
    quoteAsset: 'USDT',
    createdAt: input.nowSec,
    status: 'active',
    stoppedAt: null,
    keepPosition: false,
    mode: 'paper',
    book: input.book,
    baseline: stamp,
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

/** The key an entry signal of a symbol at a bar's close is acted on under, once. */
export const baselineKeyOf = (symbol: string, barSec: number): string => `baseline:${symbol}:${barSec}`

/** The open time of the latest bar closed at least `readAfterCloseSec` before `nowSec`: the bar a read then acts on. */
export function baselineDueBarOf(nowSec: number): number {
  return Math.floor((nowSec - BASELINE_LINES.readAfterCloseSec) / BASELINE_BAR_SEC) * BASELINE_BAR_SEC - BASELINE_BAR_SEC
}

/** Where a run's bars are read from: the strategy's warm-up and a margin before the bar the run started in, the same
 * for every read of the run, so that each computes its signals on the same bars. */
export function baselineSeriesFromSec(startedAtSec: number): number {
  const warmup = trendRegimeEnsemble.warmupBarsFor(BASELINE_BAR_SEC)
  return Math.floor(startedAtSec / BASELINE_BAR_SEC) * BASELINE_BAR_SEC - (warmup + SERIES_MARGIN_BARS) * BASELINE_BAR_SEC
}

/** The closed bars of a read, from the series' start, in order, each once. */
function closedBarsOf(bars: readonly Candle[], fromSec: number, nowSec: number): Candle[] {
  const byTime = new Map<number, Candle>()
  for (const bar of bars) if (bar.time >= fromSec && bar.time + BASELINE_BAR_SEC <= nowSec) byTime.set(bar.time, bar)
  return [...byTime.values()].sort((a, b) => a.time - b.time)
}

const utcOf = (sec: number): string => new Date(sec * 1000).toISOString().slice(0, 16).replace('T', ' ')

/** One trade closed at an exit: its result on its book's mark. In the queue, once: a trade already given a result is
 * left. */
async function closeTrade(executor: ExecutorConfig, exit: { reason: BaselineCloseReason; px: number; atSec: number }, deps: BaselineDeps): Promise<boolean> {
  const result = baselineResultOf(executor.baseline as BaselineStamp, exit)
  return deps.queue(async (): Promise<boolean> => {
    const fresh = await deps.getSettings()
    const current = fresh.executors.find((entry) => entry.id === executor.id)
    if (current?.baseline === undefined || current.book?.result !== undefined) return false
    const ended: ExecutorConfig = {
      ...current,
      status: 'stopped',
      stoppedAt: current.stoppedAt ?? exit.atSec,
      baseline: { ...current.baseline, closeReason: exit.reason, exitPx: exit.px },
      book: { ...(current.book as BookMark), result }
    }
    await deps.setExecutors(fresh.executors.map((entry) => (entry.id === executor.id ? ended : entry)))
    return true
  })
}

interface SymbolRead {
  symbol: string
  bars: Candle[]
  signals: ReturnType<typeof trendRegimeEnsemble.generateSignals>
}

/** One read of the baseline at a close: each symbol's bars, its open trades' exits, then its entry. `complete` is false
 * where a symbol's bars, price or book could not be read, so the read is worth making again. One line a symbol. */
export async function readBaseline(deps: BaselineDeps): Promise<{ lines: string[]; complete: boolean }> {
  const settings = await deps.getSettings()
  const books = healPaperBooks(settings.paperBooks)
  if (!books.running || books.startedAt === null) return { lines: [], complete: true }
  const startedAt = books.startedAt
  const nowSec = Math.floor(deps.nowMs() / 1000)
  const due = baselineDueBarOf(nowSec)
  const fromSec = baselineSeriesFromSec(startedAt)
  const lines = new Map<string, string[]>()
  const say = (symbol: string, line: string): void => {
    lines.set(symbol, [...(lines.get(symbol) ?? []), line])
  }
  let complete = true
  const reads: SymbolRead[] = []
  for (const symbol of BASELINE_LINES.symbols) {
    const raw = await deps.bars(symbol, fromSec, nowSec).catch(() => null)
    if (raw === null) {
      complete = false
      say(symbol, 'its bars could not be read')
      continue
    }
    const bars = closedBarsOf(raw, fromSec, nowSec)
    reads.push({ symbol, bars, signals: trendRegimeEnsemble.generateSignals(bars) })
  }

  // The exits first, as the backtest reads a close: a trade's stop or exit signal at a bar since its entry.
  const holding = new Set<string>()
  const stoppedAtDue = new Set<string>()
  const { executors } = await deps.getSettings()
  for (const read of reads) {
    for (const executor of baselineExecutors(executors).filter((entry) => entry.baseline?.symbol === read.symbol)) {
      const stamp = executor.baseline as BaselineStamp
      const stoppedElsewhere = executor.status === 'stopped' && executor.book?.result === undefined
      if (executor.status !== 'active' && !stoppedElsewhere) continue
      let exit: { reason: BaselineCloseReason; px: number; atSec: number } | null = null
      if (stoppedElsewhere) {
        const px = await deps.price(read.symbol).catch(() => null)
        if (px === null || !(px > 0)) {
          complete = false
          continue
        }
        exit = { reason: 'stopped', px, atSec: nowSec }
      } else {
        const found = baselineExitOf(stamp, read.bars, read.signals.exits)
        if (found === null) {
          holding.add(read.symbol)
          continue
        }
        if (found.reason === 'stop' && found.barTime === due) stoppedAtDue.add(read.symbol)
        exit = found
      }
      const how = exit.reason === 'signal' ? 'at its exit signal' : exit.reason === 'stop' ? 'at its stop' : 'as stopped'
      if (await closeTrade(executor, exit, deps)) say(read.symbol, `closed ${how} at ${exit.px}`)
    }
  }

  // Then the entries of the bar that closed: once, the run's own, through the book's room and Binance's book.
  let standing: Promise<BookStanding | null> | null = null
  let missedKeys: Promise<Set<string>> | null = null
  const missOnce = async (miss: MissRecord): Promise<void> => {
    missedKeys ??= deps
      .misses(due + BASELINE_BAR_SEC - 60)
      .then((misses) => new Set(misses.map((entry) => entry.eventKey).filter((key): key is string => key !== undefined)))
      .catch(() => new Set<string>())
    const keys = await missedKeys
    if (miss.eventKey !== undefined && keys.has(miss.eventKey)) return
    if (miss.eventKey !== undefined) keys.add(miss.eventKey)
    await deps.miss(miss).catch((error) => console.error('A missed baseline entry could not be recorded:', error))
  }
  for (const read of reads) {
    const { symbol, bars, signals } = read
    if (holding.has(symbol)) {
      say(symbol, 'holding')
      continue
    }
    const index = bars.findIndex((bar) => bar.time === due)
    if (index < 0) {
      complete = false
      say(symbol, `its bar of ${utcOf(due)} UTC was not among those read`)
      continue
    }
    const stopPx = signals.stopPrices[index]
    if (index < signals.warmupBars || signals.entries[index] !== true || stopPx === null) {
      say(symbol, 'no entry signal')
      continue
    }
    if (stoppedAtDue.has(symbol)) {
      say(symbol, 'stopped out at this close: no entry at it')
      continue
    }
    if (!baselineFreshAt({ bars, entries: signals.entries, warmupBars: signals.warmupBars, index, startedAtSec: startedAt })) {
      say(symbol, "its regime has stood since before the Start: not the run's to take")
      continue
    }
    const eventKey = baselineKeyOf(symbol, due)
    const missOf = (stage: MissStage, reason: string, refPrice: number | null): MissRecord => ({
      v: MISS_VERSION,
      at: nowSec,
      book: 'baseline',
      writer: 'baseline',
      pair: symbol,
      side: 'up',
      refPrice,
      stage,
      reason,
      predictionId: null,
      shadow: false,
      eventKey
    })
    const lagSec = nowSec - (due + BASELINE_BAR_SEC)
    if (lagSec > BASELINE_ENTRY_WINDOW_SEC) {
      await missOnce(missOf('late', `read ${Math.round(lagSec / 60)} minutes after its bar closed: the strategy enters at the close`, bars[index].close))
      say(symbol, 'missed: late')
      continue
    }
    const px = await deps.price(symbol).catch(() => null)
    if (px === null || !(px > 0)) {
      complete = false
      say(symbol, 'its price could not be read')
      continue
    }
    if (!(px > stopPx)) {
      await missOnce(missOf('gate', `its price ${px} is at or under the strategy's stop of ${stopPx}`, px))
      say(symbol, 'missed: under its stop')
      continue
    }
    standing ??= deps.baselineStanding().catch(() => null)
    const held = await standing
    const book = await deps.book(symbol).catch(() => null)
    let miss: MissRecord | null = null
    const outcome = await deps.queue(async (): Promise<string> => {
      const fresh = await deps.getSettings()
      const mine = baselineExecutors(fresh.executors)
      if (mine.some((executor) => executor.baseline?.symbol === symbol && executor.baseline.signalBarSec === due && executor.book?.startedAt === startedAt)) return 'already entered'
      if (mine.some((executor) => executor.baseline?.symbol === symbol && executor.status === 'active')) return 'holding'
      const refuse = (stage: MissStage, reason: string): string => {
        miss = missOf(stage, reason, px)
        return `missed: ${reason}`
      }
      const current = healPaperBooks(fresh.paperBooks)
      if (!current.running || current.startedAt !== startedAt) return refuse('off', 'paper testing was stopped before the entry was made')
      if (held === null) return refuse('cap', "the baseline book's standing could not be read")
      const open = bookExecutors(fresh.executors, 'baseline', startedAt).filter((executor) => executor.status === 'active')
      const stakeQuote = current.books.baseline.maxStakeShare * held.settledEquity
      const problem = bookRoomProblem({ books: current, id: 'baseline', standing: { ...held, open: open.length }, stakeQuote, dayStartEquity: held.dayStartEquity })
      if (problem !== null) return refuse('cap', problem)
      const verdict = liquidityVerdictOf({ venue: 'binance', feePct: BASELINE_LINES.takerPct, side: 'BUY', stakeQuote, levels: book, bookAgeMs: book === null ? null : deps.nowMs() - book.atMs, predictedMovePct: null })
      if (!verdict.ok) return refuse('liquidity', verdict.reason)
      const qty = stakeQuote / px
      const stamp: BaselineStamp = {
        symbol,
        signalBarSec: due,
        entryPx: px,
        qty,
        stakeQuote,
        feesQuote: (BASELINE_LINES.takerPct / 100) * stakeQuote,
        openedAtMs: deps.nowMs(),
        stopPx,
        closeReason: null,
        exitPx: null
      }
      const mark: BookMark = { id: 'baseline', startedAt, ledger: 'baseline' }
      await deps.setExecutors([...fresh.executors, baselinePaperExecutor({ id: deps.newId(), stamp, book: mark, nowSec })])
      return `entered long at ${px}, its stop at ${stopPx}`
    })
    if (miss !== null) await missOnce(miss)
    say(symbol, outcome)
  }
  return { lines: BASELINE_LINES.symbols.filter((symbol) => lines.has(symbol)).map((symbol) => `${symbol}: ${(lines.get(symbol) as string[]).join(', ')}`), complete }
}

/** Every open baseline trade closed now at its spot price, as stopped: paper testing was stopped. */
export async function closeBaselineTrades(deps: BaselineDeps): Promise<string[]> {
  const { executors } = await deps.getSettings()
  const done: string[] = []
  for (const executor of baselineExecutors(executors).filter((entry) => entry.status === 'active')) {
    const stamp = executor.baseline as BaselineStamp
    const px = await deps.price(stamp.symbol).catch(() => null)
    if (px === null || !(px > 0)) continue
    if (await closeTrade(executor, { reason: 'stopped', px, atSec: Math.floor(deps.nowMs() / 1000) }, deps)) done.push(executor.name)
  }
  return done
}

/** The same, against the running app. */
export const baselineBrowserDeps: BaselineDeps = {
  getSettings: () => window.api.settings.get(),
  setExecutors: async (executors) => {
    await window.api.settings.set({ executors })
  },
  queue: (work) => settingsWrites(work),
  baselineStanding: async () => (await window.api.books.state()).standings.find((standing) => standing.id === 'baseline') ?? null,
  bars: async (symbol, fromSec, toSec) => {
    const read = await window.api.market.fetchHistoricalRange('binance', symbol, BASELINE_LINES.interval, fromSec, toSec)
    if (read.cancelled) throw new Error('the read was cancelled')
    return read.candles
  },
  price: async (symbol) => (await window.api.market.fetchTicker24h('binance', symbol)).lastPrice,
  book: (symbol) => window.api.books.spotBook(symbol),
  misses: (sinceSec) => window.api.books.misses(sinceSec),
  miss: (miss) => window.api.books.miss(miss),
  nowMs: () => Date.now(),
  newId: () => crypto.randomUUID()
}
