import { INTERVAL_SECONDS, type Candle } from './ipc'
import type { BookMark } from './paperBooks'
import { VENUE_FEES } from './venueCosts'

// THE BASELINE BOOK'S LINES (V8 Stage 9, 27 October 2026; the plan's decision of 26 October: the best of the
// strategies already built, run as it was backtested, beside the two new ideas). Trend Regime Ensemble
// (src/backtest/strategies/trendRegimeEnsemble.ts) on the eight symbols its backtests were read on, at its own
// interval, long only on spot as it was built, its trades in the baseline book on paper. It enters only on a signal at
// a bar that closed after paper testing was started -- never on a regime already standing then -- so the book's run is
// the strategy's own from its Start. Fixed here, and named by V8-S9-BOOKS, before the first Start.

export const BASELINE_LINES = {
  version: 'baseline-v1',
  strategy: 'trend-regime-ensemble',
  interval: '4h',
  /** research/interval.ts's SELECT and CONFIRM: the eight its backtests were read on. */
  symbols: ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'ADAUSDT', 'BNBUSDT', 'LINKUSDT', 'LTCUSDT', 'XRPUSDT'],
  /** Entered only on an entry signal at a bar that closed after the Start. */
  freshSignalsOnly: true,
  /** A bar is read this long after its close, so that its close is final. */
  readAfterCloseSec: 30,
  /** Long on Binance's spot at its taker fee each way: no funding. */
  venue: 'binance',
  takerPct: VENUE_FEES.binance.takerPct
} as const

export type BaselineSymbol = (typeof BASELINE_LINES.symbols)[number]

/** The strategy's bar, in seconds. */
export const BASELINE_BAR_SEC = INTERVAL_SECONDS[BASELINE_LINES.interval]

// THE BASELINE'S ARITHMETIC (V8 Stage 9). Pure: the strategy's signals are read by its writer
// (src/baseline/baselineTrade.ts), from bars the main process reads, and handed here.

export type BaselineCloseReason = 'stop' | 'signal' | 'stopped'

/** What the baseline book keeps on each of its trades: the bar whose close its entry signal was read at, its fill, its
 * stake and fee, the strategy's disaster stop fixed at entry, and how it ended. */
export interface BaselineStamp {
  symbol: string
  /** The open time, in seconds, of the bar whose close the entry signal was read at. */
  signalBarSec: number
  entryPx: number
  qty: number
  stakeQuote: number
  /** The entry's taker fee. */
  feesQuote: number
  openedAtMs: number
  stopPx: number
  closeReason: BaselineCloseReason | null
  exitPx: number | null
}

/** Whether the strategy's entry signal at the close of bar `index` is the run's to take: the bar closed after the Start,
 * and the regime was not standing at the last bar closed before it -- or, where it was, it has since broken, at a bar
 * after that one and before this. A regime standing at the Start is the strategy's position from before the run, and
 * the run never takes it; where the strategy could not yet be read at the Start, whether it stood is not known, and
 * nothing is taken. */
export function baselineFreshAt(input: { bars: readonly Pick<Candle, 'time'>[]; entries: readonly boolean[]; warmupBars: number; index: number; startedAtSec: number; barSec?: number }): boolean {
  const { bars, entries, index, startedAtSec } = input
  const barSec = input.barSec ?? BASELINE_BAR_SEC
  if (index < 0 || index >= bars.length || bars[index].time + barSec <= startedAtSec) return false
  let atStart = -1
  for (let i = 0; i < bars.length && bars[i].time + barSec <= startedAtSec; i++) atStart = i
  if (atStart < input.warmupBars) return false
  if (!entries[atStart]) return true
  for (let i = atStart + 1; i < index; i++) if (!entries[i]) return true
  return false
}

/** Where an open baseline trade leaves, read from the closed bars after its signal's as the backtest engine reads them
 * (src/backtest/engine.ts): at a bar whose low reaches its stop, at the stop or the bar's open where the bar opened
 * past it; else at the close of a bar its exit signal holds at. Null while neither has. */
export function baselineExitOf(
  stamp: Pick<BaselineStamp, 'signalBarSec' | 'stopPx'>,
  bars: readonly Candle[],
  exits: readonly boolean[],
  barSec: number = BASELINE_BAR_SEC
): { reason: 'stop' | 'signal'; px: number; atSec: number; barTime: number } | null {
  for (let i = 0; i < bars.length; i++) {
    const bar = bars[i]
    if (bar.time <= stamp.signalBarSec) continue
    if (bar.low <= stamp.stopPx) return { reason: 'stop', px: Math.min(bar.open, stamp.stopPx), atSec: bar.time + barSec, barTime: bar.time }
    if (exits[i] === true) return { reason: 'signal', px: bar.close, atSec: bar.time + barSec, barTime: bar.time }
  }
  return null
}

/** A baseline trade's result closed at `exit`: its move on its size after the taker fee each way; spot pays no funding. */
export function baselineResultOf(
  stamp: Pick<BaselineStamp, 'entryPx' | 'qty' | 'stakeQuote' | 'feesQuote'>,
  exit: { px: number; atSec: number },
  lines: Pick<typeof BASELINE_LINES, 'takerPct'> = BASELINE_LINES
): NonNullable<BookMark['result']> {
  const feesQuote = stamp.feesQuote + (lines.takerPct / 100) * stamp.qty * exit.px
  const netQuote = (exit.px - stamp.entryPx) * stamp.qty - feesQuote
  return { netQuote, netPct: stamp.stakeQuote > 0 ? (netQuote / stamp.stakeQuote) * 100 : 0, feesQuote, fundingQuote: 0, closedAt: exit.atSec }
}

/** What an open baseline trade stands at, in the quote, were it closed now at `px`. */
export function baselineOpenNetOf(stamp: Pick<BaselineStamp, 'entryPx' | 'qty' | 'stakeQuote' | 'feesQuote'>, px: number): number {
  return baselineResultOf(stamp, { px, atSec: 0 }).netQuote
}
