import { BollingerBands, RSI } from 'technicalindicators'
import { aggregateCandles, bucketTimeFor } from './aggregateCandles'
import { AI_CONFIRM_PROMPT_VERSION, type AiStrategyBlock } from './aiConfirm'
import { AI_PANEL_PROMPT_VERSION, canonicalAgentReports, type AiAgentReports } from './aiPanel'
import { GPT_LOOKBACK_BARS, GPT_PROMPT_VERSION, type AiPositionState } from './aiSignal'
import { computeAtr } from './atr'
import { FEE_RATE, SLIPPAGE_RATE } from './fees'
import { computeEma, wilderAdx } from './indicators'
import { INTERVAL_SECONDS, type Candle, type Exchange, type Interval } from './ipc'

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
}

/** Which prompt a context is put to a model under. Derived from the context rather than passed
 * beside it, so the question asked, the version it is cached under and the version written to the
 * ledger cannot disagree: a context that carries analysts' reports is a panel's decision, one that
 * names a strategy is an entry review, and nothing else is either. */
export function aiPromptVersion(context: Pick<AiMarketContext, 'strategy' | 'agents'>): string {
  if (context.agents !== undefined) return AI_PANEL_PROMPT_VERSION
  return context.strategy === undefined ? GPT_PROMPT_VERSION : AI_CONFIRM_PROMPT_VERSION
}

/** The question a panel's decision is asked: the snapshot its analysts were shown, and what they
 * made of it. The reports are rebuilt on the way in, so the bytes -- and the cache key -- depend
 * on what the analysts said and on nothing about how it was handed over. */
export function withAgentReports(context: AiMarketContext, reports: AiAgentReports): AiMarketContext {
  if (context.strategy !== undefined || context.agents !== undefined) {
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

/** The exact bytes that are sent to the model and hashed into the cache key. One function, so the
 * two can never be serialised differently. */
export function aiContextJson(context: AiMarketContext): string {
  return JSON.stringify(context)
}
