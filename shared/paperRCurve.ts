import type { ExecutorConfig, PositionExecutorParams } from './ipc'
import { rMultiple } from './paperRisk'

// THE APP'S OWN PAPER TRADES AS A RUNNING TOTAL IN R, ONE LINE FOR THE WATCH AND ONE FOR THE NEWS
// RULES, from the results written on them when they closed (src/agents/watchPaperTrade.ts,
// src/news/newsPaperShort.ts). Chosen by the user on 5 October 2026, for Performance.
//
// R is what a trade made over what its stop would have lost (shared/paperRisk.ts), so trades of
// different sizes and stops add up on one scale, across quote assets. A trade that never entered
// made nothing and is not on a line. A trade with no stop -- a delisting's short -- has no R: it is
// counted beside its line, and not drawn on it.
//
// IT READS. Every point is worked out from what is on file; nothing is stored or asked.

export interface RCurvePoint {
  /** When a trade closed, in seconds. */
  time: number
  /** The running total in R after it. */
  r: number
}

export interface RCurve {
  /** A zero where the first trade on it opened, then a point at each close. Times strictly rise:
   * trades that closed in the same second are one point. */
  points: RCurvePoint[]
  /** The trades on the line. */
  trades: number
  /** Of those, the ones that made money. */
  ahead: number
  /** Trades that entered and closed with no stop to measure R against: not on the line. */
  unmeasured: number
}

export interface PaperRCurves {
  watch: RCurve
  news: RCurve
}

function curve(closed: { openedAt: number; closedAt: number; r: number | null; pnlQuote: number }[]): RCurve {
  const measured = closed.filter((trade): trade is { openedAt: number; closedAt: number; r: number; pnlQuote: number } => trade.r !== null).sort((a, b) => a.closedAt - b.closedAt)
  const unmeasured = closed.length - measured.length
  if (measured.length === 0) return { points: [], trades: 0, ahead: 0, unmeasured }
  const first = measured.reduce((earliest, trade) => Math.min(earliest, trade.openedAt), Number.POSITIVE_INFINITY)
  const points: RCurvePoint[] = [{ time: Math.min(first, measured[0].closedAt - 1), r: 0 }]
  let running = 0
  for (const trade of measured) {
    running += trade.r
    const last = points[points.length - 1]
    if (trade.closedAt === last.time) last.r = running
    else points.push({ time: trade.closedAt, r: running })
  }
  return { points, trades: measured.length, ahead: measured.filter((trade) => trade.pnlQuote > 0).length, unmeasured }
}

/** The two running totals, from the executors on file: each a paper Position carrying the watch's
 * mark or a news rule's, stopped with how it ended written on it, and entered. One stopped by hand
 * carries no result and is not on either. */
export function paperRCurves(executors: ExecutorConfig[]): PaperRCurves {
  const watch: Parameters<typeof curve>[0] = []
  const news: Parameters<typeof curve>[0] = []
  for (const executor of executors) {
    if (executor.mode !== 'paper' || executor.type !== 'position' || executor.status !== 'stopped') continue
    const result = executor.watch?.result ?? executor.newsRule?.result
    if (result === undefined || result.exit === 'entry_expired' || result.exit === 'btc_moved') continue
    const list = executor.watch !== undefined ? watch : news
    list.push({ openedAt: executor.createdAt, closedAt: result.closedAt, r: rMultiple(result.pnlQuote, executor.params as PositionExecutorParams), pnlQuote: result.pnlQuote })
  }
  return { watch: curve(watch), news: curve(news) }
}
