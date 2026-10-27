import { onExchange, type ExecutorConfig, type HeldPosition } from '../../shared/ipc'
import { bookOf } from '../../shared/paperBooks'
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
    if (onExchange(executor.mode)) continue
    // A trade of one of V8's books stakes its book's money, not the account's.
    if (bookOf(executor) !== 'other') continue
    const amount = executorAllocatedQuote(executor)
    // A malformed executor must not poison the whole total with NaN -- one bad row would make
    // every figure on the Account page unreadable rather than just its own.
    if (!Number.isFinite(amount) || amount <= 0) continue
    committed[executor.quoteAsset] = (committed[executor.quoteAsset] ?? 0) + amount
  }
  return committed
}

/** What Inventory positions cost, per quote asset.
 *
 * This money really has left the balance: handing a position over books -amountQuote, because
 * from then on the cash IS the position. So a balance on its own understates the account by
 * exactly this much, and "since funded" reads as a loss the user has not made -- hand over a
 * 1,000 position and the Account page called it -1,000.00, in red, while the position sat safely
 * in Inventory.
 *
 * At cost, not marked to market. This page fetches no prices, and cost is the figure that makes
 * "since funded" read zero the moment a position is handed over, which is the truth: nothing has
 * been gained or lost by moving it. Portfolio marks the same position to market for its total. */
export function heldCostByAsset(held: HeldPosition[]): Record<string, number> {
  const cost: Record<string, number> = {}
  for (const position of held) {
    const amount = position.amountQuote
    // One malformed row must not turn every figure on the page into NaN.
    if (!Number.isFinite(amount) || amount <= 0) continue
    cost[position.quoteAsset] = (cost[position.quoteAsset] ?? 0) + amount
  }
  return cost
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
