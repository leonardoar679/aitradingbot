import { isActionableOpportunity, opportunitySide, type OpportunitySide } from '../../shared/aiOpportunity'
import type { Candle } from '../../shared/ipc'
import { LIVE_MAX_INTEREST, type LiveState } from '../../shared/liveMarket'
import type { MarketRegime, ResearchPair } from '../../shared/marketResearch'
import type { NewsFeedState } from '../../shared/newsFeed'
import { scoredSide, signalScore, type SignalCall, type SignalScore } from '../../shared/opportunityScore'
import { liveReadingOf, type LiveReading } from './liveVerdict'
import { feedItemStatus, rightNowRows, type EventFeedItem, type FeedItemStatus, type RightNowRow } from './opportunities'

// THE OPPORTUNITIES TABLE (the second V3 document, §43-44): what can be acted on now, and the last
// hour's other events beside it, each with two scores -- the signal (shared/opportunityScore.ts) and,
// for an entry on offer, the execution the live price allows (shared/liveMarket.ts) -- and what the
// day, the week, the news and the models say of it.
//
// IT READS. Rows are worked out from what the page already holds: the scanner's events and the
// answers to them, their candles, the live prices, the market research and the news feed. Nothing
// here asks a model or opens anything.

/** How far back the events beside the ones on offer go. */
export const TABLE_RECENT_SECONDS = 3600
/** And how many of them are shown. */
export const TABLE_RECENT_SHOWN = 8

export interface OpportunityTableRow {
  item: EventFeedItem
  /** The entry on offer, where there is one. */
  offer: RightNowRow | null
  /** Where the event stands, for a row with nothing on offer; null where its candles are not read. */
  status: FeedItemStatus | null
  /** The side the signal is read on: the one on offer, else the way the event moved. */
  side: OpportunitySide | null
  signal: SignalScore
  /** The live check of the entry on offer; null with none, or before the stream is read. */
  live: LiveReading | null
  /** The middle of the live book, where the pair is streamed. */
  price: number | null
  /** The pair's day and week, from the research, where it is among the pairs read. */
  research: Pick<ResearchPair, 'change24hPct' | 'change7dPct'> | null
  /** Of the models that answered, how many would take the side at the confidence acted on. */
  agreement: { taking: number; answered: number }
}

/** Each answer, as the score counts it. */
export function signalCallsOf(item: EventFeedItem): SignalCall[] {
  return item.answers.map((answer) => ({ side: opportunitySide(answer.decision), refused: Boolean(answer.decision.rejected), acted: isActionableOpportunity(answer.decision) }))
}

/** The pairs the table would show, in the order their live prices matter: those on offer first,
 * then the last hour's others by how strong the event was. As many as the stream takes. */
export function tableSymbols(feed: EventFeedItem[], bars: ReadonlyMap<string, Candle[]>, nowSec: number): string[] {
  const offered = rightNowRows(feed, bars, nowSec).map((row) => row.item.event.symbol)
  const recent = feed
    .filter((item) => item.event.time <= nowSec && nowSec - item.event.time <= TABLE_RECENT_SECONDS)
    .sort((a, b) => b.event.score - a.event.score)
    .map((item) => item.event.symbol)
  return [...new Set([...offered, ...recent])].slice(0, LIVE_MAX_INTEREST)
}

/** The rows: those on offer, strongest signal first, and the last hour's other events, the same way. */
export function opportunityTableRows(input: {
  feed: EventFeedItem[]
  bars: ReadonlyMap<string, Candle[]>
  live: LiveState | null
  pairs: readonly ResearchPair[]
  regime: MarketRegime | null
  news: NewsFeedState | null
  nowSec: number
  nowMs: number
  /** The watch's Bitcoin safeguard and stake, where known: what the live check holds an entry to. */
  btcLimitPct?: number
  stakeQuote?: number
}): { onOffer: OpportunityTableRow[]; recent: OpportunityTableRow[] } {
  const stories = input.news?.stories ?? []
  const reactions = input.news?.reactions ?? {}
  const rowOf = (item: EventFeedItem, offer: RightNowRow | null): OpportunityTableRow => {
    const { event } = item
    const side = scoredSide(offer?.side ?? null, event.direction)
    const calls = signalCallsOf(item)
    const answered = calls.filter((call) => !call.refused)
    const book = input.live?.books[event.symbol] ?? null
    const researched = input.pairs.find((pair) => pair.symbol === event.symbol) ?? null
    return {
      item,
      offer,
      status: offer !== null ? 'valid' : feedItemStatus(item, input.bars.get(event.id), input.nowSec),
      side,
      signal: signalScore({ event, side, calls, stories, reactions, regime: input.regime, nowSec: input.nowSec }),
      live: offer === null ? null : liveReadingOf(offer, input.live, { btcLimitPct: input.btcLimitPct, stakeQuote: input.stakeQuote, nowMs: input.nowMs }),
      price: book === null ? null : (book.bid + book.ask) / 2,
      research: researched === null ? null : { change24hPct: researched.change24hPct, change7dPct: researched.change7dPct },
      agreement: { taking: side === null ? 0 : answered.filter((call) => call.acted && call.side === side).length, answered: answered.length }
    }
  }
  const byScore = (a: OpportunityTableRow, b: OpportunityTableRow): number => b.signal.score - a.signal.score || b.item.event.time - a.item.event.time
  const offers = rightNowRows(input.feed, input.bars, input.nowSec)
  const offered = new Set(offers.map((row) => row.item.event.id))
  const onOffer = offers.map((row) => rowOf(row.item, row)).sort(byScore)
  const recent = input.feed
    .filter((item) => !offered.has(item.event.id) && item.event.time <= input.nowSec && input.nowSec - item.event.time <= TABLE_RECENT_SECONDS)
    .map((item) => rowOf(item, null))
    .sort(byScore)
    .slice(0, TABLE_RECENT_SHOWN)
  return { onOffer, recent }
}
