import { QUANT_IDS, QUANT_NAMES, type QuantId } from '../../shared/aiEventBenchmark'
import { ROUND_TRIP_PCT } from '../../shared/forecast/edge'
import { traderStats, type LabTrade, type TraderStats } from '../../shared/forecast/lab'
import type { Candle } from '../../shared/ipc'
import { runBacktest } from '../backtest/engine'
import { QUANTS, quantSideAt, quantSpan } from '../agents/quantState'

// THE FORECAST AGAINST THE APP'S STRATEGIES (the V6 document, §50, §96 and §98; V6 Stage 11, 13 October
// 2026), on the same pairs and the same weeks as the walk forward, on the forecast's own bars:
// - Trend Regime 4h and Short-Term Channel 15m, each its own backtest (src/backtest/engine.ts) with its
//   warm-up before the window, its trades opened in the window counted, net of its fees;
// - buy and hold: each pair bought at the window's first four-hour close and sold at its last, one
//   round trip;
// - the hybrid: the forecast trader's trades where Trend Regime 4h's state at the trade's moment was on
//   its side -- long for a buy, short for a sell -- and the same with Short-Term Channel 15m.
// Each in the trader's figures: a fixed stake a trade, net, over ONE WINDOW: from where both strategies'
// warm-ups have passed on the bars on file -- Trend Regime reads 80 days before it can trade, and the
// files keep 90 -- to the span's end, on the pairs whose history reaches that far; the forecast's trades
// are cut to it too. Reading it runs public bars on file through the app's own strategies; nothing is
// asked or placed.

export type BarsFetch = (pair: string, width: '15m' | '4h', fromSec: number, toSec: number) => Promise<Candle[]>

export interface ComparisonRow {
  name: string
  stats: TraderStats
}

/** A strategy's trades as the trader's: entered in the span, each its net percent. */
function asTrades(pair: string, returns: { entryTime: number; exitTime: number; returnPct: number }[], span: { from: number; to: number }): LabTrade[] {
  return returns
    .filter((trade) => trade.entryTime >= span.from && trade.entryTime <= span.to)
    .map((trade) => ({ pair, t: trade.exitTime, horizon: 'minutes5' as const, side: 'BUY' as const, exit: 'close' as const, grossPct: trade.returnPct, netPct: trade.returnPct }))
}

/** The hybrid: the forecast's trades kept where a strategy's state agreed with their side. */
export function hybridTrades(trades: readonly LabTrade[], bars: ReadonlyMap<string, Candle[]>, id: QuantId): LabTrade[] {
  return trades.filter((trade) => {
    const mine = bars.get(trade.pair)
    if (mine === undefined) return false
    const side = quantSideAt(id, mine, trade.t)
    return (trade.side === 'BUY' && side === 'long') || (trade.side === 'SELL' && side === 'short')
  })
}

/** Buy and hold over the span: a round trip a pair, from the first bar's close in it to the last's. */
export function buyAndHold(pair: string, bars: readonly Candle[], span: { from: number; to: number }): LabTrade | null {
  const inside = bars.filter((bar) => bar.time >= span.from && bar.time <= span.to)
  if (inside.length < 2) return null
  const gross = (inside[inside.length - 1].close / inside[0].close - 1) * 100
  return { pair, t: inside[inside.length - 1].time, horizon: 'minutes5', side: 'BUY', exit: 'close', grossPct: gross, netPct: gross - ROUND_TRIP_PCT }
}

export interface ComparisonResult {
  /** The window every row is read over, and the pairs read: from where both strategies' warm-ups had
   * passed on the bars on file, on the pairs whose bars reach that far back. Null where no such window. */
  window: { from: number; to: number } | null
  pairs: string[]
  /** Pairs left out: too young for a strategy's warm-up by the window's start. */
  left: string[]
  rows: ComparisonRow[]
}

export async function runComparison(
  pairs: readonly string[],
  span: { from: number; to: number },
  forecastTrades: { rules: readonly LabTrade[]; medians: readonly LabTrade[] },
  fetchBars: BarsFetch,
  options: { onProgress?: (done: number, total: number) => void; shouldStop?: () => boolean } = {}
): Promise<ComparisonResult> {
  // Each pair's bars at each strategy's width, with the warm-up before the span where the files hold it,
  // and the first bar each strategy can act on.
  const held: Record<QuantId, Map<string, Candle[]>> = { trend4h: new Map(), channel15m: new Map() }
  const firstActs = new Map<string, number>()
  let done = 0
  for (const pair of pairs) {
    if (options.shouldStop?.()) break
    let first = Number.NEGATIVE_INFINITY
    for (const id of QUANT_IDS) {
      const window = quantSpan(id, { startSec: span.from, endSec: span.to + 86_400 })
      const bars = await fetchBars(pair, QUANTS[id].interval, window.startSec, window.endSec)
      if (bars.length <= QUANTS[id].warmupBars) {
        first = Number.POSITIVE_INFINITY
        continue
      }
      held[id].set(pair, bars)
      first = Math.max(first, bars[QUANTS[id].warmupBars].time)
    }
    firstActs.set(pair, first)
    done++
    options.onProgress?.(done, pairs.length)
    // Let the window paint between pairs.
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
  // The window starts where the warm-ups have passed on the pair with the longest history -- Bitcoin's,
  // where it is read -- and every pair whose own have not by then is left out of every row.
  const reference = firstActs.get('BTCUSDT') ?? Math.min(...firstActs.values())
  const from = Math.max(span.from, reference)
  if (!Number.isFinite(from) || from >= span.to) return { window: null, pairs: [], left: [...firstActs.keys()], rows: [] }
  const window = { from, to: span.to }
  const used = [...firstActs].filter(([, first]) => first <= from).map(([pair]) => pair)
  const left = [...firstActs].filter(([, first]) => first > from).map(([pair]) => pair)
  const strategyTrades: Record<QuantId, LabTrade[]> = { trend4h: [], channel15m: [] }
  const holds: LabTrade[] = []
  for (const pair of used) {
    for (const id of QUANT_IDS) {
      const bars = held[id].get(pair)!
      strategyTrades[id].push(...asTrades(pair, runBacktest(bars, QUANTS[id].strategyId).trades, window))
    }
    const hold = buyAndHold(pair, held.trend4h.get(pair)!, window)
    if (hold !== null) holds.push(hold)
  }
  const inWindow = (trades: readonly LabTrade[]): LabTrade[] => trades.filter((trade) => used.includes(trade.pair) && trade.t >= window.from && trade.t <= window.to)
  const rules = inWindow(forecastTrades.rules)
  const medians = inWindow(forecastTrades.medians)
  const rows: ComparisonRow[] = [
    { name: `${QUANT_NAMES.trend4h} (its own backtest)`, stats: traderStats(strategyTrades.trend4h) },
    { name: `${QUANT_NAMES.channel15m} (its own backtest)`, stats: traderStats(strategyTrades.channel15m) },
    { name: 'Buy and hold, a round trip a pair', stats: traderStats(holds) },
    { name: 'The forecast trader, as the rules stand', stats: traderStats(rules) },
    { name: 'The forecast trader on the median alone (research)', stats: traderStats(medians) }
  ]
  for (const id of QUANT_IDS) {
    rows.push({ name: `Hybrid: the rules' trades where ${QUANT_NAMES[id]} agreed`, stats: traderStats(hybridTrades(rules, held[id], id)) })
    rows.push({ name: `Hybrid: the median's trades where ${QUANT_NAMES[id]} agreed (research)`, stats: traderStats(hybridTrades(medians, held[id], id)) })
  }
  return { window, pairs: used, left, rows }
}
