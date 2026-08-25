import type { ExecutorConfig, HeldPosition } from '../../shared/ipc'
import { computeExecutorPosition } from './computeSnapshot'
import { settingsWrites } from '../utils/settingsWrites'

/** Moves an executor's still-open paper position into Inventory when it stops, honouring the
 * executor's "Keep position when stopped (hand over to Inventory)" checkbox.
 *
 * Extracted from ExecutorsPage's Stop handler because a controller's risk controls can stop an
 * executor too (ControllerScheduler, on a global stop-loss / take-profit / max-drawdown breach)
 * and was dropping the position on the floor -- so whether a ticked checkbox was honoured
 * depended on *who* pressed stop. A breach is precisely when the position most needs recording.
 *
 * Position handover is paper-only bookkeeping: a live fill already has its own ledger
 * (LivePosition) regardless of keepPosition, and re-running paper candle replay on a live
 * executor to stuff the result into paper Inventory would be wrong.
 *
 * Appends to a freshly re-read heldPositions rather than any caller-held copy -- settings.set
 * replaces the whole array, and computing the position above is a network round trip long enough
 * for another writer to land in between.
 *
 * Returns the row that was added, or null. The row itself rather than a boolean because the
 * account needs its amountQuote: cash that became an Inventory position has to leave the balance,
 * or Portfolio counts the same money twice -- once as cash and once as the position it bought. */
export async function handOverPositionOnStop(executor: ExecutorConfig): Promise<HeldPosition | null> {
  if (executor.mode === 'live' || !executor.keepPosition) return null

  const position = await computeExecutorPosition(executor)
  if (!position) return null

  const held: HeldPosition = {
    id: crypto.randomUUID(),
    sourceExecutorId: executor.id,
    sourceExecutorName: executor.name,
    exchange: executor.exchange,
    symbol: executor.symbol,
    baseAsset: executor.baseAsset,
    quoteAsset: executor.quoteAsset,
    side: position.side,
    entryPrice: position.entryPrice,
    amountQuote: position.amountQuote,
    openedAt: Math.floor(Date.now() / 1000)
  }
  // Queued so the re-read and the append are one step: re-reading alone still leaves a gap a
  // second handover can land in, and a lost row means a kept position silently discarded.
  await settingsWrites(async () => {
    const settings = await window.api.settings.get()
    await window.api.settings.set({ heldPositions: [...settings.heldPositions, held] })
  })
  return held
}
