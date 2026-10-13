import type { ForecastBar } from './bars'
import type { Horizon, PairClass } from './features'
import type { MarketRegime } from '../marketResearch'

// OPPORTUNITY CLASSES (the V6 document, §99; V6 Stage 12, 13 October 2026). A forecast's trade falls in a
// class: the kind of coin, the horizon, and the setup it was made in --
// - NEWS: a story about the coin moved the forecast, or was published in the four hours before it;
// - BREAKOUT: its close broke the day before's range;
// - REVERSAL: it calls against an hour's shock of two usual moves;
// - TREND: it calls the market's way, a bull run's for a buy, a bear run's for a sell;
// - OTHER: none of those -- in that order, the first that holds.
// A class is judged by fixed lines on two records: the forecast trader's replay of the walk forward
// (the Lab's, as the rules stand) and its own live paper trades. APPROVED where both have done it good;
// PROBATION where the replay has and the live paper has not yet enough; DISABLED where either has done
// it harm; NOT ENOUGH where the replay holds too few. The forecast trader trades only an APPROVED or a
// PROBATION class, and a decision in any other says so (CLASS_NOT_APPROVED).

export const SETUPS = ['news', 'breakout', 'reversal', 'trend', 'other'] as const
export type Setup = (typeof SETUPS)[number]

export const CLASS_LINES = {
  /** The replayed trades a class needs before it is judged, and the live paper ones before its live
   * record counts. */
  minHistoryTrades: 30,
  minLiveTrades: 10,
  /** An hour of this many usual moves is a shock. */
  shock: 2
} as const

export type ClassVerdict = 'APPROVED' | 'PROBATION' | 'DISABLED' | 'NOT_ENOUGH'

export function setupOf(input: { side: 'BUY' | 'SELL'; story: boolean; breakout: boolean; prior: number | null; regime: MarketRegime | null }): Setup {
  if (input.story) return 'news'
  if (input.breakout) return 'breakout'
  if (input.prior !== null && Number.isFinite(input.prior) && Math.abs(input.prior) >= CLASS_LINES.shock && Math.sign(input.prior) === (input.side === 'BUY' ? -1 : 1)) return 'reversal'
  if ((input.side === 'BUY' && input.regime === 'bull') || (input.side === 'SELL' && input.regime === 'bear')) return 'trend'
  return 'other'
}

export function classKeyOf(pairClass: PairClass, horizon: Horizon, setup: Setup): string {
  return `${pairClass}/${horizon}/${setup}`
}

/** Whether the close at `t` broke the range of the day before it, on five-minute bars stamped by their
 * open time: the bar that closed at `t` against the 288 before it. False without them. */
export function breakoutAt(bars: readonly ForecastBar[] | undefined, t: number): boolean {
  if (bars === undefined || bars.length === 0) return false
  let low = 0
  let high = bars.length
  while (low < high) {
    const middle = (low + high) >> 1
    if (bars[middle].time < t - 300) low = middle + 1
    else high = middle
  }
  if (low >= bars.length || bars[low].time !== t - 300) return false
  const close = bars[low].close
  let top = -Infinity
  let bottom = Infinity
  for (let index = low - 1; index >= 0 && bars[index].time >= t - 300 - 86_400; index--) {
    top = Math.max(top, bars[index].high)
    bottom = Math.min(bottom, bars[index].low)
  }
  return Number.isFinite(top) && (close > top || close < bottom)
}

export interface ClassRecord {
  key: string
  /** The replay's trades in the class and their net, a stake a trade; the live paper ones'. */
  history: { trades: number; netPct: number }
  live: { trades: number; netPct: number }
  verdict: ClassVerdict
}

export function classVerdict(history: { trades: number; netPct: number }, live: { trades: number; netPct: number }): ClassVerdict {
  if (history.trades < CLASS_LINES.minHistoryTrades) return 'NOT_ENOUGH'
  if (!(history.netPct > 0)) return 'DISABLED'
  if (live.trades >= CLASS_LINES.minLiveTrades) return live.netPct > 0 ? 'APPROVED' : 'DISABLED'
  return 'PROBATION'
}

/** Whether the forecast trader may trade a class judged so. */
export function classTradable(verdict: ClassVerdict): boolean {
  return verdict === 'APPROVED' || verdict === 'PROBATION'
}

/** Every class either record holds, judged. */
export function classTable(history: readonly { classKey: string; netPct: number }[], live: readonly { classKey: string; netPct: number }[]): ClassRecord[] {
  const keys = [...new Set([...history.map((trade) => trade.classKey), ...live.map((trade) => trade.classKey)])].sort()
  return keys.map((key) => {
    const mine = (trades: readonly { classKey: string; netPct: number }[]): { trades: number; netPct: number } => {
      const ofKey = trades.filter((trade) => trade.classKey === key)
      return { trades: ofKey.length, netPct: ofKey.reduce((sum, trade) => sum + trade.netPct, 0) }
    }
    const record = { history: mine(history), live: mine(live) }
    return { key, ...record, verdict: classVerdict(record.history, record.live) }
  })
}
