import { btcRegimeOf, type AiMarketReturns, type BtcRegime } from './aiEventMarket'
import type { Candle, SymbolInfo, Ticker24h } from './ipc'
import { pickUniverse } from './marketScanner'

// WHAT THE APP RESEARCHES WHEN IT OPENS: THE LIQUID PAIRS, WHAT MOVED OVER A DAY AND A WEEK, WHAT
// IS TRENDING, AND WHAT STATE THE MARKET IS IN.
//
// The second V3 document asks for the app to study the market by itself the moment it opens,
// before anyone configures anything (its §4, §9, §51). The main process's marketResearchService.ts
// does the reading -- at launch, then every ten minutes -- and this file is everything that is
// arithmetic on what it read: which pairs, the 24-hour and 7-day figures, CoinGecko's trending list
// matched to Binance pairs, and the market's status in four words (BTC, ETH, ALT, RISK).
//
// IT READS PUBLIC DATA AND NOTHING ELSE. No key, no model, no order. Its figures are versioned
// below, because a status shown on Overview and later given to a model must be the same rule each
// time it is read.

export const MARKET_RESEARCH_VERSION = 'research-v1'

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
    trending: null,
    trendingAt: null,
    market: null
  }
}

/** The state with one step's status changed. */
export function withStep(state: ResearchState, id: ResearchStepId, status: ResearchStepStatus, detail: string | null): ResearchState {
  return { ...state, steps: state.steps.map((step) => (step.id === id ? { ...step, status, detail } : step)) }
}

/** The pairs researched: the scanner's own choice of scannable USDT pairs -- no stablecoins or
 * pegged tokens -- by the day's quote volume, the first RESEARCH_UNIVERSE_SIZE of them that trade
 * at least RESEARCH_MIN_QUOTE_VOLUME. */
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
    trending: false
  }
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
  return { btc, eth, altVsBtcPct, alt, breadth, risk, riskReasons: reasons.map((reason) => reason.text) }
}

const signed = (value: number): string => `${value > 0 ? '+' : ''}${value.toFixed(2)}%`

/** The status in four words with a line each, for the strip at the top of Overview. */
export function describeMarketStatus(status: MarketStatus): { id: 'btc' | 'eth' | 'alt' | 'risk'; label: string; value: string; detail: string; tone: 'up' | 'down' | 'muted' | 'gold' }[] {
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
  return [
    { id: 'btc', label: 'BTC', ...btc },
    { id: 'eth', label: 'ETH', ...eth },
    { id: 'alt', label: 'ALT', ...alt },
    { id: 'risk', label: 'RISK', ...risk }
  ]
}
