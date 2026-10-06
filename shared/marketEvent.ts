import type { Candle, Exchange } from './ipc'

// What is moving, measured the same way for every pair.
//
// A model is expensive and slow, and most minutes on most pairs nothing is happening. So the
// question "is anything happening here?" is answered first, by arithmetic, for every pair at once;
// a model is only ever asked about a pair this file has already singled out.
//
// NOTHING HERE IS A MODEL, AND NOTHING HERE IS FITTED. Each component is a fixed formula with its
// scale written beside it, and the score is their plain mean. The scales were chosen to be read
// ("eight times the usual volume is a full score"), not tuned to a result, and whether an event
// found this way is followed by anything worth trading is a separate question that
// research/EVENTS.md answers on pairs these numbers have never seen.
//
// THREE PROPERTIES, each of which a test pins -- the same three shared/aiContext.ts keeps:
//
// 1. NOTHING AT OR AFTER THE EXECUTION BAR IS READ. A reading at bar i uses bars up to and
//    including i, which has closed, and a call made on it executes on bar i + 1.
//
// 2. THE RESULT DOES NOT DEPEND ON HOW MUCH HISTORY THE CALLER FETCHED. Every figure is computed
//    over exactly the twelve hours ending at bar i, so the live scanner, a scan of history and a
//    research script all get the same reading for the same minute.
//
// 3. A MOVE DOES NOT SET ITS OWN YARDSTICK. The volatility a move is measured against, and the
//    volume and range it is compared with, are all taken from before the move began. Measured
//    against a window that included it, a pump would raise the average it is being compared to
//    and score lower the larger it was.

/** The version of everything in this file that decides what an event is: the windows, the scales,
 * the bands, the cooldown and the rule for raising one. It is written on every recorded experiment
 * (shared/aiExperiment.ts), so that a sample drawn under one detector is not mistaken for a sample
 * drawn under another. tests/marketEvent.test.ts holds a hash of what the detector makes of a fixed
 * market beside this version: change what it finds, and this has to move with it. */
export const EVENT_DETECTOR_VERSION = 'events-v1'

export const EVENT_BAR_SECONDS = 60
/** Completed 1-minute bars a reading is taken from: twelve hours. One request to an exchange. */
export const EVENT_LOOKBACK_BARS = 720

/** The move being judged: the last fifteen minutes. */
const MOVE_BARS = 15
/** "Now", for volume, range and pressure: the last five minutes. */
const RECENT_BARS = 5
/** What "now" is compared with: the twenty five-minute periods before the move began. */
const BASE_BARS = 100
/** The stretch whose high and low a move has to clear to count as a break: the four hours before
 * the move began. */
const PRIOR_RANGE_BARS = 240

/** A market that has not moved at all has a volatility of zero, and any tick against it would be
 * an infinite number of standard deviations. Fifteen-minute volatility is floored here, in
 * percent; the quietest hours of the largest pairs sit a little above it. */
const MIN_SIGMA15_PCT = 0.05

// The scale of each component: the reading at which it scores 100. Below it the score is
// proportional; above it the score stays 100.
/** A fifteen-minute move of five times its usual size. */
const FULL_MOVE_SIGMAS = 5
/** Eight times the usual five-minute volume. Scored on a log scale, so twice is a third of the way. */
const FULL_VOLUME_RATIO = 8
/** Bars five times their usual range. */
const FULL_RANGE_RATIO = 5
/** Closes sitting, by volume, right at the top of their bars (or the bottom, in a fall). */
const FULL_PRESSURE = 1
/** A close two of its usual fifteen-minute moves beyond the prior four-hour range. */
const FULL_BREAK_SIGMAS = 2

/** A move smaller than its own usual size has no direction worth naming. */
const MIN_DIRECTION_SIGMAS = 1
/** With no direction, only a volume spike is an event, and only a large one. */
const VOLUME_SPIKE_COMPONENT = 80

export const EVENT_WATCH_SCORE = 60
export const EVENT_CANDIDATE_SCORE = 75
export const EVENT_URGENT_SCORE = 85

