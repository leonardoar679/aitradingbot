import { BTC_REGIME_PCT, btcRegimeOf, type AiMarketReturns, type BtcRegime } from './aiEventMarket'
import type { Candle, SymbolInfo, Ticker24h } from './ipc'
import type { EventBand, EventDirection, MarketEventType } from './marketEvent'
import { pickUniverse, type ScannerPair } from './marketScanner'

// WHAT THE APP RESEARCHES WHEN IT OPENS: THE LIQUID PAIRS, WHAT MOVED OVER A DAY AND A WEEK, WHAT
// IS TRENDING, AND WHAT STATE THE MARKET IS IN.
//
// The second V3 document asks for the app to study the market by itself the moment it opens,
// before anyone configures anything (its §4, §9, §51). The main process's marketResearchService.ts
// does the reading -- at launch, then every ten minutes -- and this file is everything that is
// arithmetic on what it read: which pairs, the 24-hour and 7-day figures, CoinGecko's trending list
// matched to Binance pairs, and the market's status in five words (REGIME, BTC, ETH, ALT, RISK).
//
// IT READS PUBLIC DATA AND NOTHING ELSE. No key, no model, no order. Its figures are versioned
// below, because a status shown on Overview and used to rank what is on offer must be the same rule
// each time it is read.

/** research-v2 (6 October 2026): the status gained the market's regime in a word. research-v3 (8
 * October 2026, the V5 document's §14-17): each pair's day and week in more figures, two scores
 * across the universe, the candidates, and the emerging movers beside the scanner. */
export const MARKET_RESEARCH_VERSION = 'research-v3'

/** The most traded USDT pairs, at most this many... */
export const RESEARCH_UNIVERSE_SIZE = 50
/** ...each trading at least this much a day, in USDT: the document's default liquidity floor. */
export const RESEARCH_MIN_QUOTE_VOLUME = 20_000_000
/** Daily bars read for each pair: eight complete days and the one forming. */
export const RESEARCH_DAILY_BARS = 9
/** Fifteen-minute bars read for Bitcoin and ether: a day, and one more. */
export const RESEARCH_MARKET_BARS = 98
export const RESEARCH_REFRESH_MS = 10 * 60_000
export const TRENDING_REFRESH_MS = 15 * 60_000
/** CoinGecko's free list of the coins searched most in the last 24 hours. No key. */
export const TRENDING_URL = 'https://api.coingecko.com/api/v3/search/trending'
/** A complete day that closed this far above its open is a strong day (the V5 document, §16). */
export const STRONG_DAY_PCT = 2
/** The pairs the funnel keeps (the V5 document, §14): the top this many by the larger of a pair's
 * two scores, the day's and the week's. */
export const RESEARCH_CANDIDATES = 15
/** The day's and the week's biggest movers listed on Markets, each way. */
export const MOVERS_SHOWN = 8

const DAY = 86_400

/** The lines the market's risk state is drawn at. Engineering defaults, written before any result
 * was looked at, not a claim about where the lines should be. */
export const RISK_LINES = {
  /** Bitcoin down this far in an hour, or over a day, is a panic. */
  panicH1Pct: -3,
  panicH24Pct: -8,
  /** Bitcoin moving this far either way in an hour, or over a day, is elevated... */
  elevatedH1Pct: 1.5,
  elevatedH24Pct: 4,
  /** ...and so is a market where fewer than this share of the pairs rose over the day. */
  elevatedBreadth: 0.2
} as const

/** Alts against Bitcoin, in percentage points of the median 24-hour move: past this either way,
 * they are strong or weak. */
export const ALT_LINE_PCT = 2

/** The market's regime in a word (the second V3 document, §20), from Bitcoin's own moves alone, so
 * that the same rule reads any minute from its candles. The first that applies, in this order:
 * - PANIC: past the panic lines above;
 * - HIGH-VOL: its last hour past the elevated line, either way;
 * - RECOVERY: rising over four hours (the benchmark's 1%) after a day down past the elevated line;
 * - BULL: rising over four hours, and the day not down;
 * - BEAR: falling over four hours, and the day not up;
 * - SIDEWAYS: the rest -- flat over four hours, or the four hours and the day pulling apart.
 * Drawn at lines already written down here and in the benchmark, before any result was looked at. */
export type MarketRegime = 'panic' | 'high-vol' | 'recovery' | 'bull' | 'bear' | 'sideways'

