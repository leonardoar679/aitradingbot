import { useEffect } from 'react'

/** Headless — mounted once in App.tsx, same tier as RoutineScheduler/ControllerScheduler.
 * Reconciles two kinds of main-process-resolved real-money state into settings.executors every
 * 5s, the same read-modify-write pattern RoutineScheduler already uses to update state a page
 * mounted elsewhere might be showing:
 *   1. Every open live limit order (liveOrdersService.ts) — for anything resolved, patches the
 *      matching executor's status/liveOrder.
 *   2. Every live Position watcher's resolved exit (livePositionWatchersService.ts) — the actual
 *      triggering runs continuously in the main process independent of this poll (see
 *      startLivePositionWatcherLoop in electron/main.ts); this just picks up the result and
 *      patches the matching executor's status/liveExitResult.
 * Deliberately polling rather than a websocket user-data-stream / continuous renderer-side
 * ticker subscription for either; see the Phase 2c/3 plans for why that's the right-sized choice
 * here. */
const POLL_MS = 5_000

export function LiveOrderScheduler(): null {
  useEffect(() => {
    let cancelled = false

    async function poll(): Promise<void> {
      try {
        const [orderResolutions, watcherEvents] = await Promise.all([
          window.api.liveTrading.pollOpenOrders(),
          window.api.liveTrading.drainWatcherEvents()
        ])
        if (cancelled || (orderResolutions.length === 0 && watcherEvents.length === 0)) return

        const settings = await window.api.settings.get()
        if (cancelled) return
        const stoppedAt = Math.floor(Date.now() / 1000)
        const nextExecutors = settings.executors.map((executor) => {
          const orderResolution = orderResolutions.find((r) => r.executorId === executor.id)
          if (orderResolution) {
            return { ...executor, status: 'stopped' as const, stoppedAt, liveOrder: orderResolution.liveOrder, pendingLiveOrderId: null }
          }
          const watcherEvent = watcherEvents.find((e) => e.executorId === executor.id)
          if (watcherEvent) {
            return { ...executor, status: 'stopped' as const, stoppedAt, liveExitResult: watcherEvent.liveExitResult, liveWatcherId: null }
          }
          return executor
        })
        await window.api.settings.set({ executors: nextExecutors })
      } catch (error) {
        console.error('Failed to poll live orders/watchers:', error)
      }
    }

    void poll()
    const timer = setInterval(poll, POLL_MS)
    return () => {
      cancelled = true
      clearInterval(timer)
    }
  }, [])

  return null
}
