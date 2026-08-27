import type { PositionHandover } from '../executors/handOverPosition'
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
 * A position handed over to Inventory is not settled as profit either -- but its COST does leave
 * the balance, because that cash is now the position. Portfolio values the Inventory row on its
 * own, so leaving the cash in place as well would count the same money twice: once as cash, once
 * as the thing it bought.
 *
 * A strategy that both banked a profit AND handed over a still-open position gets both: the cash
 * that bought the position leaves the balance, and the banked profit arrives in it. Those used to
 * be collapsed into one figure, which quietly threw the banked half away -- a grid measured on
 * real BTCUSDT candles turned over 47 round trips for 14.44 and, because it was holding four lots
 * when it stopped, kept none of it.
 *
 * Returns what was settled, or null when nothing was. */
export async function settleExecutorOnStop({
  executor,
  handedOver,
  now
}: {
  executor: ExecutorConfig
  /** The Inventory row this stop created, if any, and the profit already banked. */
  handedOver: PositionHandover
  now: number
}): Promise<number | null> {
  if (executor.mode === 'live') return null

  const settings = await window.api.settings.get()
  if (!settings.paperAccount) return null

  // A kept position: the cash bought it and is now represented by the Inventory row, so only its
  // cost leaves the balance -- but anything the executor had already banked has no row anywhere,
  // and has to arrive as cash.
  const pnl = !handedOver.held
    ? await computeExecutorPnl(executor)
    : handedOver.realizedPnl - handedOver.held.amountQuote
  // A strategy that broke even, or whose P&L could not be worked out, must not write a movement
  // -- a ledger full of zero entries explains nothing, and NaN would poison the balance.
  if (!Number.isFinite(pnl) || pnl === 0) return null

  await updateAccount(
    (account) =>
      settle(account, {
        asset: executor.quoteAsset,
        amount: pnl,
        executorId: executor.id,
        note: !handedOver.held ? `${executor.name} stopped` : `${executor.name} kept its position`,
        now,
        id: crypto.randomUUID()
      }),
    now
  )
  return pnl
}
