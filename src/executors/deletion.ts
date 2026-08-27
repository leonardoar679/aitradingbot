import type { ControllerConfig, ExecutorConfig } from '../../shared/ipc'

/** What deleting an executor would mean, and when it must not be allowed at all.
 *
 * Deleting is the one action in this app that destroys a record rather than changing it, and the
 * record is not only a row in a list: a live executor can own resting orders on a real exchange
 * and an armed exit watcher in the main process. Those live on their own -- the exchange has
 * never heard of this app's settings file. Deleting the row would not cancel a single one of
 * them; it would only take away the screen that says they exist and the Stop button that ends
 * them. So the rule is that nothing with live state attached can be deleted, and the way to
 * delete it is to stop it first, which is the path that actually tears that state down. */

/** Why this executor cannot be deleted right now, or null if it can be.
 *
 * Every one of these is about state that outlives the record. `status === 'active'` covers the
 * ordinary case; the three live-handle checks are belt and braces, because a stop that only
 * partly succeeded deliberately leaves the executor active with its handles intact -- and a
 * future change to that path must not quietly turn into an orphaned order here. */
export function describeExecutorDeletionBlock(executor: ExecutorConfig): string | null {
  if (executor.status === 'active') {
    return 'It is still running. Stop it first — stopping cancels its orders and closes what it is holding, which deleting does not.'
  }
  if (executor.pendingLiveOrderIds.length > 0) {
    const n = executor.pendingLiveOrderIds.length
    return `It still has ${n} live order${n === 1 ? '' : 's'} resting on the exchange. Stop it again so ${n === 1 ? 'it' : 'they'} can be cancelled — deleting would leave ${n === 1 ? 'it' : 'them'} on the exchange with nothing here tracking ${n === 1 ? 'it' : 'them'}.`
  }
  if (executor.liveWatcherId) {
    return 'A live exit watcher is still armed on its position. Stop it again so the watcher can be closed down — deleting would leave a real position being watched by something you can no longer see.'
  }
  if (executor.liveTwapRunId) {
    return 'A live TWAP run is still placing slices. Stop it again to halt the schedule — deleting would not stop a single slice.'
  }
  return null
}

/** Everything that changes besides the row disappearing, in plain terms. Empty when deleting is
 * only that. Shown before the user confirms, not after. */
export function describeExecutorDeletionEffects(executor: ExecutorConfig, controllers: ControllerConfig[]): string[] {
  const effects: string[] = []

  const attached = controllers.filter((c) => c.executorIds.includes(executor.id))
  if (attached.length > 0) {
    effects.push(
      `It will be detached from ${attached.length === 1 ? `the controller "${attached[0].name}"` : `${attached.length} controllers (${attached.map((c) => c.name).join(', ')})`}.`
    )
    // A controller left supervising nothing is not deleted for them -- it is theirs, and quietly
    // removing it would be a second deletion they never asked for. It does need saying, because
    // a controller with no executors silently stops doing anything at all.
    const emptied = attached.filter((c) => c.executorIds.every((id) => id === executor.id))
    if (emptied.length > 0) {
      effects.push(
        `${emptied.length === 1 ? `The controller "${emptied[0].name}" will be left` : `${emptied.length} controllers will be left`} supervising nothing, and ${emptied.length === 1 ? 'its' : 'their'} risk limits will have nothing to act on.`
      )
    }
  }

  if (executor.keepPosition) {
    effects.push('Any position it handed over to Positions → Inventory stays there — deleting the strategy does not close it.')
  }

  effects.push('What it made or lost stays in your account history. Deleting the strategy does not undo the money.')
  return effects
}

/** The controllers array with this executor detached from every controller holding it.
 *
 * Returns the same array when nothing referenced it, so a delete that changes no controller does
 * not rewrite the controllers list for no reason. Without this the controller keeps an id that
 * matches nothing: it would still count the executor on screen, and the snapshot tick would
 * quietly supervise one fewer strategy than the page claims. */
export function detachExecutorFromControllers(controllers: ControllerConfig[], executorId: string): ControllerConfig[] {
  if (!controllers.some((c) => c.executorIds.includes(executorId))) return controllers
  return controllers.map((c) =>
    c.executorIds.includes(executorId) ? { ...c, executorIds: c.executorIds.filter((id) => id !== executorId) } : c
  )
}
