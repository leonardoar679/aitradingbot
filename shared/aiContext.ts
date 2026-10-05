import { BollingerBands, RSI } from 'technicalindicators'
import { aggregateCandles, bucketTimeFor } from './aggregateCandles'
import { AI_CONFIRM_PROMPT_VERSION, type AiStrategyBlock } from './aiConfirm'
import { buildMarketBlock, type AiMarketBlock, type EventReference } from './aiEventMarket'
import { AI_OPPORTUNITY_MARKET_PROMPT_VERSION, AI_OPPORTUNITY_NEWS_PROMPT_VERSION, AI_OPPORTUNITY_PROMPT_VERSION, AI_OPPORTUNITY_SCHEMA_VERSION } from './aiOpportunity'
import { AI_PANEL_PROMPT_VERSION, canonicalAgentReports, type AiAgentReports } from './aiPanel'
import { AI_SCHEMA_VERSION, GPT_LOOKBACK_BARS, GPT_PROMPT_VERSION, type AiPositionState } from './aiSignal'
import { computeAtr } from './atr'
import { FEE_RATE, SLIPPAGE_RATE } from './fees'
import { computeEma, wilderAdx } from './indicators'
import { INTERVAL_SECONDS, type Candle, type Exchange, type Interval } from './ipc'
import {
  EVENT_BAR_SECONDS,
  EVENT_LOOKBACK_BARS,
  isAtLeast,
  readEventAt,
  type EventComponents,
  type EventReading,
  type MarketEventType
} from './marketEvent'

// What a model is shown before it decides.
//
// The first version of this app's prompt was 64 raw candles. A language model is poor at
// arithmetic over a column of prices and good at weighing readings it is handed, so the readings
// are computed here, deterministically, from the same indicator code the strategies and the chart
// use -- and the model is given those, a short tail of raw bars, and two coarser views of the
// same history.
//
// THREE PROPERTIES THIS FILE EXISTS TO KEEP, each of which a test pins:
//
// 1. NOTHING AT OR AFTER THE EXECUTION CANDLE IS READ. The context for a decision at index i is
//    built from candles[i - 672 .. i - 1] and from nothing else, not even the execution candle's
//    own timestamp. A backtest that leaks one bar of the future looks spectacular and is useless.
//
// 2. THE RESULT DOES NOT DEPEND ON HOW MUCH HISTORY THE CALLER FETCHED. Every indicator is
//    computed over exactly that 672-bar window. An EMA or a Wilder average carries memory of all
//    history before it, so computing one over "whatever was passed in" would give the same candle
//    a slightly different context from a seven-day backtest than from a bot that has been running
//    a month -- a different cache key, and the same decision billed twice.
//
// 3. THE SAME INPUT PRODUCES THE SAME BYTES. The context is hashed into the cache key, so derived
//    numbers are rounded to six significant digits and the object is built in one fixed key order.

export const AI_CONTEXT_VERSION = 'context-v1'

/** What a fee-and-slippage round trip costs, in percent: the bar a trade has to clear. */
export const AI_ROUND_TRIP_COST_PCT = Number(((FEE_RATE + SLIPPAGE_RATE) * 2 * 100).toPrecision(6))

/** The coarser views built from the base window, finest first. */
const HIGHER_TIMEFRAMES: Record<Interval, Interval[]> = {
  '1m': ['15m', '1h'],
  '15m': ['1h', '4h'],
  '1h': ['4h', '1d'],
  '4h': ['1d'],
  '1d': ['1w'],
  '1w': []
}

/** Raw bars shown per view: the base interval, then each coarser one. Indicators are computed over
 * every bar the window holds; this only bounds how many are spelled out in the prompt. */
const BARS_SHOWN = [32, 24, 18]

const FAST_EMA = 20
const SLOW_EMA = 50
const LONG_EMA = 200
const RSI_PERIOD = 14
const ATR_PERIOD = 14
const ADX_PERIOD = 14
const BOLLINGER_PERIOD = 20
const VOLUME_AVERAGE_BARS = 20

