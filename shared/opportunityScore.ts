import { ENGLISH, msg, type I18n } from './i18n/translate'
import type { NewsReading } from './aiAdditions'
import type { OpportunitySide } from './aiOpportunity'
import { eventReasons, liquidityScore, type MarketEvent } from './marketEvent'
import { describeMarketRegime, type MarketRegime } from './marketResearch'
import { describeEventType, expectedDirection, type ReadStory, type StoryReaction } from './newsFeed'

// HOW STRONG THE CASE FOR AN OPPORTUNITY IS, BY FIXED WEIGHTS SHOWN ON SCREEN (the second V3
// document, §20 and §42).
//
// Each opportunity has two scores. This file is the first, the SIGNAL: the event the scanner raised,
// its volume and its break, how much the pair trades, the news that names the coin, whether the
// market's regime suits the side, and how many of the models asked would take it -- less penalties
// for wild bars, old news and models on opposite sides. The second, EXECUTION, is the live price's
// (shared/liveMarket.ts executionQuality): whether it can be entered well now.
//
// A MODEL CONTRIBUTES OBSERVATIONS, NEVER THE SCORE. An answer counts here only as a side taken at
// the confidence this app acts on. Its confidence, its own reading of the market and its reasons
// are shown beside the score, and are not in it. The one other observation it takes is the news
// analyst's (shared/aiAdditions.ts): which way a story points, where the analyst has read it about
// this coin, in place of the fixed rule's guess from the story's kind. The weight and the impact stay
// the fixed rules'.
//
// IT RANKS; IT IS NOT A PROBABILITY. The weights are engineering defaults, written down here before
// any result was looked at. Whether a higher score earns more is for the record to say, and nothing
// is opened or refused by it.

export const OPPORTUNITY_SCORE_VERSION = 'opportunity-score-v1'

/** What each part weighs. They add up to one, so the parts at full marks make 100. */
export const SIGNAL_WEIGHTS = {
  event: 0.25,
  volume: 0.1,
  breakout: 0.1,
  liquidity: 0.1,
  news: 0.15,
  regime: 0.15,
  models: 0.15
} as const

/** The most each penalty takes off, in points. */
export const SIGNAL_PENALTIES = { volatility: 10, staleNews: 10, disagreement: 15 } as const

/** A story about the coin counts from this long before the event. */
export const SIGNAL_NEWS_SECONDS = 3 * 3600

/** Bars this many points into the event's bar-size reading start to cost, and cost the most at 100. */
const CALM_BARS = 50

/** How well each regime suits a side, 0 to 100. Without a side, or a regime, the middle. */
const REGIME_FIT: Record<MarketRegime, Record<OpportunitySide, number>> = {
  bull: { long: 100, short: 0 },
  recovery: { long: 75, short: 25 },
  sideways: { long: 50, short: 50 },
  'high-vol': { long: 25, short: 25 },
  bear: { long: 0, short: 100 },
  panic: { long: 0, short: 50 }
}

export type SignalPartId = keyof typeof SIGNAL_WEIGHTS
export type SignalPenaltyId = keyof typeof SIGNAL_PENALTIES

export interface SignalPart {
  id: SignalPartId
  label: string
  weight: number
  /** 0 to 100. */
  value: number
  /** What it adds to the score: its weight times its value. */
  points: number
  fact: string
}

export interface SignalPenalty {
  id: SignalPenaltyId
  label: string
  /** What it takes off the score. */
  points: number
  fact: string
}

export interface SignalScore {
  version: string
  /** 0 to 100, whole. */
  score: number
  parts: SignalPart[]
  /** Only the penalties that took something off. */
  penalties: SignalPenalty[]
  /** The story the news part was read from, or null without one. */
  story: ReadStory | null
}

/** One model's answer, as the score counts it. */
export interface SignalCall {
  side: OpportunitySide | null
  refused: boolean
  /** A side at the confidence this app acts on. */
  acted: boolean
}

const clamp = (value: number, low: number, high: number): number => Math.min(high, Math.max(low, value))
const SIDE_WORDS: Record<OpportunitySide, string> = { long: msg('BUY'), short: msg('SELL') }

