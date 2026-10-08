import { FEE_RATE, positionSlippageRate } from './fees'
import type { ExecutorConfig, PaperAccount, PaperRiskSettings, PositionExecutorParams } from './ipc'

// THE PAPER TRADES THE APP OPENS BY ITSELF: HOW BIG EACH IS, AND HOW MUCH THEY HAVE OUT TOGETHER.
//
// Two things open paper positions with nobody pressing anything: the watch (shared/aiWatchPaper.ts)
// and the news rules (shared/newsActions.ts). Each has a stake, set where it is switched on. Since
// 5 October 2026, when the user chose it, two settings bound them, kept in settings.json as
// `paperRisk` and set on Risk & Safety:
//
// - SIZED BY RISK. A trade with a stop stakes what would lose about the risk per trade if the stop
//   is hit, after the fees of a round trip, and never more than its own stake: the stake becomes
//   the most it stakes. So a far stop stakes less, and a near one up to the stake. A delisting's
//   short has no stop, and stakes its stake. A trade sized under what an order on Binance must be
//   worth is not opened: it could not have been placed for real.
// - MONEY OUT. The watch and the news rules open nothing that would take what their open paper
//   trades stake together past this, in one quote asset. Trades made by hand on Strategies ›
//   Execution are not counted: what a person opens is theirs to judge. Nor are the bots: a bot's
//   run is a replay of its strategy, measured in percent, and holds no paper money.
//
// - SIZED BY A SHARE OF THE PAPER ACCOUNT (since 8 October 2026; the V4 document, §35-36): as by
//   risk, with the risk per trade a share of the paper account's equity in the trade's quote -- its
//   balance and what the app's own open paper trades have out. With no paper account, or none in
//   that quote, the fixed risk per trade stands, so a fresh install sizes as before.
//
// BOTH ONLY EVER OPEN LESS. A trade sized by risk stakes at most what its feature was switched on
// with, and the cap only refuses. So neither is a term the watch's confirmation names again, and
// either may be changed at any time.
//
// IT IS PAPER. Nothing here reaches an order.

export const PAPER_RISK_CHOICES = [1, 2, 5, 10, 25, 50] as const
export const PAPER_MAX_OUT_CHOICES = [250, 500, 1000, 2500, 5000, 10000] as const
/** Of the paper account's equity, in percent, what one trade may risk at its stop. */
export const PAPER_RISK_PCT_CHOICES = [0.1, 0.25, 0.5, 1, 2] as const
/** Binance's smallest order on a USDT pair -- what the app's own paper trades are on -- is worth 5
 * USDT. */
export const PAPER_MIN_STAKE = 5

/** What applies until it is changed: each trade with a stop risks about 1 at it, a hundredth of the
 * watch's and the news rules' default stake of 100, and together they stake at most 1,000. Against
 * the stops the models have given (a median of 1% from the entry), a stake of 100 is then held to
 * 100 only for a stop nearer than about 0.8%. */
export const DEFAULT_PAPER_RISK: PaperRiskSettings = { sizing: 'risk', riskQuote: 1, riskPct: 0.25, maxOutQuote: 1000 }

function isRiskChoice(value: unknown): value is number {
  return (PAPER_RISK_CHOICES as readonly unknown[]).includes(value)
}

function isMaxOutChoice(value: unknown): value is number {
  return (PAPER_MAX_OUT_CHOICES as readonly unknown[]).includes(value)
}

function isRiskPctChoice(value: unknown): value is number {
  return (PAPER_RISK_PCT_CHOICES as readonly unknown[]).includes(value)
}

/** A stored setting, read as one: settings.json is written by the renderer, so it is healed rather
 * than obeyed. A field that is not one of its choices takes its default. No cap is a choice of its
 * own, stored as null; a file written before the setting existed holds nothing, and has the cap. */