export interface AiTimeframeView {
  interval: Interval
  /** [unixTime, open, high, low, close, volume], oldest first. Completed bars only. */
  bars: number[][]
  ema20: number | null
  ema50: number | null
  /** Base interval only; the coarser views do not hold 200 bars. */
  ema200: number | null
  rsi14: number | null
  /** ATR(14) as a percentage of the last close. */
  atrPct: number | null
  adx14: number | null
}

/** What the scanner raised, as a model is shown it (shared/marketEvent.ts). Rebuilt from the
 * 1-minute candles by buildEventContext; nobody hands one in. */
export interface AiEventBlock {
  type: MarketEventType
  direction: 'up' | 'down'
  /** Open time of the 1-minute bar a call on this event executes on. */
  time: number
  /** The close of the last completed 1-minute bar: the price any levels are placed against. */
  price: number
  /** 0 to 100: the plain mean of the five components. */
  score: number
  components: EventComponents
  returnsPct: { m1: number; m5: number; m15: number; h1: number; h4: number }
  /** The usual size of a fifteen-minute move in this market, in percent, over the hours before
   * this one. What "large" means here. */
  usualMove15mPct: number
  /** The last five minutes' traded value against the usual five minutes before the move began. */
  volumeRatio: number | null
  /** [unixTime, open, high, low, close, volume], oldest first: the last thirty 1-minute bars, and
   * the two hours before the event in 5-minute bars counted back from it. */
  bars1m: number[][]
  bars5m: number[][]
}

export interface AiMarketContext {
  version: string
  exchange: Exchange
  symbol: string
  interval: Interval
  /** When the candle this decision executes on opens. Derived from the last bar in the window, not
   * read from the execution candle, so a context contains nothing from the bar it is deciding. */
  decisionTime: number
  position: AiPositionState
  lastClose: number
  /** How much history the readings below span. */
  windowDays: number
  changePct: { h1: number | null; h4: number | null; h24: number | null; window: number | null }
  /** High and low of the whole window, and where the last close sits between them (0 = low). */
  range: { high: number; low: number; positionPct: number | null }
  bollinger: { upper: number | null; middle: number | null; lower: number | null; percentB: number | null } | null
  /** The last bar's volume against the average of the twenty bars before it. */
  volume: { last: number | null; average20: number | null; ratio: number | null }
  roundTripCostPct: number
  timeframes: AiTimeframeView[]
  /** Present only when a model is reviewing an entry a strategy signalled (shared/aiConfirm.ts):
   * which strategy, its rule and what it measured. ABSENT, not null, on a standalone signal, so
   * that context serialises to the same bytes -- and the same cache key -- it always did. */
  strategy?: AiStrategyBlock
  /** Present only when a panel's decision is being asked for (shared/aiPanel.ts): what its three
   * analysts made of this same snapshot. ABSENT on every other question, the analysts' own
   * included, for the reason `strategy` is. */
  agents?: AiAgentReports
  /** Present only on an opportunity question (shared/aiOpportunity.ts): the event the scanner
   * raised, on 1-minute candles, over the seven-day snapshot above. ABSENT on every other
   * question, for the reason `strategy` is. */
  event?: AiEventBlock
  /** Present only on an event's question asked WITH THE MARKET AROUND IT (shared/aiEventMarket.ts):
   * what Bitcoin and ether did over the same stretches, and this pair's return less theirs.
   * Rebuilt from their candles by withMarketBlock; nobody hands one in. ABSENT on every other
   * question -- the pair-alone one included, so that its bytes, and the answers already bought for
   * it, do not move -- and always after `event`. */
  market?: AiMarketBlock
  /** Present only on an event's question asked BECAUSE OF AN ANNOUNCEMENT (shared/newsActions.ts):
   * the announcement Binance published, as the main process read it from Binance's own list and
   * kept it. Rebuilt in the main process from its own record of the article; nobody hands one in.
   * ABSENT on every other question, for the reason `market` is, and always after `event`. */
  news?: AiNewsBlock
}