/** After an event, the same pair raises another only by reaching a higher band. One pump is one
 * event, not fifteen. */
export const EVENT_COOLDOWN_SECONDS = 30 * 60

/** Events one pass of the scanner will put forward. When the whole market moves at once every
 * pair has an event, and asking a model about sixty of them in a minute is the cost this file
 * exists to avoid. The rest are still recorded. */
export const EVENT_MAX_RANKED = 3

/** What the detector names a move -- and 'delisting' and 'monitoring_tag', which it never does:
 * those are events raised by Binance's announcement that it will delist the coin, or has added it to
 * its Monitoring Tag (toNewsEvent), not by the candles. */
export const MARKET_EVENT_TYPES = ['pump', 'dump', 'breakout', 'breakdown', 'volume_spike', 'delisting', 'monitoring_tag'] as const
export type MarketEventType = (typeof MARKET_EVENT_TYPES)[number]
export type EventDirection = 'up' | 'down' | 'none'
export type EventBand = 'quiet' | 'watch' | 'candidate' | 'urgent'

const BAND_RANK: Record<EventBand, number> = { quiet: 0, watch: 1, candidate: 2, urgent: 3 }

export interface EventComponents {
  price: number
  volume: number
  volatility: number
  pressure: number
  breakout: number
}

export interface EventReading {
  /** Open time of the bar the reading was taken at: the last one to have closed. */
  barTime: number
  /** Open time of the bar a call made on this reading executes on. */
  time: number
  /** The close the reading was taken at. */
  price: number
  returnsPct: { m1: number; m5: number; m15: number; h1: number; h4: number }
  /** The usual size of a fifteen-minute move, in percent, over the hours before this one. */
  sigma15Pct: number
  /** The last fifteen minutes' move in units of that. */
  moveSigmas: number
  /** The last five minutes' traded value against the usual five minutes before the move began.
   * Null when those traded nothing. */
  volumeRatio: number | null
  /** The same comparison for the size of the bars. */
  rangeRatio: number | null
  /** Where the last five bars closed inside their own ranges, weighted by volume: +1 at the highs,
   * -1 at the lows. */
  pressure: number
  /** How far the close is beyond the four hours before the move: positive above their high,
   * negative below their low, zero inside. In percent. */
  breakPct: number
  components: EventComponents
  score: number
  direction: EventDirection
  band: EventBand
  /** Null while the band is quiet: a move too small to be watched does not get a name. A market
   * ticking up by its usual amount is not a pump. */
  type: MarketEventType | null
}

function clamp01(value: number): number {
  return value <= 0 || !Number.isFinite(value) ? 0 : value >= 1 ? 1 : value
}

export function eventBand(score: number): EventBand {
  if (score >= EVENT_URGENT_SCORE) return 'urgent'
  if (score >= EVENT_CANDIDATE_SCORE) return 'candidate'
  return score >= EVENT_WATCH_SCORE ? 'watch' : 'quiet'
}

export function isAtLeast(band: EventBand, floor: EventBand): boolean {
  return BAND_RANK[band] >= BAND_RANK[floor]
}

function trueRangePct(bar: Candle, previousClose: number): number {
  const range = Math.max(bar.high - bar.low, Math.abs(bar.high - previousClose), Math.abs(bar.low - previousClose))
  return bar.close > 0 ? (range / bar.close) * 100 : 0
}

/** The reading at `bars[index]`, or null when twelve unbroken hours of completed bars do not end
 * there.
 *
 * `bars` must be COMPLETED 1-minute bars, oldest first. A bar still forming has a close that is
 * not yet a fact, and a reading taken at it would describe a minute that has not happened. */
