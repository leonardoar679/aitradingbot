import { EXIT_LINES, describeExitTrigger, exitOrderOf, type ExitCheck, type ExitCheckRequest } from '../../shared/aiAdditions'
import type { NoticeExtra } from '../../shared/notices'
import type { AiConfig } from '../../shared/aiCost'
import { MARKET_BARS_15M, MARKET_BARS_1M, MARKET_REFERENCE_SYMBOLS, referenceReturns, type ReferenceCandles } from '../../shared/aiEventMarket'
import type { AiExitOrder } from '../../shared/aiExit'
import type { AppSettings, Candle, Exchange, ExecutorConfig } from '../../shared/ipc'
import { marketRegimeOf, type MarketRegime } from '../../shared/marketResearch'
import { ownOpenPaperTrades } from '../../shared/paperRisk'
import { runExecutorSimulation } from '../executors/engine'
import { exitNewsShort, newsShortBrowserDeps } from '../news/newsPaperShort'
import { exitWatchPaperTrade, watchPaperBrowserDeps } from './watchPaperTrade'

// THE EXIT CHECK'S LOOK AT THE APP'S OWN OPEN PAPER TRADES (shared/aiAdditions.ts has the rules and
// the question; shared/aiExit.ts says what an EXIT writes).
//
// Every two minutes while the watch is on and the check is switched on, each of the app's own paper
// trades that has entered is measured on its closed minutes: where the engine says it entered, the
// last close, the pair's last fifteen minutes, and the market's regime by Bitcoin's minutes when it
// entered and now. Then it is put to the main process, which reads the trade itself from the
// executors on file, finds the reasons by fixed lines, and asks only for a reason it has not been
// asked about on that trade before. An answered EXIT is handed to the file that writes that kind of
// trade, which brings its time limit forward so that it closes at the next minute, on paper. KEEP
// and REDUCE change nothing.
//
// IT WRITES NOTHING ITSELF. It reads settings and candles, asks, and notifies; the two writers are
// handed the EXIT. A live executor is never among the trades it looks at (ownOpenPaperTrades), and
// neither writer can find one (tests/aiNoLivePath.test.ts).

/** How often it looks. */
export const EXIT_LOOK_MS = 120_000

const QUARTER_HOUR = 900

export interface ExitCheckDeps {
  getConfig: () => Promise<Pick<AiConfig, 'watch' | 'additions'>>
  getSettings: () => Promise<Pick<AppSettings, 'executors'>>
  /** Candles of [startSec, endSec], of a minute or of fifteen. */
  fetchCandles: (exchange: Exchange, symbol: string, interval: '1m' | '15m', startSec: number, endSec: number) => Promise<Candle[]>
  exitCheck: (request: ExitCheckRequest) => Promise<ExitCheck>
  /** The two writers, each handed an EXIT for one of its own trades. */
  exitWatchTrade: (order: AiExitOrder) => Promise<boolean>
  exitNewsShort: (order: AiExitOrder) => Promise<boolean>
  notify: (title: string, body: string, extra?: NoticeExtra) => void
  nowSec: () => number
}

/** Where an open trade stands on its closed minutes. */
export interface OpenTradeReading {
  entryPrice: number
  enteredAt: number
  /** The last closed minute. */
  last: Candle
  /** The pair's move over its last fifteen closed minutes, in percent; null when they are not all
   * there. */
  move15mPct: number | null
}

/** Where a trade stands: where the engine says it entered, the last close, and the pair's last fifteen
 * minutes. Null for one that has not entered, has closed, or whose minutes are not of the last few. */
export function readOpenTrade(executor: ExecutorConfig, minutes: Candle[], nowSec: number): OpenTradeReading | null {
  const closed = minutes.filter((bar) => bar.time + 60 <= nowSec)
  // Its own minutes are the ones the settle loops simulate: from when it was opened.
  const own = closed.filter((bar) => bar.time >= executor.createdAt)
  if (own.length === 0) return null
  const state = runExecutorSimulation(own, executor, own[0].close)
  if (state.kind !== 'position' || state.status !== 'open' || state.entryPrice === null || state.enteredAt === null) return null
  const last = closed[closed.length - 1]
  if (nowSec - (last.time + 60) > EXIT_LINES.priceMaxAgeSeconds) return null
  const before = closed.find((bar) => bar.time === last.time - QUARTER_HOUR)
  const move15mPct = before === undefined || !(before.close > 0) ? null : (last.close / before.close - 1) * 100
  return { entryPrice: state.entryPrice, enteredAt: state.enteredAt, last, move15mPct }
}

/** The market's regime as of a minute, by Bitcoin's candles before it (shared/marketResearch.ts), or
 * null when they do not reach it. */
export function regimeAt(btc: ReferenceCandles, time: number): MarketRegime | null {
  return marketRegimeOf(referenceReturns(btc, time))
}

function triggersIn(check: ExitCheck): string {
  return check.triggers.map(describeExitTrigger).join(', ')
}

/** One look at the app's own open paper trades. Returns a line for each it asked about, saying what
 * came of it. Never throws for one trade it could not read or ask about: that one is tried again on
 * the next look, and the others go on. */
