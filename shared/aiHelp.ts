import {
  EVENT_BUY_AND_HOLD,
  QUANT_IDS,
  QUANT_NAMES,
  hybridName,
  quantRuleName,
  type EventBenchmarkRow,
  type EventBenchmarkSummary,
  type EventTrade,
  type QuantId
} from './aiEventBenchmark'
import { MIN_SCORED_CALLS } from './aiOutcome'
import { MAX_SPREAD_PCT } from './liveMarket'
import type { MarketEvent } from './marketEvent'
import { expectedDirection, type StoryMark } from './newsFeed'

// DOES AI HELP? The second V3 document's central question (§21, §33 and §61), answered by counting
// trades already scored (shared/aiEventBenchmark.ts) -- nothing here is asked of a model.
//
// THE ROWS. The quant baselines -- the follow rule where Trend Regime 4h, or Short-Term Channel 15m,
// agrees with the move -- buying and holding the same hours, a model on its own, and the hybrids:
// the model's own trades where a strategy agrees with its side. Each with its trades, gains over
// losses, net and R a trade, deepest fall, and a trade's Sharpe and Sortino.
//
// THREE VERDICTS, each comparing two sets of closed trades by their net return a trade:
// - AI IMPROVED QUANT: the hybrid against the quant rule it is built on, one verdict a strategy;
// - NEWS HELPED: the model's trades on events whose coin a fresh story named, pointing the trade's
//   way, in the hours before -- against its trades on events no story named;
// - LIVE PRICE HELPED: the model's trades on events whose spread was within the line the live check
//   enters at -- against those on a wider one, which the check would have refused.
// "Yes" only when the difference is larger than the 95% margin around it; "no" otherwise, saying
// whether it was smaller or only inside the noise; and "not enough trades" until each side has 30.
// These lines were written down before any result was looked at.

export const AI_HELP_MIN_TRADES = MIN_SCORED_CALLS
/** A story counts for an event from this long before it. */
export const AI_HELP_NEWS_SECONDS = 3 * 3600

export type AiHelpKind = 'quant' | 'hold' | 'ai' | 'hybrid'

export interface AiHelpRow {
  kind: AiHelpKind
  label: string
  row: EventBenchmarkRow
}

export type AiHelpAnswer = 'yes' | 'no' | 'not enough'

export interface AiHelpVerdict {
  id: 'quant-trend4h' | 'quant-channel15m' | 'news' | 'live'
  question: string
  answer: AiHelpAnswer
  text: string
}

export interface TradeComparison {
  answer: AiHelpAnswer
  /** Closed trades on each side. */
  a: number
  b: number
  meanA: number | null
  meanB: number | null
  /** meanA less meanB, and the 95% margin around it; null under the floor. */
  difference: number | null
  margin: number | null
}

const mean = (values: number[]): number => values.reduce((sum, value) => sum + value, 0) / values.length
const variance = (values: number[], at: number): number => values.reduce((sum, value) => sum + (value - at) ** 2, 0) / (values.length - 1)

/** Whether net returns `a` beat `b` a trade by more than the 95% margin around the difference of
 * their means. */
export function compareTrades(a: number[], b: number[]): TradeComparison {
  const meanA = a.length > 0 ? mean(a) : null
  const meanB = b.length > 0 ? mean(b) : null
  if (a.length < AI_HELP_MIN_TRADES || b.length < AI_HELP_MIN_TRADES || meanA === null || meanB === null) {
    return { answer: 'not enough', a: a.length, b: b.length, meanA, meanB, difference: null, margin: null }
  }
  const difference = meanA - meanB
  const margin = 1.96 * Math.sqrt(variance(a, meanA) / a.length + variance(b, meanB) / b.length)
  return { answer: difference > margin ? 'yes' : 'no', a: a.length, b: b.length, meanA, meanB, difference, margin }
}

/** The news on an event's coin in the hours before it: whether a fresh story pointed up, down, or
 * named it at all. */
export interface EventNews {
  up: boolean
  down: boolean
  any: boolean
}

/** Each event's news, by event id, from the stories on file. Null for an event from before the
 * first story on file, when none could have been read; an event an announcement raised is news,
 * pointing down. */
export function eventNewsOf(events: Pick<MarketEvent, 'id' | 'baseAsset' | 'time' | 'news'>[], marks: readonly StoryMark[]): Record<string, EventNews | null> {
  const firstRead = marks.reduce((first, mark) => Math.min(first, mark.publishedAt), Infinity)
  const out: Record<string, EventNews | null> = {}
  for (const event of events) {
    if (event.news !== undefined) {
      out[event.id] = { up: false, down: true, any: true }
      continue
    }
    if (event.time - AI_HELP_NEWS_SECONDS < firstRead) {
      out[event.id] = null
      continue
    }
    const about = marks.filter(
      (mark) => !mark.stale && mark.publishedAt >= event.time - AI_HELP_NEWS_SECONDS && mark.publishedAt <= event.time && mark.tickers.includes(event.baseAsset)
    )
    out[event.id] = {
      up: about.some((mark) => expectedDirection(mark.eventType) === 'up'),
      down: about.some((mark) => expectedDirection(mark.eventType) === 'down'),
      any: about.length > 0
    }
  }
  return out
}