export function healPaperRisk(value: unknown): PaperRiskSettings {
  const raw = (typeof value === 'object' && value !== null && !Array.isArray(value) ? value : {}) as Partial<Record<keyof PaperRiskSettings, unknown>>
  return {
    sizing: raw.sizing === 'risk' || raw.sizing === 'stake' || raw.sizing === 'equity' ? raw.sizing : DEFAULT_PAPER_RISK.sizing,
    riskQuote: isRiskChoice(raw.riskQuote) ? raw.riskQuote : DEFAULT_PAPER_RISK.riskQuote,
    riskPct: isRiskPctChoice(raw.riskPct) ? raw.riskPct : DEFAULT_PAPER_RISK.riskPct,
    maxOutQuote: raw.maxOutQuote === null ? null : isMaxOutChoice(raw.maxOutQuote) ? raw.maxOutQuote : DEFAULT_PAPER_RISK.maxOutQuote
  }
}

/** Why a setting cannot be saved, or null when it can. */
export function paperRiskProblem(settings: PaperRiskSettings): string | null {
  if (settings.sizing !== 'risk' && settings.sizing !== 'stake' && settings.sizing !== 'equity') {
    return 'A paper trade is sized by the risk at its stop, by a share of the paper account, or by its stake'
  }
  if (!isRiskChoice(settings.riskQuote)) return `A paper trade risks ${PAPER_RISK_CHOICES.join(', ')} at its stop`
  if (!isRiskPctChoice(settings.riskPct)) return `A paper trade risks ${PAPER_RISK_PCT_CHOICES.join(', ')}% of the paper account at its stop`
  if (settings.maxOutQuote !== null && !isMaxOutChoice(settings.maxOutQuote)) {
    return `The app's own paper trades stake at most ${PAPER_MAX_OUT_CHOICES.join(', ')} together, or have no cap`
  }
  return null
}

const shown = (amount: number): string => Number(amount.toFixed(2)).toLocaleString('en-US')

/** The paper account's equity in one quote asset: its balance in it, and what the app's own open
 * paper trades have out in it (their stakes left the balance when they opened). Null with no
 * account, or nothing in that asset: then there is no equity to take a share of. */
export function paperEquity(account: Pick<PaperAccount, 'balances'> | null | undefined, executors: ExecutorConfig[], quoteAsset: string): number | null {
  if (account === null || account === undefined) return null
  const balance = account.balances[quoteAsset]
  const held = Number.isFinite(balance) ? Math.max(0, balance) : 0
  const equity = held + paperOut(executors, quoteAsset)
  return equity > 0 ? equity : null
}

/** What one trade risks at its stop: the fixed risk, or, sized by a share of the paper account, that
 * share of its equity -- and the fixed risk again where there is no equity to measure. */
export function riskPerTrade(risk: PaperRiskSettings, equityQuote: number | null | undefined): number {
  if (risk.sizing !== 'equity' || equityQuote === null || equityQuote === undefined || !(equityQuote > 0)) return risk.riskQuote
  return Math.round(((equityQuote * risk.riskPct) / 100) * 100) / 100
}

/** What a trade stakes: its own stake, or, sized by risk or by a share of the paper account, what
 * loses about the risk per trade at a stop `stopPct` away after the round trip's fees and its
 * slippage (`slippageRate`, on both fills), rounded down to a hundredth -- never more than its own
 * stake. A trade with no stop stakes its stake. `equityQuote` is the paper account's equity
 * (paperEquity), read by the share; absent or null, the fixed risk stands. */
export function paperStake(input: { risk: PaperRiskSettings; stakeQuote: number; stopPct: number | null; slippageRate?: number | null; equityQuote?: number | null }): number {
  const { risk, stakeQuote, stopPct } = input
  if (risk.sizing === 'stake' || stopPct === null || !(stopPct > 0)) return stakeQuote
  const lostPerQuote = stopPct / 100 + 2 * FEE_RATE + 2 * positionSlippageRate(input)
  return Math.min(stakeQuote, Math.floor((riskPerTrade(risk, input.equityQuote) / lostPerQuote) * 100) / 100)
}

export type PaperSize = { ok: true; amountQuote: number } | { ok: false; reason: string }

/** What a trade stakes, or why it is not opened: sized under what an order on Binance must be
 * worth. */
