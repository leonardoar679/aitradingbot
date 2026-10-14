import { ENGLISH, type I18n } from './i18n/translate'
// STRATEGY HEALTH, SHOWN AND NEVER ACTING (the V4 document, §109).
//
// A bot's dry run keeps the trades its strategy made on its pair since the bot was switched on
// (src/bots/useDryRun.ts). Over the last thirty of them that closed, its profit factor, win rate
// and mean hold are set against what the same strategy made on six symbols that took no part in
// choosing it, over seven years at its own bar size (src/backtest/marketConditions.ts
// MEASURED_EXPECTATIONS, measured by research/tradeexpect.ts through the shipped engine).
//
// DEGRADED when it is losing AND behaving unlike what was measured: a profit factor under one over
// those thirty trades, and with it either a win rate more than fifteen points under the measured
// one, or a mean hold three times the measured one or a third of it. Losing alone is not
// degradation: thirty trades of a strategy that wins a third of the time lose as a matter of
// course, and a flag that fired on every such run would be noise. A flag on the bot's card under
// Strategies › Active Runs and one notice a day; the bot keeps running on paper, and a person
// stops it.

export const STRATEGY_HEALTH_TRADES = 30
export const STRATEGY_WIN_RATE_SLACK_POINTS = 15
export const STRATEGY_HOLD_RATIO = 3

/** What a strategy made a trade where it was measured. */
export interface StrategyTradeExpectation {
  /** Closed trades the figures are over. */
  trades: number
  profitFactor: number
  winRatePct: number
  meanHoldHours: number
}

export interface StrategyTrade {
  entryTime: number
  exitTime: number
  returnPct: number
}

export type StrategyVerdict = 'not enough' | 'unmeasured' | 'as measured' | 'degraded'

export interface StrategyHealth {
  verdict: StrategyVerdict
  /** Closed trades on file. The figures are over the last STRATEGY_HEALTH_TRADES of them. */
  closed: number
  /** Null under the minimum, and with no losing trade to divide by. */
  profitFactor: number | null
  winRatePct: number | null
  meanHoldHours: number | null
  reasons: string[]
}

/** Gains over losses; null with no losing trade to divide by. */
export function profitFactorOf(returns: readonly number[]): number | null {
  let gain = 0
  let loss = 0
  for (const value of returns) {
    if (value > 0) gain += value
    else loss -= value
  }
  return loss > 0 ? gain / loss : null
}

export function describeHours(hours: number, i18n: I18n = ENGLISH): string {
  if (i18n.language === 'en') return hours < 48 ? `${hours.toFixed(0)} h` : `${(hours / 24).toFixed(1)} days`
  return hours < 48 ? i18n.t('{hours} h', { hours: i18n.num(hours, 0, 0) }) : i18n.t('{days} days', { days: i18n.num(hours / 24, 1, 1) })
}

/** Its record against what was measured; its reasons in English, as recorded, unless handed a language
 * (V6 Stage 14). */
export function strategyHealth(trades: readonly StrategyTrade[], expectation: StrategyTradeExpectation | null, i18n: I18n = ENGLISH): StrategyHealth {
  const { t, num } = i18n
  const closed = [...trades].sort((a, b) => b.exitTime - a.exitTime)
  if (closed.length < STRATEGY_HEALTH_TRADES) return { verdict: 'not enough', closed: closed.length, profitFactor: null, winRatePct: null, meanHoldHours: null, reasons: [] }
  const recent = closed.slice(0, STRATEGY_HEALTH_TRADES)
  const returns = recent.map((trade) => trade.returnPct)
  const profitFactor = profitFactorOf(returns)
  const winRatePct = (returns.filter((value) => value > 0).length / recent.length) * 100
  const meanHoldHours = recent.reduce((sum, trade) => sum + (trade.exitTime - trade.entryTime) / 3600, 0) / recent.length
  const figures = { closed: closed.length, profitFactor, winRatePct, meanHoldHours }
  if (expectation === null) return { verdict: 'unmeasured', ...figures, reasons: [] }
  const unlike: string[] = []
  if (winRatePct < expectation.winRatePct - STRATEGY_WIN_RATE_SLACK_POINTS) {
    unlike.push(t('wins {rate}% of the time against {measured}% measured', { rate: num(winRatePct, 0, 0), measured: num(expectation.winRatePct, 0, 0) }))
  }
  if (meanHoldHours >= expectation.meanHoldHours * STRATEGY_HOLD_RATIO || meanHoldHours <= expectation.meanHoldHours / STRATEGY_HOLD_RATIO) {
    unlike.push(t('holds {hold} a trade against {measured} measured', { hold: describeHours(meanHoldHours, i18n), measured: describeHours(expectation.meanHoldHours, i18n) }))
  }
  const losing = profitFactor !== null && profitFactor < 1
  if (!losing || unlike.length === 0) return { verdict: 'as measured', ...figures, reasons: [] }
  return { verdict: 'degraded', ...figures, reasons: [t('profit factor {pf} over its last {count} closed trades', { pf: num(profitFactor, 2, 2), count: STRATEGY_HEALTH_TRADES }), ...unlike] }
}

/** One line for the bot's card. */
export function describeStrategyHealth(health: StrategyHealth, expectation: StrategyTradeExpectation | null): string {
  if (health.verdict === 'not enough') return `Strategy health: not enough yet, ${health.closed} of ${STRATEGY_HEALTH_TRADES} closed trades.`
  const figures = `profit factor ${health.profitFactor === null ? 'no losing trade' : health.profitFactor.toFixed(2)}, win rate ${health.winRatePct?.toFixed(0)}%, hold ${describeHours(health.meanHoldHours ?? 0)}`
  if (health.verdict === 'unmeasured' || expectation === null) return `Strategy health: over its last ${STRATEGY_HEALTH_TRADES} closed trades ${figures}; nothing was measured for this strategy to set that against.`
  if (health.verdict === 'degraded') return `DEGRADED: ${health.reasons.join('; ')}. It keeps running on paper; a person stops it.`
  return `Strategy health: as measured. Over its last ${STRATEGY_HEALTH_TRADES} closed trades ${figures}; measured ${expectation.profitFactor.toFixed(2)}, ${expectation.winRatePct.toFixed(0)}%, ${describeHours(expectation.meanHoldHours)} over ${expectation.trades} trades.`
}
