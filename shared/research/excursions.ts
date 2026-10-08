import type { ExecutorConfig, PositionExecutorParams } from '../ipc'
import { RESEARCH_MIN_TRADES } from './common'

// EXCURSIONS ON FILE (the V4 document, §66): since 8 October 2026 a paper trade of the watch's
// carries, when it closes, how far the price went for it and against it while it was held
// (watch.result.bestPct, worstPct), from the minutes it was settled on. Four questions, answered
// from those trades alone, LIVE PAPER: how often a winner first fell 1%; how far winners ran; what
// a stop half as far would have cost; how often the target cut a bigger winner short. Thirty
// trades with excursions, or not enough.

export interface ExcursionTrade {
  pnlPct: number
  bestPct: number
  worstPct: number
  stopPct: number | null
  targetPct: number | null
  exit: string
}

/** The watch's closed paper trades that carry their excursions, each with its result in percent
 * of its stake. */
export function excursionTrades(executors: readonly ExecutorConfig[]): ExcursionTrade[] {
  const out: ExcursionTrade[] = []
  for (const executor of executors) {
    const result = executor.watch?.result
    if (result === undefined || result.bestPct === undefined || result.worstPct === undefined || executor.mode !== 'paper') continue
    const params = executor.params as PositionExecutorParams
    if (!(params.amountQuote > 0)) continue
    out.push({ pnlPct: (result.pnlQuote / params.amountQuote) * 100, bestPct: result.bestPct, worstPct: result.worstPct, stopPct: params.stopLossPct, targetPct: params.takeProfitPct, exit: result.exit })
  }
  return out
}

export interface ExcursionAnswers {
  label: 'LIVE PAPER'
  trades: number
  winners: number
  enough: boolean
  /** Of the winners, the share that first fell 1% or more against them. Null under the minimum. */
  winnersFellFirstPct: number | null
  /** The median of how far winners ran in their favour, in percent. */
  medianWinnerBestPct: number | null
  /** What a stop half as far would have cost: the share of winners it would have stopped out, and
   * their net result together in percent of a stake each. */
  halfStopWouldCut: { share: number; netPctLost: number } | null
  /** Of the trades that reached their target, the share that went on at least a target's width
   * further: a bigger winner cut short. */
  targetCutBiggerPct: number | null
}

const median = (values: number[]): number | null => {
  if (values.length === 0) return null
  const sorted = [...values].sort((a, b) => a - b)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 1 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2
}

export function excursionAnswers(trades: readonly ExcursionTrade[]): ExcursionAnswers {
  const enough = trades.length >= RESEARCH_MIN_TRADES
  const winners = trades.filter((trade) => trade.pnlPct > 0)
  const withStop = winners.filter((trade) => trade.stopPct !== null && trade.stopPct > 0)
  const cut = withStop.filter((trade) => trade.worstPct <= -((trade.stopPct ?? 0) / 2))
  const targeted = trades.filter((trade) => trade.exit === 'take_profit' && trade.targetPct !== null && trade.targetPct > 0)
  const bigger = targeted.filter((trade) => trade.bestPct >= 2 * (trade.targetPct ?? 0))
  return {
    label: 'LIVE PAPER',
    trades: trades.length,
    winners: winners.length,
    enough,
    winnersFellFirstPct: enough && winners.length > 0 ? (winners.filter((trade) => trade.worstPct <= -1).length / winners.length) * 100 : null,
    medianWinnerBestPct: enough && winners.length > 0 ? median(winners.map((trade) => trade.bestPct)) : null,
    halfStopWouldCut: enough && withStop.length > 0 ? { share: (cut.length / withStop.length) * 100, netPctLost: cut.reduce((sum, trade) => sum + trade.pnlPct, 0) } : null,
    targetCutBiggerPct: enough && targeted.length > 0 ? (bigger.length / targeted.length) * 100 : null
  }
}

/** How far the price went for a side and against it over `bars`, from `entryPrice`, in percent:
 * what the settle loop writes on a trade when it closes. */
export function excursionOf(bars: readonly { high: number; low: number }[], entryPrice: number, side: 'buy' | 'sell'): { bestPct: number; worstPct: number } {
  if (!(entryPrice > 0) || bars.length === 0) return { bestPct: 0, worstPct: 0 }
  const sign = side === 'buy' ? 1 : -1
  let best = 0
  let worst = 0
  for (const bar of bars) {
    const favourable = sign * ((side === 'buy' ? bar.high : bar.low) / entryPrice - 1) * 100
    const adverse = sign * ((side === 'buy' ? bar.low : bar.high) / entryPrice - 1) * 100
    if (favourable > best) best = favourable
    if (adverse < worst) worst = adverse
  }
  return { bestPct: best, worstPct: worst }
}