/** The regime from Bitcoin's returns, or null without them. */
export function marketRegimeOf(btc: Pick<AiMarketReturns, 'h1' | 'h4' | 'h24'> | null): MarketRegime | null {
  if (btc === null) return null
  const { h1, h4, h24 } = btc
  if (h1 <= RISK_LINES.panicH1Pct || (h24 !== null && h24 <= RISK_LINES.panicH24Pct)) return 'panic'
  if (Math.abs(h1) >= RISK_LINES.elevatedH1Pct) return 'high-vol'
  const rising = h4 >= BTC_REGIME_PCT
  const falling = h4 <= -BTC_REGIME_PCT
  if (rising && h24 !== null && h24 <= -RISK_LINES.elevatedH24Pct) return 'recovery'
  if (rising && (h24 === null || h24 >= 0)) return 'bull'
  if (falling && (h24 === null || h24 <= 0)) return 'bear'
  return 'sideways'
}

/** The regime as it is shown: its word, and the tone it is shown in. */
export function describeMarketRegime(regime: MarketRegime): { word: string; tone: 'up' | 'down' | 'muted' | 'gold' } {
  const shown: Record<MarketRegime, { word: string; tone: 'up' | 'down' | 'muted' | 'gold' }> = {
    panic: { word: 'PANIC', tone: 'down' },
    'high-vol': { word: 'HIGH-VOL', tone: 'gold' },
    recovery: { word: 'RECOVERY', tone: 'up' },
    bull: { word: 'BULL', tone: 'up' },
    bear: { word: 'BEAR', tone: 'down' },
    sideways: { word: 'SIDEWAYS', tone: 'muted' }
  }
  return shown[regime]
}

export interface ResearchPair {
  symbol: string
  baseAsset: string
  price: number
  change24hPct: number
  quoteVolume24h: number
  /** From the close of the day eight days before the one forming, to the price now. Null without
   * the days. */
  change7dPct: number | null
  /** The day's volume over the mean of the seven complete days before it. Null without them. */
  volumeExpansion: number | null
  /** Of the last seven complete days, how many closed above where they opened. */
  upDays: number | null
  /** The price now against the highest of those seven days and today, in percent: zero at the high,
   * negative below it. */
  fromHigh7dPct: number | null
  /** The day's range, its high over its low, in percent of the low (the V5 document, §15). Null
   * without the ticker's high and low. */
  range24hPct: number | null
  /** The price now against the day's high, in percent: zero at the high, negative below it. */
  fromHigh24hPct: number | null
  /** The standard deviation of the seven complete days' close-to-close moves, in percent (§16).
   * Null without eight complete days. */
  volatility7dPct: number | null
  /** How much of the week's path was one direction: the net move of the seven complete days over
   * the sum of each day's move, 0 (back and forth) to 1 (straight). Null without eight complete
   * days. */
  trend7d: number | null
  /** Of the last seven complete days, how many closed STRONG_DAY_PCT or more above their open. */
  strongDays: number | null
  /** The day's standing across the universe: the mean of the pair's z-scores for its day's move,
   * its volume expansion (log), its range and its distance from the day's high, each over the pairs
   * that have the figure (withScores). Null until scored, or without any figure. */
  score24h: number | null
  /** The week's standing the same way: its week's move, its volatility, its trend, its distance
   * from the week's high and its strong days. */
  score7d: number | null
  /** On CoinGecko's trending list when it was last read. */
  trending: boolean
}

export interface TrendingCoin {
  symbol: string
  name: string
  marketCapRank: number | null
  /** The Binance USDT pair of the same base asset, or null when there is none. */
  pair: string | null
}

export interface MarketSide {
  price: number
  returns: AiMarketReturns
  regime: BtcRegime
}

export type AltStrength = 'strong' | 'in line' | 'weak'
export type RiskState = 'normal' | 'elevated' | 'panic'

export interface MarketStatus {
  btc: MarketSide | null
  eth: MarketSide | null
  /** The median 24-hour move of the pairs other than Bitcoin and ether, less Bitcoin's own. */
  altVsBtcPct: number | null
  alt: AltStrength | null
  /** The share of the pairs that rose over the day, 0 to 1. */
  breadth: number | null
  /** Null when Bitcoin could not be read. */
  regime: MarketRegime | null
  risk: RiskState
  /** Why the risk state is what it is, in words; empty when it is normal. */
  riskReasons: string[]
}