/** An announcement as a model is shown it: whose, what kind, its title as published, and when. */
export interface AiNewsBlock {
  source: 'Binance'
  kind: 'delisting'
  title: string
  /** Unix seconds. */
  releasedAt: number
}

/** Which prompt a context is put to a model under. Derived from the context rather than passed
 * beside it, so the question asked, the version it is cached under and the version written to the
 * ledger cannot disagree: a context that carries analysts' reports is a panel's decision, one that
 * names a strategy is an entry review, one with an event is an opportunity -- with the market
 * around it or without -- and nothing else is any of those. */
export function aiPromptVersion(context: Pick<AiMarketContext, 'strategy' | 'agents' | 'event' | 'market' | 'news'>): string {
  if (context.agents !== undefined) return AI_PANEL_PROMPT_VERSION
  if (context.event !== undefined) {
    if (context.news !== undefined) return AI_OPPORTUNITY_NEWS_PROMPT_VERSION
    return context.market === undefined ? AI_OPPORTUNITY_PROMPT_VERSION : AI_OPPORTUNITY_MARKET_PROMPT_VERSION
  }
  return context.strategy === undefined ? GPT_PROMPT_VERSION : AI_CONFIRM_PROMPT_VERSION
}

/** Which answer shape a context is asked for in, derived from the context for the same reason
 * the prompt version is: an opportunity's answer carries an entry range, every other one is the
 * signal's. */
export function aiSchemaVersion(context: Pick<AiMarketContext, 'event'>): string {
  return context.event === undefined ? AI_SCHEMA_VERSION : AI_OPPORTUNITY_SCHEMA_VERSION
}

/** The question a panel's decision is asked: the snapshot its analysts were shown, and what they
 * made of it. The reports are rebuilt on the way in, so the bytes -- and the cache key -- depend
 * on what the analysts said and on nothing about how it was handed over. */
export function withAgentReports(context: AiMarketContext, reports: AiAgentReports): AiMarketContext {
  if (context.strategy !== undefined || context.agents !== undefined || context.event !== undefined) {
    throw new Error('A panel decides a standalone signal, and is shown its reports once')
  }
  return { ...context, agents: canonicalAgentReports(reports) }
}

function sig(value: number | null | undefined): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? Number(value.toPrecision(6)) : null
}

function last<T>(values: T[]): T | undefined {
  return values[values.length - 1]
}

function compactBar(candle: Candle): number[] {
  return [candle.time, candle.open, candle.high, candle.low, candle.close, sig(candle.volume) ?? 0]
}

/** An EMA is only reported once the window holds at least `period` bars. computeEma seeds on the
 * first value and returns a number from bar zero, so without this a 41-bar view would report an
 * "EMA(50)" that is mostly its own seed. */
function emaAt(closes: number[], period: number): number | null {
  return closes.length >= period ? sig(last(computeEma(closes, period))) : null
}

function timeframeView(interval: Interval, candles: Candle[], shown: number, withLongEma: boolean): AiTimeframeView {
  const closes = candles.map((c) => c.close)
  const close = last(closes)
  const atr = last(computeAtr(candles, ATR_PERIOD))
  return {
    interval,
    bars: candles.slice(-shown).map(compactBar),
    ema20: emaAt(closes, FAST_EMA),
    ema50: emaAt(closes, SLOW_EMA),
    ema200: withLongEma ? emaAt(closes, LONG_EMA) : null,
    rsi14: sig(last(RSI.calculate({ period: RSI_PERIOD, values: closes }))),
    atrPct: atr !== undefined && close !== undefined && close > 0 ? sig((atr / close) * 100) : null,
    adx14: sig(wilderAdx(candles, ADX_PERIOD))
  }
}