export function sizePaperTrade(input: { risk: PaperRiskSettings; stakeQuote: number; stopPct: number | null; quoteAsset: string; slippageRate?: number | null; equityQuote?: number | null }): PaperSize {
  const amountQuote = paperStake(input)
  if (amountQuote >= PAPER_MIN_STAKE) return { ok: true, amountQuote }
  return {
    ok: false,
    reason: `Its stop is ${shown(input.stopPct ?? 0)}% away, so risking ${shown(riskPerTrade(input.risk, input.equityQuote))} ${input.quoteAsset} there stakes ${shown(amountQuote)} ${input.quoteAsset}: under the ${PAPER_MIN_STAKE} the smallest order on Binance is worth.`
  }
}

/** What being stopped out would have lost, in the trade's quote: its stake times the distance to its
 * stop, a round trip's fees and, for a trade that carries a slippage rate, that on both fills. What a
 * trade sized by risk stakes is this, solved for the stake. Null for a trade with no stop -- a
 * delisting's short -- which has nothing to measure against. */
export function riskedAtStop(params: Pick<PositionExecutorParams, 'amountQuote' | 'stopLossPct' | 'slippageRate'>): number | null {
  if (params.stopLossPct === null || !(params.stopLossPct > 0) || !(params.amountQuote > 0)) return null
  return params.amountQuote * (params.stopLossPct / 100 + 2 * FEE_RATE + 2 * positionSlippageRate(params))
}

/** What a closed trade made in what it risked at its stop: its R. +1 is a win as large as the loss
 * its stop allowed; -1 is that loss. Null for a trade with no stop. */
export function rMultiple(pnlQuote: number, params: Pick<PositionExecutorParams, 'amountQuote' | 'stopLossPct' | 'slippageRate'>): number | null {
  const risked = riskedAtStop(params)
  return risked === null ? null : pnlQuote / risked
}

/** "+1.00 R", "-0.50 R". */
export function describeR(r: number): string {
  return `${r > 0 ? '+' : ''}${r.toFixed(2)} R`
}

/** The app's own open paper trades: the watch's and the news rules', each a paper Position carrying
 * its mark. An executor that is not paper is never one of them, whatever it carries. */
export function ownOpenPaperTrades(executors: ExecutorConfig[]): ExecutorConfig[] {
  return executors.filter(
    (executor) =>
      executor.status === 'active' && executor.mode === 'paper' && executor.type === 'position' && (executor.watch !== undefined || executor.newsRule !== undefined)
  )
}

/** What the app's own open paper trades stake together, in `quoteAsset`. */
export function paperOut(executors: ExecutorConfig[], quoteAsset: string): number {
  let out = 0
  for (const executor of ownOpenPaperTrades(executors)) {
    if (executor.quoteAsset !== quoteAsset) continue
    const amount = (executor.params as PositionExecutorParams).amountQuote
    // One malformed row must not turn the total into NaN, and with it let everything through.
    if (Number.isFinite(amount) && amount > 0) out += amount
  }
  return out
}

/** Why one more of the app's own paper trades, staking `amountQuote`, is not opened, or null: it
 * would take what they have out together past the cap. */
export function paperOutBlock(input: { risk: PaperRiskSettings; executors: ExecutorConfig[]; quoteAsset: string; amountQuote: number }): string | null {
  const cap = input.risk.maxOutQuote
  if (cap === null) return null
  const out = paperOut(input.executors, input.quoteAsset)
  // A hundredth of a cent of rounding is not over the cap.
  if (out + input.amountQuote <= cap + 1e-6) return null
  return `The watch's and the news rules' open paper trades stake ${shown(out)} ${input.quoteAsset} together, and ${shown(input.amountQuote)} more would take them past the ${shown(cap)} set on Risk & Safety.`
}

/** The setting in a sentence, as it is set. */
export function describePaperRisk(risk: PaperRiskSettings): string {
  const sizing =
    risk.sizing === 'risk'
      ? `Each with a stop stakes what would lose about ${risk.riskQuote} there, after fees, and never more than its own stake.`
      : risk.sizing === 'equity'
        ? `Each with a stop stakes what would lose about ${risk.riskPct}% of the paper account's equity there, after fees, and never more than its own stake; without a paper account, about ${risk.riskQuote}.`
        : 'Each stakes its own stake.'
  const out = risk.maxOutQuote === null ? 'There is no cap on what they stake together.' : `Together they stake at most ${shown(risk.maxOutQuote)}.`
  return `${sizing} ${out}`
}
