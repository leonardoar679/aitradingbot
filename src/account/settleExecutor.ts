import type { ExecutorConfig, HeldPosition } from '../../shared/ipc'
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
 * A position handed over to Inventory is not settled as profit either -- but its COST does leave
 * the balance, because that cash is now the position. Portfolio values the Inventory row on its
 * own, so leaving the cash in place as well would count the same money twice: once as cash, once
 * as the thing it bought.
 *
 * A known limit worth stating: a strategy that both closed some cycles at a profit AND handed over
 * a still-open position leaves the closed part attached to the Inventory row rather than the cash
 * balance. Splitting realised from unrealised needs a second pass over the simulation, and getting
 * the total right in the common case matters more than the split in the rare one.
 *
 * Returns what was settled, or null when nothing was. */
export async function settleExecutorOnStop({
  executor,
  handedOver,
  now
}: {
  executor: ExecutorConfig
  /** The Inventory row this stop created, if any. */
  handedOver: HeldPosition | null
  now: number
}): Promise<number | null> {
  if (executor.mode === 'live') return null

  const settings = await window.api.settings.get()
  if (!settings.paperAccount) return null

  // A kept position: the cash bought it and is now represented by the Inventory row.
  const pnl = !handedOver ? await computeExecutorPnl(executor) : -handedOver.amountQuote
  // A strategy that broke even, or whose P&L could not be worked out, must not write a movement
  // -- a ledger full of zero entries explains nothing, and NaN would poison the balance.
  if (!Number.isFinite(pnl) || pnl === 0) return null

  await updateAccount(
    (account) =>
      settle(account, {
        asset: executor.quoteAsset,
        amount: pnl,
        executorId: executor.id,
        note: !handedOver ? `${executor.name} stopped` : `${executor.name} kept its position`,
        now,
        id: crypto.randomUUID()
      }),
    now
  )
  return pnl
}