export async function lookAtOpenTrades(deps: ExitCheckDeps): Promise<string[]> {
  const config = await deps.getConfig()
  // It asks by itself, so it is held to the watch, as the main process holds it too.
  if (!config.watch.enabled || !config.additions.exit) return []
  const { executors } = await deps.getSettings()
  const trades = ownOpenPaperTrades(executors).filter((executor) => (executor.watch ?? executor.newsRule)?.aiExit === undefined)
  const read: { executor: ExecutorConfig; reading: OpenTradeReading }[] = []
  for (const executor of trades) {
    try {
      const nowSec = deps.nowSec()
      const reading = readOpenTrade(executor, await deps.fetchCandles(executor.exchange, executor.symbol, '1m', executor.createdAt - QUARTER_HOUR - 60, nowSec), nowSec)
      if (reading !== null) read.push({ executor, reading })
    } catch (failure) {
      console.error(`The exit check could not read the minutes of "${executor.name}":`, failure)
    }
  }
  if (read.length === 0) return []

  // Bitcoin's minutes, read once a look for each exchange, from before the earliest entry.
  const nowSec = deps.nowSec()
  const bitcoin = new Map<Exchange, Promise<ReferenceCandles | null>>()
  const btcOf = (exchange: Exchange): Promise<ReferenceCandles | null> => {
    let reading = bitcoin.get(exchange)
    if (reading === undefined) {
      const from = Math.min(...read.filter((entry) => entry.executor.exchange === exchange).map((entry) => entry.reading.enteredAt))
      reading = Promise.all([
        deps.fetchCandles(exchange, MARKET_REFERENCE_SYMBOLS.btc, '1m', from - (MARKET_BARS_1M + 1) * 60, nowSec),
        deps.fetchCandles(exchange, MARKET_REFERENCE_SYMBOLS.btc, '15m', from - (MARKET_BARS_15M + 2) * QUARTER_HOUR, nowSec)
      ]).then(
        ([candles1m, candles15m]) => ({ candles1m, candles15m }),
        () => null
      )
      bitcoin.set(exchange, reading)
    }
    return reading
  }

  const lines: string[] = []
  for (const { executor, reading } of read) {
    const btc = await btcOf(executor.exchange)
    const request: ExitCheckRequest = {
      executorId: executor.id,
      entryPrice: reading.entryPrice,
      enteredAt: reading.enteredAt,
      priceTime: reading.last.time,
      price: reading.last.close,
      move15mPct: reading.move15mPct,
      regimeAtEntry: btc === null ? null : regimeAt(btc, reading.enteredAt),
      regimeNow: btc === null ? null : regimeAt(btc, reading.last.time + 60)
    }
    let check: ExitCheck
    try {
      check = await deps.exitCheck(request)
    } catch (failure) {
      console.error(`The exit check could not look at "${executor.name}":`, failure)
      continue
    }
    const { outcome } = check
    if (outcome === null) continue
    if (outcome.status !== 'answered') {
      lines.push(`${executor.symbol}: not checked (${triggersIn(check)}): ${outcome.reason}`)
      continue
    }
    const order = exitOrderOf(check)
    if (order === null) {
      lines.push(`${executor.symbol}: ${outcome.answer.verdict} (${triggersIn(check)}).`)
      continue
    }
    const exit: AiExitOrder = { executorId: executor.id, enteredAt: reading.enteredAt, ...order }
    const closing = executor.watch !== undefined ? await deps.exitWatchTrade(exit) : await deps.exitNewsShort(exit)
    if (!closing) {
      lines.push(`${executor.symbol}: EXIT (${triggersIn(check)}), but it closes by its own plan as soon.`)
      continue
    }
    lines.push(`${executor.symbol}: EXIT (${triggersIn(check)}); it closes at the next minute, on paper.`)
    try {
      deps.notify(`Exit check: ${executor.name} closes`, `Asked because ${triggersIn(check)}. ${order.reason} It closes at the next minute, on paper.`, { kind: 'TRADE_EXECUTED', thread: executor.id })
    } catch {
      // A desktop that cannot show it is not a reason to report a trade that is closing as not.
    }
  }
  return lines
}

/** The same, against the running app. */
export const exitCheckBrowserDeps: ExitCheckDeps = {
  getConfig: () => window.api.ai.getConfig(),
  getSettings: () => window.api.settings.get(),
  fetchCandles: async (exchange, symbol, interval, startSec, endSec) => (await window.api.market.fetchHistoricalRange(exchange, symbol, interval, startSec, endSec)).candles,
  exitCheck: (request) => window.api.ai.exitCheck(request),
  exitWatchTrade: (order) => exitWatchPaperTrade(order, watchPaperBrowserDeps),
  exitNewsShort: (order) => exitNewsShort(order, newsShortBrowserDeps),
  notify: (title, body, extra) => void window.api.notify(title, body, extra?.severity, extra).catch(() => undefined),
  nowSec: () => Math.floor(Date.now() / 1000)
}