/** Which way a story points for `coin`: the news analyst's reading where it read the story about
 * this coin, else the fixed rule's by the story's kind; null for neither way. */
export function storyWay(story: Pick<ReadStory, 'id' | 'eventType'>, coin: string, readings: Readonly<Record<string, NewsReading>> | undefined): 'up' | 'down' | null {
  const reading = readings?.[story.id]
  if (reading !== undefined && reading.ticker === coin) return reading.direction === 'none' ? null : reading.direction
  return expectedDirection(story.eventType)
}

/** How far a story points the side's way: all the way, not at all, or halfway with no way of its
 * own, or no side to read it by. */
function storyAgreement(way: 'up' | 'down' | null, side: OpportunitySide | null): number {
  if (way === null || side === null) return 0.5
  return (way === 'up') === (side === 'long') ? 1 : 0
}

/** The stories that name the coin, from SIGNAL_NEWS_SECONDS before the event to now. */
export function storiesAbout(baseAsset: string, eventTime: number, stories: readonly ReadStory[], nowSec: number): ReadStory[] {
  return stories.filter(
    (story) =>
      story.publishedAt >= eventTime - SIGNAL_NEWS_SECONDS && story.publishedAt <= nowSec && story.assets.some((asset) => asset.ticker === baseAsset)
  )
}

/** The signal score of an event, on the side on offer, or on the event's own direction where
 * nothing is (`side` null for an event with neither). */