const closedNets = (trades: EventTrade[]): number[] => trades.filter((trade) => trade.outcome.status === 'closed').map((trade) => trade.outcome.netPct ?? 0)
const signed = (value: number): string => `${value > 0 ? '+' : ''}${value.toFixed(2)}%`

function verdictText(comparison: TradeComparison, with_: string, without: string): string {
  if (comparison.answer === 'not enough') {
    return `Not enough trades yet: ${AI_HELP_MIN_TRADES} are needed on each side, and there are ${comparison.a} ${with_} and ${comparison.b} ${without}.`
  }
  const both = `${signed(comparison.meanA as number)} a trade over ${comparison.a} trades ${with_}, against ${signed(comparison.meanB as number)} over ${comparison.b} ${without}`
  const difference = comparison.difference as number
  const margin = (comparison.margin as number).toFixed(2)
  if (comparison.answer === 'yes') return `Yes: ${both}, ${difference.toFixed(2)} points more, beyond the ${margin}-point margin.`
  return difference > 0
    ? `No: ${both}, ${difference.toFixed(2)} points more, but inside the ${margin}-point margin: not told apart from chance.`
    : `No: ${both}, ${Math.abs(difference).toFixed(2)} points less.`
}

/** The rows and the three verdicts for one model, from a summary worked out with the quant states. */
export function doesAiHelp(input: {
  summary: Pick<EventBenchmarkSummary, 'models' | 'quant' | 'hybrids' | 'buyAndHold'>
  model: string
  events: Pick<MarketEvent, 'id' | 'live'>[]
  /** Each event's news by event id; null where the stories on file were not read. */
  news: Record<string, EventNews | null> | null
}): { rows: AiHelpRow[]; verdicts: AiHelpVerdict[] } {
  const { summary, model } = input
  const ai = summary.models.find((row) => row.name === model) ?? null
  const quantRow = (id: QuantId): EventBenchmarkRow | null => summary.quant.find((row) => row.name === quantRuleName(id)) ?? null
  const hybridRow = (id: QuantId): EventBenchmarkRow | null => summary.hybrids.find((entry) => entry.model === model && entry.quant === id)?.row ?? null

  const rows: AiHelpRow[] = []
  for (const id of QUANT_IDS) {
    const row = quantRow(id)
    if (row !== null) rows.push({ kind: 'quant', label: `Quant: ${QUANT_NAMES[id]}, following the move`, row })
  }
  rows.push({ kind: 'hold', label: EVENT_BUY_AND_HOLD, row: summary.buyAndHold })
  if (ai !== null) rows.push({ kind: 'ai', label: `AI: ${model}`, row: ai })
  for (const id of QUANT_IDS) {
    const row = hybridRow(id)
    if (row !== null) rows.push({ kind: 'hybrid', label: `Hybrid: ${hybridName(model, id)}`, row })
  }

  const verdicts: AiHelpVerdict[] = []
  for (const id of QUANT_IDS) {
    const quant = quantRow(id)
    const hybrid = hybridRow(id)
    if (quant === null || hybrid === null) continue
    const comparison = compareTrades(closedNets(hybrid.trades), closedNets(quant.trades))
    verdicts.push({
      id: id === 'trend4h' ? 'quant-trend4h' : 'quant-channel15m',
      question: `Did ${model} improve ${QUANT_NAMES[id]}?`,
      answer: comparison.answer,
      text: verdictText(comparison, `by the model where ${QUANT_NAMES[id]} agreed`, `by the strategy following every move it agreed with`)
    })
  }

  const eventAt = (trade: EventTrade): Pick<MarketEvent, 'id' | 'live'> | undefined => input.events[trade.index]
  const aiTrades = ai?.trades ?? []
  // News: the model's trades on events with a fresh story pointing its way, against those no story named.
  const withNews: EventTrade[] = []
  const withoutNews: EventTrade[] = []
  for (const trade of aiTrades) {
    const event = eventAt(trade)
    const news = event === undefined ? null : (input.news?.[event.id] ?? null)
    if (news === null) continue
    if (trade.side === 'long' ? news.up : news.down) withNews.push(trade)
    else if (!news.any) withoutNews.push(trade)
  }
  const news = compareTrades(closedNets(withNews), closedNets(withoutNews))
  verdicts.push({ id: 'news', question: 'Did news help?', answer: news.answer, text: verdictText(news, "on events with a story pointing the trade's way", 'on events no story named') })

  // The live price: the model's trades on events whose spread was within the line, against wider ones.
  const tight: EventTrade[] = []
  const wide: EventTrade[] = []
  for (const trade of aiTrades) {
    const spread = eventAt(trade)?.live?.spreadPct ?? null
    if (spread === null) continue
    if (spread <= MAX_SPREAD_PCT) tight.push(trade)
    else wide.push(trade)
  }
  const live = compareTrades(closedNets(tight), closedNets(wide))
  verdicts.push({
    id: 'live',
    question: 'Did the live price help?',
    answer: live.answer,
    text: verdictText(live, `on events with a spread within ${MAX_SPREAD_PCT}%`, 'on wider ones, which the live check refuses')
  })
  return { rows, verdicts }
}