export function readEventAt(bars: Candle[], index: number): EventReading | null {
  const start = index - EVENT_LOOKBACK_BARS + 1
  if (start < 0 || index >= bars.length) return null
  const last = bars[index]
  // A hole in the series makes every "n bars ago" below mean something else.
  if (last.time - bars[start].time !== (EVENT_LOOKBACK_BARS - 1) * EVENT_BAR_SECONDS) return null
  if (!(last.close > 0)) return null

  const changeOver = (n: number): number => {
    const from = bars[index - n].close
    return from > 0 ? (last.close / from - 1) * 100 : 0
  }

  // The yardstick: one-minute returns over the window, up to where the move begins.
  const moveStart = index - MOVE_BARS
  let squares = 0
  let count = 0
  for (let i = start + 1; i <= moveStart; i++) {
    const previous = bars[i - 1].close
    if (!(previous > 0)) continue
    const change = (bars[i].close / previous - 1) * 100
    squares += change * change
    count++
  }
  const sigma1 = count > 0 ? Math.sqrt(squares / count) : 0
  const sigma15Pct = Math.max(MIN_SIGMA15_PCT, sigma1 * Math.sqrt(MOVE_BARS))

  const recentStart = index - RECENT_BARS + 1
  const baseStart = moveStart - BASE_BARS + 1
  let recentVolume = 0
  let recentRange = 0
  let pressureSum = 0
  let pressureVolume = 0
  for (let i = recentStart; i <= index; i++) {
    const bar = bars[i]
    recentVolume += bar.volume * bar.close
    recentRange += trueRangePct(bar, bars[i - 1].close)
    if (bar.high > bar.low) pressureSum += bar.volume * ((2 * bar.close - bar.high - bar.low) / (bar.high - bar.low))
    pressureVolume += bar.volume
  }
  let baseVolume = 0
  let baseRange = 0
  for (let i = baseStart; i <= moveStart; i++) {
    baseVolume += bars[i].volume * bars[i].close
    baseRange += trueRangePct(bars[i], bars[i - 1].close)
  }
  // Both sides as a mean per five-minute period, so the ratio reads "times the usual".
  const usualVolume = baseVolume / (BASE_BARS / RECENT_BARS)
  const usualRange = baseRange / BASE_BARS
  const volumeRatio = usualVolume > 0 ? recentVolume / usualVolume : null
  const rangeRatio = usualRange > 0 ? recentRange / RECENT_BARS / usualRange : null
  const pressure = pressureVolume > 0 ? pressureSum / pressureVolume : 0

  let priorHigh = -Infinity
  let priorLow = Infinity
  for (let i = moveStart - PRIOR_RANGE_BARS + 1; i <= moveStart; i++) {
    if (bars[i].high > priorHigh) priorHigh = bars[i].high
    if (bars[i].low < priorLow) priorLow = bars[i].low
  }
  const breakPct = last.close > priorHigh ? (last.close / priorHigh - 1) * 100 : last.close < priorLow ? (last.close / priorLow - 1) * 100 : 0

  const m15 = changeOver(MOVE_BARS)
  const moveSigmas = m15 / sigma15Pct
  const direction: EventDirection = moveSigmas >= MIN_DIRECTION_SIGMAS ? 'up' : moveSigmas <= -MIN_DIRECTION_SIGMAS ? 'down' : 'none'
  const sign = direction === 'up' ? 1 : direction === 'down' ? -1 : 0

  const components: EventComponents = {
    price: 100 * clamp01(Math.abs(moveSigmas) / FULL_MOVE_SIGMAS),
    volume: volumeRatio === null ? 0 : 100 * clamp01(Math.log2(volumeRatio) / Math.log2(FULL_VOLUME_RATIO)),
    volatility: rangeRatio === null ? 0 : 100 * clamp01((rangeRatio - 1) / (FULL_RANGE_RATIO - 1)),
    // Pressure and a break only count in the direction of the move: buyers lifting a pump, a
    // rise clearing the prior high. Against it they are evidence of something else.
    pressure: 100 * clamp01((sign * pressure) / FULL_PRESSURE),
    breakout: 100 * clamp01((sign * breakPct) / (FULL_BREAK_SIGMAS * sigma15Pct))
  }

  // A volume spike is the one event with no direction, so it is scored on the two components
  // that do not need one. Scored on all five it could never reach a band at all.
  const directional = (components.price + components.volume + components.volatility + components.pressure + components.breakout) / 5
  const undirected = (components.volume + components.volatility) / 2
  let kind: MarketEventType | null = null
  if (direction === 'up') kind = components.breakout > 0 ? 'breakout' : 'pump'
  else if (direction === 'down') kind = components.breakout > 0 ? 'breakdown' : 'dump'
  else if (components.volume >= VOLUME_SPIKE_COMPONENT) kind = 'volume_spike'
  const score = kind === 'volume_spike' ? undirected : directional
  const band = kind === null ? 'quiet' : eventBand(score)

  return {
    barTime: last.time,
    time: last.time + EVENT_BAR_SECONDS,
    price: last.close,
    returnsPct: { m1: changeOver(1), m5: changeOver(5), m15, h1: changeOver(60), h4: changeOver(240) },
    sigma15Pct,
    moveSigmas,
    volumeRatio,
    rangeRatio,
    pressure,
    breakPct,
    components,
    score,
    direction,
    band,
    type: band === 'quiet' ? null : kind
  }
}

