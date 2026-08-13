import { useEffect } from 'react'

/** Headless — mounted once in App.tsx, same tier as RoutineScheduler/ControllerScheduler.
 * Polls every open live limit order (main process, liveOrdersService.ts) every 5s; for anything
 * resolved, patches the matching executor's status/liveOrder directly in settings.json — the
 * same read-modify-write pattern RoutineScheduler already uses to update state a page mounted
 * elsewhere might be showing. Deliberately polling rather than a websocket user-data-stream; see
 * the Phase 2c plan for why that's the right-sized choice here. */
const POLL_MS = 5_000

export function LiveOrderScheduler(): null {
  useEffect(() => {
    let cancelled = false

    async function poll(): Promise<void> {
      try {
        const resolutions = await window.api.liveTrading.pollOpenOrders()
        if (cancelled || resolutions.length === 0) return

        const settings = await window.api.settings.get()
        if (cancelled) return
        const stoppedAt = Math.floor(Date.now() / 1000)
        const nextExecutors = settings.executors.map((executor) => {
          const resolution = resolutions.find((r) => r.executorId === executor.id)
          if (!resolution) return executor
          return { ...executor, status: 'stopped' as const, stoppedAt, liveOrder: resolution.liveOrder, pendingLiveOrderId: null }
        })
        await window.api.settings.set({ executors: nextExecutors })
      } catch (error) {
        console.error('Failed to poll live orders:', error)
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