/** The window's bars merged into `interval`, with any bucket still in progress removed.
 *
 * aggregateCandles keeps a partial TRAILING bucket on purpose, because for a chart that is the bar
 * currently forming. Here it would be a bar whose close moves with every base candle, sitting in a
 * list of finished ones and feeding an RSI as though it were finished too. The raw base bars
 * already cover those most recent hours, so nothing is hidden by leaving it out. */
function completedBuckets(window: Candle[], base: Interval, interval: Interval): Candle[] {
  const bars = aggregateCandles(window, interval)
  const final = last(window)
  if (final === undefined || bars.length === 0) return bars
  const nextOpen = final.time + INTERVAL_SECONDS[base]
  if (bucketTimeFor(nextOpen, interval) === bucketTimeFor(final.time, interval)) bars.pop()
  return bars
}

/** The context for a decision executing on `candles[executionIndex]`, or null when fewer than the
 * lookback's worth of completed bars precede it. */
export function buildAiContext(
  candles: Candle[],
  executionIndex: number,
  meta: { exchange: Exchange; symbol: string; interval: Interval; position: AiPositionState; strategy?: AiStrategyBlock }
): AiMarketContext | null {
  if (executionIndex < GPT_LOOKBACK_BARS || executionIndex > candles.length) return null
  const window = candles.slice(executionIndex - GPT_LOOKBACK_BARS, executionIndex)
  const barSeconds = INTERVAL_SECONDS[meta.interval]
  const final = window[window.length - 1]
  const closes = window.map((c) => c.close)
  const lastClose = final.close

  const changeOver = (bars: number): number | null => {
    if (bars < 1) return null
    const from = window[window.length - 1 - bars]
    return from !== undefined && from.close > 0 ? sig((lastClose / from.close - 1) * 100) : null
  }
  const barsIn = (seconds: number): number => Math.round(seconds / barSeconds)

  let high = -Infinity
  let low = Infinity
  for (const candle of window) {
    if (candle.high > high) high = candle.high
    if (candle.low < low) low = candle.low
  }

  const band = last(BollingerBands.calculate({ period: BOLLINGER_PERIOD, stdDev: 2, values: closes }))
  const priorVolumes = window.slice(-VOLUME_AVERAGE_BARS - 1, -1).map((c) => c.volume)
  const averageVolume =
    priorVolumes.length === VOLUME_AVERAGE_BARS ? priorVolumes.reduce((a, b) => a + b, 0) / VOLUME_AVERAGE_BARS : null

  const timeframes = [timeframeView(meta.interval, window, BARS_SHOWN[0], true)]
  HIGHER_TIMEFRAMES[meta.interval].forEach((interval, index) => {
    timeframes.push(timeframeView(interval, completedBuckets(window, meta.interval, interval), BARS_SHOWN[index + 1], false))
  })

  return {
    version: AI_CONTEXT_VERSION,
    exchange: meta.exchange,
    symbol: meta.symbol,
    interval: meta.interval,
    decisionTime: final.time + barSeconds,
    position: meta.position,
    lastClose,
    windowDays: sig((GPT_LOOKBACK_BARS * barSeconds) / 86_400) ?? 0,
    changePct: {
      h1: changeOver(barsIn(3600)),
      h4: changeOver(barsIn(4 * 3600)),
      h24: changeOver(barsIn(24 * 3600)),
      window: changeOver(window.length - 1)
    },
    range: { high, low, positionPct: high > low ? sig(((lastClose - low) / (high - low)) * 100) : null },
    bollinger: band
      ? { upper: sig(band.upper), middle: sig(band.middle), lower: sig(band.lower), percentB: sig(band.pb) }
      : null,
    volume: {
      last: sig(final.volume),
      average20: sig(averageVolume),
      ratio: averageVolume !== null && averageVolume > 0 ? sig(final.volume / averageVolume) : null
    },
    roundTripCostPct: AI_ROUND_TRIP_COST_PCT,
    timeframes,
    // Last, and only when there is one: see AiMarketContext.strategy.
    ...(meta.strategy !== undefined ? { strategy: meta.strategy } : {})
  }
}