/** An event already raised for a pair: when, and how high. */
export interface RaisedEvent {
  time: number
  band: EventBand
}

/** Whether a reading is a new event for its pair, given the ones already raised for it.
 *
 * At or above `floor`, and higher than anything raised for the pair inside the cooldown. So a
 * pump that reaches "candidate" and five minutes later "urgent" is raised twice, once at each,
 * and a pump that stays at "candidate" for ten minutes is raised once.
 *
 * AND IT HAS A DIRECTION. A volume spike with none is read, scored and shown, and never raised:
 * research/EVENTS.md measured what followed one on twenty pairs, at every horizon from five
 * minutes to a day, and found nothing -- while on thinly traded pairs spikes are most of what
 * fires. Raising them would spend a model's attention on the one kind of event known to say
 * nothing. */
export function raisesEvent(reading: EventReading, earlier: RaisedEvent[], floor: EventBand = 'candidate'): boolean {
  if (reading.type === null || reading.direction === 'none' || !isAtLeast(reading.band, floor)) return false
  for (const event of earlier) {
    if (reading.time - event.time < EVENT_COOLDOWN_SECONDS && BAND_RANK[event.band] >= BAND_RANK[reading.band]) return false
  }
  return true
}

/** Every event in a stretch of history, oldest first: the readings a live scanner would have
 * raised had it been running, by the same rule. `from` and `to` are execution times, `from`
 * inclusive and `to` exclusive. */
export function detectEvents(bars: Candle[], options: { from?: number; to?: number; floor?: EventBand } = {}): EventReading[] {
  const floor = options.floor ?? 'candidate'
  const raised: RaisedEvent[] = []
  const events: EventReading[] = []
  for (let index = EVENT_LOOKBACK_BARS - 1; index < bars.length; index++) {
    const time = bars[index].time + EVENT_BAR_SECONDS
    if (options.to !== undefined && time >= options.to) break
    const reading = readEventAt(bars, index)
    if (reading === null || !raisesEvent(reading, raised, floor)) continue
    // The cooldown runs from every event, including ones before `from`: a scan that starts in
    // the middle of a pump must not raise it again as though it had just begun.
    while (raised.length > 0 && reading.time - raised[0].time >= EVENT_COOLDOWN_SECONDS) raised.shift()
    raised.push({ time: reading.time, band: reading.band })
    if (options.from === undefined || time >= options.from) events.push(reading)
  }
  return events
}

/** What the scanner knew about a pair beyond its candles when it raised an event. None of it can
 * be recovered afterwards -- a spread is not in a candle -- so it is recorded here, and none of
 * it is shown to a model, so that a replay of history asks the question a live event did. */
export interface EventLiveContext {
  /** Wall-clock seconds when the scanner raised it. */
  detectedAt: number
  quoteVolume24h: number | null
  /** Best ask over best bid, in percent of the mid. */
  spreadPct: number | null
  candidateScore: number
  /** 1 for the strongest candidate of its pass. Above EVENT_MAX_RANKED it was recorded and not
   * put forward. */
  rank: number
}

