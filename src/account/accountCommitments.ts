import type { ExecutorConfig } from '../../shared/ipc'
import { executorAllocatedQuote } from '../executors/computeSnapshot'

/** How much of each asset is currently out working, i.e. committed to running paper strategies.
 *
 * Only paper executors count. A live executor spends real money on a real exchange and has its
 * own ledger; charging it against the simulated account would show funds leaving a balance those
 * orders never touched. Stopped executors have already returned their money.
 *
 * Keyed by quote asset, because that is what an executor's size is denominated in --
 * `executorAllocatedQuote` returns a quote amount for every executor type. */
export function committedByAsset(executors: ExecutorConfig[]): Record<string, number> {
  const committed: Record<string, number> = {}
  for (const executor of executors) {
    if (executor.status !== 'active') continue
    if (executor.mode === 'live') continue
    const amount = executorAllocatedQuote(executor)
    // A malformed executor must not poison the whole total with NaN -- one bad row would make
    // every figure on the Account page unreadable rather than just its own.
    if (!Number.isFinite(amount) || amount <= 0) continue
    committed[executor.quoteAsset] = (committed[executor.quoteAsset] ?? 0) + amount
  }
  return committed
}

export function committedFor(executors: ExecutorConfig[], asset: string): number {
  return committedByAsset(executors)[asset] ?? 0
}

/** Every asset the account touches: funded, committed, or both. Sorted so the ones with the most
 * free money come first, with committed-only assets after them. */
export function assetsInPlay(balances: Record<string, number>, committed: Record<string, number>): string[] {
  const all = new Set([...Object.keys(balances), ...Object.keys(committed)])
  return [...all]
    .filter((asset) => {
      const free = balances[asset]
      const out = committed[asset]
      return (Number.isFinite(free) && free !== 0) || (Number.isFinite(out) && out !== 0)
    })
    .sort((a, b) => (balances[b] ?? 0) - (balances[a] ?? 0))
}
