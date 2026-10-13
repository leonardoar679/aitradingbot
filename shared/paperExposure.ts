import { MARKET_REFERENCE_SYMBOLS } from './aiEventMarket'
import type { Candle, Exchange, ExecutorConfig, ExecutorSide, PaperAccount, PaperRiskSettings, PositionExecutorParams } from './ipc'
import { ownOpenPaperTrades } from './paperRisk'

// THE APP'S OWN PAPER TRADES ON ONE SIDE OF THE MARKET, ON COINS THAT MOVE WITH BITCOIN.
//
// Altcoins move with Bitcoin. Several trades open the same way on coins that track it closely are
// one bet on Bitcoin, however many pairs they are spread over. So since 6 October 2026 (the second
// V3 document, §24) the watch's and the news rules' paper trades open nothing that would take what
// they stake together -- on one side, on pairs whose hourly moves over the last seven days correlate
// with Bitcoin's at 0.7 or more -- past 15% of the paper account: what it was funded with in the
// quote asset, or, with no paper account, the money-out cap set on Risk & Safety.
//
// IT ONLY EVER OPENS LESS. A pair whose correlation could not be read counts as one that tracks
// Bitcoin, and so does a trade opened before this existed, which carries none. With neither an
// account nor a cap there is nothing to take 15% of, and nothing is refused. The line and the share
// are engineering defaults, written down here before any result was looked at.
//
// IT IS PAPER. Nothing here reaches an order.

/** A correlation with Bitcoin at or past this is a coin that tracks it. */
export const CORRELATED_LINE = 0.7
/** What the trades on one side, on such coins, may stake together: this share of the account. */
export const CORRELATED_SHARE = 0.15
/** The correlation is read over this many days of hourly bars. */
export const CORRELATION_DAYS = 7
/** Hourly returns both pairs need for a correlation to be read: most of the week's 168. */
const MIN_RETURNS = 120
const HOUR = 3600

/** The correlation of two pairs' hourly log returns over the closed hours both have, or null with
 * fewer than MIN_RETURNS of them, or with either flat. Bars oldest first. */
export function hourlyCorrelation(pair: readonly Candle[], btc: readonly Candle[]): number | null {
  const btcClose = new Map(btc.map((bar) => [bar.time, bar.close]))
  const xs: number[] = []
  const ys: number[] = []
  for (let k = 1; k < pair.length; k++) {
    const from = pair[k - 1]
    const to = pair[k]
    if (to.time - from.time !== HOUR) continue
    const btcFrom = btcClose.get(from.time)
    const btcTo = btcClose.get(to.time)
    if (btcFrom === undefined || btcTo === undefined || !(from.close > 0 && to.close > 0 && btcFrom > 0 && btcTo > 0)) continue
    xs.push(Math.log(to.close / from.close))
    ys.push(Math.log(btcTo / btcFrom))
  }
  if (xs.length < MIN_RETURNS) return null
  const mean = (values: number[]): number => values.reduce((sum, value) => sum + value, 0) / values.length
  const mx = mean(xs)
  const my = mean(ys)
  let sxy = 0
  let sxx = 0
  let syy = 0
  for (let k = 0; k < xs.length; k++) {
    sxy += (xs[k] - mx) * (ys[k] - my)
    sxx += (xs[k] - mx) ** 2
    syy += (ys[k] - my) ** 2
  }
  if (!(sxx > 0) || !(syy > 0)) return null
  return sxy / Math.sqrt(sxx * syy)
}

/** The span of hourly bars a correlation is read from, ending at the last hour closed by `nowSec`. */
export function correlationWindow(nowSec: number): { startSec: number; endSec: number } {
  const endSec = Math.floor(nowSec / HOUR) * HOUR
  return { startSec: endSec - CORRELATION_DAYS * 24 * HOUR - HOUR, endSec }
}

/** A pair's correlation with Bitcoin now, from hourly bars `fetchHourly` reads: null when either
 * cannot be read. Bitcoin's own pair is Bitcoin. */
export async function readBtcCorrelation(
  fetchHourly: (exchange: Exchange, symbol: string, startSec: number, endSec: number) => Promise<Candle[]>,
  exchange: Exchange,
  symbol: string,
  nowSec: number
): Promise<number | null> {
  if (symbol === MARKET_REFERENCE_SYMBOLS.btc) return 1
  const { startSec, endSec } = correlationWindow(nowSec)
  const closed = (bars: Candle[]): Candle[] => bars.filter((bar) => bar.time + HOUR <= nowSec)
  try {
    const [pair, btc] = await Promise.all([fetchHourly(exchange, symbol, startSec, endSec), fetchHourly(exchange, MARKET_REFERENCE_SYMBOLS.btc, startSec, endSec)])
    return hourlyCorrelation(closed(pair), closed(btc))
  } catch {
    return null
  }
}

