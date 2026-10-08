import type { ExecutorConfig, PositionExecutorParams } from '../ipc'
import type { MarketEvent } from '../marketEvent'
import type { MarketRegime } from '../marketResearch'
import { rMultiple } from '../paperRisk'
import { agreementBucketOf, type AgreementBucket } from '../research/agreementValue'
import { RESEARCH_MIN_SLICE, RESEARCH_MIN_TRADES, csvOf } from '../research/common'

// WHERE THE RESULT CAME FROM (the V5 document, §82-90; V5 Stage 10, 8 October 2026). Over the app's
// own paper trades that have closed: how much of the net a few trades made (concentration); what
// the signal score at the call said of the trades that followed (score buckets); the result by
// pair and by how much the pair trades (cap tier), by the market's regime at entry, by model, by
// kind of event, by news and by the vote; and where the net came from -- what holding the pair
// from the entry to the plan's end would have made at the stake, against the rest, which is the
// exit. Thirty closed trades for a figure, ten for a slice, as the Research tab counts. Read from
// the records; nothing here is stored or acted on, and nothing that trades reads it.

export const ATTRIBUTION_VERSION = 'attribution-v1'

/** How much a pair trades a day, in the quote, for its cap tier: large from a hundred million,
 * mid from twenty. */
export const CAP_TIER_LINES = { large: 100_000_000, mid: 20_000_000 } as const
export type CapTier = 'large' | 'mid' | 'small'

/** The score buckets of §85, by the signal at the call. */
export const SCORE_BUCKETS = ['90+', '80-90', '70-80', 'under 70', 'not scored'] as const
export type ScoreBucket = (typeof SCORE_BUCKETS)[number]

/** Five trades making this share of the net is fragile. */
export const FRAGILE_SHARE = 0.9
export const FRAGILE_TRADES = 5

export interface AttributedTrade {
  id: string
  symbol: string
  /** The watch's model; null for a news rule's trade. */
  model: string | null
  side: 'buy' | 'sell'
  /** The event's kind; null where its record is not on file. */
  kind: string | null
  closedAt: number
  netQuote: number
  stakeQuote: number
  /** Net over the stake, in percent. */
  netPct: number
  r: number | null
  /** The signal score at the call, where it could be read back. */
  signal: number | null
  /** The market's regime at entry where the trade recorded it; else Bitcoin's direction at the
   * event; else null. */
  regime: MarketRegime | 'rising' | 'falling' | 'flat' | null
  capTier: CapTier | null
  news: 'with news' | 'no news' | null
  vote: AgreementBucket | 'one model' | null
  /** What holding the pair from the entry to the plan's end would have made at the stake, after
   * fees; null where it could not be read. */
  holdNetQuote: number | null
}

export function capTierOf(quoteVolume24h: number | null | undefined): CapTier | null {
  if (quoteVolume24h === null || quoteVolume24h === undefined || !Number.isFinite(quoteVolume24h)) return null
  if (quoteVolume24h >= CAP_TIER_LINES.large) return 'large'
  return quoteVolume24h >= CAP_TIER_LINES.mid ? 'mid' : 'small'
}

export function scoreBucketOf(signal: number | null): ScoreBucket {
  if (signal === null || !Number.isFinite(signal)) return 'not scored'
  if (signal >= 90) return '90+'
  if (signal >= 80) return '80-90'
  return signal >= 70 ? '70-80' : 'under 70'
}

/** What the card reads for each trade, by executor id and by event id, before the trades are built. */
export interface AttributionReadings {
  /** Each trade's event, where its record is on file. */
  events: Readonly<Record<string, Pick<MarketEvent, 'id' | 'type' | 'live'>>>
  /** How many of the models that answered the event usably took the trade's side. */
  votes: Readonly<Record<string, { taking: number; usable: number }>>
  /** Bitcoin's direction at the event, where its minutes were read. */
  btc: Readonly<Record<string, 'rising' | 'falling' | 'flat'>>
  /** The signal score at the call, by executor id, where it could be read back. */
  signals: Readonly<Record<string, number | null>>
  /** Holding the window at the stake, after fees, by executor id. */
  holds: Readonly<Record<string, number | null>>
  /** A fresh story pointing the trade's way within the window before the call, by event id. */
  news: Readonly<Record<string, boolean | null>>
}