export type ResearchStepId = 'universe' | 'movers' | 'market' | 'trending'
export type ResearchStepStatus = 'waiting' | 'running' | 'done' | 'failed'

export interface ResearchStep {
  id: ResearchStepId
  label: string
  status: ResearchStepStatus
  /** What came of it, or why it failed. */
  detail: string | null
}

export interface ResearchState {
  version: string
  /** True while a pass is reading. */
  running: boolean
  /** When the last pass finished, in seconds. Null before the first. */
  finishedAt: number | null
  steps: ResearchStep[]
  pairs: ResearchPair[]
  /** The funnel's choice (the V5 document, §14): the RESEARCH_CANDIDATES pairs standing highest by
   * the larger of their two scores, best first. Empty until scored. */
  candidates: string[]
  trending: TrendingCoin[] | null
  trendingAt: number | null
  market: MarketStatus | null
}

const STEP_LABELS: Record<ResearchStepId, string> = {
  universe: 'Liquid pairs',
  movers: 'Movers over a day and a week',
  market: 'Bitcoin, ether and the market',
  trending: 'Trending'
}

export function emptyResearchState(): ResearchState {
  return {
    version: MARKET_RESEARCH_VERSION,
    running: false,
    finishedAt: null,
    steps: (Object.keys(STEP_LABELS) as ResearchStepId[]).map((id) => ({ id, label: STEP_LABELS[id], status: 'waiting', detail: null })),
    pairs: [],
    candidates: [],
    trending: null,
    trendingAt: null,
    market: null
  }
}

/** The state with one step's status changed. */
export function withStep(state: ResearchState, id: ResearchStepId, status: ResearchStepStatus, detail: string | null): ResearchState {
  return { ...state, steps: state.steps.map((step) => (step.id === id ? { ...step, status, detail } : step)) }
}

/** The pairs researched: the scanner's own choice of scannable USDT pairs -- no stablecoins, pegged
 * tokens or stock tokens -- by the day's quote volume, the first RESEARCH_UNIVERSE_SIZE of them that
 * trade at least RESEARCH_MIN_QUOTE_VOLUME. A stock token would count a rally on Wall Street into
 * the altcoins' strength and breadth. */
export function researchUniverse(symbols: SymbolInfo[], tickers: Ticker24h[]): (SymbolInfo & { quoteVolume24h: number })[] {
  return pickUniverse(symbols, tickers, RESEARCH_UNIVERSE_SIZE).filter((pair) => pair.quoteVolume24h >= RESEARCH_MIN_QUOTE_VOLUME)
}

const pctChange = (to: number, from: number): number => (to / from - 1) * 100

/** One pair's figures, from its 24-hour ticker and its daily bars, oldest first. A bar still forming
 * at `nowSec` is today's; the ones before it are complete days. */
export function readResearchPair(pair: SymbolInfo & { quoteVolume24h: number }, ticker: Ticker24h, daily: Candle[], nowSec: number): ResearchPair {
  const price = ticker.lastPrice
  const complete = daily.filter((bar) => bar.time + DAY <= nowSec)
  const today = daily.filter((bar) => bar.time + DAY > nowSec)
  const week = complete.slice(-7)
  const base = complete.length >= 8 ? complete[complete.length - 8].close : null
  const meanVolume = week.length === 7 ? week.reduce((sum, bar) => sum + bar.volume, 0) / 7 : null
  const high = week.length === 7 ? Math.max(...week.map((bar) => bar.high), ...today.map((bar) => bar.high)) : null
  // The week's path: eight closes, seven moves between them.
  const closes = complete.length >= 8 ? complete.slice(-8).map((bar) => bar.close) : null
  const moves = closes !== null && closes.every((close) => close > 0) ? closes.slice(1).map((close, index) => pctChange(close, closes[index])) : null
  const volatility7dPct = moves === null ? null : standardDeviation(moves)
  const path = closes === null ? null : closes.slice(1).reduce((sum, close, index) => sum + Math.abs(close - closes[index]), 0)
  const trend7d = closes === null || path === null ? null : path > 0 ? Math.abs(closes[closes.length - 1] - closes[0]) / path : 0
  const dayHigh = ticker.highPrice
  const dayLow = ticker.lowPrice
  return {
    symbol: pair.symbol,
    baseAsset: pair.baseAsset,
    price,
    change24hPct: ticker.priceChangePercent,
    quoteVolume24h: pair.quoteVolume24h,
    change7dPct: base !== null && base > 0 && price > 0 ? pctChange(price, base) : null,
    volumeExpansion: meanVolume !== null && meanVolume > 0 ? ticker.volume / meanVolume : null,
    upDays: week.length === 7 ? week.filter((bar) => bar.close > bar.open).length : null,
    fromHigh7dPct: high !== null && high > 0 && price > 0 ? pctChange(price, high) : null,
    range24hPct: dayHigh > 0 && dayLow > 0 && dayHigh >= dayLow ? pctChange(dayHigh, dayLow) : null,
    fromHigh24hPct: dayHigh > 0 && price > 0 ? pctChange(price, dayHigh) : null,
    volatility7dPct,
    trend7d,
    // To a hundredth of a percent, as the figure is shown: 102 over 100 is 2.00%, not 2.0000000000000018.
    strongDays: week.length === 7 ? week.filter((bar) => bar.open > 0 && round2(pctChange(bar.close, bar.open)) >= STRONG_DAY_PCT).length : null,
    score24h: null,
    score7d: null,
    trending: false
  }
}

