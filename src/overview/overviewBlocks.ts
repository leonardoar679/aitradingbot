import type { NewsReading } from '../../shared/aiAdditions'
import { opportunitySide } from '../../shared/aiOpportunity'
import type { ExecutorConfig, PositionExecutorParams } from '../../shared/ipc'
import { isAtLeast } from '../../shared/marketEvent'
import type { ReadStory, StoryReaction } from '../../shared/newsFeed'
import { rMultiple } from '../../shared/paperRisk'
import type { EventAnswer, EventFeedItem } from '../agents/opportunities'
import type { AlertRecord } from '../news/alertStore'

// OVERVIEW IN FIVE SECONDS (the second V3 document, §51): the blocks the landing page shows after
// the market's status and the best opportunity -- the last hour's events, the news that matters, and
// what the app's own paper trades did today -- as plain selections over what the app already holds.
//
// THEY READ. Nothing here asks a model, opens a trade or writes anything; a block is a view of the
// scanner's events, the alerts raised this session, the stories on file and the executors.

/** Events this recent are breaking. */
export const BREAKING_SECONDS = 3600
export const BREAKING_SHOWN = 5
/** Stories this recent are news that still matters. */
export const NEWS_IMPACT_SECONDS = 6 * 3600
export const NEWS_IMPACT_SHOWN = 5

/** The last hour's events at candidate or above, strongest first, with the answers held for them. */
export function breakingEvents(feed: readonly EventFeedItem[], nowSec: number, shown = BREAKING_SHOWN): EventFeedItem[] {
  return feed
    .filter((item) => item.event.time >= nowSec - BREAKING_SECONDS && item.event.time <= nowSec && isAtLeast(item.event.band, 'candidate'))
    .sort((a, b) => b.event.score - a.event.score || b.event.time - a.event.time)
    .slice(0, shown)
}

export interface AnswerTally {
  long: number
  short: number
  none: number
  refused: number
}

/** What the models said about an event, counted by side. */
export function tallyAnswers(answers: readonly EventAnswer[]): AnswerTally {
  const tally: AnswerTally = { long: 0, short: 0, none: 0, refused: 0 }
  for (const answer of answers) {
    if (answer.decision.rejected) tally.refused++
    else {
      const side = opportunitySide(answer.decision)
      if (side === 'long') tally.long++
      else if (side === 'short') tally.short++
      else tally.none++
    }
  }
  return tally
}

export function describeTally(tally: AnswerTally): string {
  const parts: string[] = []
  if (tally.long > 0) parts.push(`${tally.long} BUY`)
  if (tally.short > 0) parts.push(`${tally.short} SELL`)
  if (tally.none > 0) parts.push(`${tally.none} NO TRADE`)
  if (tally.refused > 0) parts.push(`${tally.refused} refused`)
  return parts.length === 0 ? 'no answer yet' : parts.join(', ')
}

/** The alerts of this session at HIGH or above, newest first, as the store keeps them. */
export function majorAlerts(alerts: readonly AlertRecord[], shown = BREAKING_SHOWN): AlertRecord[] {
  return alerts.filter((alert) => alert.severity === 'high' || alert.severity === 'critical').slice(0, shown)
}

export interface NewsImpactRow {
  story: ReadStory
  /** The news analyst's reading of it, where it read it. */
  reading: NewsReading | null
  /** What the price did after, where it has been measured. */
  reaction: StoryReaction | null
}

/** The strongest stories of the last six hours that name a coin, with the analyst's reading and the
 * price's reaction where there is one. */
export function newsImpact(
  stories: readonly ReadStory[],
  readings: Readonly<Record<string, NewsReading>>,
  reactions: Readonly<Record<string, StoryReaction>>,
  nowSec: number,
  shown = NEWS_IMPACT_SHOWN
): NewsImpactRow[] {
  return stories
    .filter((story) => !story.stale && story.assets.length > 0 && story.publishedAt >= nowSec - NEWS_IMPACT_SECONDS && story.publishedAt <= nowSec)
    .sort((a, b) => b.impact - a.impact || b.publishedAt - a.publishedAt)
    .slice(0, shown)
    .map((story) => ({ story, reading: readings[story.id] ?? null, reaction: reactions[story.id] ?? null }))
}

/** A reaction in a few words: its verdict and the move at fifteen minutes. */
export function describeReaction(reaction: StoryReaction): string {
  const m15 = reaction.after.m15
  return m15 === null ? reaction.verdict : `${reaction.verdict}, ${m15 >= 0 ? '+' : ''}${m15.toFixed(1)}% at 15m`
}

export interface TodayPaper {
  /** Of the app's own paper trades, the watch's and the news rules': opened today, closed today
   * having entered, and open now. */
  opened: number
  closed: number
  openNow: number
  /** The net of the trades closed today, after fees, by quote asset. */
  net: { asset: string; amount: number }[]
  /** Their total in R, over those with a stop to measure it against. */
  r: number
  rTrades: number
  best: { symbol: string; pnlQuote: number } | null
  worst: { symbol: string; pnlQuote: number } | null
}

const UTC_DAY = 86_400

/** What the app's own paper trades did today, by the UTC day, from the executors on file. */
export function todaysPaper(executors: readonly ExecutorConfig[], nowSec: number): TodayPaper {
  const dayStart = Math.floor(nowSec / UTC_DAY) * UTC_DAY
  const own = executors.filter((executor) => executor.mode === 'paper' && executor.type === 'position' && (executor.watch !== undefined || executor.newsRule !== undefined))
  const today: TodayPaper = { opened: 0, closed: 0, openNow: 0, net: [], r: 0, rTrades: 0, best: null, worst: null }
  const net = new Map<string, number>()
  for (const executor of own) {
    if (executor.createdAt >= dayStart) today.opened++
    if (executor.status === 'active') today.openNow++
    const result = executor.watch?.result ?? executor.newsRule?.result
    if (executor.status !== 'stopped' || result === undefined || result.closedAt < dayStart) continue
    if (result.exit === 'entry_expired' || result.exit === 'btc_moved') continue
    today.closed++
    net.set(executor.quoteAsset, (net.get(executor.quoteAsset) ?? 0) + result.pnlQuote)
    const r = rMultiple(result.pnlQuote, executor.params as PositionExecutorParams)
    if (r !== null) {
      today.r += r
      today.rTrades++
    }
    if (today.best === null || result.pnlQuote > today.best.pnlQuote) today.best = { symbol: executor.symbol, pnlQuote: result.pnlQuote }
    if (today.worst === null || result.pnlQuote < today.worst.pnlQuote) today.worst = { symbol: executor.symbol, pnlQuote: result.pnlQuote }
  }
  today.net = [...net.entries()].map(([asset, amount]) => ({ asset, amount }))
  return today
}
