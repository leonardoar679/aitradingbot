import type { Horizon } from './features'
import type { ForecastModelId } from './models'
import type { ModelScore } from './walkForward'

// PROMOTION AND DEGRADATION (the V6 document, §104-105; V6 Stage 5, 13 October 2026).
//
// A model weighs in the forecast only once its out-of-sample record earns it, line by line, every line
// written before any result was looked at: enough outcomes, an 80% interval that held about 80% of
// them, a pinball loss below persistence's on the same outcomes -- it knows more than "the move will be
// as big as usual" -- and, for a horizon the forecast trader takes (V6 Stage 11), a positive net after
// costs over thirty replayed trades. Not yet promoted, a model is still computed and kept on record; it
// only does not weigh. Persistence itself needs no promotion: it is the floor everything stands on.
//
// DEGRADED when its last week went wrong on any count: coverage gone more than ten points from 80%,
// a pinball loss above persistence's, the median biased by more than a quarter of the usual move, or
// the trader's last thirty trades on it losing. Flagged and told once a day; never deleted or switched
// off by the app -- its weight in the forecast falls with its own score.

export const PROMOTION_LINES = { minOutcomes: 5000, coverageTolerance: 0.05, minTrades: 30 } as const
export const DEGRADATION_LINES = { coverageTolerance: 0.1, biasLimit: 0.25, minOutcomes: 200, trades: 30 } as const

export interface CheckLine {
  id: 'outcomes' | 'coverage' | 'pinball' | 'trades'
  ok: boolean | null
  text: string
}

const pct = (share: number): string => `${(share * 100).toFixed(1)}%`
/** A distance from 80% within a tolerance, the tolerance itself included whatever the doubles say (|0.75 - 0.8| is 0.05000000000000004). */
const within = (share: number, tolerance: number): boolean => Math.abs(share - 0.8) <= tolerance + 1e-9

/** The checklist for one model at one horizon. `tradesNet` is the forecast trader's net after costs
 * over its replayed trades on the model, and their count; null until the trader has replayed it. */
export function promotionChecklist(score: ModelScore, persistence: ModelScore, trades: { count: number; net: number } | null): { promoted: boolean; lines: CheckLine[] } {
  const lines: CheckLine[] = [
    { id: 'outcomes', ok: score.n >= PROMOTION_LINES.minOutcomes, text: `${score.n} outcomes out of sample (${PROMOTION_LINES.minOutcomes} needed)` },
    {
      id: 'coverage',
      ok: within(score.coverage80, PROMOTION_LINES.coverageTolerance),
      text: `the 80% interval held ${pct(score.coverage80)} (within ${PROMOTION_LINES.coverageTolerance * 100} points of 80% needed)`
    },
    { id: 'pinball', ok: score.pinball < persistence.pinball, text: `pinball loss ${score.pinball.toFixed(4)} against persistence's ${persistence.pinball.toFixed(4)}` },
    trades === null || trades.count < PROMOTION_LINES.minTrades
      ? { id: 'trades', ok: null, text: `the forecast trader has not replayed ${PROMOTION_LINES.minTrades} trades on it yet` }
      : { id: 'trades', ok: trades.net > 0, text: `${trades.count} replayed trades netted ${(trades.net * 100).toFixed(2)}% after costs` }
  ]
  // A line not yet measured does not block; one measured and failed does.
  return { promoted: lines.every((line) => line.ok !== false), lines }
}

/** Whether a model's last week went wrong, and why. `recentTradesNet` is its last thirty trades' net,
 * or null without thirty. Too few outcomes in the week to say: not degraded. */
export function degradationOf(recent: ModelScore, persistenceRecent: ModelScore, recentTradesNet: number | null): { degraded: boolean; reasons: string[] } {
  if (recent.n < DEGRADATION_LINES.minOutcomes) return { degraded: false, reasons: [] }
  const reasons: string[] = []
  if (!within(recent.coverage80, DEGRADATION_LINES.coverageTolerance)) reasons.push(`its 80% interval held ${pct(recent.coverage80)} of the week's outcomes`)
  if (recent.pinball > persistenceRecent.pinball) reasons.push(`its pinball loss (${recent.pinball.toFixed(4)}) was above persistence's (${persistenceRecent.pinball.toFixed(4)})`)
  if (Math.abs(recent.bias) > DEGRADATION_LINES.biasLimit) reasons.push(`its median was off by ${recent.bias.toFixed(2)} of the usual move on average`)
  if (recentTradesNet !== null && recentTradesNet < 0) reasons.push(`the trader's last ${DEGRADATION_LINES.trades} trades on it lost ${(-recentTradesNet * 100).toFixed(2)}%`)
  return { degraded: reasons.length > 0, reasons }
}

const HORIZON_WORDS: Record<Horizon, string> = { minutes5: '5 minutes', minutes15: '15 minutes', hour1: '1 hour', hours4: '4 hours', hours24: '24 hours' }

/** What the desktop is told of a degraded model, once a day on its thread. */
export function degradedForecastNotice(model: ForecastModelId, horizon: Horizon, reasons: readonly string[]): { title: string; body: string; thread: string } {
  return {
    title: `Forecast model degraded: ${model}, ${HORIZON_WORDS[horizon]}`,
    body: `Over the last week ${reasons.join('; ')}. It stays computed and on record; its weight in the forecast falls with its score. Nothing was placed or sold.`,
    thread: `degraded:forecast:${model}:${horizon}`
  }
}