function standardDeviation(values: number[]): number {
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length
  return Math.sqrt(values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / values.length)
}

/** Each value's standing among the others, in standard deviations from their mean; null where the
 * value is missing, and 0 for every value when they are all the same. With fewer than two values
 * there is no standing. */
function zScores(values: (number | null)[]): (number | null)[] {
  const known = values.filter((value): value is number => value !== null && Number.isFinite(value))
  if (known.length < 2) return values.map(() => null)
  const mean = known.reduce((sum, value) => sum + value, 0) / known.length
  const spread = standardDeviation(known)
  return values.map((value) => (value === null || !Number.isFinite(value) ? null : spread > 0 ? (value - mean) / spread : 0))
}

const round2 = (value: number): number => Math.round(value * 100) / 100

/** The mean of the standings a pair has, or null when it has none. */
function meanStanding(standings: (number | null)[]): number | null {
  const known = standings.filter((value): value is number => value !== null)
  return known.length === 0 ? null : round2(known.reduce((sum, value) => sum + value, 0) / known.length)
}

/** The pairs scored against each other (the V5 document, §15-16): the day's score from the day's
 * move, the volume expansion (its log, so a tenfold day counts as far as a tenth), the range and
 * the distance from the day's high; the week's from the week's move, its volatility, its trend, the
 * distance from the week's high and the strong days. Each input is a z-score over the pairs that
 * have it, and a pair's score is the mean of the inputs it has, so a pair missing one is scored on
 * the rest. Zero is the universe's middle; two is well above it. */
export function withScores(pairs: ResearchPair[]): ResearchPair[] {
  const day = [
    pairs.map((pair) => pair.change24hPct),
    pairs.map((pair) => (pair.volumeExpansion !== null && pair.volumeExpansion > 0 ? Math.log(pair.volumeExpansion) : null)),
    pairs.map((pair) => pair.range24hPct),
    pairs.map((pair) => pair.fromHigh24hPct)
  ].map(zScores)
  const week = [
    pairs.map((pair) => pair.change7dPct),
    pairs.map((pair) => pair.volatility7dPct),
    pairs.map((pair) => pair.trend7d),
    pairs.map((pair) => pair.fromHigh7dPct),
    pairs.map((pair) => pair.strongDays)
  ].map(zScores)
  return pairs.map((pair, index) => ({ ...pair, score24h: meanStanding(day.map((input) => input[index])), score7d: meanStanding(week.map((input) => input[index])) }))
}

/** The funnel's choice (the V5 document, §14): the `count` pairs standing highest by the larger of
 * their two scores, best first; a pair with neither score is not a candidate. */
export function candidatesOf(pairs: ResearchPair[], count = RESEARCH_CANDIDATES): ResearchPair[] {
  const best = (pair: ResearchPair): number => Math.max(pair.score24h ?? Number.NEGATIVE_INFINITY, pair.score7d ?? Number.NEGATIVE_INFINITY)
  return pairs
    .filter((pair) => Number.isFinite(best(pair)))
    .sort((a, b) => best(b) - best(a) || a.symbol.localeCompare(b.symbol))
    .slice(0, count)
}