/** The app's own paper trades that closed, each with what is known of it. */
export function attributedTrades(executors: readonly ExecutorConfig[], readings: AttributionReadings): AttributedTrade[] {
  const out: AttributedTrade[] = []
  for (const executor of executors) {
    if (executor.mode !== 'paper' || executor.type !== 'position') continue
    const mark = executor.watch
    const result = mark?.result ?? executor.newsRule?.result
    if (result === undefined || result.exit === 'entry_expired' || result.exit === 'btc_moved') continue
    const params = executor.params as PositionExecutorParams
    if (params.side !== 'buy' && params.side !== 'sell') continue
    const stake = params.amountQuote
    const eventId = mark?.eventId ?? null
    const event = eventId === null ? undefined : readings.events[eventId]
    const vote = eventId === null ? undefined : readings.votes[eventId]
    const bucket = vote === undefined ? null : vote.usable < 2 ? 'one model' : agreementBucketOf(vote.taking, vote.usable)
    const newsAt = eventId === null ? undefined : readings.news[eventId]
    out.push({
      id: executor.id,
      symbol: executor.symbol,
      model: mark?.model ?? null,
      side: params.side,
      kind: event?.type ?? null,
      closedAt: result.closedAt,
      netQuote: result.pnlQuote,
      stakeQuote: stake,
      netPct: stake > 0 ? (result.pnlQuote / stake) * 100 : 0,
      r: rMultiple(result.pnlQuote, params),
      signal: readings.signals[executor.id] ?? null,
      regime: mark?.regime ?? (eventId === null ? null : (readings.btc[eventId] ?? null)),
      capTier: capTierOf(event?.live?.quoteVolume24h ?? null),
      news: newsAt === undefined || newsAt === null ? null : newsAt ? 'with news' : 'no news',
      vote: bucket,
      holdNetQuote: readings.holds[executor.id] ?? null
    })
  }
  return out.sort((a, b) => a.closedAt - b.closedAt)
}

export interface Concentration {
  trades: number
  netQuote: number
  /** Of the net, the share the best 1%, 5% and 10% of trades made, in percent; null where the net
   * is not positive or under thirty trades. */
  top1Pct: number | null
  top5Pct: number | null
  top10Pct: number | null
  /** The share the best five trades made. */
  bestFiveSharePct: number | null
  fragile: boolean
  enough: boolean
}

const sum = (values: readonly number[]): number => values.reduce((total, value) => total + value, 0)

/** How much of the net a few trades made. */
export function concentration(trades: readonly AttributedTrade[]): Concentration {
  const nets = trades.map((trade) => trade.netQuote).sort((a, b) => b - a)
  const net = sum(nets)
  const enough = trades.length >= RESEARCH_MIN_TRADES
  const share = (count: number): number | null => (!enough || net <= 0 ? null : (sum(nets.slice(0, Math.max(1, count))) / net) * 100)
  const bestFive = share(FRAGILE_TRADES)
  return {
    trades: trades.length,
    netQuote: net,
    top1Pct: share(Math.ceil(trades.length * 0.01)),
    top5Pct: share(Math.ceil(trades.length * 0.05)),
    top10Pct: share(Math.ceil(trades.length * 0.1)),
    bestFiveSharePct: bestFive,
    // Compared to a hundredth, as the share is shown: 90 is 90, whatever the floating point says.
    fragile: bestFive !== null && Math.round(bestFive * 100) / 100 >= FRAGILE_SHARE * 100,
    enough
  }
}

export interface SliceRow {
  key: string
  trades: number
  wins: number
  /** Null under ten trades. */
  winRatePct: number | null
  /** The mean net a trade over its stake, in percent. */
  expectancyPct: number | null
  meanR: number | null
  netQuote: number
  enough: boolean
}

const mean = (values: readonly number[]): number | null => (values.length === 0 ? null : sum(values) / values.length)

/** The trades cut by a key, each slice with its figures from ten trades. */
export function slicesBy(trades: readonly AttributedTrade[], keyOf: (trade: AttributedTrade) => string | null, order?: readonly string[]): SliceRow[] {
  const groups = new Map<string, AttributedTrade[]>()
  for (const trade of trades) {
    const key = keyOf(trade)
    if (key === null) continue
    groups.set(key, [...(groups.get(key) ?? []), trade])
  }
  const keys = order === undefined ? [...groups.keys()].sort() : [...order.filter((key) => groups.has(key)), ...[...groups.keys()].filter((key) => !order.includes(key)).sort()]
  return keys.map((key): SliceRow => {
    const own = groups.get(key) ?? []
    const enough = own.length >= RESEARCH_MIN_SLICE
    const wins = own.filter((trade) => trade.netQuote > 0).length
    const rs = own.map((trade) => trade.r).filter((r): r is number => r !== null)
    return {
      key,
      trades: own.length,
      wins,
      winRatePct: enough ? (wins / own.length) * 100 : null,
      expectancyPct: enough ? mean(own.map((trade) => trade.netPct)) : null,
      meanR: enough && rs.length > 0 ? mean(rs) : null,
      netQuote: sum(own.map((trade) => trade.netQuote)),
      enough
    }
  })
}

export function scoreBuckets(trades: readonly AttributedTrade[]): SliceRow[] {
  return slicesBy(trades, (trade) => scoreBucketOf(trade.signal), SCORE_BUCKETS)
}

export interface NetSourceRow {
  key: string
  trades: number
  netQuote: number
  /** Holding the window at the stake, after fees, added up over the trades it could be read for. */
  holdNetQuote: number
  /** The net less the hold: what the exit -- the target, the stop, the clock, the exit check -- added or cost. */
  restQuote: number
  enough: boolean
}

