import { ENGLISH, type I18n } from './i18n/translate'
import type { Candle } from './ipc'

// RISK BY THE CONDITIONS (the V5 document, §46-47 and §72-73; V5 Stage 7, 8 October 2026). What the
// app's own paper trades risk, and what a real order filled in from a call is suggested to stake,
// fall with the conditions a trade is entered in: the whole risk per trade, six tenths of it, or
// none -- NO TRADE -- with the reasons said. Five conditions are read:
//
// - VOLATILITY: the pair's average true range over its last fourteen fifteen-minute bars, as a
//   share of the price, against the usual of that figure over thirty days. At one and a half times
//   its usual the risk is reduced; at three times, no trade is made.
// - THE SPREAD: at a twentieth of a percent or more the risk is reduced (a trade is refused at a
//   tenth, shared/liveMarket.ts, as before).
// - LIQUIDITY: the best level of the book must hold the stake three times over, or the risk is
//   reduced (a level that cannot hold it once refuses the trade, as before).
// - DISAGREEMENT: a vote that passed with a usable answer not on the side taken reduces it.
// - CORRELATED EXPOSURE: what the app's own paper trades already have out on this side, on coins
//   that move with Bitcoin, over a tenth of the paper money reduces it (the cap is at 15%).
//
// Each line is a pinned constant, shown on the effective-configuration card; nothing here is a
// setting, and nothing here reads a file or a stream: it is given its inputs. A condition that
// could not be read is no reason: the risk only ever falls on what was read.

export const RISK_LINES = {
  /** The bars the average true range is read over, on fifteen-minute candles. */
  atrBars: 14,
  /** The days the usual range is read over, and the windows it needs at least. */
  usualDays: 30,
  usualWindows: 10,
  /** The range now over its usual: at this the risk is reduced; at the extreme, no trade. */
  volatilityHigh: 1.5,
  volatilityExtreme: 3,
  /** The spread, in percent, at or over which the risk is reduced. */
  spreadPct: 0.05,
  /** The best level must hold the stake this many times over, or the risk is reduced. */
  liquidityCover: 3,
  /** The share of the paper money already out on one side, on coins that move with Bitcoin, over
   * which the risk is reduced. */
  correlatedShare: 0.1,
  /** What the risk is reduced to. */
  reduced: 0.6
} as const

export const FIFTEEN_MINUTES = 15 * 60

export interface RiskConditions {
  /** The range now over its usual (volatilityRatio); null where it could not be read. */
  volatilityRatio: number | null
  /** The live spread, in percent; null with no book. */
  spreadPct: number | null
  /** What the best level holds in the quote, over the stake; null with no book or no stake. */
  liquidityCover: number | null
  /** A vote that passed with a usable answer not on the side taken; null with no vote. */
  dissent: boolean | null
  /** The app's own paper trades' stake out on this side on coins that move with Bitcoin, as a
   * share of the paper money; null where the pair does not move with Bitcoin, or there is no cap. */
  correlatedShare: number | null
}

export interface RiskMultiplier {
  factor: 0 | 0.6 | 1
  /** Why, one a condition; none at the whole risk. */
  reasons: string[]
}

const read = (value: number | null): value is number => value !== null && Number.isFinite(value)

/** The factor on the risk per trade, and why: none at extreme volatility, six tenths with any
 * other condition against it, else the whole. Its reasons in English, as recorded, unless handed a
 * language (V6 Stage 14). */