/** A pair becoming interesting now (the V5 document, §17), as the scanner scores it every minute:
 * its 15-minute move against its usual size, its 5 minutes' volume against the prior 100, and the
 * rest of the event score (shared/marketEvent.ts), set beside the day it has had. */
export interface EmergingMover {
  symbol: string
  /** The scanner's score, 0 to 100. */
  score: number
  band: EventBand
  type: MarketEventType | null
  direction: EventDirection
  m15Pct: number
  volumeRatio: number | null
  /** The day's move from the research, or null when the pair is not among the researched. */
  change24hPct: number | null
  /** Among the day's MOVERS_SHOWN biggest risers already. */
  inDayTop: boolean
}

/** The scanner's latest reading of every pair it watches, ranked by its score and set beside the
 * day: a coin at +2% on the day and five times its volume now ranks above one at +15% going quiet.
 * Empty while the scanner is off or has not read yet. */
export function emergingMovers(research: ResearchPair[], scanner: ScannerPair[], count: number): EmergingMover[] {
  const dayTop = new Set(rankMovers(research, '24h', MOVERS_SHOWN).up.map((pair) => pair.symbol))
  const byDay = new Map(research.map((pair) => [pair.symbol, pair.change24hPct]))
  return scanner
    .filter((pair) => Number.isFinite(pair.score))
    .map((pair) => ({
      symbol: pair.symbol,
      score: pair.score,
      band: pair.band,
      type: pair.type,
      direction: pair.direction,
      m15Pct: pair.returnsPct.m15,
      volumeRatio: pair.volumeRatio,
      change24hPct: byDay.get(pair.symbol) ?? null,
      inDayTop: dayTop.has(pair.symbol)
    }))
    .sort((a, b) => b.score - a.score || a.symbol.localeCompare(b.symbol))
    .slice(0, count)
}

export type MoverKind = '24h' | '7d' | 'volume'

/** The movers of one kind, most first: the day's or the week's biggest rises (`up`) and falls
 * (`down`), or the largest volume expansions (`up`; `down` is empty). Pairs without the figure are
 * left out. */
export function rankMovers(pairs: ResearchPair[], kind: MoverKind, count: number): { up: ResearchPair[]; down: ResearchPair[] } {
  const value = (pair: ResearchPair): number | null => (kind === '24h' ? pair.change24hPct : kind === '7d' ? pair.change7dPct : pair.volumeExpansion)
  const known = pairs.filter((pair) => {
    const figure = value(pair)
    return figure !== null && Number.isFinite(figure)
  })
  const byValue = [...known].sort((a, b) => (value(b) as number) - (value(a) as number) || a.symbol.localeCompare(b.symbol))
  if (kind === 'volume') return { up: byValue.slice(0, count), down: [] }
  return {
    up: byValue.filter((pair) => (value(pair) as number) > 0).slice(0, count),
    down: [...byValue].reverse().filter((pair) => (value(pair) as number) < 0).slice(0, count)
  }
}

/** CoinGecko's trending list, matched to Binance's USDT pairs by base asset. Anything unreadable in
 * it is left out rather than guessed at. */
export function parseTrending(json: unknown, symbols: SymbolInfo[]): TrendingCoin[] {
  const coins = (json as { coins?: unknown } | null)?.coins
  if (!Array.isArray(coins)) return []
  const usdt = new Map(symbols.filter((pair) => pair.quoteAsset === 'USDT').map((pair) => [pair.baseAsset.toUpperCase(), pair.symbol]))
  const out: TrendingCoin[] = []
  for (const entry of coins) {
    const item = (entry as { item?: Record<string, unknown> | null } | null)?.item
    if (typeof item !== 'object' || item === null || typeof item.symbol !== 'string' || typeof item.name !== 'string') continue
    const symbol = item.symbol.trim().toUpperCase()
    if (symbol === '') continue
    const rank = item.market_cap_rank
    out.push({ symbol, name: item.name, marketCapRank: typeof rank === 'number' && Number.isFinite(rank) ? rank : null, pair: usdt.get(symbol) ?? null })
  }
  return out
}

/** The pairs with `trending` set from the list. */
export function markTrending(pairs: ResearchPair[], trending: TrendingCoin[] | null): ResearchPair[] {
  const on = new Set((trending ?? []).map((coin) => coin.pair).filter((pair): pair is string => pair !== null))
  return pairs.map((pair) => ({ ...pair, trending: on.has(pair.symbol) }))
}

