import { QUANT_IDS, type EventQuantStates, type QuantId, type QuantSide } from '../../shared/aiEventBenchmark'
import type { Candle, Exchange } from '../../shared/ipc'
import type { MarketEvent } from '../../shared/marketEvent'
import { runBacktest } from '../backtest/engine'
import { CHANNEL_BAND, channelPositionSeries, shortTermChannel } from '../backtest/strategies/shortTermChannel'
import { REGIME_VOTE, regimeAgreement, trendRegimeEnsemble } from '../backtest/strategies/trendRegimeEnsemble'

// WHAT THE APP'S TWO QUANT STRATEGIES SAID AT EACH EVENT'S MOMENT, AND WHAT THEY EARNED ON THEIR OWN
// (the second V3 document, §21, §33 and §61: does AI beat the quant baselines?).
//
// EVERY READING IS THE STRATEGY'S OWN, as on the live strategy monitor (src/backtest/liveSignal.ts):
// Trend Regime's vote from regimeAgreement() at REGIME_VOTE's lines, on 4-hour bars, and Short-Term
// Channel's position from channelPositionSeries() at CHANNEL_BAND's, on 15-minute bars -- never a
// second copy of either rule. A strategy is on the LONG side where it would hold (all four of its
// trend averages agree; the price at the top of its channels), on the SHORT side where it would be
// out because the trend or the channel has turned down, and on neither between.
//
// NOTHING AT OR AFTER THE EVENT'S MOMENT IS READ: the state is that of the last bar that had closed,
// and none is read before the strategy's own warm-up has passed. Public candles, one pair's bars once
// for all of its events; nothing here asks a model or trades.

/** Bars of public candles, as the market bridge serves them. */
export type QuantFetch = (exchange: Exchange, symbol: string, interval: '4h' | '15m', startSec: number, endSec: number) => Promise<Candle[]>

interface QuantSpec {
  strategyId: string
  interval: '4h' | '15m'
  barSeconds: number
  /** Bars the strategy reads before its state means anything: its own declared warm-up. */
  warmupBars: number
}

export const QUANTS: Record<QuantId, QuantSpec> = {
  trend4h: { strategyId: trendRegimeEnsemble.id, interval: '4h', barSeconds: 14_400, warmupBars: trendRegimeEnsemble.warmupBarsFor(14_400) },
  channel15m: { strategyId: shortTermChannel.id, interval: '15m', barSeconds: 900, warmupBars: shortTermChannel.warmupBarsFor(900) }
}

/** The strategy's reading on each bar, from its own export: the vote, or the channel position. */
function readings(id: QuantId, bars: Candle[]): number[] {
  return id === 'trend4h' ? regimeAgreement(bars, QUANTS.trend4h.barSeconds) : channelPositionSeries(bars)
}

function sideOf(id: QuantId, value: number): QuantSide | null {
  if (!Number.isFinite(value)) return null
  const lines = id === 'trend4h' ? REGIME_VOTE : CHANNEL_BAND
  return value >= lines.enterAt ? 'long' : value <= lines.exitAt ? 'short' : 'none'
}

/** The strategy's state at `atSec`: on the last of `bars` (oldest first, one pair) that had closed
 * by then. Null before its warm-up has passed, or without the bars. */
export function quantSideAt(id: QuantId, bars: Candle[], atSec: number): QuantSide | null {
  const closed = bars.filter((bar) => bar.time + QUANTS[id].barSeconds <= atSec)
  if (closed.length < QUANTS[id].warmupBars) return null
  const series = readings(id, closed)
  return sideOf(id, series[series.length - 1])
}

/** The span of one strategy's bars that reads every event in [startSec, endSec]: its warm-up and two
 * bars to spare before the first. */
export function quantSpan(id: QuantId, window: { startSec: number; endSec: number }): { startSec: number; endSec: number } {
  const spec = QUANTS[id]
  return { startSec: window.startSec - (spec.warmupBars + 2) * spec.barSeconds, endSec: window.endSec }
}

export interface QuantData {
  /** Each event's two states, by event id. */
  states: Record<string, EventQuantStates>
  /** Each pair's bars, by symbol, for the strategies' own backtests. */
  bars: Record<string, Partial<Record<QuantId, Candle[]>>>
  /** Pairs whose bars could not be read, each with why: their events read as not known. */
  failed: { symbol: string; error: string }[]
}

