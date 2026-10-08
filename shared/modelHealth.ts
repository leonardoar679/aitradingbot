import type { EventBenchmarkRow, EventTrade } from './aiEventBenchmark'
import { MIN_SCORED_CALLS } from './aiOutcome'
import { describeDecider } from './aiPanel'
import { watchPaperExecutors } from './aiWatchPaper'
import type { ExecutorConfig } from './ipc'
import { profitFactorOf } from './strategyHealth'

// MODEL HEALTH, SHOWN AND NEVER ACTING (the V4 document, §107-109; the user's choice of 7 October
// 2026: a model that has degraded is flagged and told once a day, never switched off by the app).
//
// Two readings of a model's row on the live board (shared/aiEventBenchmark.ts, over the events the
// watch put to it as they happened):
//
// - THE PROMOTION CHECKLIST: seven lines a person would want ticked before trusting a model with
//   more. A sample of a hundred closed trades; a positive expectancy; a profit factor over one; a
//   drawdown under ten R; the live board's sign agreeing with the benchmark's; the app's own paper
//   trades on its calls agreeing with the board (a profit factor within 30%); and a net after what
//   its answers cost that is positive. Ticks, and no action: nothing is promoted by a full list.
//
// - DEGRADED: over its last thirty closed trades it loses (an expectancy under zero AND a profit
//   factor under one), or its confidence is more than twenty points from its hit rate over those
//   trades. The mark on the registry and the Watch card, and one CIRCUIT_BREAKER notice a day.
//   The watch still asks it: the models it asks are chosen by a person on Opportunities.

export const PROMOTION_TRADES = 100
export const PROMOTION_MAX_DRAWDOWN_R = 10
export const PROMOTION_PAPER_PF_SLACK = 0.3
export const HEALTH_ROLLING_TRADES = 30
export const HEALTH_CONFIDENCE_SLACK_POINTS = 20

export type LiveRowForHealth = Pick<EventBenchmarkRow, 'closed' | 'meanNetPct' | 'profitFactor' | 'netAfterAiCostUsd' | 'trades'>

/** The closed trades of a row, the most recently closed first. */
export function closedTrades(trades: readonly EventTrade[]): EventTrade[] {
  return trades.filter((trade) => trade.outcome.status === 'closed').sort((a, b) => (b.outcome.exitTime ?? b.time) - (a.outcome.exitTime ?? a.time))
}

/** The deepest fall of the running total in R, trades in the order they closed. Null where no
 * closed trade carries an R. */
export function drawdownR(trades: readonly EventTrade[]): number | null {
  const rs = closedTrades(trades)
    .reverse()
    .map((trade) => trade.outcome.r)
    .filter((r): r is number => r !== null)
  if (rs.length === 0) return null
  let running = 0
  let peak = 0
  let worst = 0
  for (const r of rs) {
    running += r
    if (running > peak) peak = running
    if (peak - running > worst) worst = peak - running
  }
  return worst
}

export interface ChecklistItem {
  label: string
  /** True ticked, false not, null where the record cannot say yet. */
  ok: boolean | null
  detail: string
}

export interface PromotionChecklist {
  items: ChecklistItem[]
  ticked: number
  /** Every line ticked. */
  ready: boolean
}

export interface PaperRecord {
  closed: number
  profitFactor: number | null
}

const signed = (value: number, places = 2): string => `${value >= 0 ? '+' : ''}${value.toFixed(places)}`
/** To a hundredth: a sum of thirty fractions carries a drift that would put "twenty points exactly" on
 * the wrong side of the line. */
const points = (value: number): number => Math.round(value * 100) / 100