/** A pair's returns over 15 minutes, an hour, four hours and a day, from completed 15-minute bars,
 * oldest first, in percent -- the shape a model is shown (shared/aiEventMarket.ts). Null without
 * four hours of them. */
export function returnsOf(bars15m: Candle[], nowSec: number): { price: number; returns: AiMarketReturns } | null {
  const closed = bars15m.filter((bar) => bar.time + 15 * 60 <= nowSec)
  if (closed.length < 17) return null
  const last = closed[closed.length - 1].close
  const back = (bars: number): number | null => {
    const bar = closed[closed.length - 1 - bars]
    return bar === undefined || !(bar.close > 0) ? null : pctChange(last, bar.close)
  }
  const m15 = back(1)
  const h1 = back(4)
  const h4 = back(16)
  if (m15 === null || h1 === null || h4 === null || !(last > 0)) return null
  return { price: last, returns: { m15, h1, h4, h24: back(96) } }
}

const median = (values: number[]): number | null => {
  if (values.length === 0) return null
  const sorted = [...values].sort((a, b) => a - b)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 1 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2
}

/** The market's status: Bitcoin's and ether's four-hour regime by the rule the event benchmark
 * slices by (btcRegimeOf, applied to ether as it is to Bitcoin), how the other pairs did against
 * Bitcoin over the day, how many rose, and the risk state by RISK_LINES. */
export function marketStatusOf(input: { btc15m: Candle[]; eth15m: Candle[]; pairs: ResearchPair[]; nowSec: number }): MarketStatus {
  const side = (bars: Candle[]): MarketSide | null => {
    const read = returnsOf(bars, input.nowSec)
    return read === null ? null : { price: read.price, returns: read.returns, regime: btcRegimeOf({ btc: read.returns }) }
  }
  const btc = side(input.btc15m)
  const eth = side(input.eth15m)
  const others = input.pairs.filter((pair) => pair.symbol !== 'BTCUSDT' && pair.symbol !== 'ETHUSDT').map((pair) => pair.change24hPct)
  const altMedian = median(others)
  const btcDay = input.pairs.find((pair) => pair.symbol === 'BTCUSDT')?.change24hPct ?? null
  const altVsBtcPct = altMedian !== null && btcDay !== null ? altMedian - btcDay : null
  const alt: AltStrength | null = altVsBtcPct === null ? null : altVsBtcPct >= ALT_LINE_PCT ? 'strong' : altVsBtcPct <= -ALT_LINE_PCT ? 'weak' : 'in line'
  const breadth = input.pairs.length === 0 ? null : input.pairs.filter((pair) => pair.change24hPct > 0).length / input.pairs.length

  const reasons: { level: RiskState; text: string }[] = []
  const h1 = btc?.returns.h1 ?? null
  const h24 = btc?.returns.h24 ?? btcDay
  if (h1 !== null && h1 <= RISK_LINES.panicH1Pct) reasons.push({ level: 'panic', text: `Bitcoin fell ${Math.abs(h1).toFixed(2)}% in the last hour` })
  if (h24 !== null && h24 <= RISK_LINES.panicH24Pct) reasons.push({ level: 'panic', text: `Bitcoin fell ${Math.abs(h24).toFixed(2)}% over the day` })
  if (h1 !== null && h1 > RISK_LINES.panicH1Pct && Math.abs(h1) >= RISK_LINES.elevatedH1Pct) {
    reasons.push({ level: 'elevated', text: `Bitcoin moved ${h1 > 0 ? '+' : ''}${h1.toFixed(2)}% in the last hour` })
  }
  if (h24 !== null && h24 > RISK_LINES.panicH24Pct && Math.abs(h24) >= RISK_LINES.elevatedH24Pct) {
    reasons.push({ level: 'elevated', text: `Bitcoin moved ${h24 > 0 ? '+' : ''}${h24.toFixed(2)}% over the day` })
  }
  if (breadth !== null && breadth < RISK_LINES.elevatedBreadth) reasons.push({ level: 'elevated', text: `only ${Math.round(breadth * 100)}% of the pairs rose over the day` })
  const risk: RiskState = reasons.some((reason) => reason.level === 'panic') ? 'panic' : reasons.length > 0 ? 'elevated' : 'normal'
  // The day from the ticker where the bars do not reach it, as the risk state reads it.
  const regime = btc === null || h1 === null ? null : marketRegimeOf({ h1, h4: btc.returns.h4, h24 })
  return { btc, eth, altVsBtcPct, alt, breadth, regime, risk, riskReasons: reasons.map((reason) => reason.text) }
}

