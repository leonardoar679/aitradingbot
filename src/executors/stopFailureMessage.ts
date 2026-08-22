/** Builds the message shown on an executor card when a live Stop only partly succeeded.
 *
 * Kept out of the component because the two failures need different actions from the user and
 * must not be blurred into one "stop failed": a resting order still sitting on the exchange can
 * be cancelled from the exchange's own UI, whereas an open position that is still being watched
 * cannot -- it has to be closed. Naming which one is still out there is the whole point of the
 * message. */
export function describeIncompleteStop(params: {
  restingOrders: number
  watcherStillActive: boolean
  cancelError: string | null
  watcherError: string | null
}): string | null {
  const { restingOrders, watcherStillActive, cancelError, watcherError } = params
  if (restingOrders <= 0 && !watcherStillActive) return null

  const parts: string[] = []
  if (restingOrders > 0) {
    parts.push(
      `${restingOrders} real resting order${restingOrders === 1 ? ' is' : 's are'} still live on the exchange (${cancelError ?? 'cancel failed'})`
    )
  }
  if (watcherStillActive) {
    parts.push(`the open position is still being watched and was NOT closed (${watcherError ?? 'close failed'})`)
  }
  return `Stop did not fully complete — ${parts.join(', and ')}. The executor is deliberately left active so you can press Stop again.`
}
