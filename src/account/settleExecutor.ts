import type { ExecutorConfig } from '../../shared/ipc'
import { computeExecutorPnl } from '../executors/computeSnapshot'
import { settle } from './paperAccount'
import { updateAccount } from './persistAccount'

/** Books a stopped paper strategy's result into the account.
 *
 * Central on purpose. A strategy can be stopped from the Executors page, by a Controller hitting
 * a risk limit, or by a live run finishing, and the account has to end up the same either way --
 * the same "whoever pressed stop" problem that once decided whether a kept position survived.
 *
 * Three cases are deliberately skipped:
 *
 * - Live executors. They move real money and keep their own ledger; adding their result to a
 *   simulated balance would invent paper profit out of real trades.
 * - No account. Nothing to settle into, and the app worked this way before the account existed.
 * - A position handed over to Inventory. Its value is now carried by that Inventory row, which
 *   Portfolio prices on its own, so settling as well would count the same money twice.
 *
 * The third case has a known limit worth stating: a strategy that both closed some cycles at a
 * profit AND handed over a still-open position leaves the closed part attached to the Inventory
 * row rather than the cash balance. Splitting realised from unrealised needs a second pass over
 * the simulation, and getting the total right in the common case matters more than getting the
 * split right in the rare one.
 *
 * Returns what was settled, or null when nothing was. */
export async function settleExecutorOnStop({
  executor,
  handedOverToInventory,
  now
}: {
  executor: ExecutorConfig
  handedOverToInventory: boolean
  now: number
}): Promise<number | null> {
  if (executor.mode === 'live') return null
  if (handedOverToInventory) return null

  const settings = await window.api.settings.get()
  if (settings.paperAccount === null) return null

  const pnl = await computeExecutorPnl(executor)
  // A strategy that broke even, or whose P&L could not be worked out, must not write a movement
  // -- a ledger full of zero entries explains nothing, and NaN would poison the balance.
  if (!Number.isFinite(pnl) || pnl === 0) return null

  await updateAccount(
    (account) =>
      settle(account, {
        asset: executor.quoteAsset,
        amount: pnl,
        executorId: executor.id,
        note: `${executor.name} stopped`,
        now,
        id: crypto.randomUUID()
      }),
    now
  )
  return pnl
}
