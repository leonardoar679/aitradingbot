import type { AiCallRecord } from '../aiLedger'
import type { ExecutorConfig } from '../ipc'
import { RESEARCH_MIN_TRADES } from './common'

// AGREEMENT VALUE (the V5 document, §90; V5 Stage 5): of the app's own paper trades the watch
// opened, how those where every model agreed did against those where only more than half did, or
// half or fewer. LIVE PAPER: the trades as they were settled. A row needs thirty closed trades, or
// it says "not enough"; and while the watch asks one model there is nothing for models to agree
// on, which the table says instead of a figure. If the data does not back the vote, the vote is
// not a rule worth keeping (the document, §90) -- this is where that is read.

export type AgreementBucket = 'all' | 'majority' | 'half_or_fewer'

export interface AgreementRow {
  bucket: AgreementBucket
  name: string
  label: 'LIVE PAPER'
  closed: number
  wins: number
  winRatePct: number | null
  profitFactor: number | null
  /** The mean net result a trade, in percent of its stake. */
  meanNetPct: number | null
}

export interface AgreementTable {
  /** Models whose answers were on file for the trades' events, at most, over all of them. */
  modelsAsked: number
  rows: AgreementRow[]
}

const BUCKET_NAMES: Record<AgreementBucket, string> = { all: 'All agreed', majority: 'More than half agreed', half_or_fewer: 'Half or fewer agreed' }

function sideOf(row: Pick<AiCallRecord, 'recommendation'>): 'buy' | 'sell' | 'hold' | null {
  return row.recommendation === 'buy' || row.recommendation === 'sell' || row.recommendation === 'hold' ? row.recommendation : null
}

/** Which bucket a trade falls in: of the models that answered its event usably, how many took its side. */
export function agreementBucketOf(taking: number, usable: number): AgreementBucket | null {
  if (usable < 2) return null
  if (taking === usable) return 'all'
  if (taking * 2 > usable) return 'majority'
  return 'half_or_fewer'
}

export function agreementValue(executors: readonly ExecutorConfig[], calls: readonly Pick<AiCallRecord, 'eventId' | 'model' | 'recommendation' | 'status' | 'source'>[]): AgreementTable {
  const byEvent = new Map<string, Map<string, 'buy' | 'sell' | 'hold'>>()
  for (const row of calls) {
    if (row.source !== 'watch' || row.status !== 'ok' || row.eventId === undefined) continue
    const side = sideOf(row)
    if (side === null) continue
    const answers = byEvent.get(row.eventId) ?? new Map<string, 'buy' | 'sell' | 'hold'>()
    answers.set(row.model, side)
    byEvent.set(row.eventId, answers)
  }
  // How many models the watch has been asking, over every event answered: what the note rests on.
  let modelsAsked = 0
  for (const answers of byEvent.values()) modelsAsked = Math.max(modelsAsked, answers.size)
  const nets: Record<AgreementBucket, number[]> = { all: [], majority: [], half_or_fewer: [] }
  for (const executor of executors) {
    const mark = executor.watch
    if (mark === undefined || mark.result === undefined || mark.result.exit === 'btc_moved' || executor.mode !== 'paper' || executor.type !== 'position') continue
    const answers = byEvent.get(mark.eventId)
    if (answers === undefined) continue
    // A position executor's params: its side and its stake (shared/ipc.ts).
    const params = executor.params as Partial<{ side: 'buy' | 'sell'; amountQuote: number }>
    if (params.side !== 'buy' && params.side !== 'sell') continue
    const taking = [...answers.values()].filter((side) => side === params.side).length
    const bucket = agreementBucketOf(taking, answers.size)
    if (bucket === null) continue
    const stake = typeof params.amountQuote === 'number' ? params.amountQuote : 0
    nets[bucket].push(stake > 0 ? (mark.result.pnlQuote / stake) * 100 : 0)
  }
  const rows = (Object.keys(BUCKET_NAMES) as AgreementBucket[]).map((bucket): AgreementRow => {
    const values = nets[bucket]
    const wins = values.filter((net) => net > 0)
    const losses = values.filter((net) => net <= 0)
    const enough = values.length >= RESEARCH_MIN_TRADES
    const grossLoss = -losses.reduce((sum, net) => sum + net, 0)
    return {
      bucket,
      name: BUCKET_NAMES[bucket],
      label: 'LIVE PAPER',
      closed: values.length,
      wins: wins.length,
      winRatePct: enough ? (wins.length / values.length) * 100 : null,
      profitFactor: enough && grossLoss > 0 ? wins.reduce((sum, net) => sum + net, 0) / grossLoss : null,
      meanNetPct: enough ? values.reduce((sum, net) => sum + net, 0) / values.length : null
    }
  })
  return { modelsAsked, rows }
}
