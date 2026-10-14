import { ENGLISH, type I18n } from '../../shared/i18n/translate'
import type { ExecutorConfig, PaperAccount } from '../../shared/ipc'
import { committedByAsset } from './accountCommitments'
import { describeInsufficientFunds } from './paperAccount'

export interface FundingRequest {
  quoteAsset: string
  amountQuote: number
}

/** Whether the paper account can support starting these strategies, or why not.
 *
 * Two deliberate exemptions:
 *
 * - No account means no limit. The account is opt-in, so anyone who never set one up keeps the
 *   behaviour they already had. Refusing to create executors because of a feature the user has
 *   not adopted would break a working app to enforce bookkeeping they never asked for.
 * - Live executors are never checked. They spend real money on a real exchange and are gated by
 *   liveTradingService instead; charging them against a simulated balance would block a real
 *   order over imaginary funds.
 *
 * Requests are summed per asset before checking, so adding a whole starter pack is judged on what
 * the pack costs together. Checking each one alone is how three affordable strategies add up to
 * one the account cannot cover. */
export function describeBatchFunding(
  {
    account,
    executors,
    requests
  }: {
    account: PaperAccount | null
    executors: ExecutorConfig[]
    requests: FundingRequest[]
  },
  i18n: I18n = ENGLISH
): string | null {
  // Falsy, not just null: a settings file written before the account existed has no
  // paperAccount key at all, and `undefined === null` is false -- which would send an absent
  // account straight into a property read.
  if (!account) return null
  if (requests.length === 0) return null

  const committed = committedByAsset(executors)
  const wanted: Record<string, number> = {}
  for (const request of requests) {
    if (!Number.isFinite(request.amountQuote) || request.amountQuote <= 0) continue
    wanted[request.quoteAsset] = (wanted[request.quoteAsset] ?? 0) + request.amountQuote
  }

  for (const [asset, amount] of Object.entries(wanted)) {
    const problem = describeInsufficientFunds(
      {
        account,
        asset,
        amount,
        committed: committed[asset] ?? 0
      },
      i18n
    )
    if (problem !== null) return problem
  }
  return null
}

/** The single-executor case, which is what the New Executor form asks. */
export function describeExecutorFunding(
  {
    account,
    executors,
    mode,
    quoteAsset,
    amountQuote
  }: {
    account: PaperAccount | null
    executors: ExecutorConfig[]
    mode: 'paper' | 'live'
    quoteAsset: string
    amountQuote: number
  },
  i18n: I18n = ENGLISH
): string | null {
  if (mode === 'live') return null
  return describeBatchFunding({ account, executors, requests: [{ quoteAsset, amountQuote }] }, i18n)
}
