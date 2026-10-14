import type { AiCallRecord } from '../../shared/aiLedger'
import type { AiModelInfo } from '../../shared/aiCost'
import { ENGLISH, type I18n } from '../../shared/i18n/translate'

// WHAT EACH MODEL COSTS AND HOW IT HAS ANSWERED (the V5 document, §34; V5 Stage 5): the catalogue's
// price a million tokens and whether the model takes a strict schema, and from thirty days of the
// ledger how many calls it took, how fast at the median, and how many were refused or failed.
// Shown beside each model the watch may ask, so the choice is made on these and not on a name.
// Reads the catalogue (free) and the ledger; asks nothing.

export interface ModelFacts {
  promptPer1M: number | null
  completionPer1M: number | null
  schema: boolean | null
  calls: number
  medianLatencyMs: number | null
  /** Of the calls, the share refused by the validator or failed outright; null with no calls. */
  refusedOrFailedPct: number | null
}

const baseOf = (model: string): string => model.split('@')[0]

export function modelFactsOf(model: string, catalogue: readonly AiModelInfo[], rows: readonly Pick<AiCallRecord, 'model' | 'status' | 'usage'>[]): ModelFacts {
  const info = catalogue.find((entry) => entry.id === baseOf(model))
  const own = rows.filter((row) => baseOf(row.model) === baseOf(model))
  const latencies = own
    .map((row) => row.usage?.latencyMs)
    .filter((value): value is number => typeof value === 'number' && Number.isFinite(value))
    .sort((a, b) => a - b)
  const middle = latencies.length === 0 ? null : latencies.length % 2 === 1 ? latencies[(latencies.length - 1) / 2] : (latencies[latencies.length / 2 - 1] + latencies[latencies.length / 2]) / 2
  const bad = own.filter((row) => row.status !== 'ok').length
  return {
    promptPer1M: info?.promptPricePerToken == null ? null : info.promptPricePerToken * 1_000_000,
    completionPer1M: info?.completionPricePerToken == null ? null : info.completionPricePerToken * 1_000_000,
    schema: info === undefined ? null : info.structuredOutputs,
    calls: own.length,
    medianLatencyMs: middle,
    refusedOrFailedPct: own.length === 0 ? null : (bad / own.length) * 100
  }
}

/** The facts in a line: "$0.25 in · $2.00 out a million tokens · strict schema · 100 calls in 30 days, 6.4 s at the median, 0% refused or failed". */
export function describeModelFacts(facts: ModelFacts, i18n: I18n = ENGLISH): string {
  const { t, num, money, pctPlain } = i18n
  const usd = (value: number): string => (i18n.language === 'en' ? `$${value.toFixed(2)}` : money(value, 'USD', 2))
  const price = facts.promptPer1M === null || facts.completionPer1M === null ? t('no fixed price') : t('{in} in · {out} out a million tokens', { in: usd(facts.promptPer1M), out: usd(facts.completionPer1M) })
  const schema = facts.schema === null ? t('not in the catalogue') : facts.schema ? t('strict schema') : t('no strict schema')
  const record =
    facts.calls === 0
      ? t('no calls in 30 days')
      : t('{count} calls in 30 days, {seconds} s at the median, {share} refused or failed', {
          count: facts.calls,
          seconds: facts.medianLatencyMs === null ? '?' : num(facts.medianLatencyMs / 1000, 1, 1),
          share: pctPlain(Math.round(facts.refusedOrFailedPct ?? 0), 0)
        })
  return `${price} · ${schema} · ${record}`
}

/** The facts of each model, from the catalogue and the ledger through the bridge. A catalogue or a
 * ledger that cannot be read leaves its part out rather than failing the card. */
export async function loadModelFacts(models: readonly string[], sinceSec: number): Promise<Record<string, ModelFacts>> {
  const [catalogue, page] = await Promise.all([
    window.api.ai.listModels(false).then(
      (result) => result.models,
      () => [] as AiModelInfo[]
    ),
    window.api.ai.listCalls({ sinceSec, limit: 5000 }).then(
      (result) => result.rows,
      () => [] as AiCallRecord[]
    )
  ])
  return Object.fromEntries(models.map((model) => [model, modelFactsOf(model, catalogue, page)]))
}