// ---------------------------------------------------------------------------------------------
// AN EVENT'S QUESTION (shared/aiOpportunity.ts): the seven-day snapshot, and on top of it what the
// scanner saw on 1-minute candles.

/** 1-minute bars spelled out in an event's question, and 5-minute bars made from the ones before. */
const EVENT_BARS_1M = 30
const EVENT_BARS_5M = 24
const FIVE = 5

/** Five-minute bars counted BACK FROM THE EVENT, not aligned to the clock: the last one ends at
 * the last completed minute, so none of them is a partial bucket and the newest five minutes are
 * always one whole bar. */
function fiveMinuteBars(bars: Candle[], count: number): number[][] {
  const out: number[][] = []
  for (let end = bars.length; end - FIVE >= 0 && out.length < count; end -= FIVE) {
    const slice = bars.slice(end - FIVE, end)
    let high = -Infinity
    let low = Infinity
    let volume = 0
    for (const bar of slice) {
      if (bar.high > high) high = bar.high
      if (bar.low < low) low = bar.low
      volume += bar.volume
    }
    out.push([slice[0].time, slice[0].open, high, low, slice[FIVE - 1].close, sig(volume) ?? 0])
  }
  return out.reverse()
}

function eventBlock(reading: EventReading & { type: MarketEventType; direction: 'up' | 'down' }, bars1m: Candle[]): AiEventBlock {
  return {
    type: reading.type,
    direction: reading.direction,
    time: reading.time,
    price: reading.price,
    score: sig(reading.score) ?? 0,
    components: {
      price: sig(reading.components.price) ?? 0,
      volume: sig(reading.components.volume) ?? 0,
      volatility: sig(reading.components.volatility) ?? 0,
      pressure: sig(reading.components.pressure) ?? 0,
      breakout: sig(reading.components.breakout) ?? 0
    },
    returnsPct: {
      m1: sig(reading.returnsPct.m1) ?? 0,
      m5: sig(reading.returnsPct.m5) ?? 0,
      m15: sig(reading.returnsPct.m15) ?? 0,
      h1: sig(reading.returnsPct.h1) ?? 0,
      h4: sig(reading.returnsPct.h4) ?? 0
    },
    usualMove15mPct: sig(reading.sigma15Pct) ?? 0,
    volumeRatio: sig(reading.volumeRatio),
    bars1m: bars1m.slice(-EVENT_BARS_1M).map(compactBar),
    bars5m: fiveMinuteBars(bars1m.slice(0, -EVENT_BARS_1M), EVENT_BARS_5M)
  }
}

/** The question an event is put to a model as, or null when these candles do not make one.
 *
 * `candles1m` and `candles15m` are COMPLETED bars, oldest first. The event is read from the last
 * EVENT_LOOKBACK_BARS one-minute bars -- its time is the minute after the last of them -- and the
 * seven-day snapshot from the last GPT_LOOKBACK_BARS fifteen-minute bars that had closed by then.
 * Bars after either window are not read, and bars before them change nothing.
 *
 * NULL UNLESS THE DETECTOR CALLS IT AN EVENT WORTH RAISING: at candidate or above, with a
 * direction. The event is worked out here from the candles, never passed in, so a model cannot be
 * asked -- and billed -- about a minute on someone's say-so that it was interesting.
 *
 * With `reference`, the question with the market around the event (withMarketBlock), or null when
 * those candles do not reach the event's minute. */