const signed = (value: number): string => `${value > 0 ? '+' : ''}${value.toFixed(2)}%`

/** Why the regime is what it is, in a sentence, from Bitcoin's returns. */
function regimeDetail(regime: MarketRegime, btc: AiMarketReturns): string {
  const day = btc.h24 === null ? '' : `, ${signed(btc.h24)} over the day`
  if (regime === 'panic') return `Bitcoin ${signed(btc.h1)} in the last hour${day}: past the panic lines (${RISK_LINES.panicH1Pct}% in an hour, ${RISK_LINES.panicH24Pct}% in a day).`
  if (regime === 'high-vol') return `Bitcoin ${signed(btc.h1)} in the last hour, past the ${RISK_LINES.elevatedH1Pct}% line either way.`
  if (regime === 'recovery') return `Bitcoin ${signed(btc.h4)} over four hours, after a day down${btc.h24 === null ? '' : ` ${signed(btc.h24)}`}.`
  if (regime === 'sideways') return `Bitcoin ${signed(btc.h4)} over four hours${day}: no direction.`
  return `Bitcoin ${signed(btc.h4)} over four hours${day}.`
}

/** The status in five words with a line each, for the strip at the top of Overview. */
export function describeMarketStatus(status: MarketStatus): {
  id: 'regime' | 'btc' | 'eth' | 'alt' | 'risk'
  label: string
  value: string
  detail: string
  tone: 'up' | 'down' | 'muted' | 'gold'
}[] {
  const regimeWord = (regime: BtcRegime): string => (regime === 'rising' ? 'RISING' : regime === 'falling' ? 'FALLING' : 'FLAT')
  const regimeTone = (regime: BtcRegime): 'up' | 'down' | 'muted' => (regime === 'rising' ? 'up' : regime === 'falling' ? 'down' : 'muted')
  const sideLine = (name: string, side: MarketSide | null): { value: string; detail: string; tone: 'up' | 'down' | 'muted' } =>
    side === null
      ? { value: '—', detail: `${name} could not be read.`, tone: 'muted' }
      : {
          value: regimeWord(side.regime),
          detail: `${signed(side.returns.h4)} over four hours${side.returns.h24 === null ? '' : `, ${signed(side.returns.h24)} over the day`}.`,
          tone: regimeTone(side.regime)
        }
  const btc = sideLine('Bitcoin', status.btc)
  const eth = sideLine('Ether', status.eth)
  const alt =
    status.alt === null || status.altVsBtcPct === null
      ? { value: '—', detail: 'Not enough pairs read.', tone: 'muted' as const }
      : {
          value: status.alt === 'strong' ? 'STRONG' : status.alt === 'weak' ? 'WEAK' : 'IN LINE',
          detail: `The other pairs' median day was ${signed(status.altVsBtcPct)} against Bitcoin's${status.breadth === null ? '' : `; ${Math.round(status.breadth * 100)}% of them rose`}.`,
          tone: status.alt === 'strong' ? ('up' as const) : status.alt === 'weak' ? ('down' as const) : ('muted' as const)
        }
  const risk = {
    value: status.risk.toUpperCase(),
    detail: status.risk === 'normal' ? 'Nothing past the lines it is drawn at.' : `${status.riskReasons.join('; ')}.`.replace(/^./, (first) => first.toUpperCase()),
    tone: status.risk === 'normal' ? ('up' as const) : status.risk === 'panic' ? ('down' as const) : ('gold' as const)
  }
  const regime =
    status.regime === null || status.btc === null
      ? { value: '—', detail: 'Bitcoin could not be read.', tone: 'muted' as const }
      : {
          value: describeMarketRegime(status.regime).word,
          detail: regimeDetail(status.regime, status.btc.returns),
          tone: describeMarketRegime(status.regime).tone
        }
  return [
    { id: 'regime', label: 'REGIME', ...regime },
    { id: 'btc', label: 'BTC', ...btc },
    { id: 'eth', label: 'ETH', ...eth },
    { id: 'alt', label: 'ALT', ...alt },
    { id: 'risk', label: 'RISK', ...risk }
  ]
}
