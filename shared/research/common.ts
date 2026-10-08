import type { AiSignalDecision } from '../aiSignal'
import type { EventBenchmarkInput } from '../aiEventBenchmark'
import { isActionableOpportunity } from '../aiOpportunity'
import { DEFAULT_OPPORTUNITY_COSTS, opportunityCallOf, replayAnsweredAt, slippageRateForEvent, type OpportunityCall, type OpportunityCosts, type OpportunityOutcome } from '../aiOpportunityOutcome'
import type { MarketEvent } from '../marketEvent'

// RESEARCH ON THE RECORD (the V4 document, §57-72): what the records already hold, read as tables,
// with no model asked and nothing acted on. Each table is a pure builder over the watch's events,
// the answers on file and the candles the outcomes already fetch. Every figure is labelled: NET is
// after the fees and slippage the score charges; GROSS is before them; LIVE PAPER is the app's own
// paper trades as they were settled. A row needs thirty trades and a slice ten, or it says "not
// enough" and shows no figure.

export const RESEARCH_MIN_TRADES = 30
export const RESEARCH_MIN_SLICE = 10
/** Events the research reads, at most: the newest. More is more requests for the same answer. */
export const RESEARCH_MAX_EVENTS = 200

export type ResearchLabel = 'GROSS' | 'NET' | 'LIVE PAPER'

export type ResearchInput = Pick<EventBenchmarkInput, 'events' | 'models' | 'answers' | 'answeredAt' | 'bars' | 'dailyVolume' | 'nowSec'>

export interface TradeStats {
  trades: number
  closed: number
  wins: number
  /** Null under the minimum. */
  winRatePct: number | null
  profitFactor: number | null
  /** The mean net a trade, in percent. */
  expectancyPct: number | null
  meanR: number | null
  meanBestPct: number | null
  meanWorstPct: number | null
  enough: boolean
}

const mean = (values: number[]): number | null => (values.length === 0 ? null : values.reduce((sum, value) => sum + value, 0) / values.length)

/** The figures of a set of outcomes, shown only from `minimum` closed trades. */
export function tradeStats(outcomes: readonly OpportunityOutcome[], minimum = RESEARCH_MIN_TRADES): TradeStats {
  const closed = outcomes.filter((outcome) => outcome.status === 'closed')
  const nets = closed.map((outcome) => outcome.netPct ?? 0)
  const wins = nets.filter((net) => net > 0)
  const losses = nets.filter((net) => net <= 0)
  const enough = closed.length >= minimum
  const grossLoss = -losses.reduce((sum, net) => sum + net, 0)
  const rs = closed.map((outcome) => outcome.r).filter((r): r is number => r !== null)
  return {
    trades: outcomes.length,
    closed: closed.length,
    wins: wins.length,
    winRatePct: enough ? (wins.length / closed.length) * 100 : null,
    profitFactor: enough && grossLoss > 0 ? wins.reduce((sum, net) => sum + net, 0) / grossLoss : null,
    expectancyPct: enough ? mean(nets) : null,
    meanR: enough && rs.length > 0 ? mean(rs) : null,
    meanBestPct: enough ? mean(closed.map((outcome) => outcome.bestPct ?? 0)) : null,
    meanWorstPct: enough ? mean(closed.map((outcome) => outcome.worstPct ?? 0)) : null,
    enough
  }
}

/** One actionable answer of the watch's, as a call with its costs: what every sweep starts from. */
export interface ResearchCall {
  index: number
  event: MarketEvent
  model: string
  decision: AiSignalDecision
  call: OpportunityCall
  costs: OpportunityCosts
}

/** When a model's answer was in hand: when it really arrived, else after the ask delay and the
 * model's own latency, as the benchmark takes it. */
export function arrivalOf(input: ResearchInput, model: string, index: number, decision: AiSignalDecision): number {
  return input.answeredAt?.[model]?.[index] ?? replayAnsweredAt(input.events[index].time, decision.usage?.latencyMs)
}

/** Every answer this app would act on, from every model compared, each as the call the score
 * trades. The same entry, stop, target and horizon every sweep starts from. */
export function researchCalls(input: ResearchInput): ResearchCall[] {
  const out: ResearchCall[] = []
  input.events.forEach((event, index) => {
    for (const model of input.models) {
      const decision = input.answers[model]?.[index] ?? null
      if (!isActionableOpportunity(decision) || decision === null) continue
      const call = opportunityCallOf(event.time, decision, arrivalOf(input, model, index, decision))
      if (call === null) continue
      out.push({ index, event, model, decision, call, costs: { feeRate: DEFAULT_OPPORTUNITY_COSTS.feeRate, slippageRate: slippageRateForEvent(event, input.dailyVolume?.[event.id]) } })
    }
  })
  return out
}

/** A CSV cell: quoted when it holds a comma, a quote or a line break. */
export function csvCell(value: string | number | null | undefined): string {
  if (value === null || value === undefined) return ''
  const text = typeof value === 'number' ? (Number.isFinite(value) ? String(Math.round(value * 10_000) / 10_000) : '') : value
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text
}

/** A table as CSV, headers first. */
export function csvOf(headers: readonly string[], rows: readonly (readonly (string | number | null | undefined)[])[]): string {
  return [headers, ...rows].map((row) => row.map(csvCell).join(',')).join('\n') + '\n'
}

/** A figure as it is shown: to two places, with a sign for a percent, or "not enough". */
export function figure(value: number | null, kind: 'pct' | 'ratio' | 'r' = 'pct'): string {
  if (value === null) return 'not enough'
  if (kind === 'ratio') return value.toFixed(2)
  const signed = `${value >= 0 ? '+' : ''}${value.toFixed(2)}`
  return kind === 'r' ? `${signed} R` : `${signed}%`
}
