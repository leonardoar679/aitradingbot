import { settingsWrites } from '../utils/settingsWrites'
import { buildPresetExecutor, buildStarterPack, type StarterPack, type StarterPreset } from './starterPresets'
import type { ExecutorConfig } from '../../shared/ipc'
import { describeBatchFunding } from '../account/executorFunding'
import { executorAllocatedQuote } from '../executors/computeSnapshot'

/** Throws when the paper account cannot cover these executors, with the shortfall named.
 *
 * Checked inside the queued read so it sees the same settings the write will use. Checking
 * beforehand against a stale copy is how a pack gets admitted that no longer fits by the time it
 * lands. Returns silently when there is no account -- it is opt-in. */
function assertAffordable(
  settings: { executors: ExecutorConfig[]; paperAccount: Parameters<typeof describeBatchFunding>[0]['account'] },
  additions: ExecutorConfig[]
): void {
  const problem = describeBatchFunding({
    account: settings.paperAccount,
    executors: settings.executors,
    requests: additions
      .filter((e) => e.mode !== 'live')
      .map((e) => ({ quoteAsset: e.quoteAsset, amountQuote: executorAllocatedQuote(e) }))
  })
  if (problem !== null) throw new Error(problem)
}

/** Adds a pack's executors AND the controller supervising them in one write.
 *
 * Both lists are re-read immediately before the append and both go into a single settings.set,
 * because settings.set replaces whole top-level arrays: writing executors and controllers as two
 * separate patches would leave a window where the controller exists but its executors do not, and
 * ControllerScheduler would tick against a group whose members it cannot find.
 *
 * Queued with every other settings writer so the re-read and the write cannot be split by one. */
export async function insertStarterPack(
  pack: StarterPack,
  opts: { referencePrice: number; now: number }
): Promise<ExecutorConfig[]> {
  const { executors, controller } = buildStarterPack(pack, opts)
  await settingsWrites(async () => {
    const fresh = await window.api.settings.get()
    assertAffordable(fresh, executors)
    await window.api.settings.set({
      executors: [...fresh.executors, ...executors],
      controllers: [...fresh.controllers, controller]
    })
  })
  return executors
}

/** Adds a single preset with no controller around it -- appended to whatever storage holds now
 * rather than to any caller-held copy. */
export async function insertPreset(
  preset: StarterPreset,
  opts: { referencePrice: number; now: number }
): Promise<ExecutorConfig> {
  const executor = buildPresetExecutor(preset, opts)
  await settingsWrites(async () => {
    const fresh = await window.api.settings.get()
    assertAffordable(fresh, [executor])
    await window.api.settings.set({ executors: [...fresh.executors, executor] })
  })
  return executor
}
