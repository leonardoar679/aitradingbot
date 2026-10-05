import type { Candle, ExecutorConfig, HeldPosition, PaperAccount, PositionExecutorParams } from './ipc'
import type { ExchangeBalance } from './liveBalances'
import { EVENT_LOOKBACK_BARS, readEventAt, type EventReading } from './marketEvent'
import { isActedNewsCategory, type NewsItem } from './news'
import { BRACKET_HOLD_BARS, BRACKET_STOP_SIGMAS, BRACKET_TARGET_SIGMAS, HOLD_EXIT_BARS } from './newsRules'

// What an announcement does, as the user chose on 2026-10-05 after research/NEWS.md, for the two
// kinds that passed -- a delisting, and a coin added to Binance's Monitoring Tag: a desktop notice
// to someone holding the coin, and a PAPER short by the rule the study measured for the kind. (The
// third choice, putting it to the watch's models, goes through the watch.) The rules are here,
// pure; src/news/ does the reading and the one write.
//
// NOTHING REAL IS PLACED OR SOLD BECAUSE OF NEWS. The notice says what was announced and what such
// coins did, and that nothing has been sold. The short is paper, by a literal in the one file that
// makes it, and can never be anything else: this app places no short.

/** A delisting's rule, as research/NEWS.md measured it on its held-out half: sell short at once,
 * and buy back at the open four hours after the announcement's minute, with no stop and no target. */
export const DELISTING_RULE_EXIT_MINUTES = HOLD_EXIT_BARS

/** A delisting's paper short is opened only this soon after the announcement. Later, it is not the
 * trade that was measured: the study entered in the second minute after it. */
export const DELISTING_SHORT_LATEST_SECONDS = 5 * 60

/** A Monitoring Tag's rule, the bracket every study here has used, as research/NEWS.md measured it:
 * short at the open of the second minute after the announcement's, with a stop 1.5 and a target 3
 * of the coin's usual fifteen-minute moves, read from the twelve hours before the announcement; out
 * at the close of its sixtieth minute otherwise. */
export const TAG_RULE_STOP_SIGMAS = BRACKET_STOP_SIGMAS
export const TAG_RULE_TARGET_SIGMAS = BRACKET_TARGET_SIGMAS
export const TAG_RULE_HOLD_MINUTES = BRACKET_HOLD_BARS

/** A holder is told up to this long after an announcement: the fall went on for a day, after a
 * delisting and after a tag. */
export const NEWS_NOTICE_LATEST_SECONDS = 24 * 3600

export type NewsShortMark = NonNullable<ExecutorConfig['newsRule']>

/** The paper shorts the rules opened. Only paper Positions carrying the mark: a live executor can
 * never carry one, and is never counted as one if it somehow did. */
export function newsShortExecutors(executors: ExecutorConfig[]): ExecutorConfig[] {
  return executors.filter((executor) => executor.newsRule !== undefined && executor.mode === 'paper' && executor.type === 'position')
}

/** A delisting's short. Entered at the open of the first minute after it is opened (a paper
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

/** The seconds a Monitoring Tag's short may be opened in. A paper executor enters at the open of
 * the first minute that begins once it is made, and the rule enters at the second minute after the
 * announcement's: so it is made after the first of those has begun, and by the time the second
 * does. */
export function tagShortWindow(releaseSec: number): { fromSec: number; toSec: number } {
  const announcementMinute = Math.floor(releaseSec / 60) * 60
  return { fromSec: announcementMinute + 61, toSec: announcementMinute + 120 }
}

/** The 1-minute candles a tag's short reads the coin's usual move from: the twelve hours that end
 * with the minute before the announcement's, as research/news.ts read it. */
export function tagReadingWindow(releaseSec: number): { startSec: number; endSec: number } {
  const before = Math.floor(releaseSec / 60) * 60 - 60
  return { startSec: before - (EVENT_LOOKBACK_BARS - 1) * 60, endSec: before + 59 }
}

/** The coin's reading at the minute before the announcement's, or null when the candles do not
 * hold twelve unbroken hours up to it. */
