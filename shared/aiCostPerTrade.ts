import type { AiCallRecord } from './aiLedger'
import type { ExecutorConfig } from './ipc'

// WHAT AN ANSWER COSTS A TRADE (the V4 document, §77). For each of the watch's own paper trades,
// what the ledger says was spent to make it: every call the watch made on its event, whichever
// model answered, and the additions on it -- the reviewer's second look on the event, and the exit
// check's looks at the trade. Then, by model: the cost a trade, a winning trade, and a dollar of
// net result. Read from the records; nothing here is stored, asked or acted on.

/** Dollars to a millionth: sums of a ledger's costs, which are fractions of a cent, without the
 * drift of adding them. */
const round = (usd: number): number => Math.round(usd * 1_000_000) / 1_000_000

export interface TradeCost {
  executorId: string
  model: string
  eventId: string
  /** The watch's calls on the event, all models asked. */
  callsUsd: number
  /** The reviewer's and the exit check's calls on it. */
  additionsUsd: number
  totalUsd: number
  /** After the simulation's fees; null while the trade is open. */
  pnlQuote: number | null
}

/** Each of the watch's own paper trades with what was spent to make it. A trade dropped before it
 * entered still cost its calls, and is counted. */
export function tradeCosts(executors: readonly ExecutorConfig[], rows: readonly AiCallRecord[]): TradeCost[] {
  const out: TradeCost[] = []
  for (const executor of executors) {
    const mark = executor.watch
    if (mark === undefined || executor.mode !== 'paper' || executor.type !== 'position') continue
    let callsUsd = 0
    let additionsUsd = 0
    for (const row of rows) {
      const cost = row.usage.costUsd ?? 0
      if (row.source === 'watch' && row.eventId === mark.eventId) callsUsd += cost
      else if (row.addition === 'review' && row.subjectId === mark.eventId) additionsUsd += cost
      else if (row.addition === 'exit' && row.subjectId !== undefined && row.subjectId.startsWith(`${executor.id}:`)) additionsUsd += cost
    }
    out.push({
      executorId: executor.id,
      model: mark.model,
      eventId: mark.eventId,
      callsUsd: round(callsUsd),
      additionsUsd: round(additionsUsd),
      totalUsd: round(callsUsd + additionsUsd),
      pnlQuote: mark.result === undefined ? null : mark.result.pnlQuote
    })
  }
  return out
}

export interface ModelTradeCosts {
  model: string
  trades: number
  /** Closed trades, and those among them that made money. */
  closed: number
  wins: number
  costUsd: number
  perTradeUsd: number
  /** Null without a winning trade. */
  perWinUsd: number | null
  /** The closed trades' net result in their quote, taken as dollars. */
  netQuote: number
  /** Cents of AI spend a dollar of net result cost; null where the net is not positive. */
  perNetDollar: number | null
}

/** The costs by model, dearest a trade first. */
export function modelTradeCosts(costs: readonly TradeCost[]): ModelTradeCosts[] {
  const byModel = new Map<string, TradeCost[]>()
  for (const cost of costs) byModel.set(cost.model, [...(byModel.get(cost.model) ?? []), cost])
  const out: ModelTradeCosts[] = []
  for (const [model, own] of byModel) {
    const closed = own.filter((cost) => cost.pnlQuote !== null)
    const wins = closed.filter((cost) => (cost.pnlQuote ?? 0) > 0).length
    const costUsd = round(own.reduce((sum, cost) => sum + cost.totalUsd, 0))
    const netQuote = round(closed.reduce((sum, cost) => sum + (cost.pnlQuote ?? 0), 0))
    const closedCost = round(closed.reduce((sum, cost) => sum + cost.totalUsd, 0))
    out.push({
      model,
      trades: own.length,
      closed: closed.length,
      wins,
      costUsd,
      perTradeUsd: own.length === 0 ? 0 : costUsd / own.length,
      perWinUsd: wins === 0 ? null : closedCost / wins,
      netQuote,
      perNetDollar: netQuote > 0 ? closedCost / netQuote : null
    })
  }
  return out.sort((a, b) => b.perTradeUsd - a.perTradeUsd || a.model.localeCompare(b.model))
}

const usd = (value: number): string => (value < 0.01 && value > 0 ? `$${value.toFixed(4)}` : `$${value.toFixed(2)}`)

/** "$0.012 a trade, $0.036 a winning trade, 1.1 cents a dollar of net result". */
export function describeTradeCosts(entry: ModelTradeCosts): string {
  const win = entry.perWinUsd === null ? 'no winning trade yet' : `${usd(entry.perWinUsd)} a winning trade`
  const net = entry.perNetDollar === null ? 'no positive net to set it against' : `${(entry.perNetDollar * 100).toFixed(1)} cents a dollar of net result`
  return `${usd(entry.perTradeUsd)} a trade over ${entry.trades}, ${win}, ${net}.`
}