/** Where the net came from: the pair's own move over the window against the rest, by a key. */
export function netSources(trades: readonly AttributedTrade[], keyOf: (trade: AttributedTrade) => string | null): NetSourceRow[] {
  const read = trades.filter((trade) => trade.holdNetQuote !== null)
  const groups = new Map<string, AttributedTrade[]>()
  for (const trade of read) {
    const key = keyOf(trade)
    if (key === null) continue
    groups.set(key, [...(groups.get(key) ?? []), trade])
  }
  return [...groups.keys()].sort().map((key): NetSourceRow => {
    const own = groups.get(key) ?? []
    const net = sum(own.map((trade) => trade.netQuote))
    const hold = sum(own.map((trade) => trade.holdNetQuote ?? 0))
    return { key, trades: own.length, netQuote: net, holdNetQuote: hold, restQuote: net - hold, enough: own.length >= RESEARCH_MIN_SLICE }
  })
}

export interface Attribution {
  version: string
  trades: number
  concentration: Concentration
  scores: SliceRow[]
  byPair: SliceRow[]
  byCapTier: SliceRow[]
  byRegime: SliceRow[]
  byModel: SliceRow[]
  byKind: SliceRow[]
  byNews: SliceRow[]
  byVote: SliceRow[]
  sources: { all: NetSourceRow[]; byKind: NetSourceRow[]; byNews: NetSourceRow[]; byModel: NetSourceRow[]; byVote: NetSourceRow[] }
}

const REGIME_ORDER = ['panic', 'high-vol', 'recovery', 'bull', 'bear', 'sideways', 'rising', 'falling', 'flat']
const VOTE_ORDER = ['all', 'majority', 'half_or_fewer', 'one model']

export function attribution(trades: readonly AttributedTrade[]): Attribution {
  return {
    version: ATTRIBUTION_VERSION,
    trades: trades.length,
    concentration: concentration(trades),
    scores: scoreBuckets(trades),
    byPair: slicesBy(trades, (trade) => trade.symbol),
    byCapTier: slicesBy(trades, (trade) => trade.capTier, ['large', 'mid', 'small']),
    byRegime: slicesBy(trades, (trade) => trade.regime, REGIME_ORDER),
    byModel: slicesBy(trades, (trade) => trade.model),
    byKind: slicesBy(trades, (trade) => trade.kind),
    byNews: slicesBy(trades, (trade) => trade.news, ['with news', 'no news']),
    byVote: slicesBy(trades, (trade) => trade.vote, VOTE_ORDER),
    sources: {
      all: netSources(trades, () => 'all'),
      byKind: netSources(trades, (trade) => trade.kind),
      byNews: netSources(trades, (trade) => trade.news),
      byModel: netSources(trades, (trade) => trade.model),
      byVote: netSources(trades, (trade) => trade.vote)
    }
  }
}

const round = (value: number | null, digits = 2): number | null => (value === null ? null : Math.round(value * 10 ** digits) / 10 ** digits)

/** Every table as one spreadsheet. */
export function attributionCsv(report: Attribution): string {
  const rows: (string | number | null)[][] = []
  const c = report.concentration
  rows.push(['concentration', 'trades', c.trades, '', '', '', ''])
  rows.push(['concentration', 'net', round(c.netQuote), '', '', '', ''])
  rows.push(['concentration', 'best 1% share %', round(c.top1Pct), '', '', '', ''])
  rows.push(['concentration', 'best 5% share %', round(c.top5Pct), '', '', '', ''])
  rows.push(['concentration', 'best 10% share %', round(c.top10Pct), '', '', '', ''])
  rows.push(['concentration', 'best five share %', round(c.bestFiveSharePct), c.fragile ? 'fragile' : '', '', '', ''])
  const slices: [string, SliceRow[]][] = [['score', report.scores], ['pair', report.byPair], ['cap tier', report.byCapTier], ['regime', report.byRegime], ['model', report.byModel], ['kind', report.byKind], ['news', report.byNews], ['vote', report.byVote]]
  for (const [name, list] of slices) for (const row of list) rows.push([name, row.key, row.trades, row.wins, round(row.winRatePct), round(row.expectancyPct), round(row.netQuote)])
  const sources: [string, NetSourceRow[]][] = [['source', report.sources.all], ['source by kind', report.sources.byKind], ['source by news', report.sources.byNews], ['source by model', report.sources.byModel], ['source by vote', report.sources.byVote]]
  for (const [name, list] of sources) for (const row of list) rows.push([name, row.key, row.trades, round(row.netQuote), round(row.holdNetQuote), round(row.restQuote), row.enough ? '' : 'under ten'])
  return csvOf(['table', 'key', 'trades', 'wins or net', 'win rate % or hold', 'expectancy % or rest', 'net or note'], rows)
}