export function tagReading(bars: Candle[], releaseSec: number): EventReading | null {
  const before = Math.floor(releaseSec / 60) * 60 - 60
  const index = bars.findIndex((bar) => bar.time === before)
  return index < 0 ? null : readEventAt(bars, index)
}

/** A Monitoring Tag's short: its stop and target from the coin's usual fifteen-minute move, out at
 * the close of its sixtieth minute. */
export function tagShortParams(input: { sigma15Pct: number; stakeQuote: number }): PositionExecutorParams {
  return {
    side: 'sell',
    entryPrice: null,
    amountQuote: input.stakeQuote,
    takeProfitPct: TAG_RULE_TARGET_SIGMAS * input.sigma15Pct,
    stopLossPct: TAG_RULE_STOP_SIGMAS * input.sigma15Pct,
    timeLimitSec: (TAG_RULE_HOLD_MINUTES - 1) * 60,
    trailingStop: null
  }
}

/** Why the rule opens no paper short on this coin now, or null when it does. */
export function newsShortBlock(input: { item: NewsItem; ticker: string; nowSec: number; executors: ExecutorConfig[] }): string | null {
  const { item, ticker, nowSec } = input
  if (!isActedNewsCategory(item.category) || !item.tickers.includes(ticker)) return 'It is not a delisting or a Monitoring Tag of this coin.'
  if (item.category === 'DELISTING' && nowSec - item.releaseSec > DELISTING_SHORT_LATEST_SECONDS) {
    return 'It was announced more than five minutes ago: a short now is not the trade that was measured.'
  }
  if (item.category === 'MONITORING_TAG') {
    const opens = tagShortWindow(item.releaseSec)
    if (nowSec < opens.fromSec) return 'It is too soon: the rule enters at the second minute after the announcement.'
    if (nowSec > opens.toSec) return 'It is too late to enter at the second minute after the announcement, which is the trade that was measured.'
  }
  if (newsShortExecutors(input.executors).some((executor) => executor.newsRule?.articleId === item.id && executor.newsRule.ticker === ticker)) {
    return 'The rule has already opened its short on this coin for this announcement.'
  }
  return null
}

function utcClock(sec: number): string {
  return new Date(sec * 1000).toISOString().slice(11, 16)
}

function pct(value: number | null): string {
  return `${(value ?? 0).toFixed(2)}%`
}

/** What an executor's card says about where a short of a rule's came from. A mark with no kind on
 * it is a delisting's: it was made before the tag was read. */
export function describeNewsShortOrigin(mark: NewsShortMark): string {
  const at = utcClock(mark.releaseSec)
  return mark.category === 'MONITORING_TAG'
    ? `Opened by the news reader, with nobody pressing anything, on Binance's announcement at ${at} UTC that it adds ${mark.ticker} to its Monitoring Tag: a short with a stop and a target, out within the hour, by the rule research/NEWS.md measured. Paper.`
    : `Opened by the news reader, with nobody pressing anything, on Binance's announcement at ${at} UTC that it will delist ${mark.ticker}: a short held four hours by the rule research/NEWS.md measured. Paper.`
}