export interface MarketEvent {
  /** `exchange:symbol:time`. One pair raises at most one event a minute, so this is unique. */
  id: string
  exchange: Exchange
  symbol: string
  baseAsset: string
  quoteAsset: string
  /** Open time of the 1-minute bar a call on this event executes on. */
  time: number
  type: MarketEventType
  direction: EventDirection
  band: EventBand
  score: number
  components: EventComponents
  price: number
  returnsPct: EventReading['returnsPct']
  moveSigmas: number
  volumeRatio: number | null
  rangeRatio: number | null
  /** Null on an event found by scanning history rather than raised live. */
  live: EventLiveContext | null
  /** Set on an event raised by an announcement rather than by the detector (toNewsEvent): which one.
   * The reading beside it is the market at the minute the announcement was read, whatever it said.
   * ABSENT on every event the detector raised, so those read back exactly as they were written. */
  news?: { articleId: number; title: string; releaseSec: number }
}

function sig(value: number): number {
  return Number.isFinite(value) ? Number(value.toPrecision(6)) : 0
}

export function marketEventId(exchange: Exchange, symbol: string, time: number): string {
  return `${exchange}:${symbol}:${time}`
}

/** The record kept of a reading that was raised. Figures are rounded to six significant digits:
 * it is written to a file and read back, and a number that changes in its fifteenth digit on the
 * way is not the same record. */
export function toMarketEvent(
  reading: EventReading,
  market: { exchange: Exchange; symbol: string; baseAsset: string; quoteAsset: string },
  live: EventLiveContext | null = null
): MarketEvent {
  if (reading.type === null) throw new Error('A reading with no event type is not an event')
  return {
    id: marketEventId(market.exchange, market.symbol, reading.time),
    exchange: market.exchange,
    symbol: market.symbol,
    baseAsset: market.baseAsset,
    quoteAsset: market.quoteAsset,
    time: reading.time,
    type: reading.type,
    direction: reading.direction,
    band: reading.band,
    score: sig(reading.score),
    components: {
      price: sig(reading.components.price),
      volume: sig(reading.components.volume),
      volatility: sig(reading.components.volatility),
      pressure: sig(reading.components.pressure),
      breakout: sig(reading.components.breakout)
    },
    price: reading.price,
    returnsPct: {
      m1: sig(reading.returnsPct.m1),
      m5: sig(reading.returnsPct.m5),
      m15: sig(reading.returnsPct.m15),
      h1: sig(reading.returnsPct.h1),
      h4: sig(reading.returnsPct.h4)
    },
    moveSigmas: sig(reading.moveSigmas),
    volumeRatio: reading.volumeRatio === null ? null : sig(reading.volumeRatio),
    rangeRatio: reading.rangeRatio === null ? null : sig(reading.rangeRatio),
    live
  }
}

/** The event an announcement raises for one coin it names: the market as read at the minute the
 * announcement was read -- whatever the detector would have called it, or nothing -- named for the
 * announcement's kind ('delisting', 'monitoring_tag'), and pointing down, because of the announcement
 * and not the candles. Raised by the main process from an announcement it read itself
 * (electron/services/newsService.ts). */
export function toNewsEvent(
  reading: EventReading,
  market: { exchange: Exchange; symbol: string; baseAsset: string; quoteAsset: string },
  live: EventLiveContext,
  news: NonNullable<MarketEvent['news']>,
  type: 'delisting' | 'monitoring_tag'
): MarketEvent {
  return { ...toMarketEvent({ ...reading, type, direction: 'down' }, market, live), news: { ...news } }
}

/** How long after an event its page says what the price did: fifteen minutes, an hour, four hours. */
export const EVENT_FOLLOW_MINUTES = [15, 60, 240] as const

/** The plain price change, in percent, from an event's price to the close `minutes` after the bar
 * its call executes on opened. Not signed by the event's direction: after a dump, a negative
 * number means it kept falling.
 *
 * Null until that minute has closed, and null when the candle for it is not among `bars`. Like
 * every outcome in this app it is worked out from candles when it is looked at, never stored. */