export function riskMultiplier(conditions: RiskConditions, i18n: I18n = ENGLISH): RiskMultiplier {
  const { t, num } = i18n
  const times = (value: number): string => t('{ratio}× its usual', { ratio: num(value, 1, 1) })
  const { volatilityRatio: ratio } = conditions
  if (read(ratio) && ratio >= RISK_LINES.volatilityExtreme) return { factor: 0, reasons: [t('extreme volatility, {times}', { times: times(ratio) })] }
  const reasons: string[] = []
  if (read(ratio) && ratio >= RISK_LINES.volatilityHigh) reasons.push(t('high volatility, {times}', { times: times(ratio) }))
  if (read(conditions.spreadPct) && conditions.spreadPct >= RISK_LINES.spreadPct) reasons.push(t('a spread of {spread}', { spread: i18n.pctPlain(conditions.spreadPct, 3) }))
  if (read(conditions.liquidityCover) && conditions.liquidityCover < RISK_LINES.liquidityCover) reasons.push(t('the best level covers the stake {count} times', { count: num(conditions.liquidityCover, 1, 1) }))
  if (conditions.dissent === true) reasons.push(t('a model would not take it'))
  if (read(conditions.correlatedShare) && conditions.correlatedShare > RISK_LINES.correlatedShare) {
    reasons.push(t('{share} of the paper money already out on this side on coins that move with Bitcoin', { share: i18n.pctPlain(Math.round(conditions.correlatedShare * 100), 0) }))
  }
  return reasons.length === 0 ? { factor: 1, reasons: [] } : { factor: RISK_LINES.reduced, reasons }
}

/** The reasons in one breath: "high volatility, 1.8× its usual; a spread of 0.060%". */
export function riskReasonsText(multiplier: Pick<RiskMultiplier, 'reasons'>, { t }: I18n = ENGLISH): string {
  return multiplier.reasons.join(t('; '))
}

/** Why no trade is made at the conditions, or null: the one condition that refuses. */
export function riskRefusal(multiplier: RiskMultiplier, i18n: I18n = ENGLISH): string | null {
  return multiplier.factor === 0 ? i18n.t('The conditions allow no trade: {reasons}.', { reasons: riskReasonsText(multiplier, i18n) }) : null
}

/** The average true range of the last `n` bars, as a percent of the last close: each bar's range
 * widened to the previous close where it gapped. Null with fewer than `n` bars and the one before
 * them, or a bar that cannot be read. */
export function atrPct(bars: readonly Candle[], n: number = RISK_LINES.atrBars): number | null {
  if (!(n > 0) || bars.length < n + 1) return null
  const tail = bars.slice(-(n + 1))
  let sum = 0
  for (let i = 1; i < tail.length; i++) {
    const bar = tail[i]
    const previous = tail[i - 1].close
    if (!(bar.high >= bar.low) || !(previous > 0)) return null
    sum += Math.max(bar.high - bar.low, Math.abs(bar.high - previous), Math.abs(bar.low - previous))
  }
  const last = tail[tail.length - 1].close
  return last > 0 ? (sum / n / last) * 100 : null
}

/** The usual of that figure over the bars given: the median of the average true range read over
 * consecutive windows of `n` bars, newest first. Null with fewer windows than the usual needs. */
export function usualAtrPct(bars: readonly Candle[], n: number = RISK_LINES.atrBars): number | null {
  const values: number[] = []
  for (let end = bars.length; end - (n + 1) >= 0; end -= n) {
    const value = atrPct(bars.slice(end - (n + 1), end), n)
    if (value !== null) values.push(value)
  }
  if (values.length < RISK_LINES.usualWindows) return null
  values.sort((a, b) => a - b)
  const mid = Math.floor(values.length / 2)
  return values.length % 2 === 1 ? values[mid] : (values[mid - 1] + values[mid]) / 2
}

/** The range now over its usual, from fifteen-minute bars reaching back the usual's days: the
 * last `n` closed bars against the median window. A forming bar is left out. Null where either
 * cannot be read. */
export function volatilityRatio(bars: readonly Candle[], nowSec: number, n: number = RISK_LINES.atrBars): number | null {
  const closed = bars.filter((bar) => bar.time + FIFTEEN_MINUTES <= nowSec)
  const now = atrPct(closed, n)
  const usual = usualAtrPct(closed, n)
  if (now === null || usual === null || !(usual > 0)) return null
  return now / usual
}

/** What the best level holds in the quote, over the stake: the ask for a buy, the bid for a sell. */
export function liquidityCoverOf(book: { bid: number; ask: number; bidQty: number; askQty: number } | null, side: 'buy' | 'sell', stakeQuote: number): number | null {
  if (book === null || !(stakeQuote > 0)) return null
  const held = side === 'buy' ? book.ask * book.askQty : book.bid * book.bidQty
  return Number.isFinite(held) && held >= 0 ? held / stakeQuote : null
}
