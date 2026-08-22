import type { ExecutorConfig } from '../../shared/ipc'

/** True when this executor may have a real position open on the exchange with nothing watching
 * it — arming its exit watcher failed, or a fill happened and no position could be found to arm
 * one against. Tolerates `undefined` from executors saved before the field existed. */
export function hasUnprotectedLivePosition(executor: ExecutorConfig): boolean {
  return (executor.liveWatcherError ?? null) !== null
}

/** Only live DCA and Grid ladders arm their exit watcher lazily, from LiveOrderScheduler's poll
 * once a level fills — Position arms one synchronously at creation, Order and TWAP never use one.
 * So they are the only types that can be left holding an unarmed position, and the only ones
 * worth retrying. */
export function needsExitWatcherRetry(executor: ExecutorConfig): boolean {
  return (
    executor.mode === 'live' &&
    executor.status === 'active' &&
    (executor.type === 'dca' || executor.type === 'grid') &&
    executor.liveWatcherId === null &&
    hasUnprotectedLivePosition(executor)
  )
}

/** The rule that decides an executor has finished: nothing resting, nothing being watched, no
 * TWAP run.
 *
 * The last clause is the safety one. Without it, a fill that cleared the last resting order and
 * then failed to arm its watcher satisfied all three emptiness checks, so the executor was marked
 * stopped -- presenting a real, unprotected position as a job cleanly finished. An executor that
 * could not arm its watcher is not finished; it is the opposite of finished. */
export function isFinished(executor: ExecutorConfig): boolean {
  return (
    executor.pendingLiveOrderIds.length === 0 &&
    executor.liveWatcherId === null &&
    executor.liveTwapRunId === null &&
    !hasUnprotectedLivePosition(executor)
  )
}