export function moveAfterEvent(event: { time: number; price: number }, bars: Candle[], minutes: number, nowSec: number): number | null {
  const lastBarTime = event.time + (minutes - 1) * EVENT_BAR_SECONDS
  if (lastBarTime + EVENT_BAR_SECONDS > nowSec || !(event.price > 0)) return null
  // Bars are oldest first; a binary search, because a page of events asks this many times.
  let low = 0
  let high = bars.length - 1
  while (low <= high) {
    const middle = (low + high) >> 1
    if (bars[middle].time === lastBarTime) return (bars[middle].close / event.price - 1) * 100
    if (bars[middle].time < lastBarTime) low = middle + 1
    else high = middle - 1
  }
  return null
}

/** A day of trading under this is not put forward however hard it is moving: one million of the
 * quote asset. */
const THIN_QUOTE_VOLUME = 1_000_000
/** And this much or more counts as fully liquid. Scored on a log scale between the two. */
const DEEP_QUOTE_VOLUME = 100_000_000
/** A spread this wide or wider scores nothing: it is a fifth of a percent, most of a round trip's
 * fee, paid before the trade has moved at all. */
const WIDE_SPREAD_PCT = 0.2

/** How good a candidate an event is, 0 to 100: mostly how strong the event is, and partly whether
 * the pair can be traded at the size and price a person would get.
 *
 * An unknown volume or spread scores as the middle of its range rather than as zero or full: the
 * scanner not having a number is not evidence about the pair either way. */
export function candidateScore(eventScore: number, quoteVolume24h: number | null, spreadPct: number | null): number {
  const tightness = spreadPct === null ? 50 : 100 * clamp01(1 - spreadPct / WIDE_SPREAD_PCT)
  return 0.6 * eventScore + 0.25 * liquidityScore(quoteVolume24h) + 0.15 * tightness
}

/** How much a pair trades, 0 to 100: nothing at a million of the quote a day, full at a hundred
 * million, on a log scale between; the middle when it is not known. */
export function liquidityScore(quoteVolume24h: number | null): number {
  if (quoteVolume24h === null) return 50
  return 100 * clamp01(Math.log10(Math.max(quoteVolume24h, 1) / THIN_QUOTE_VOLUME) / Math.log10(DEEP_QUOTE_VOLUME / THIN_QUOTE_VOLUME))
}

/** The events of one pass in the order they are put forward, each with its rank. Ties go to the
 * pair that sorts first, so that the same pass always ranks the same way. */
export function rankCandidates<T extends { symbol: string; candidateScore: number }>(candidates: T[]): (T & { rank: number })[] {
  return [...candidates]
    .sort((a, b) => b.candidateScore - a.candidateScore || a.symbol.localeCompare(b.symbol))
    .map((candidate, index) => ({ ...candidate, rank: index + 1 }))
}

/** Bases the scanner never watches: stablecoins, and tokens pegged to another asset. A pair built
 * not to move is not one to look for moves on, and its volume would rank it into the watched set
 * every day. */
export const SCAN_EXCLUDED_BASES: ReadonlySet<string> = new Set([
  'USDC',
  'FDUSD',
  'TUSD',
  'USDP',
  'DAI',
  'BUSD',
  'EUR',
  'EURI',
  'AEUR',
  'USD1',
  'XUSD',
  'BFUSD',
  'USDE',
  'RLUSD',
  'WBTC',
  'WBETH',
  'BNSOL',
  'PAXG',
  // Tether's gold, pegged to an ounce as PAXG is; on Binance's USDT list by October 2026, and seen
  // among the market research's movers before it was left out here.
  'XAUT'
])

