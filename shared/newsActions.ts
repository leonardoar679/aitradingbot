import type { ExecutorConfig, HeldPosition, PaperAccount, PositionExecutorParams } from './ipc'
import type { ExchangeBalance } from './liveBalances'
import type { NewsItem } from './news'

// What a delisting announcement does, as the user chose on 2026-10-05 after research/NEWS.md: a
// desktop notice to someone holding the coin, and a PAPER short by the rule the study measured.
// (The third choice, putting it to the watch's models, goes through the watch.) The rules are here,
// pure; src/news/ does the reading and the one write.
//
// NOTHING REAL IS PLACED OR SOLD BECAUSE OF NEWS. The notice says what was announced and what such
// coins did, and that nothing has been sold. The short is paper, by a literal in the one file that
// makes it, and can never be anything else: this app places no short.

/** The rule research/NEWS.md measured on its held-out half: sell short at once, and buy back at the
 * open four hours after the announcement's minute, with no stop and no target. */
export const DELISTING_RULE_EXIT_MINUTES = 240

/** A paper short is opened only this soon after the announcement. Later, it is not the trade that
 * was measured: the study entered in the second minute after it. */
export const DELISTING_SHORT_LATEST_SECONDS = 5 * 60

/** A holder is told up to this long after an announcement: the fall went on for a day. */
export const DELISTING_NOTICE_LATEST_SECONDS = 24 * 3600

export type NewsShortMark = NonNullable<ExecutorConfig['newsRule']>

/** The paper shorts the rule opened. Only paper Positions carrying the mark: a live executor can
 * never carry one, and is never counted as one if it somehow did. */
export function newsShortExecutors(executors: ExecutorConfig[]): ExecutorConfig[] {
  return executors.filter((executor) => executor.newsRule !== undefined && executor.mode === 'paper' && executor.type === 'position')
}

/** The short's levels. Entered at the open of the first minute after it is opened (a paper
 * executor reads its candles from when it was made); its time limit is set so that it is out at
 * the open four hours after the announcement's minute, which is the close of the minute before. */
export function delistingShortParams(input: { releaseSec: number; createdAt: number; stakeQuote: number }): PositionExecutorParams {
  const announcementMinute = Math.floor(input.releaseSec / 60) * 60
  const entryMinute = Math.ceil(input.createdAt / 60) * 60
  return {
    side: 'sell',
    entryPrice: null,
    amountQuote: input.stakeQuote,
    takeProfitPct: null,
    stopLossPct: null,
    timeLimitSec: Math.max(60, announcementMinute + (DELISTING_RULE_EXIT_MINUTES - 1) * 60 - entryMinute),
    trailingStop: null
  }
}

/** Why the rule opens no paper short on this coin now, or null when it does. */
export function delistingShortBlock(input: { item: NewsItem; ticker: string; nowSec: number; executors: ExecutorConfig[] }): string | null {
  const { item, ticker, nowSec } = input
  if (item.category !== 'DELISTING' || !item.tickers.includes(ticker)) return 'It is not a delisting of this coin.'
  if (nowSec - item.releaseSec > DELISTING_SHORT_LATEST_SECONDS) return 'It was announced more than five minutes ago: a short now is not the trade that was measured.'
  if (newsShortExecutors(input.executors).some((executor) => executor.newsRule?.articleId === item.id && executor.newsRule.ticker === ticker)) {
    return 'The rule has already opened its short on this coin for this announcement.'
  }
  return null
}

function utcClock(sec: number): string {
  return new Date(sec * 1000).toISOString().slice(11, 16)
}

/** What an executor's card says about where a short of the rule's came from. */
export function describeNewsShortOrigin(mark: NewsShortMark): string {
  return `Opened by the news reader, with nobody pressing anything, on Binance's announcement at ${utcClock(mark.releaseSec)} UTC that it will delist ${mark.ticker}: a short held four hours by the rule research/NEWS.md measured. Paper.`
}

export function delistingShortNotice(item: NewsItem, ticker: string, params: PositionExecutorParams, quoteAsset: string): { title: string; body: string } {
  return {
    title: `Paper short: ${ticker}${quoteAsset}`,
    body: `Binance will delist ${ticker} (announced ${utcClock(item.releaseSec)} UTC). A paper short of ${params.amountQuote} ${quoteAsset} was opened by the rule, out four hours after the announcement. Paper: nothing real was placed.`
  }
}

/** What someone holds of one coin, each place in a few words: on Binance, on paper. */
export interface Holdings {
  /** Real balances on Binance, or null when there is no key to read them with or they could not be read. */
  live: ExchangeBalance[] | null
  paperAccount: PaperAccount | null
  heldPositions: HeldPosition[]
  executors: ExecutorConfig[]
}

function amount(value: number): string {
  return Number(value.toPrecision(6)).toLocaleString('en-US', { maximumFractionDigits: 8 })
}

export function heldPlaces(ticker: string, holdings: Holdings): string[] {
  const places: string[] = []
  const real = holdings.live?.find((row) => row.asset === ticker)
  if (real !== undefined && real.free + real.locked > 0) places.push(`${amount(real.free + real.locked)} ${ticker} on Binance`)
  const paper = holdings.paperAccount?.balances[ticker] ?? 0
  if (paper > 0) places.push(`${amount(paper)} ${ticker} in the paper account`)
  if (holdings.heldPositions.some((held) => held.baseAsset === ticker)) places.push(`a paper position in Inventory`)
  // A short of the rule's is not something held: it is on the other side.
  const running = holdings.executors.filter((executor) => executor.status === 'active' && executor.baseAsset === ticker && executor.newsRule === undefined)
  if (running.length > 0) places.push(`${running.length === 1 ? 'an executor' : `${running.length} executors`} running on ${ticker}`)
  return places
}

/** The notice to someone holding a coin Binance will delist, or null when they hold none of them. */
export function delistingHolderNotice(item: NewsItem, holdings: Holdings): { title: string; body: string } | null {
  if (item.category !== 'DELISTING') return null
  const held = item.tickers.map((ticker) => ({ ticker, places: heldPlaces(ticker, holdings) })).filter((entry) => entry.places.length > 0)
  if (held.length === 0) return null
  // The title of the announcement goes last: a notice is cut at 400 characters, and what must not
  // be cut is that nothing has been sold.
  return {
    title: `Binance will delist ${held.map((entry) => entry.ticker).join(', ')}, which you hold`,
    body:
      `You hold ${held.map((entry) => entry.places.join(' and ')).join('; ')}. Nothing has been sold. ` +
      `Coins Binance announced it would delist were on average 13% lower four hours later (research/NEWS.md). Announced ${utcClock(item.releaseSec)} UTC: "${item.title}"`
  }
}

/** Whether an announcement is one to act on now: a delisting this app read in this session, and not
 * so long after its release that the action is no longer the one chosen. */
export function isFreshDelisting(item: NewsItem, input: { sessionStartSec: number; nowSec: number; latestSeconds: number }): boolean {
  return item.category === 'DELISTING' && item.seenAt >= input.sessionStartSec && input.nowSec - item.releaseSec <= input.latestSeconds
}
