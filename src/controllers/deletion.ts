import type { ControllerConfig, ExecutorConfig } from '../../shared/ipc'

/** What deleting a controller means.
 *
 * Nothing blocks it. A controller holds no orders and no position of its own -- it is a watcher
 * over executors that each run on their own. That is exactly why the warning matters: deleting it
 * does not stop anything, it removes the thing that would have stopped them. An active controller
 * with running executors under it is the only safety net those executors have, and it disappears
 * silently unless someone says so first. */
export function describeControllerDeletionEffects(
  controller: ControllerConfig,
  executors: ExecutorConfig[]
): string[] {
  const effects: string[] = []
  const attached = executors.filter((e) => controller.executorIds.includes(e.id))
  const running = attached.filter((e) => e.status === 'active')

  if (running.length > 0) {
    const limits = [
      controller.riskControls.globalStopLossPct !== null && `a ${Math.abs(controller.riskControls.globalStopLossPct)}% stop loss`,
      controller.riskControls.globalTakeProfitPct !== null && `a ${Math.abs(controller.riskControls.globalTakeProfitPct)}% take profit`,
      controller.riskControls.maxDrawdownPct !== null && `a ${Math.abs(controller.riskControls.maxDrawdownPct)}% max drawdown`
    ].filter((x): x is string => typeof x === 'string')

    effects.push(
      `${running.length} executor${running.length === 1 ? '' : 's'} ${running.length === 1 ? 'is' : 'are'} still running under it (${running.map((e) => e.name).join(', ')}). ${running.length === 1 ? 'It' : 'They'} will keep running — deleting the controller stops nothing.`
    )
    if (limits.length > 0) {
      const named = limits.join(', ')
      effects.push(
        `${named.charAt(0).toUpperCase()}${named.slice(1)} will no longer be watched for. Nothing will stop ${running.length === 1 ? 'it' : 'them'} automatically after this.`
      )
    }
  } else if (attached.length > 0) {
    effects.push(`Its ${attached.length} attached executor${attached.length === 1 ? '' : 's'} ${attached.length === 1 ? 'is' : 'are'} already stopped and will not be touched.`)
  }

  effects.push('The executors themselves are not deleted.')
  return effects
}