/** Whether a pair belongs in the watched set at all: quoted in the one asset every watched pair
 * shares, so that their volumes can be ranked against each other, not pegged to anything, and not
 * a token that tracks a stock.
 *
 * A STOCK TOKEN'S MOVES ARE ITS STOCK'S. When the US market opens it catches up on the night in a
 * few minutes, on many times its usual volume, and the detector reads that as an urgent breakout.
 * In a twelve-hour run of the app on 6 October 2026 the first five events were three stock tokens
 * between 13:32 and 13:38 UTC, two minutes after the open, and three of the watch's first four
 * questions went to them. Over the week before it, the detector run on the same 60 pairs found
 * those three, 3 pairs in 60, making 16 of the 112 urgent events: ten within 13 minutes of the open,
 * the other six before it or on Sunday evening, New York time, and at least one on every trading day.
 * Nothing the app reads beside a move -- Bitcoin's regime, the crypto news, the safeguard on
 * Bitcoin's move -- says anything about a stock. */
export function isScannablePair(pair: { baseAsset: string; quoteAsset: string; stockToken?: boolean }, quoteAsset = 'USDT'): boolean {
  return pair.quoteAsset === quoteAsset && !SCAN_EXCLUDED_BASES.has(pair.baseAsset) && pair.stockToken !== true
}

const TYPE_LABEL: Record<MarketEventType, string> = {
  pump: 'Pump',
  dump: 'Dump',
  breakout: 'Breakout',
  breakdown: 'Breakdown',
  volume_spike: 'Volume spike',
  delisting: 'Delisting',
  monitoring_tag: 'Monitoring Tag'
}

export function describeEventType(type: MarketEventType): string {
  return TYPE_LABEL[type]
}

/** One of the five things an event's score is the mean of, with the fact behind it. */
export interface EventReason {
  component: keyof EventComponents
  label: string
  /** 0 to 100. */
  score: number
  /** The reading the score was made from, in words. */
  fact: string
}

function times(value: number): string {
  return `${value.toFixed(1)} times`
}

/** Why this pair was singled out: each component of its score beside the reading behind it.
 *
 * Only what the event's own record holds. A component whose reading was not kept -- where the
 * closes sat, how far past the range the price went -- is said from the score, which is that
 * reading on a fixed scale. */
export function eventReasons(event: Pick<MarketEvent, 'components' | 'returnsPct' | 'moveSigmas' | 'volumeRatio' | 'rangeRatio' | 'direction'>): EventReason[] {
  const { components } = event
  const up = event.direction !== 'down'
  const move = `${event.returnsPct.m15 >= 0 ? '+' : ''}${event.returnsPct.m15.toFixed(2)}%`
  return [
    {
      component: 'price',
      label: 'Move',
      score: components.price,
      fact: `${move} in fifteen minutes, ${times(Math.abs(event.moveSigmas))} its usual size (full at ${FULL_MOVE_SIGMAS})`
    },
    {
      component: 'volume',
      label: 'Volume',
      score: components.volume,
      fact:
        event.volumeRatio === null
          ? 'nothing traded in the hours before to compare the last five minutes with'
          : `the last five minutes traded ${times(event.volumeRatio)} the usual (full at ${FULL_VOLUME_RATIO})`
    },
    {
      component: 'volatility',
      label: 'Bar size',
      score: components.volatility,
      fact: event.rangeRatio === null ? 'no usual bar size to compare with' : `bars ${times(event.rangeRatio)} their usual range (full at ${FULL_RANGE_RATIO})`
    },
    {
      component: 'pressure',
      label: 'Pressure',
      score: components.pressure,
      fact:
        components.pressure > 0
          ? `the last five minutes closed ${Math.round(50 + components.pressure / 2)}% of the way ${up ? 'up' : 'down'} their bars, by volume`
          : `the last five minutes did not close on the ${up ? 'upper' : 'lower'} side of their bars`
    },
    {
      component: 'breakout',
      label: 'Break',
      score: components.breakout,
      fact:
        components.breakout > 0
          ? `${up ? 'above the high' : 'below the low'} of the four hours before the move${components.breakout >= 100 ? `, by ${FULL_BREAK_SIGMAS} usual moves or more` : ''}`
          : 'inside the range of the four hours before the move'
    }
  ]
}