/** The two strategies' states at every event, reading each pair's bars once. */
export async function loadQuantData(
  events: Pick<MarketEvent, 'id' | 'exchange' | 'symbol' | 'time'>[],
  window: { startSec: number; endSec: number },
  fetch: QuantFetch,
  options: { shouldStop?: () => boolean; onProgress?: (done: number, total: number) => void } = {}
): Promise<QuantData> {
  const pairs = [...new Map(events.map((event) => [`${event.exchange}:${event.symbol}`, event])).values()]
  const data: QuantData = { states: {}, bars: {}, failed: [] }
  let done = 0
  for (const pair of pairs) {
    if (options.shouldStop?.()) break
    const held: Partial<Record<QuantId, Candle[]>> = {}
    try {
      for (const id of QUANT_IDS) {
        const span = quantSpan(id, window)
        held[id] = await fetch(pair.exchange, pair.symbol, QUANTS[id].interval, span.startSec, span.endSec)
      }
    } catch (failure) {
      data.failed.push({ symbol: pair.symbol, error: failure instanceof Error ? failure.message : String(failure) })
    }
    data.bars[pair.symbol] = held
    // Each bar's reading depends on it and the bars before it only, so one series a pair serves every
    // event on it, read at the last bar closed by the event's moment.
    const series = Object.fromEntries(QUANT_IDS.map((id) => [id, held[id] === undefined ? null : readings(id, held[id] as Candle[])])) as Record<QuantId, number[] | null>
    for (const event of events) {
      if (event.exchange !== pair.exchange || event.symbol !== pair.symbol) continue
      const states = {} as EventQuantStates
      for (const id of QUANT_IDS) {
        const bars = held[id]
        const values = series[id]
        if (bars === undefined || values === null) {
          states[id] = null
          continue
        }
        let last = -1
        for (let k = 0; k < bars.length && bars[k].time + QUANTS[id].barSeconds <= event.time; k++) last = k
        states[id] = last + 1 < QUANTS[id].warmupBars ? null : sideOf(id, values[last])
      }
      data.states[event.id] = states
    }
    options.onProgress?.(++done, pairs.length)
  }
  return data
}

export interface QuantBacktest {
  id: QuantId
  /** Pairs it could be run on: with enough bars to warm up and trade in the window. */
  pairs: number
  trades: number
  /** Each pair's net return over the window, averaged, and their median. */
  meanReturnPct: number | null
  medianReturnPct: number | null
  /** Each pair's deepest fall, averaged: negative, in percent of the equity's peak. */
  meanMaxDrawdownPct: number | null
  /** Holding the same pairs over the same window, averaged. */
  holdMeanReturnPct: number | null
}

const average = (values: number[]): number | null => (values.length === 0 ? null : values.reduce((sum, value) => sum + value, 0) / values.length)

/** Each strategy run on its own over the window, on every pair, through the backtest engine: what
 * the quant baselines earned by themselves on the same pairs, beside holding them. */
export function quantBacktests(data: Pick<QuantData, 'bars'>, window: { startSec: number; endSec: number }, nowSec: number): QuantBacktest[] {
  return QUANT_IDS.map((id) => {
    const returns: number[] = []
    const drawdowns: number[] = []
    const holds: number[] = []
    let trades = 0
    for (const held of Object.values(data.bars)) {
      const bars = (held[id] ?? []).filter((bar) => bar.time + QUANTS[id].barSeconds <= Math.min(nowSec, window.endSec))
      const inWindow = bars.filter((bar) => bar.time >= window.startSec)
      if (bars.length <= QUANTS[id].warmupBars || inWindow.length < 2) continue
      const result = runBacktest(bars, QUANTS[id].strategyId)
      returns.push(result.stats.totalNetProfitPct)
      drawdowns.push(result.stats.maxDrawdownPct)
      trades += result.stats.totalClosedTrades
      holds.push((inWindow[inWindow.length - 1].close / inWindow[0].open - 1) * 100)
    }
    const sorted = [...returns].sort((a, b) => a - b)
    const middle = Math.floor(sorted.length / 2)
    return {
      id,
      pairs: returns.length,
      trades,
      meanReturnPct: average(returns),
      medianReturnPct: sorted.length === 0 ? null : sorted.length % 2 === 1 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2,
      meanMaxDrawdownPct: average(drawdowns),
      holdMeanReturnPct: average(holds)
    }
  })
}
