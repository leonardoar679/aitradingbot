import type { AiModelInfo } from './aiCost'
import { aiModelSlugOf } from './aiEffort'
import type { EventBenchmarkRow } from './aiEventBenchmark'
import type { AiCallRecord } from './aiLedger'

// THE MODEL REGISTRY, SHOWN AND NEVER ACTING (the second V3 document, §16 and §35-36).
//
// One view of each model the app may ask: what the catalogue says of it (its context, its prices,
// whether it can be held to a schema), what the ledger says it has done over the last thirty days
// (calls, answers refused, how long it takes, what it cost, which dated version answered), and its
// row of the live leaderboard where it has one -- closed trades, profit factor, R a trade, and how
// it did by event type and by Bitcoin's regime. The leaderboard's own lines hold: a figure under
// thirty closed trades, or ten in a slice, is not printed.
//
// NOTHING IS STORED AND NOTHING IS PROMOTED. It is worked out when looked at, like every other view
// of the ledger, and the watch's models are still chosen by a person on Opportunities. The document
// asks for a registry that scores and promotes models by itself; measured, no model has shown an
// edge to promote, and a promotion rule would be fitted to noise.

export const REGISTRY_DAYS = 30

export interface RegistrySlice {
  key: string
  trades: number
  wins: number
  /** Net return a trade, in percent; null under ten closed trades, as the benchmark leaves it. */
  meanNetPct: number | null
}

export interface ModelRegistryResults {
  closed: number
  /** Null under thirty closed trades, or with no losing trade to divide by. */
  profitFactor: number | null
  meanR: number | null
  byType: RegistrySlice[]
  byBtc: RegistrySlice[]
}

export interface ModelRegistryEntry {
  id: string
  /** The catalogue's entry, under this id (a model at a lower effort shares its model's); null when
   * the catalogue no longer carries it. */
  listed: AiModelInfo | null
  /** Over the calls given, which the caller limits to REGISTRY_DAYS. */
  calls: number
  /** Calls that got an answer back, refused ones included. */
  answered: number
  refused: number
  failed: number
  latencyP50Ms: number | null
  latencyP95Ms: number | null
  costUsd: number
  lastAskedAt: number | null
  /** The dated versions OpenRouter said answered, most recent first. */
  servedModels: string[]
  providers: string[]
  /** Its leaderboard row, where the watch has asked it; null where it has none. */
  results: ModelRegistryResults | null
}

/** The nearest-rank percentile of a sorted list; null for an empty one. */
export function percentile(sorted: readonly number[], p: number): number | null {
  if (sorted.length === 0) return null
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1))
  return sorted[index]
}

export function modelRegistry(input: {
  models: readonly string[]
  catalogue: readonly AiModelInfo[]
  calls: readonly AiCallRecord[]
  rows: readonly Pick<EventBenchmarkRow, 'name' | 'closed' | 'profitFactor' | 'meanR' | 'slices'>[]
}): ModelRegistryEntry[] {
  const known = new Map(input.catalogue.map((model) => [model.id, model]))
  return input.models.map((id) => {
    const base = known.get(aiModelSlugOf(id)) ?? null
    const own = input.calls.filter((row) => row.model === id).sort((a, b) => b.at - a.at)
    const failed = own.filter((row) => row.status === 'failed')
    const timed = own
      .filter((row) => row.status !== 'failed' && row.usage.latencyMs > 0)
      .map((row) => row.usage.latencyMs)
      .sort((a, b) => a - b)
    const servedModels: string[] = []
    const providers: string[] = []
    for (const row of own) {
      if (row.servedModel !== undefined && !servedModels.includes(row.servedModel)) servedModels.push(row.servedModel)
      if (row.provider !== null && !providers.includes(row.provider)) providers.push(row.provider)
    }
    const row = input.rows.find((entry) => entry.name === id)
    const slice = (by: 'type' | 'btc'): RegistrySlice[] =>
      row === undefined ? [] : row.slices.filter((entry) => entry.by === by).map((entry) => ({ key: entry.key, trades: entry.trades, wins: entry.wins, meanNetPct: entry.meanNetPct }))
    return {
      id,
      listed: base === null ? null : { ...base, id },
      calls: own.length,
      answered: own.length - failed.length,
      refused: own.filter((entry) => entry.status === 'rejected').length,
      failed: failed.length,
      latencyP50Ms: percentile(timed, 0.5),
      latencyP95Ms: percentile(timed, 0.95),
      costUsd: own.reduce((sum, entry) => sum + (entry.usage.costUsd ?? 0), 0),
      lastAskedAt: own.length === 0 ? null : own[0].at,
      servedModels,
      providers,
      results: row === undefined ? null : { closed: row.closed, profitFactor: row.profitFactor, meanR: row.meanR, byType: slice('type'), byBtc: slice('btc') }
    }
  })
}