export function signalScore(input: {
  event: Pick<MarketEvent, 'score' | 'components' | 'live' | 'baseAsset' | 'time' | 'returnsPct' | 'moveSigmas' | 'volumeRatio' | 'rangeRatio' | 'direction'>
  side: OpportunitySide | null
  calls: readonly SignalCall[]
  stories: readonly ReadStory[]
  reactions: Readonly<Record<string, StoryReaction>>
  /** The news analyst's readings, by story id, where it has read any. */
  readings?: Readonly<Record<string, NewsReading>>
  regime: MarketRegime | null
  nowSec: number
  /** The language its words are in: English unless handed another (V6 Stage 14). Its figures are the
   * same in every one. */
  i18n?: I18n
}): SignalScore {
  const { event, side } = input
  const i18n = input.i18n ?? ENGLISH
  const { t } = i18n
  const sideWord = (way: OpportunitySide): string => t(SIDE_WORDS[way])
  const reasons = eventReasons(event, i18n)
  const reasonOf = (component: 'volume' | 'volatility' | 'breakout'): string => reasons.find((reason) => reason.component === component)?.fact ?? ''

  // The news: the strongest story about the coin that is not old news, by its impact and how far it
  // points the side's way.
  const about = storiesAbout(event.baseAsset, event.time, input.stories, input.nowSec)
  const fresh = about.filter((story) => !story.stale)
  let best: { story: ReadStory; value: number; agreement: number } | null = null
  for (const story of fresh) {
    const agreement = storyAgreement(storyWay(story, event.baseAsset, input.readings), side)
    const value = story.impact * agreement
    if (best === null || value > best.value) best = { story, value, agreement }
  }
  const read = best === null ? undefined : input.readings?.[best.story.id]
  const byAnalyst = read !== undefined && read.ticker === event.baseAsset
  const story = best === null ? null : { kind: describeEventType(best.story.eventType, i18n), impact: best.story.impact, title: best.story.title, source: best.story.sourceName }
  const analyst = !byAnalyst ? '' : read.direction === 'none' ? t(', read by the news analyst as pointing neither way') : read.direction === 'up' ? t(', read by the news analyst as pointing up') : t(', read by the news analyst as pointing down')
  const newsFact =
    best === null || story === null
      ? about.length > 0
        ? t('only old news names the coin')
        : t('no story names {coin} in the {hours} hours before the event or since', { coin: event.baseAsset, hours: SIGNAL_NEWS_SECONDS / 3600 })
      : `${best.agreement === 0 ? t('{kind}, impact {impact}: {title} ({source}), which points the other way', story) : t('{kind}, impact {impact}: {title} ({source})', story)}${analyst}`

  // The models: how many of those that answered would take this side, at the confidence acted on.
  const answered = input.calls.filter((call) => !call.refused)
  const taking = side === null ? 0 : answered.filter((call) => call.acted && call.side === side).length
  const modelsValue = answered.length === 0 ? 0 : (100 * taking) / answered.length
  const modelsFact =
    answered.length === 0
      ? t('no model has answered')
      : side === null
        ? t('{count} answered, and none would trade it', { count: answered.length })
        : t('{taking} of the {count} that answered would {side} at the confidence this app acts on', { taking, count: answered.length, side: sideWord(side) })

  const regimeValue = input.regime === null || side === null ? 50 : REGIME_FIT[input.regime][side]
  const regimeWord = input.regime === null ? '' : describeMarketRegime(input.regime, i18n).word
  const regimeFact = input.regime === null ? t('the market has not been read') : side === null ? regimeWord : t('{regime}, for a {side}', { regime: regimeWord, side: sideWord(side) })

  const quoteVolume = event.live?.quoteVolume24h ?? null
  const parts: Omit<SignalPart, 'points' | 'weight'>[] = [
    { id: 'event', label: t('Event'), value: event.score, fact: t('the scanner scored it {score}', { score: Math.round(event.score) }) },
    { id: 'volume', label: t('Volume'), value: event.components.volume, fact: reasonOf('volume') },
    { id: 'breakout', label: t('Break'), value: event.components.breakout, fact: reasonOf('breakout') },
    {
      id: 'liquidity',
      label: t('Liquidity'),
      value: liquidityScore(quoteVolume),
      fact: quoteVolume === null ? t('how much it trades is not known') : t('{amount}M a day', { amount: Math.round(quoteVolume / 1e6) })
    },
    { id: 'news', label: t('News'), value: best === null ? 0 : best.value, fact: newsFact },
    { id: 'regime', label: t('Regime'), value: regimeValue, fact: regimeFact },
    { id: 'models', label: t('Models'), value: modelsValue, fact: modelsFact }
  ]
  const weighed: SignalPart[] = parts.map((part) => {
    const weight = SIGNAL_WEIGHTS[part.id]
    const value = clamp(part.value, 0, 100)
    return { ...part, value, weight, points: weight * value }
  })

  const penalties: SignalPenalty[] = []
  const wild = clamp((event.components.volatility - CALM_BARS) / (100 - CALM_BARS), 0, 1)
  if (wild > 0) penalties.push({ id: 'volatility', label: t('Wild bars'), points: SIGNAL_PENALTIES.volatility * wild, fact: reasonOf('volatility') })
  const pricedIn = best !== null && input.reactions[best.story.id]?.pricedIn === true
  if (pricedIn || (best === null && about.length > 0)) {
    penalties.push({
      id: 'staleNews',
      label: t('Old news'),
      points: SIGNAL_PENALTIES.staleNews,
      fact: pricedIn ? t('the price had already moved its way before the story was published') : t('the only stories that name the coin are old news')
    })
  }
  if (answered.some((call) => call.side === 'long') && answered.some((call) => call.side === 'short')) {
    penalties.push({ id: 'disagreement', label: t('Models split'), points: SIGNAL_PENALTIES.disagreement, fact: t('the models take opposite sides') })
  }

  const total = weighed.reduce((sum, part) => sum + part.points, 0) - penalties.reduce((sum, penalty) => sum + penalty.points, 0)
  return { version: OPPORTUNITY_SCORE_VERSION, score: Math.round(clamp(total, 0, 100)), parts: weighed, penalties, story: best?.story ?? null }
}

/** The side a score is read on: the one on offer, else the way the event moved. */
export function scoredSide(onOffer: OpportunitySide | null, direction: MarketEvent['direction']): OpportunitySide | null {
  if (onOffer !== null) return onOffer
  return direction === 'up' ? 'long' : direction === 'down' ? 'short' : null
}