export function buildEventContext(
  candles15m: Candle[],
  candles1m: Candle[],
  meta: { exchange: Exchange; symbol: string },
  reference?: EventReference | null
): AiMarketContext | null {
  if (candles1m.length < EVENT_LOOKBACK_BARS) return null
  const bars1m = candles1m.slice(-EVENT_LOOKBACK_BARS)
  const reading = readEventAt(bars1m, bars1m.length - 1)
  if (reading === null || reading.type === null || reading.direction === 'none' || !isAtLeast(reading.band, 'candidate')) return null

  const base = eventSnapshot(candles15m, reading.time, meta)
  if (!base) return null
  // Last, and only here: see AiMarketContext.event.
  const question: AiMarketContext = { ...base, event: eventBlock({ ...reading, type: reading.type, direction: reading.direction }, bars1m) }
  return reference === undefined || reference === null ? question : withMarketBlock(question, reference)
}

/** The seven-day snapshot an event's question sits on: the fifteen-minute bars that had closed when
 * the event was read, and nothing later -- and the newest of them has to be the one that had JUST
 * closed, or the snapshot is of some earlier market than the event's. */
function eventSnapshot(candles15m: Candle[], eventTime: number, meta: { exchange: Exchange; symbol: string }): AiMarketContext | null {
  const barSeconds = INTERVAL_SECONDS['15m']
  const closed = candles15m.filter((bar) => bar.time + barSeconds <= eventTime)
  if (closed.length < GPT_LOOKBACK_BARS) return null
  const window = closed.slice(-GPT_LOOKBACK_BARS)
  if (eventTime - (window[window.length - 1].time + barSeconds) >= barSeconds) return null
  return buildAiContext(window, window.length, { exchange: meta.exchange, symbol: meta.symbol, interval: '15m', position: 'flat' })
}

/** The question an announcement is put to a model as, or null when these candles do not make one.
 *
 * The candles are read as an event's are, and the minute is the one after the last of them. UNLIKE
 * AN EVENT'S QUESTION, THE DETECTOR NEED NOT CALL THAT MINUTE ANYTHING: what raised it is the
 * announcement, so the event is named 'delisting' and points down, and `news` says what was
 * announced. The caller does not get to say that -- the main process builds `news` from its own
 * record of an article it read (electron/services/aiSignalService.ts checks the article first). */
export function buildNewsEventContext(
  candles15m: Candle[],
  candles1m: Candle[],
  meta: { exchange: Exchange; symbol: string },
  news: AiNewsBlock
): AiMarketContext | null {
  if (candles1m.length < EVENT_LOOKBACK_BARS) return null
  const bars1m = candles1m.slice(-EVENT_LOOKBACK_BARS)
  const reading = readEventAt(bars1m, bars1m.length - 1)
  if (reading === null) return null
  const base = eventSnapshot(candles15m, reading.time, meta)
  if (!base) return null
  // `event`, then `news`, last: see AiMarketContext.news.
  return { ...base, event: eventBlock({ ...reading, type: 'delisting', direction: 'down' }, bars1m), news: { ...news } }
}

/** An event's question with the market around it, or null when Bitcoin's or ether's candles do
 * not run to the event's minute: it is not asked with half a market (buildMarketBlock says why).
 *
 * THE PAIR'S SIDE OF EACH DIFFERENCE IS THE QUESTION'S OWN FIGURES: the event's returns over
 * fifteen minutes, an hour and four hours, and the snapshot's day -- measured as the references'
 * are, from the same closes, up to the same minute. `market` goes on last, after `event`. */
export function withMarketBlock(context: AiMarketContext, reference: EventReference): AiMarketContext | null {
  const event = context.event
  if (event === undefined || context.market !== undefined) return null
  const market = buildMarketBlock(
    { m15: event.returnsPct.m15, h1: event.returnsPct.h1, h4: event.returnsPct.h4, h24: context.changePct.h24 },
    reference,
    event.time
  )
  return market === null ? null : { ...context, market }
}

/** The 1-minute bar an event's question was read at, from the question itself. */
export function eventBarTime(event: AiEventBlock): number {
  return event.time - EVENT_BAR_SECONDS
}

/** The exact bytes that are sent to the model and hashed into the cache key. One function, so the
 * two can never be serialised differently. */
export function aiContextJson(context: AiMarketContext): string {
  return JSON.stringify(context)
}