export function newsShortNotice(item: NewsItem, ticker: string, params: PositionExecutorParams, quoteAsset: string): { title: string; body: string } {
  const at = utcClock(item.releaseSec)
  const opened = `A paper short of ${params.amountQuote} ${quoteAsset} was opened by the rule`
  return {
    title: `Paper short: ${ticker}${quoteAsset}`,
    body:
      item.category === 'MONITORING_TAG'
        ? `Binance added ${ticker} to its Monitoring Tag (announced ${at} UTC). ${opened}: a stop ${pct(params.stopLossPct)} above, a target ${pct(params.takeProfitPct)} below, out within the hour. Paper: nothing real was placed.`
        : `Binance will delist ${ticker} (announced ${at} UTC). ${opened}, out four hours after the announcement. Paper: nothing real was placed.`
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
  // A short of a rule's is not something held: it is on the other side.
  const running = holdings.executors.filter((executor) => executor.status === 'active' && executor.baseAsset === ticker && executor.newsRule === undefined)
  if (running.length > 0) places.push(`${running.length === 1 ? 'an executor' : `${running.length} executors`} running on ${ticker}`)
  return places
}

/** The notice to someone holding a coin Binance will delist, or has added to its Monitoring Tag;
 * null when they hold none of the coins, or for any other kind of news. */
export function newsHolderNotice(item: NewsItem, holdings: Holdings): { title: string; body: string } | null {
  if (!isActedNewsCategory(item.category)) return null
  const held = item.tickers.map((ticker) => ({ ticker, places: heldPlaces(ticker, holdings) })).filter((entry) => entry.places.length > 0)
  if (held.length === 0) return null
  const names = held.map((entry) => entry.ticker).join(', ')
  // The title of the announcement goes last: a notice is cut at 400 characters, and what must not
  // be cut is that nothing has been sold.
  const where = `You hold ${held.map((entry) => entry.places.join(' and ')).join('; ')}. Nothing has been sold. `
  const announced = `Announced ${utcClock(item.releaseSec)} UTC: "${item.title}"`
  return item.category === 'MONITORING_TAG'
    ? {
        title: `Binance's Monitoring Tag now includes ${names}, which you hold`,
        body: `${where}Coins Binance added to the tag were on average 12% lower a day later, and 84 of 97 were later delisted (research/NEWS.md). ${announced}`
      }
    : {
        title: `Binance will delist ${names}, which you hold`,
        body: `${where}Coins Binance announced it would delist were on average 13% lower four hours later (research/NEWS.md). ${announced}`
      }
}

/** Whether an announcement is one to act on now: a delisting or a tag this app read in this
 * session, and not so long after its release that the action is no longer the one chosen. */
export function isFreshNews(item: NewsItem, input: { sessionStartSec: number; nowSec: number; latestSeconds: number }): boolean {
  return isActedNewsCategory(item.category) && item.seenAt >= input.sessionStartSec && input.nowSec - item.releaseSec <= input.latestSeconds
}

// ---------------------------------------------------------------------------------------------
// The models: a delisting, or a coin added to the Monitoring Tag, raised as an event the watch puts
// to them (shared/aiContext.ts, buildNewsEventContext). The main process raises it from an
// announcement it read itself, and puts the question only about an announcement it read itself.

/** An announcement is raised as an event only this soon after its release: the event is the market
 * at the minute it was read, and an announcement read later is history, not news. */
export const NEWS_EVENT_LATEST_SECONDS = 5 * 60

/** A question about an announcement's event may be about a minute from just before its release to
 * this long after it, and no other. */
export const NEWS_QUESTION_LATEST_SECONDS = 30 * 60

/** Whether a delisting or a tag the reader has just kept is raised as an event: released, and read,
 * only minutes ago. One kept the first time the reader is switched on is history. */
export function shouldRaiseNewsEvent(item: NewsItem, nowSec: number): boolean {
  return isActedNewsCategory(item.category) && nowSec - item.releaseSec <= NEWS_EVENT_LATEST_SECONDS && item.seenAt - item.releaseSec <= NEWS_EVENT_LATEST_SECONDS
}

/** The event type, and the kind a model is shown, of an announcement that raises one. */
export function newsEventKind(item: NewsItem): 'delisting' | 'monitoring_tag' | null {
  return item.category === 'DELISTING' ? 'delisting' : item.category === 'MONITORING_TAG' ? 'monitoring_tag' : null
}

/** Why a question about `symbol` at the minute `eventTime` may not be put with this announcement in
 * it, or null when it may. `item` is the main process's own record of the article, or null when it
 * has none: a question cannot bring its own announcement. */
export function newsQuestionProblem(item: NewsItem | null, symbol: string, eventTime: number): string | null {
  if (item === null) return 'This app has read no such announcement.'
  if (!isActedNewsCategory(item.category)) return 'Only a delisting or a Monitoring Tag is put to the models.'
  if (!item.tickers.some((ticker) => `${ticker}USDT` === symbol)) return `The announcement does not name ${symbol}.`
  if (eventTime < item.releaseSec - 120 || eventTime > item.releaseSec + NEWS_QUESTION_LATEST_SECONDS) return 'The question is not about the minutes after the announcement.'
  return null
}