/** Whether a pair tracks Bitcoin: a correlation at or past the line, or none read. */
export function tracksBtc(correlation: number | null | undefined): boolean {
  return correlation === null || correlation === undefined || correlation >= CORRELATED_LINE
}

/** The correlation written on one of the app's own paper trades when it was opened. */
function markedCorrelation(executor: ExecutorConfig): number | null | undefined {
  if (executor.watch !== undefined) return executor.watch.btcCorrelation
  return executor.newsRule !== undefined ? executor.newsRule.btcCorrelation : executor.forecast?.btcCorrelation
}

/** The share the setting holds them to: the risk mode's, or 0.15 as it was fixed before the modes. */
export function correlatedShareOf(risk: Pick<PaperRiskSettings, 'correlatedShare'>): number {
  const share = risk.correlatedShare
  return share !== undefined && Number.isFinite(share) && share > 0 && share < 1 ? share : CORRELATED_SHARE
}

/** What the app's own open paper trades on `side` stake together in `quoteAsset`, on pairs that
 * track Bitcoin. */
export function correlatedOut(executors: ExecutorConfig[], side: ExecutorSide, quoteAsset: string): number {
  let out = 0
  for (const executor of ownOpenPaperTrades(executors)) {
    const params = executor.params as PositionExecutorParams
    if (executor.quoteAsset !== quoteAsset || params.side !== side || !tracksBtc(markedCorrelation(executor))) continue
    // One malformed row must not turn the total into NaN, and with it let everything through.
    if (Number.isFinite(params.amountQuote) && params.amountQuote > 0) out += params.amountQuote
  }
  return out
}

/** What the paper account was funded with in `quoteAsset`; zero without an account, or a figure. */
function fundedWith(account: PaperAccount | null, quoteAsset: string): number {
  const funded = account?.initialBalances?.[quoteAsset]
  return funded !== undefined && Number.isFinite(funded) && funded > 0 ? funded : 0
}

/** The most those trades may stake together: CORRELATED_SHARE of what the paper account was funded
 * with in the quote asset, or of the money-out cap without an account; null with neither. */
export function correlatedCap(input: { account: PaperAccount | null; risk: PaperRiskSettings; quoteAsset: string }): number | null {
  const funded = fundedWith(input.account, input.quoteAsset)
  const share = correlatedShareOf(input.risk)
  if (funded > 0) return funded * share
  return input.risk.maxOutQuote === null ? null : input.risk.maxOutQuote * share
}

const shown = (amount: number): string => Number(amount.toFixed(2)).toLocaleString('en-US')

/** Why one more of the app's own paper trades is not opened, or null: on a pair that tracks
 * Bitcoin, it would take what they stake together on its side past the cap. */
export function correlatedExposureBlock(input: {
  account: PaperAccount | null
  risk: PaperRiskSettings
  executors: ExecutorConfig[]
  quoteAsset: string
  side: ExecutorSide
  amountQuote: number
  /** The new trade's pair's correlation with Bitcoin; null when it could not be read. */
  correlation: number | null
}): string | null {
  if (!tracksBtc(input.correlation)) return null
  const cap = correlatedCap(input)
  if (cap === null) return null
  const out = correlatedOut(input.executors, input.side, input.quoteAsset)
  // A hundredth of a cent of rounding is not over the cap.
  if (out + input.amountQuote <= cap + 1e-6) return null
  const way = input.side === 'buy' ? 'BUY' : 'SELL'
  const why =
    input.correlation === null
      ? "Its pair's correlation with Bitcoin could not be read, so it counts as one that moves with it"
      : `Its pair moves with Bitcoin (its hourly moves over ${CORRELATION_DAYS} days correlate at ${input.correlation.toFixed(2)})`
  const of = fundedWith(input.account, input.quoteAsset) > 0 ? 'what the paper account was funded with' : 'the money-out cap'
  return `${why}, and the app's open paper ${way}s on such pairs stake ${shown(out)} ${input.quoteAsset} together: ${shown(input.amountQuote)} more would take them past ${shown(cap)}, ${Math.round(correlatedShareOf(input.risk) * 100)}% of ${of}.`
}

/** The rule in a sentence, for Risk & Safety. */
export function describeCorrelatedExposure(input: { account: PaperAccount | null; risk: PaperRiskSettings; quoteAsset: string }): string {
  const cap = correlatedCap(input)
  const line = `On pairs whose hourly moves over ${CORRELATION_DAYS} days correlate with Bitcoin's at ${CORRELATED_LINE} or more, those open on one side stake at most ${Math.round(correlatedShareOf(input.risk) * 100)}%`
  if (cap === null) return `${line} of the paper account, or of the money-out cap; with neither, there is no such limit.`
  const of = fundedWith(input.account, input.quoteAsset) > 0 ? 'of what the paper account was funded with' : 'of the money-out cap'
  return `${line} ${of}: ${shown(cap)} ${input.quoteAsset} together.`
}
