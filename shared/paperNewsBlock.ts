import { ENGLISH, type I18n } from './i18n/translate'
import { REVIEW_LINES, type NewsReading } from './aiAdditions'
import type { MarketEvent } from './marketEvent'
import type { ReadStory } from './newsFeed'
import { storyWay } from './opportunityScore'

// NEWS AGAINST A PAPER TRADE (the second V3 document, §25: "news contradicted" invalidates a trade).
//
// A story of major impact that names the coin, from the reviewer's three hours before the event to
// now, and points against the side, refuses the paper trade the watch would open. Which way a story
// points is the signal score's rule (shared/opportunityScore.ts, storyWay): the news analyst's reading
// where it read this story about this coin, else the fixed rule's guess from the story's kind. A
// story with no way of its own refuses nothing, and so does one the analyst read as pointing neither
// way. What makes news major is the reviewer's line (REVIEW_LINES), said once.
//
// IT ONLY EVER OPENS LESS, AND IT READS. Nothing here places, sizes or arms anything, and a story
// pointing the trade's own way changes nothing: the reviewer still takes its second look at it.

export type NewsAgainstStory = Pick<ReadStory, 'id' | 'eventType' | 'assets' | 'impact' | 'publishedAt' | 'stale' | 'title' | 'sourceName'>

export interface NewsAgainstInput {
  event: Pick<MarketEvent, 'baseAsset' | 'time'>
  side: 'buy' | 'sell'
  stories: readonly NewsAgainstStory[]
  /** The analyst's readings, by story id; with none, the kinds' ways stand. */
  readings: Readonly<Record<string, NewsReading>> | undefined
  nowSec: number
}

/** The stories that would refuse the side, strongest first; empty when none does. */
export function storiesAgainst(input: NewsAgainstInput): NewsAgainstStory[] {
  const against = input.side === 'buy' ? 'down' : 'up'
  return input.stories
    .filter(
      (story) =>
        !story.stale &&
        story.impact >= REVIEW_LINES.majorNewsImpact &&
        story.publishedAt >= input.event.time - REVIEW_LINES.majorNewsSeconds &&
        story.publishedAt <= input.nowSec &&
        story.assets.some((asset) => asset.ticker === input.event.baseAsset) &&
        storyWay(story, input.event.baseAsset, input.readings) === against
    )
    .sort((a, b) => b.impact - a.impact || b.publishedAt - a.publishedAt)
}

const MAX_TITLE = 90

/** Why a paper trade is refused on the news, or null: the strongest story against it, named last, in
 * parentheses, so that the session report counts such refusals together by coin and side. In English, as
 * recorded, unless handed a language (V6 Stage 14). */
export function newsAgainstBlock(input: NewsAgainstInput, i18n: I18n = ENGLISH): string | null {
  const story = storiesAgainst(input)[0]
  if (story === undefined) return null
  const title = story.title.length > MAX_TITLE ? `${story.title.slice(0, MAX_TITLE - 3).trimEnd()}…` : story.title
  const clock = i18n.t('{time} UTC', { time: i18n.language === 'en' ? new Date(story.publishedAt * 1000).toISOString().slice(11, 16) : i18n.utcTime(story.publishedAt * 1000) })
  const values = { impact: Math.round(story.impact), coin: input.event.baseAsset, title, source: story.sourceName, time: clock }
  return input.side === 'buy'
    ? i18n.t('A story of impact {impact} names {coin} and points down, against a paper BUY ("{title}", {source}, {time}).', values)
    : i18n.t('A story of impact {impact} names {coin} and points up, against a paper SELL ("{title}", {source}, {time}).', values)
}