export function promotionChecklist(input: { live: LiveRowForHealth; benchmark: { meanNetPct: number | null; closed: number } | null; paper: PaperRecord | null }): PromotionChecklist {
  const { live, benchmark, paper } = input
  const drawdown = drawdownR(live.trades)
  const items: ChecklistItem[] = [
    { label: `${PROMOTION_TRADES} closed trades`, ok: live.closed >= PROMOTION_TRADES, detail: `${live.closed} of ${PROMOTION_TRADES}` },
    {
      label: 'Positive expectancy',
      ok: live.meanNetPct === null ? null : live.meanNetPct > 0,
      detail: live.meanNetPct === null ? `under ${MIN_SCORED_CALLS} closed trades` : `${signed(live.meanNetPct)}% a trade`
    },
    {
      label: 'Profit factor over 1',
      ok: live.profitFactor === null ? (live.closed >= MIN_SCORED_CALLS ? true : null) : live.profitFactor > 1,
      detail: live.profitFactor === null ? (live.closed >= MIN_SCORED_CALLS ? 'no losing trade' : `under ${MIN_SCORED_CALLS} closed trades`) : live.profitFactor.toFixed(2)
    },
    { label: `Drawdown under ${PROMOTION_MAX_DRAWDOWN_R} R`, ok: drawdown === null ? null : drawdown < PROMOTION_MAX_DRAWDOWN_R, detail: drawdown === null ? 'no closed trade with a stop' : `${drawdown.toFixed(1)} R` },
    {
      label: "Live board's sign agrees with the benchmark's",
      ok: benchmark === null || benchmark.meanNetPct === null || live.meanNetPct === null ? null : live.meanNetPct > 0 === benchmark.meanNetPct > 0,
      detail:
        benchmark === null
          ? 'no benchmark scored this session'
          : benchmark.meanNetPct === null || live.meanNetPct === null
            ? `under ${MIN_SCORED_CALLS} closed trades on one of them`
            : `live ${signed(live.meanNetPct)}%, benchmark ${signed(benchmark.meanNetPct)}% a trade`
    },
    {
      label: `Live and paper agree: profit factor within ${Math.round(PROMOTION_PAPER_PF_SLACK * 100)}%`,
      // To a thousandth: 0.42 over 1.4 is 0.3 on paper and a hair over it in binary.
      ok: paper === null || paper.profitFactor === null || live.profitFactor === null ? null : Math.round((Math.abs(paper.profitFactor - live.profitFactor) / live.profitFactor) * 1000) / 1000 <= PROMOTION_PAPER_PF_SLACK,
      detail:
        paper === null || paper.closed === 0
          ? 'no paper trade on its calls'
          : paper.profitFactor === null || live.profitFactor === null
            ? 'a profit factor is missing on one side'
            : `paper ${paper.profitFactor.toFixed(2)} over ${paper.closed}, live ${live.profitFactor.toFixed(2)}`
    },
    {
      label: 'Net after AI cost positive',
      ok: live.netAfterAiCostUsd === null ? null : live.netAfterAiCostUsd > 0,
      detail: live.netAfterAiCostUsd === null ? 'not a model' : `$${live.netAfterAiCostUsd.toFixed(2)} at $1,000 a trade`
    }
  ]
  const ticked = items.filter((item) => item.ok === true).length
  return { items, ticked, ready: ticked === items.length }
}

export interface ModelHealth {
  degraded: boolean
  reasons: string[]
  closed: number
  /** Over the last HEALTH_ROLLING_TRADES closed trades; the figures are null under that many. */
  rolling: { trades: number; expectancyPct: number | null; profitFactor: number | null; meanConfidencePct: number | null; hitRatePct: number | null }
}

export function modelHealth(row: Pick<EventBenchmarkRow, 'trades'>): ModelHealth {
  const closed = closedTrades(row.trades)
  const recent = closed.slice(0, HEALTH_ROLLING_TRADES)
  if (recent.length < HEALTH_ROLLING_TRADES) {
    return { degraded: false, reasons: [], closed: closed.length, rolling: { trades: recent.length, expectancyPct: null, profitFactor: null, meanConfidencePct: null, hitRatePct: null } }
  }
  const nets = recent.map((trade) => trade.outcome.netPct ?? 0)
  const expectancyPct = points(nets.reduce((sum, net) => sum + net, 0) / recent.length)
  const profitFactor = profitFactorOf(nets)
  const meanConfidencePct = points((recent.reduce((sum, trade) => sum + trade.confidence, 0) / recent.length) * 100)
  const hitRatePct = points((nets.filter((net) => net > 0).length / recent.length) * 100)
  const reasons: string[] = []
  if (expectancyPct < 0 && profitFactor !== null && profitFactor < 1) {
    reasons.push(`losing over its last ${HEALTH_ROLLING_TRADES} closed trades: ${signed(expectancyPct)}% a trade, profit factor ${profitFactor.toFixed(2)}`)
  }
  if (Math.abs(meanConfidencePct - hitRatePct) > HEALTH_CONFIDENCE_SLACK_POINTS) {
    reasons.push(`says ${meanConfidencePct.toFixed(0)}% and is right ${hitRatePct.toFixed(0)}% of the time over those trades`)
  }
  return { degraded: reasons.length > 0, reasons, closed: closed.length, rolling: { trades: recent.length, expectancyPct, profitFactor, meanConfidencePct, hitRatePct } }
}

/** The notice's body, and the registry's line. */
export function describeModelHealth(model: string, health: ModelHealth): string {
  if (health.degraded) return `${describeDecider(model)} has degraded: ${health.reasons.join('; ')}. The watch still asks it; untick it on Opportunities to stop asking it. Nothing is switched off by this.`
  if (health.rolling.expectancyPct === null) return `${describeDecider(model)}: ${health.rolling.trades} of ${HEALTH_ROLLING_TRADES} closed trades, not enough to judge.`
  return `${describeDecider(model)}: as expected over its last ${HEALTH_ROLLING_TRADES} closed trades (${signed(health.rolling.expectancyPct)}% a trade, says ${health.rolling.meanConfidencePct?.toFixed(0)}% and is right ${health.rolling.hitRatePct?.toFixed(0)}%).`
}

/** The app's own paper trades on a model's calls, as they were settled: the record the live board is
 * set against in the checklist. */
export function paperRecordOf(executors: readonly ExecutorConfig[], model: string): PaperRecord {
  const results = watchPaperExecutors([...executors])
    .filter((executor) => executor.watch?.model === model && executor.watch.result !== undefined && executor.watch.result.exit !== 'btc_moved')
    .map((executor) => executor.watch?.result?.pnlQuote ?? 0)
  return { closed: results.length, profitFactor: profitFactorOf(results) }
}
